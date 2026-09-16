import { eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  LineItemError,
  type PriceableProduct,
  priceCart,
  sanitizeMandate,
  validateCart,
} from "@/core/pricing";
import {
  budgetReservations,
  cartMandates,
  db,
  intentMandates,
  isSerializationConflict,
  paymentActions,
  policyDecisions,
  products,
  runTransaction,
  toStatement,
} from "@/db";
import { logAuditEvent } from "@/lib/audit/logger";
import { authenticateAgentRequest } from "@/lib/auth/agent-auth";
import { generateCartMandateSnapshotHash } from "@/lib/crypto/canonical";
import { getMerchantAgentRules } from "@/lib/merchant/agent";
import {
  getActiveCampaigns,
  recordCampaignSpend,
} from "@/lib/merchant/campaigns";
import { getMerchantContext } from "@/lib/merchant/context";
import { aiSalesPausedResponse } from "@/lib/merchant/guard";
import { getAgreedNegotiationForCheckout } from "@/lib/merchant/negotiation";
import { SURGE_PRICING_REASON } from "@/lib/merchant/surge";
import {
  getUpsellRules,
  type MarketBasketRecord,
  resolveUpsellOffer,
  type UpsellCartItem,
  type UpsellCatalogItem,
} from "@/lib/merchant/upsell";
import { logger } from "@/lib/observability/logger";
import {
  CartSnapshotMismatchError,
  preparePayment,
} from "@/lib/payments/orchestrator";
import { getRollingBudgetUsage } from "@/lib/policy/budget";
import { evaluatePolicy, type IntentMandate } from "@/lib/policy/engine";
import { generateId, generateTraceId } from "@/lib/utils";

