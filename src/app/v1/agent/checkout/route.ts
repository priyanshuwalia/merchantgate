import { eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  budgetReservations,
  cartMandates,
  db,
  intentMandates,
  merchants,
  paymentActions,
  policyDecisions,
  products,
} from "@/db";
import { logAuditEvent } from "@/lib/audit/logger";
import { authenticateAgentRequest } from "@/lib/auth/agent-auth";
import { generateCartMandateSnapshotHash } from "@/lib/crypto/canonical";
import {
  evaluateMerchantNegotiation,
  getMerchantAgentRules,
} from "@/lib/merchant/agent";
import {
  getActiveCampaigns,
  recordCampaignSpend,
  resolveCampaignForLine,
} from "@/lib/merchant/campaigns";
import {
  aiSalesPausedResponse,
  getMerchantGateState,
} from "@/lib/merchant/guard";
import { getAgreedNegotiationForCheckout } from "@/lib/merchant/negotiation";
import { hydrateRuntimeState } from "@/lib/merchant/runtime-state";
import {
  isSurgePricingActive,
  SURGE_PRICING_REASON,
} from "@/lib/merchant/surge";
import {
  getUpsellRules,
  type MarketBasketRecord,
  resolveUpsellOffer,
  type UpsellCartItem,
  type UpsellCatalogItem,
} from "@/lib/merchant/upsell";
import {
  CartSnapshotMismatchError,
  preparePayment,
} from "@/lib/payments/orchestrator";
import { getRollingBudgetUsage } from "@/lib/policy/budget";
import { evaluatePolicy, type IntentMandate } from "@/lib/policy/engine";
import { generateId, generateTraceId } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * Normalise and bound a buyer-supplied (or stored) intent mandate's money and
 * policy constraints so a malicious/hallucinated mandate can never grant an
 * unbounded budget, negative limits, or impossible tolerances. This is the
 * authoritative boundary for values that drive the policy engine.
 */
function sanitizeMandate(mandate: IntentMandate): IntentMandate {
  const c = mandate.constraints || {};
  const MAX_TXN = 1_000_000_000; // ₹10 crore
  const MAX_ROLLING = 5_000_000_000;
  const MAX_QTY = 1_000_000;

  const num = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };

  return {
    ...mandate,
    constraints: {
      ...c,
      currency:
        typeof c.currency === "string" ? c.currency.toUpperCase() : "INR",
      maxTransactionAmountMinor: Math.min(
        MAX_TXN,
        num(c.maxTransactionAmountMinor, 500000),
      ),
      rolling30dAmountMinor: Math.min(
        MAX_ROLLING,
        num(c.rolling30dAmountMinor, MAX_ROLLING),
      ),
      quantityMax: Math.min(MAX_QTY, num(c.quantityMax, 1000000)),
      maxPriceSlippageBps: Math.min(
        10000,
        Math.max(0, num(c.maxPriceSlippageBps, 200)),
      ),
      requiresRefundability: Boolean(c.requiresRefundability),
      allowedMerchants: Array.isArray(c.allowedMerchants)
        ? c.allowedMerchants.filter((m: unknown) => typeof m === "string")
        : [],
      allowedCategories: Array.isArray(c.allowedCategories)
        ? c.allowedCategories.filter((m: unknown) => typeof m === "string")
        : [],
      fulfillment: c.fulfillment,
    },
  };
}