export const dynamic = "force-dynamic";

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

    // Resolve the acting merchant context in ONE read: row + runtime-state
    // hydration + kill-switch + surge state (previously 2–3 separate reads).
    const { context } = await getMerchantContext();
    const merchantId = context.merchantId;
    const surgeActive = context.surgeActive;

    if (!context.aiSalesEnabled) {
      return aiSalesPausedResponse({ endpoint: "/v1/agent/checkout" });
    }
    const merchantConfig = context.config;
    const merchantAgentRules = getMerchantAgentRules(merchantConfig);

    // Agent authentication + rate limiting (C7). Rejects unauthenticated money
    // requests in strict mode; throttles everywhere.
    const auth = await authenticateAgentRequest(request, { merchantConfig });
    if (!auth.ok && auth.response) return auth.response;

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

    const mandateId = intentMandateId || clientMandate?.id || generateId("int");
    const upsellRules = getUpsellRules(merchantConfig);

    // The buyer's refundability requirement must shape which cross-sell items
    // are offered: a mandate requiring refundable goods never sees a
    // non-returnable upsell (policy would otherwise hard-DENY the merged cart
    // with NON_REFUNDABLE_ITEM_DISALLOWED). The stored mandate is fetched ONCE
    // here (previously up to 3× in the same request) and reused below for the
    // policy resolution.
    let requiresRefundable = true;
    let dbMandate: typeof intentMandates.$inferSelect | undefined;
    if (clientMandate) {
      requiresRefundable =
        (clientMandate as IntentMandate).constraints?.requiresRefundability ??
        true;
    } else if (intentMandateId) {
      [dbMandate] = await db
        .select()
        .from(intentMandates)
        .where(eq(intentMandates.id, intentMandateId))
        .limit(1);
      requiresRefundable =
        (dbMandate?.mandate_json as IntentMandate | null)?.constraints
          ?.requiresRefundability ?? true;
    }

    // Fetch everything the cart needs in parallel: the catalogue, active
    // campaigns (no-op while surge is pricing UP), committed spend for the
    // rolling 30-day budget, and the historical baskets that power upsell.
    const upsellNeedsBaskets = Boolean(
      upsellOfferId && !surgeActive && upsellRules.enabled,
    );
    const [catalogue, campaigns, rollingBudgetUsage, upsellBaskets] =
      await Promise.all([
        db.select().from(products),
        surgeActive ? Promise.resolve([]) : getActiveCampaigns(),
        getRollingBudgetUsage(mandateId),
        upsellNeedsBaskets ? loadUpsellMarketBaskets() : Promise.resolve([]),
      ]);

    const productMap: Map<string, PriceableProduct> = new Map(
      catalogue.map((p) => [
        p.variant_id,
        { ...p, attributes: (p.attributes as Record<string, unknown>) || {} },
      ]),
    );

    // Optional: accept a bounded upsell offer by its id (A1). Re-resolves the
    // offer deterministically against the same catalogue, so a buyer can only
    // ever add items the merchant priced at quote time.
    let acceptedUpsellOffer: {
      offerId: string;
      items: number;
      addedMinor: number;
    } | null = null;

    if (upsellOfferId && !surgeActive && upsellRules.enabled) {
      const cartSummary: UpsellCartItem[] = requestedItems.reduce<
        UpsellCartItem[]
      >((acc, item) => {
        const p = productMap.get(item.variantId);
        if (p) {
          acc.push({
            variantId: p.variant_id,
            category: p.category,
            title: p.title,
            quantity: Math.max(1, Number(item.quantity) || 1),
            unitAmountMinor: p.base_price_minor,
          });
        }
        return acc;
      }, []);

      const marketBaskets: MarketBasketRecord[] = upsellBaskets.map((b) => ({
        agentId: String(b.agentId),
        variantIds: (b.items || []).map((i) => i.variantId),
      }));

      const catalog: UpsellCatalogItem[] = catalogue.map((p) => ({
        variantId: p.variant_id,
        title: p.title,
        category: p.category,
        unitAmountMinor: p.base_price_minor,
        stockQuantity: p.stock_quantity,
        returnable: p.returnable,
        attributes: (p.attributes as Record<string, unknown>) || {},
      }));

      const offerItems = resolveUpsellOffer({
        cart: cartSummary,
        catalog,
        rules: upsellRules,
        marketBaskets,
        upsellOfferId,
        requiresRefundable,
      });

      if (offerItems) {
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

    // Fail fast on availability/quantity BEFORE any pricing work, with the
    // same error contract as before.
    try {
      validateCart(requestedItems, productMap);
    } catch (e) {
      if (!(e instanceof LineItemError)) throw e;
      const status = e.code === "PRODUCT_VARIANT_NOT_FOUND" ? 404 : 400;
      const message =
        e.code === "PRODUCT_VARIANT_NOT_FOUND"
          ? `Product variant not found: ${e.title}`
          : e.code === "INVALID_QUANTITY"
            ? `Invalid quantity for ${e.title}. Quantity must be a whole number between 1 and 1,000,000.`
            : `Insufficient inventory for ${e.title}. Available: ${e.available}`;
      return NextResponse.json({ success: false, error: message }, { status });
    }

    // Price the merged cart line-by-line. Pure, deterministic — surge,
    // campaigns and negotiated terms are folded in here.
    const cart = priceCart(requestedItems, {
      productMap,
      surgeActive,
      campaigns,
      rules: merchantAgentRules,
      negotiatedTerms,
      negotiationSession,
    });

    const { lines: cartItems, totals } = cart;
    const grandTotalMinor = totals.grandTotalMinor;
    const currency = catalogue[0]?.currency || "INR";

    // 2. Fetch or prepare Intent Mandate (reuses the single read above)
    let resolvedMandate: IntentMandate | null = null;

    if (clientMandate) {
      resolvedMandate = clientMandate;
    } else if (dbMandate) {
      resolvedMandate = dbMandate.mandate_json as IntentMandate;
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
    resolvedMandate = sanitizeMandate(resolvedMandate as IntentMandate);

    const quoteIssuedAt = new Date();
    const quoteExpiresAt = new Date(quoteIssuedAt.getTime() + 15 * 60 * 1000); // 15 min freeze

    const cartMandateQuote = {
      merchantId,
      items: cartItems,
      totals: {
        ...totals,
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
    const decisionId = generateId("dec");

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

    // The intent mandate is upserted idempotently (no pre-read existence check).
    const intentMandateInsert = {
      id: mandateId,
      user_id: resolvedMandate?.principal?.userId || "user_demo",
      agent_id: resolvedMandate?.delegate?.agentId || "agt_apollo_buyer_v1",
      mandate_json: resolvedMandate,
      max_transaction_minor:
        resolvedMandate?.constraints?.maxTransactionAmountMinor || 500000,
      currency,
      validity_expires_at: new Date(
        resolvedMandate?.validity?.expiresAt || Date.now() + 86400000,
      ),
      status: "active",
    };

    const decisionInsert = {
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
    };

    let razorpayOrderId: string | undefined;
    let razorpayKeyId: string | undefined;
    let budgetReservationId: string | undefined;
    let paymentActionId: string | undefined;

    // Every payment now creates a real Razorpay order and opens the Razorpay
    // test checkout window. Payment intents are therefore created for every
    // ALLOW decision.
    const queuedForApproval = false;
    const createsPaymentIntent =
      finalPolicyResult.decision === "ALLOW" || queuedForApproval;

    // 6. Reserve budget & (for ALLOW) create payment intent. The Razorpay order
    // is created against the rows we are about to persist — they are passed in
    // memory so preparePayment needs NO re-reads (-3 round-trips) — then the
    // whole checkout commit is one transaction.
    if (createsPaymentIntent) {
      budgetReservationId = generateId("bres");

      const knownCart = {
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
        status: "flagged" as const,
      } as unknown as typeof cartMandates.$inferSelect;
      const knownDecision = {
        ...decisionInsert,
        created_at: new Date(),
      } as unknown as typeof policyDecisions.$inferSelect;

      const preparedPayment = await preparePayment({
        cartMandateId,
        decisionId,
        budgetReservationId,
        traceId,
        allowQueuedApproval: queuedForApproval,
        knownCart,
        knownDecision,
      });

      if (!preparedPayment.order) {
        throw new Error(
          "Unexpected reused payment action during new checkout proposal.",
        );
      }

      razorpayOrderId = preparedPayment.razorpayOrderId;
      razorpayKeyId = preparedPayment.razorpayKeyId;
      paymentActionId = generateId("pact");

      // Compile every write (mandate upsert, cart, decision, reservation,
      // payment action) into one ATOMIC transaction over a single HTTP request.
      // The DB trigger `enforce_rolling_budget` re-checks the mandate's 30-day
      // ceiling inside this transaction (roll-back on violation), and
      // SERIALIZABLE isolation aborts one side of any concurrent checkout race
      // (SQLSTATE 40001) — the batch is retried because every id is generated
      // in advance and `intentMandates` upserts with ON CONFLICT DO NOTHING.
      let checkoutCommitted = false;
      for (let attempt = 1; attempt <= 3 && !checkoutCommitted; attempt++) {
        try {
          await runTransaction([
            toStatement(
              db
                .insert(intentMandates)
                .values(intentMandateInsert)
                .onConflictDoNothing(),
            ),
            toStatement(
              db.insert(cartMandates).values({
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
                status: "proposed",
              }),
            ),
            toStatement(db.insert(policyDecisions).values(knownDecision)),
            toStatement(
              db.insert(budgetReservations).values({
                id: budgetReservationId,
                intent_mandate_id: mandateId,
                amount_minor: grandTotalMinor,
                status: "reserved",
                expires_at: quoteExpiresAt,
              }),
            ),
            toStatement(
              db.insert(paymentActions).values({
                id: paymentActionId!,
                cart_mandate_id: cartMandateId,
                decision_id: decisionId,
                budget_reservation_id: budgetReservationId!,
                amount_minor: grandTotalMinor,
                currency,
                // Every ALLOW payment is `pending_payment` until the human completes a
                // real Razorpay test checkout in the browser.
                status: "pending_payment",
                razorpay_order_id: razorpayOrderId!,
                provider_metadata: { isMock: preparedPayment.order.isMock },
              }),
            ),
          ]);
          checkoutCommitted = true;
        } catch (error) {
          // Concurrent checkout race: retry. The re-run computes new usage and
          // the trigger decides — commit, or raise ROLLING_BUDGET_EXHAUSTED.
          if (isSerializationConflict(error) && attempt < 3) continue;
          throw error;
        }
      }
    } else {
      // DENY path: persist mandate, cart + decision atomically.
      await runTransaction([
        toStatement(
          db
            .insert(intentMandates)
            .values(intentMandateInsert)
            .onConflictDoNothing(),
        ),
        toStatement(
          db.insert(cartMandates).values({
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
            status: "flagged",
          }),
        ),
        toStatement(db.insert(policyDecisions).values(decisionInsert)),
      ]);
    }

    // Record campaign discount spend once an order becomes payable, so a
    // campaign's budget cap is consumed authoritatively at payment-intent time
    // and never by quotes that are later abandoned/denied. Batched into a
    // single UPDATE ... FROM (VALUES ...) round-trip.
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

    // The DB trigger refused the reservation because concurrent commits pushed
    // this mandate past its rolling-30-day ceiling. Surface it as a hard DENY
    // (a `ROLLING_BUDGET_EXHAUSTED` response, never a 500).
    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      String((error as { message: string }).message).includes(
        "ROLLING_BUDGET_EXHAUSTED",
      )
    ) {
      await logAuditEvent({
        traceId,
        actorType: "system",
        actorId: "payment_orchestrator",
        eventType: "rolling_budget_rejected_at_commit",
        reasonCodes: ["ROLLING_BUDGET_EXHAUSTED"],
        explanation:
          "Commit-time rolling-budget guard fired: concurrent reservations exhausted the mandate's 30-day ceiling.",
      });
      return NextResponse.json(
        {
          success: false,
          error: "ROLLING_BUDGET_EXHAUSTED",
          decision: "DENY",
          message:
            "The mandate's rolling 30-day budget is exhausted (concurrent commits accounted).",
        },
        { status: 409 },
      );
    }

    logger.error("checkout.quote_failed", {
      traceId,
      event: "checkout_quote_failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      {
        success: false,
        error: "Internal server error during checkout",
      },
      { status: 500 },
    );
  }
}

/** Completed carts + their items in ONE join (previously two sequential reads). */
async function loadUpsellMarketBaskets(): Promise<
  Array<{ agentId: string; items: Array<{ variantId: string }> }>
> {
  const rows = await db
    .select({
      agentId: cartMandates.intent_mandate_id,
      items: cartMandates.items,
    })
    .from(paymentActions)
    .innerJoin(
      cartMandates,
      eq(cartMandates.id, paymentActions.cart_mandate_id),
    )
    .where(inArray(paymentActions.status, ["completed"]))
    .limit(100);

  return rows.map((r) => ({
    agentId: String(r.agentId),
    items: (r.items as Array<{ variantId: string }>) || [],
  }));
}