export async function POST(request: Request) {
  const traceId = generateTraceId();

  try {
    const body = await request.json();
    const {
      intentMandateId,
      intentMandate: clientMandate,
      items: requestedItems,
      delivery,
      negotiationSessionId,
      upsellOfferId,
    } = body;

    if (
      !requestedItems ||
      !Array.isArray(requestedItems) ||
      requestedItems.length === 0
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "Items array is required and cannot be empty.",
        },
        { status: 400 },
      );
    }

    const merchantId = "mch_nimbus_gear_001";
    const [_merchant] = await db
      .select()
      .from(merchants)
      .where(eq(merchants.id, merchantId))
      .limit(1);

    // Check Enable AI Sales Channel Kill-Switch (global gate)
    const gate = await getMerchantGateState();
    if (!gate.aiSalesEnabled) {
      return aiSalesPausedResponse({ endpoint: "/v1/agent/checkout" });
    }
    const merchantConfig = gate.config;
    const merchantAgentRules = getMerchantAgentRules(merchantConfig);

    // Agent authentication + rate limiting (C7). Rejects unauthenticated money
    // requests in strict mode; throttles everywhere.
    const auth = await authenticateAgentRequest(request, { merchantConfig });
    if (!auth.ok && auth.response) return auth.response;

    // Rehydrate surge/negotiation runtime state from the DB so sessions and
    // the surge toggle survive process restarts (C8).
    await hydrateRuntimeState();

    // Resolve an agent-to-agent negotiation session (if the buyer negotiated terms)
    const negotiationSession =
      getAgreedNegotiationForCheckout(negotiationSessionId);
    const negotiatedTerms = new Map<
      string,
      { discountBps: number; quantity: number }
    >();
    if (negotiationSession) {
      for (const item of negotiationSession.items) {
        negotiatedTerms.set(item.variantId, {
          discountBps: Math.min(
            negotiationSession.currentDiscountBps,
            merchantAgentRules.maxDiscountBps,
          ),
          quantity: item.quantity,
        });
      }
    }

    const surgeActive = isSurgePricingActive();

    // Fetch the full active catalogue once: it drives cart pricing, campaign
    // resolution and (when the buyer accepts one) upsell offer re-resolution.
    const catalogue = await db.select().from(products);
    const productMap = new Map(catalogue.map((p) => [p.variant_id, p]));

    // Active merchant campaigns may discount eligible lines (A2). Campaign
    // discounts never stack with a live surge (surge re-prices UP; promotions
    // only apply at normal pricing conditions).
    const campaigns = surgeActive ? [] : await getActiveCampaigns();

    // Optional: accept a bounded upsell offer by its id (A1). Re-resolves the
    // offer deterministically against the same catalogue, so a buyer can only
    // ever add items the merchant priced at quote time.
    let acceptedUpsellOffer: {
      offerId: string;
      items: number;
      addedMinor: number;
    } | null = null;
    const upsellRules = getUpsellRules(merchantConfig);
    if (upsellOfferId && !surgeActive && upsellRules.enabled) {
      const cartSummary: UpsellCartItem[] = requestedItems.reduce<
        UpsellCartItem[]
      >((acc, item) => {
        const p = productMap.get(item.variantId);
        if (p) {
          const quantity = Math.max(1, Number(item.quantity) || 1);
          acc.push({
            variantId: p.variant_id,
            category: p.category,
            title: p.title,
            quantity,
            unitAmountMinor: p.base_price_minor,
          });
        }
        return acc;
      }, []);

      const completedPayments = await db
        .select()
        .from(paymentActions)
        .where(inArray(paymentActions.status, ["completed"]))
        .limit(100);
      const completedCartIds = completedPayments.map((p) => p.cart_mandate_id);
      const completedCarts =
        completedCartIds.length > 0
          ? await db
              .select()
              .from(cartMandates)
              .where(inArray(cartMandates.id, completedCartIds))
          : [];
      const marketBaskets: MarketBasketRecord[] = completedCarts.map((c) => ({
        agentId: String(c.intent_mandate_id),
        variantIds: ((c.items as Array<{ variantId: string }>) || []).map(
          (i) => i.variantId,
        ),
      }));

      const catalog: UpsellCatalogItem[] = catalogue.map((p) => ({
        variantId: p.variant_id,
        title: p.title,
        category: p.category,
        unitAmountMinor: p.base_price_minor,
        stockQuantity: p.stock_quantity,
        attributes: (p.attributes as Record<string, unknown>) || {},
      }));

      const offerItems = resolveUpsellOffer({
        cart: cartSummary,
        catalog,
        rules: upsellRules,
        marketBaskets,
        upsellOfferId,
      });

      if (offerItems) {
        // Merge the accepted add-on items into the requested line items so the
        // exact same quantity/inventory/policy guards apply to them.
        for (const add of offerItems) {
          requestedItems.push({
            variantId: add.variantId,
            quantity: add.quantity,
          });
        }
        acceptedUpsellOffer = {
          offerId: upsellOfferId,
          items: offerItems.length,
          addedMinor: offerItems.reduce((s, i) => s + i.lineAmountMinor, 0),
        };
      }
    }

    // Running subtotal used for order-level campaign minimum-order gating.
    const preSubtotalMinor = requestedItems.reduce<number>((sum, item) => {
      const p = productMap.get(item.variantId);
      if (!p) return sum;
      const quantity = Math.max(1, Number(item.quantity) || 1);
      return sum + p.base_price_minor * quantity;
    }, 0);

    // Check availability & build line items
    let subtotalMinor = 0;
    let taxMinor = 0;
    let discountMinor = 0;
    const cartItems = [];

    for (const item of requestedItems) {
      const dbProduct = productMap.get(item.variantId);
      if (!dbProduct) {
        return NextResponse.json(
          {
            success: false,
            error: `Product variant not found: ${item.variantId}`,
          },
          { status: 404 },
        );
      }

      // Validate quantity strictly: it must be a positive integer. A missing
      // value defaults to 1. Negative, zero, NaN, non-integer or absurd values
      // are rejected — otherwise a crafted negative quantity would produce a
      // negative line total (money fabricated in the merchant's disfavour) and
      // bypass the inventory guard.
      const rawQuantity =
        item.quantity === undefined || item.quantity === null
          ? 1
          : Number(item.quantity);
      if (
        !Number.isSafeInteger(rawQuantity) ||
        rawQuantity < 1 ||
        rawQuantity > 1000000
      ) {
        return NextResponse.json(
          {
            success: false,
            error: `Invalid quantity for ${dbProduct.title}. Quantity must be a whole number between 1 and 1,000,000.`,
          },
          { status: 400 },
        );
      }
      const quantity = rawQuantity;

      if (dbProduct.stock_quantity < quantity) {
        return NextResponse.json(
          {
            success: false,
            error: `Insufficient inventory for ${dbProduct.title}. Available: ${dbProduct.stock_quantity}`,
          },
          { status: 400 },
        );
      }

      const baseUnitPrice = dbProduct.base_price_minor;
      const discoveryPriceMinor = item.discoveryPriceMinor || baseUnitPrice;

      // When surge pricing is active, quote at +15% above discovery price to
      // trigger slippage defense. Otherwise a live merchant campaign may
      // discount the line off the merchant's list price.
      let unitAmountMinor = surgeActive
        ? Math.round(baseUnitPrice * 1.15)
        : baseUnitPrice;
      let appliedCampaign:
        | {
            id: string;
            name: string;
            discountBps: number;
            discountMinor?: number;
          }
        | undefined;

      if (!surgeActive && !negotiationSession) {
        const campaignMatch = resolveCampaignForLine({
          variantId: dbProduct.variant_id,
          category: dbProduct.category,
          basePriceMinor: unitAmountMinor,
          campaigns,
          orderSubtotalMinor: preSubtotalMinor,
        });
        if (campaignMatch) {
          unitAmountMinor = campaignMatch.discountedUnitPriceMinor;
          appliedCampaign = {
            id: campaignMatch.campaign.id,
            name: campaignMatch.campaign.name,
            discountBps: campaignMatch.discountBps,
            discountMinor: campaignMatch.discountMinor,
          };
        }
      }

      const productAttributes =
        (dbProduct.attributes as Record<string, unknown>) || {};
      const rating = {
        average: Number(productAttributes.ratingAverage ?? 4.6),
        count: Number(productAttributes.ratingCount ?? 100),
      };

      const negotiatedTerm =
        negotiationSession &&
        negotiatedTerms.get(dbProduct.variant_id)?.quantity === quantity
          ? negotiatedTerms.get(dbProduct.variant_id)
          : undefined;

      let negotiation = evaluateMerchantNegotiation(
        {
          title: dbProduct.title,
          category: dbProduct.category,
          quantity,
          unitAmountMinor,
          stockQuantity: dbProduct.stock_quantity,
          rating,
        },
        merchantAgentRules,
      );

      if (
        negotiatedTerm &&
        negotiatedTerm.discountBps > negotiation.discountBps
      ) {
        // Apply the agent-to-agent negotiated discount in place of the static bulk tier
        const unitDiscountMinor = Math.round(
          (unitAmountMinor * negotiatedTerm.discountBps) / 10000,
        );
        const discountedUnitAmountMinor = Math.max(
          0,
          unitAmountMinor - unitDiscountMinor,
        );
        negotiation = {
          agentName: `${negotiation.agentName} (Negotiated)`,
          discountBps: negotiatedTerm.discountBps,
          unitDiscountMinor,
          discountedUnitAmountMinor,
          lineDiscountMinor: unitDiscountMinor * quantity,
          merchantMessage: `Negotiation session ${negotiationSession?.id}: agreed ${(negotiatedTerm.discountBps / 100).toFixed(1)}% off for ${quantity} x ${dbProduct.title}.`,
          requiresMerchantApproval: Boolean(
            negotiationSession?.requiresMerchantApproval,
          ),
          reasonCodes: ["NEGOTIATED_AGREEMENT"],
        };
      }

      const discountedUnitAmountMinor = negotiation.discountedUnitAmountMinor;
      const lineAmountMinor = discountedUnitAmountMinor * quantity;
      const itemTaxMinor = Math.round(
        (lineAmountMinor * (dbProduct.tax_rate_bps || 1800)) / 10000,
      );

      subtotalMinor += lineAmountMinor;
      taxMinor += itemTaxMinor;
      discountMinor += negotiation.lineDiscountMinor;

      cartItems.push({
        productId: dbProduct.id,
        variantId: dbProduct.variant_id,
        category: dbProduct.category,
        title: dbProduct.title,
        quantity,
        unitAmountMinor: discountedUnitAmountMinor,
        originalUnitAmountMinor: unitAmountMinor,
        discountBps: negotiation.discountBps,
        lineDiscountMinor: negotiation.lineDiscountMinor,
        lineAmountMinor,
        discoveryPriceMinor,
        returnable: dbProduct.returnable,
        rating,
        negotiation,
        campaign: appliedCampaign,
      });
    }

    const shippingMinor = 0; // Free standard shipping
    const grandTotalMinor = subtotalMinor + taxMinor + shippingMinor;
    const currency = catalogue[0]?.currency || "INR";

    // 2. Fetch or prepare Intent Mandate
    let resolvedMandate: IntentMandate | null = null;
    const mandateId = intentMandateId || clientMandate?.id || generateId("int");

    if (clientMandate) {
      resolvedMandate = clientMandate;
    } else if (intentMandateId) {
      const [dbMandate] = await db
        .select()
        .from(intentMandates)
        .where(eq(intentMandates.id, intentMandateId))
        .limit(1);

      if (dbMandate) {
        resolvedMandate = dbMandate.mandate_json as IntentMandate;
      }
    }

    if (!resolvedMandate) {
      // Fallback default mandate for testing
      resolvedMandate = {
        type: "intent_mandate.v1",
        id: mandateId,
        revision: 1,
        principal: { userId: "user_demo_shopper" },
        delegate: { agentId: "agt_apollo_buyer_v1", agentVersion: "1.0.0" },
        constraints: {
          currency: "INR",
          maxTransactionAmountMinor: 500000,
          rolling30dAmountMinor: 2000000,
          allowedMerchants: [merchantId],
          allowedCategories: [
            "electronics",
            "audio",
            "accessories",
            "computers",
          ],
          quantityMax: 10,
          maxPriceSlippageBps: 200,
          requiresRefundability: true,
          fulfillment: { country: delivery?.country || "IND" },
        },
        validity: {
          notBefore: new Date(Date.now() - 3600000).toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      };
    }

    // Bound the (possibly buyer-supplied) mandate before any policy decision.
    resolvedMandate = sanitizeMandate(resolvedMandate);

    // B5: count committed rolling spend (reservations + completed payments,
    // ≤ 30 days) for this mandate so the policy engine enforces the REAL
    // remaining rolling budget.
    const rollingBudgetUsage = await getRollingBudgetUsage(mandateId);

    const quoteIssuedAt = new Date();
    const quoteExpiresAt = new Date(quoteIssuedAt.getTime() + 15 * 60 * 1000); // 15 min freeze

    const cartMandateQuote = {
      merchantId,
      items: cartItems,
      totals: {
        subtotalMinor,
        discountMinor,
        shippingMinor,
        taxMinor,
        grandTotalMinor,
        currency,
      },
      fulfillment: {
        country: delivery?.country || "IND",
        postalCode: delivery?.postalCode || "560001",
        state: delivery?.state,
        city: delivery?.city,
        addressLine1: delivery?.addressLine1,
      },
      terms: {
        refundable: cartItems.every((i) => i.returnable),
        returnWindowDays: 7,
        shippingPolicy: "Standard 2-3 Day Delivery",
      },
    };

    // 3. Policy Evaluation (with negotiated-discount approval context)
    const appliedNegotiatedBps = negotiationSession
      ? Math.min(
          negotiationSession.currentDiscountBps,
          merchantAgentRules.maxDiscountBps,
        )
      : undefined;

    // Auto-settlement for autonomous buyer purchases: the buyer agent has
    // already run through the prices and validated the cart against its own
    // mandate. When the authoritative quote's grand total is WITHIN the buyer's
    // own mandate budget, the spend is fully authorized on the buyer's side, so
    // it settles automatically (ALLOW) without demanding a further human/manual
    // approval decision. This applies whether or not the buyer negotiated: an
    // over-budget cart is still hard-DENIED by the mandate ceiling regardless.
    const buyerBudgetMinor =
      resolvedMandate?.constraints?.maxTransactionAmountMinor;
    const withinBuyerBudget =
      typeof buyerBudgetMinor === "number" &&
      buyerBudgetMinor > 0 &&
      grandTotalMinor <= buyerBudgetMinor;

    const effectiveMerchantConfig = withinBuyerBudget
      ? {
          ...merchantConfig,
          autoProcessAgentOrders: true,
          agentRequiresApproval: false,
          negotiatedDiscountBps: undefined,
          discountApprovalThresholdBps: undefined,
          rollingBudgetUsageMinor: rollingBudgetUsage.usageMinor,
        }
      : {
          ...merchantConfig,
          rollingBudgetUsageMinor: rollingBudgetUsage.usageMinor,
        };

    const policyResult = evaluatePolicy(resolvedMandate, cartMandateQuote, {
      ...effectiveMerchantConfig,
      negotiatedDiscountBps: appliedNegotiatedBps,
      discountApprovalThresholdBps:
        merchantAgentRules.requireApprovalAboveDiscountBps,
    });

    // Surge pricing semantics: while the merchant's Surge Pricing simulation is
    // active every quote is priced +15% (see below) and is NEVER auto-settled.
    // Escalate to STEP_UP with an explicit SURGE_PRICING_ACTIVE reason so the
    // transaction trace tells the buyer exactly why — the merchant must confirm
    // the surged price. A cart already hard-DENIED by the buyer's mandate
    // ceiling stays DENY (no merchant approval can override the buyer's cap).
    let finalPolicyResult = policyResult;
    if (surgeActive && finalPolicyResult.decision !== "DENY") {
      const reasonCodes = Array.from(
        new Set([...finalPolicyResult.reasonCodes, SURGE_PRICING_REASON]),
      );
      finalPolicyResult = {
        ...finalPolicyResult,
        decision: "STEP_UP",
        reasonCodes,
        explanation:
          finalPolicyResult.decision === "STEP_UP"
            ? `${policyResult.explanation} Surge pricing is active — the merchant is simulating a +15% price increase (${SURGE_PRICING_REASON}), so this quote requires human merchant confirmation.`
            : `Requires human merchant confirmation: ${reasonCodes.join(", ")}. Surge pricing is active — the merchant is simulating a +15% price increase (${SURGE_PRICING_REASON}), so this quote requires human merchant confirmation.`,
      };
    }

    const cartMandateId = generateId("cart");
    const quoteId = generateId("quo");

    // Canonical Cart Snapshot Hash over the full persisted cart mandate.
    const cartSnapshotHash = generateCartMandateSnapshotHash({
      id: cartMandateId,
      intent_mandate_id: mandateId,
      merchant_id: merchantId,
      quote_expires_at: quoteExpiresAt,
      total_minor: grandTotalMinor,
      currency,
      items: cartItems,
      fulfillment: cartMandateQuote.fulfillment,
      terms: cartMandateQuote.terms,
    });

    const cartMandateResponse = {
      type: "cart_mandate.v1",
      id: cartMandateId,
      intentMandateId: mandateId,
      merchantId,
      quote: {
        quoteId,
        version: 1,
        issuedAt: quoteIssuedAt.toISOString(),
        expiresAt: quoteExpiresAt.toISOString(),
      },
      items: cartItems.map((i) => ({
        productId: i.productId,
        variantId: i.variantId,
        category: i.category,
        title: i.title,
        quantity: i.quantity,
        unitAmountMinor: i.unitAmountMinor,
        lineAmountMinor: i.lineAmountMinor,
        originalUnitAmountMinor: i.originalUnitAmountMinor,
        discountBps: i.discountBps,
        lineDiscountMinor: i.lineDiscountMinor,
        rating: i.rating,
        campaign: i.campaign,
      })),
      totals: cartMandateQuote.totals,
      fulfillment: cartMandateQuote.fulfillment,
      terms: cartMandateQuote.terms,
      devProof: {
        type: "sha256-canonical-json",
        digest: cartSnapshotHash,
      },
    };

    // Ensure intent mandate is persisted in db
    const existingMandate = await db
      .select()
      .from(intentMandates)
      .where(eq(intentMandates.id, mandateId))
      .limit(1);

    if (existingMandate.length === 0) {
      await db.insert(intentMandates).values({
        id: mandateId,
        user_id: resolvedMandate.principal?.userId || "user_demo",
        agent_id: resolvedMandate.delegate?.agentId || "agt_apollo_buyer_v1",
        mandate_json: resolvedMandate,
        max_transaction_minor:
          resolvedMandate.constraints?.maxTransactionAmountMinor || 500000,
        currency,
        validity_expires_at: new Date(
          resolvedMandate.validity?.expiresAt || Date.now() + 86400000,
        ),
        status: "active",
      });
    }

    // 4. Save Cart Mandate in DB with canonical snapshot hash
    await db.insert(cartMandates).values({
      id: cartMandateId,
      intent_mandate_id: mandateId,
      merchant_id: merchantId,
      quote_expires_at: quoteExpiresAt,
      total_minor: grandTotalMinor,
      currency,
      items: cartItems,
      fulfillment: cartMandateQuote.fulfillment,
      terms: cartMandateQuote.terms,
      content_hash: cartSnapshotHash,
      status: finalPolicyResult.decision === "ALLOW" ? "proposed" : "flagged",
    });

    // 5. Save Policy Decision in DB
    const decisionId = generateId("dec");
    await db.insert(policyDecisions).values({
      id: decisionId,
      intent_mandate_id: mandateId,
      cart_mandate_id: cartMandateId,
      decision: finalPolicyResult.decision,
      reason_codes: finalPolicyResult.reasonCodes,
      decision_json: {
        ...finalPolicyResult,
        cart_snapshot_hash: cartSnapshotHash,
      },
      expires_at: quoteExpiresAt,
    });

    let razorpayOrderId: string | undefined;
    let razorpayKeyId: string | undefined;
    let budgetReservationId: string | undefined;
    let paymentActionId: string | undefined;

    // == COMMENTED OUT: maxAgentTransactionAmount logic ==
    // Over the merchant's configured "set transaction amount" the proposal used
    // to be QUEUED (pending_approval) for later merchant approval. That gate is
    // disabled: every payment now creates a real Razorpay order and opens the
    // Razorpay test checkout window. Payment intents are therefore created for
    // every ALLOW decision.
    // const queuedForApproval =
    //   finalPolicyResult.decision === "STEP_UP" &&
    //   finalPolicyResult.reasonCodes.includes("MERCHANT_LIMIT_EXCEEDED");
    const queuedForApproval = false;
    const createsPaymentIntent =
      finalPolicyResult.decision === "ALLOW" || queuedForApproval;

    // 6. Reserve budget & (for ALLOW or queued-approval) create payment intent
    if (createsPaymentIntent) {
      budgetReservationId = generateId("bres");
      await db.insert(budgetReservations).values({
        id: budgetReservationId,
        intent_mandate_id: mandateId,
        amount_minor: grandTotalMinor,
        status: "reserved",
        expires_at: quoteExpiresAt,
      });

      const preparedPayment = await preparePayment({
        cartMandateId,
        decisionId,
        budgetReservationId,
        traceId,
        allowQueuedApproval: queuedForApproval,
      });

      if (!preparedPayment.order) {
        throw new Error(
          "Unexpected reused payment action during new checkout proposal.",
        );
      }

      razorpayOrderId = preparedPayment.razorpayOrderId;
      razorpayKeyId = preparedPayment.razorpayKeyId;

      paymentActionId = generateId("pact");
      await db.insert(paymentActions).values({
        id: paymentActionId,
        cart_mandate_id: cartMandateId,
        decision_id: decisionId,
        budget_reservation_id: budgetReservationId,
        amount_minor: grandTotalMinor,
        currency,
        // Every ALLOW payment is `pending_payment` until the human completes a
        // real Razorpay test checkout in the browser.
        status: "pending_payment",
        razorpay_order_id: razorpayOrderId,
        provider_metadata: { isMock: preparedPayment.order.isMock },
      });
    }

    // Record campaign discount spend once an order becomes payable, so a
    // campaign's budget cap is consumed authoritatively at payment-intent time
    // and never by quotes that are later abandoned/denied.
    if (createsPaymentIntent) {
      const campaignSpend = new Map<string, number>();
      for (const item of cartItems) {
        if (!item.campaign?.id || item.campaign.discountMinor === undefined) {
          continue;
        }
        const lineDiscount =
          item.campaign.discountMinor * Math.max(1, item.quantity);
        campaignSpend.set(
          item.campaign.id,
          (campaignSpend.get(item.campaign.id) ?? 0) + lineDiscount,
        );
      }
      if (campaignSpend.size > 0) {
        await recordCampaignSpend(
          [...campaignSpend.entries()].map(([campaignId, discountMinor]) => ({
            campaignId,
            discountMinor,
          })),
        );
      }
    }

    // 7. Audit Log
    const isAllowed = finalPolicyResult.decision === "ALLOW";
    const campaignsApplied = cartItems.filter((i) => i.campaign !== undefined);
    const upsellNote = acceptedUpsellOffer
      ? ` Upsell offer ${acceptedUpsellOffer.offerId} accepted (+${acceptedUpsellOffer.addedMinor} minor).`
      : "";
    const campaignNote =
      campaignsApplied.length > 0
        ? ` Campaign discount(s) applied on ${campaignsApplied.length} line(s).`
        : "";
    const auditExplanation = queuedForApproval
      ? `Generated quote ${cartMandateId} for ${currency} ${(grandTotalMinor / 100).toFixed(2)}. Amount exceeds merchant limit — queued for merchant approval. Decision: STEP_UP [MERCHANT_LIMIT_EXCEEDED]. Payment intent ${razorpayOrderId} created (pending approval).`
      : isAllowed
        ? `Generated quote ${cartMandateId} for ${currency} ${(grandTotalMinor / 100).toFixed(2)}. Decision: ${finalPolicyResult.decision}. Razorpay order created: ${razorpayOrderId}${campaignNote}${upsellNote}`
        : `Generated quote ${cartMandateId} for ${currency} ${(grandTotalMinor / 100).toFixed(2)}. Decision: ${finalPolicyResult.decision} [${finalPolicyResult.reasonCodes.join(", ")}]. NO_RAZORPAY_ORDER_CREATED.`;

    await logAuditEvent({
      traceId,
      actorType: "merchant",
      actorId: merchantId,
      eventType: queuedForApproval
        ? "checkout_quote_queued_for_approval"
        : isAllowed
          ? "checkout_quote_generated"
          : "checkout_quote_flagged_or_denied",
      intentMandateId: mandateId,
      cartMandateId,
      decisionId,
      paymentActionId,
      reasonCodes: finalPolicyResult.reasonCodes,
      explanation: auditExplanation,
      metadata: {
        totalMinor: grandTotalMinor,
        itemCount: cartItems.length,
        cartSnapshotHash,
        merchantAgentRules,
        merchantAgentNegotiations: cartItems.map((item) => item.negotiation),
        negotiationSessionId: negotiationSession?.id || null,
        negotiatedDiscountBps: negotiationSession?.currentDiscountBps ?? null,
        razorpayOrderId: razorpayOrderId || null,
        surgeActive,
        queuedForApproval,
        noRazorpayOrderCreated: !createsPaymentIntent,
        campaignsApplied: campaignsApplied.map((i) => ({
          campaignId: i.campaign?.id,
          name: i.campaign?.name,
          discountBps: i.campaign?.discountBps ?? 0,
          quantity: i.quantity,
          lineAmountMinor: i.lineAmountMinor,
          discountMinor: i.campaign?.discountMinor ?? 0,
          variantId: i.variantId,
        })),
        acceptedUpsellOffer,
        rollingBudgetUsageMinor: rollingBudgetUsage.usageMinor,
        agentId: auth.agentId,
        agentAuthMode: auth.mode,
        rateLimitRemaining: auth.rateLimitInfo.remaining,
      },
    });

    return NextResponse.json({
      success: true,
      cartMandate: cartMandateResponse,
      policyEvaluation: {
        decisionId,
        decision: finalPolicyResult.decision,
        reasonCodes: finalPolicyResult.reasonCodes,
        money: finalPolicyResult.money,
        cartSnapshotHash,
        expiresAt: quoteExpiresAt.toISOString(),
      },
      paymentRequired: isAllowed,
      queuedForApproval,
      paymentActionId,
      razorpayOrderId,
      razorpayKeyId,
      surgeActive,
      negotiationSessionId: negotiationSession?.id || null,
      merchantAgentNegotiations: cartItems.map((item) => item.negotiation),
      campaignsApplied: campaignsApplied.map((i) => ({
        variantId: i.variantId,
        campaign: i.campaign,
      })),
      upsell: acceptedUpsellOffer,
      rollingBudgetUsageMinor: rollingBudgetUsage.usageMinor,
      rollingBudgetRemainingMinor:
        finalPolicyResult.money.rollingBudgetRemainingMinor,
      agentAuth: {
        agentId: auth.agentId,
        mode: auth.mode,
        rateLimitRemaining: auth.rateLimitInfo.remaining,
      },
    });
  } catch (error) {
    if (error instanceof CartSnapshotMismatchError) {
      await logAuditEvent({
        traceId,
        actorType: "system",
        actorId: "payment_orchestrator",
        eventType: "security_toctou_violation",
        cartMandateId: error.cartMandateId,
        explanation: "CART_SNAPSHOT_MISMATCH. Razorpay Order not created.",
        metadata: {
          expectedHash: error.expectedHash,
          recomputedHash: error.recomputedHash,
          noRazorpayOrderCreated: true,
        },
      });

      return NextResponse.json(
        {
          success: false,
          error: "CART_SNAPSHOT_MISMATCH",
          decision: "DENY",
          message:
            "Cart changed after policy approval. Razorpay Order not created.",
        },
        { status: 403 },
      );
    }

    console.error("Error generating checkout quote:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Internal server error during checkout",
      },
      { status: 500 },
    );
  }
}
