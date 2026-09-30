import { eq, sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import {
  budgetReservations,
  cartMandates,
  type DbStatement,
  db,
  paymentActions,
  policyDecisions,
  products,
  runTransaction,
  toStatement,
} from "@/db";
import { logAuditEvent } from "@/lib/audit/logger";
import { authorizeSettlement } from "@/lib/auth/settlement-authz";
import { generateCartMandateSnapshotHash } from "@/lib/crypto/canonical";
import { getMerchantContext } from "@/lib/merchant/context";
import { aiSalesPausedResponse } from "@/lib/merchant/guard";
import { SURGE_PRICING_REASON } from "@/lib/merchant/surge";
import {
  CartSnapshotMismatchError,
  preparePayment,
} from "@/lib/payments/orchestrator";
import {
  confirmStripePaymentIntent,
  isStripeLiveMode,
  type StripePaymentResult,
} from "@/lib/payments/stripe";
import { generateId, generateTraceId } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const traceId = generateTraceId();

  try {
    const body = await request.json();
    const { cartMandateId, decisionId, paymentMethod, paymentToken } = body;

    const ALLOWED_PAYMENT_METHODS = [
      "simulated_uap",
      "razorpay_checkout",
      "stripe_card",
      "stripe",
    ];
    // Settlement rails must be named explicitly. This field used to default to
    // "simulated_uap", so a caller that simply omitted it — or sent a typo'd
    // body — silently took the least-guarded branch instead of erroring.
    if (!paymentMethod) {
      return NextResponse.json(
        {
          success: false,
          error: "PAYMENT_METHOD_REQUIRED",
          message: `paymentMethod is required and must be one of: ${ALLOWED_PAYMENT_METHODS.join(", ")}.`,
        },
        { status: 400 },
      );
    }
    if (!ALLOWED_PAYMENT_METHODS.includes(paymentMethod)) {
      return NextResponse.json(
        {
          success: false,
          error: `Unsupported payment method: ${paymentMethod}`,
        },
        { status: 400 },
      );
    }
    const isStripe =
      paymentMethod === "stripe_card" || paymentMethod === "stripe";
    const paymentMethodId = isStripe
      ? String(paymentToken || body.paymentMethodId || "").trim()
      : "";

    // Resolve the merchant context in ONE read: kill-switch + runtime-state
    // hydration + surge state (previously three separate reads/code paths).
    const { context } = await getMerchantContext();

    // GLOBAL KILL-SWITCH: re-checked on every settlement attempt so quotes
    // issued before the merchant paused AI sales can never complete.
    if (!context.aiSalesEnabled) {
      return aiSalesPausedResponse({
        endpoint: "/v1/agent/checkout/confirm",
        cartMandateId,
      });
    }

    // Settlement authorization. Previously `authenticateAgentRequest` was
    // called here and its result discarded — only audit metadata read it — so
    // this endpoint accepted settlements from anyone, and even `AGENT_AUTH_MODE
    // = strict` could not reject them. Discovery stays open; moving money does
    // not. The Agent Sandbox keeps working via the merchant session.
    const authz = await authorizeSettlement(request, context.config);
    if (!authz.ok && authz.response) {
      await logAuditEvent({
        traceId,
        actorType: "system",
        actorId: "settlement_authz",
        eventType: "security_settlement_unauthorized",
        cartMandateId,
        explanation:
          "Rejected settlement attempt: no verified agent API key and no merchant session.",
        metadata: {
          claimedAgentId: authz.agentId,
          paymentMethod,
          remoteIp:
            request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
            null,
        },
      });
      return authz.response;
    }
    const auth = {
      agentId: authz.agentId,
      mode: "demo" as const,
      rateLimitInfo: { ok: true, limit: 0, remaining: 0, retryAfterSeconds: 0 },
    };
    const settlementPrincipal = authz.principal;

    if (!cartMandateId) {
      return NextResponse.json(
        { success: false, error: "cartMandateId is required." },
        { status: 400 },
      );
    }

    // 1. Fetch Cart Mandate
    const [cart] = await db
      .select()
      .from(cartMandates)
      .where(eq(cartMandates.id, cartMandateId))
      .limit(1);

    if (!cart) {
      return NextResponse.json(
        { success: false, error: "Cart mandate not found." },
        { status: 404 },
      );
    }

    // Expiry check
    if (new Date() > new Date(cart.quote_expires_at)) {
      return NextResponse.json(
        {
          success: false,
          error: "Quote has expired. Please request a new quote.",
        },
        { status: 410 },
      );
    }

    // TOCTOU Cart Snapshot Verification Protection
    const [decision] = await db
      .select()
      .from(policyDecisions)
      .where(eq(policyDecisions.cart_mandate_id, cartMandateId))
      .limit(1);

    if (decision) {
      const decisionJson =
        (decision.decision_json as Record<string, unknown>) || {};
      const expectedSnapshotHash =
        (decisionJson.cart_snapshot_hash as string) || cart.content_hash;
      const recomputedHash = generateCartMandateSnapshotHash(cart);

      if (expectedSnapshotHash && recomputedHash !== expectedSnapshotHash) {
        await logAuditEvent({
          traceId,
          actorType: "system",
          actorId: "toctou_guard",
          eventType: "security_toctou_violation",
          cartMandateId,
          decisionId: decision.id,
          explanation: `SECURITY ALERT: Cart snapshot hash mismatch detected during settlement. Cart ${cartMandateId} was modified after policy gate approval. Settlement aborted.`,
          metadata: {
            storedHash: expectedSnapshotHash,
            actualHash: recomputedHash,
            persistedContentHash: cart.content_hash,
            toctouBlocked: true,
            noRazorpayOrderCreated: true,
          },
        });

        return NextResponse.json(
          {
            success: false,
            error: "CART_SNAPSHOT_MISMATCH",
            decision: "DENY",
            message:
              "Cart snapshot mismatch detected. Cart totals or line items were modified after policy gate approval. Settlement aborted.",
          },
          { status: 403 },
        );
      }
    }

    // Surge re-pricing guard: while the merchant's Surge Pricing simulation is
    // active, any in-flight quote that is still `proposed` or has been re-flagged
    // must not settle at the pre-surge price. The merchant must approve the
    // surged price first (which moves the cart to `payment_pending`). Escalating
    // to STEP_UP here — with the explicit SURGE_PRICING_ACTIVE reason — makes the
    // mid-flight re-pricing visible in the buyer's trace as well as the console.
    if (
      context.surgeActive &&
      (cart.status === "proposed" || cart.status === "flagged")
    ) {
      await logAuditEvent({
        traceId,
        actorType: "system",
        actorId: "surge_pricing_guard",
        eventType: "surge_settlement_blocked",
        cartMandateId,
        explanation:
          "Surge pricing is active, so this in-flight transaction was re-priced +15% and escalated to STEP_UP. Settlement blocked until the merchant approves the surged price.",
        metadata: {
          surgeReason: SURGE_PRICING_REASON,
          cartStatusBefore: cart.status,
          blockedAt: new Date().toISOString(),
        },
      });

      return NextResponse.json(
        {
          success: false,
          decision: "STEP_UP",
          reasonCodes: [SURGE_PRICING_REASON],
          explanation:
            "Surge pricing is active. This transaction was re-priced +15% and requires human merchant approval before it can settle.",
          cartMandateId,
          needsReapproval: true,
        },
        { status: 409 },
      );
    }

    // ─── POLICY GATE: settlement requires an ALLOW decision, on EVERY rail ──
    //
    // This check used to live inside the `razorpay_checkout` branch only, so the
    // autonomous Stripe branch and the simulated branch both settled carts the
    // policy engine had refused — leaving TRANSACTION_LIMIT_EXCEEDED,
    // ROLLING_BUDGET_EXHAUSTED, CATEGORY_NOT_ALLOWED, QUANTITY_LIMIT_EXCEEDED
    // and MANDATE_EXPIRED unenforced on two of three rails. The production
    // database held the evidence: completed orders bound to STEP_UP decisions,
    // which is exactly the state that exists to require a human approval.
    //
    // It is hoisted here, above every rail, so the policy engine is genuinely
    // authoritative rather than advisory for the payment half of the protocol.
    if (!decision) {
      return NextResponse.json(
        {
          success: false,
          error: "POLICY_DECISION_MISSING",
          decision: "DENY",
          message:
            "No policy decision is recorded for this cart, so it cannot be settled. Request a new quote.",
          cartMandateId,
        },
        { status: 409 },
      );
    }

    if (decision.decision !== "ALLOW") {
      await logAuditEvent({
        traceId,
        actorType: "system",
        actorId: "policy_gate",
        eventType: "security_unauthorized_settlement_blocked",
        cartMandateId,
        decisionId: decision.id,
        explanation: `SECURITY: settlement refused — the authoritative policy decision is ${decision.decision}, not ALLOW. Reason codes: ${JSON.stringify(decision.reason_codes ?? [])}`,
        metadata: {
          decision: decision.decision,
          paymentMethod,
          reasonCodes: decision.reason_codes ?? [],
          rail: isStripe ? "stripe" : paymentMethod,
        },
      });

      return NextResponse.json(
        {
          success: false,
          error: "TRANSACTION_NOT_AUTHORIZED",
          decision: decision.decision,
          reasonCodes: decision.reason_codes ?? [],
          message: `This cart's policy decision is ${decision.decision}, so no settlement rail can complete it.`,
          cartMandateId,
        },
        { status: 409 },
      );
    }

    // 2. Fetch or create Payment Action
    let [paymentAction] = await db
      .select()
      .from(paymentActions)
      .where(eq(paymentActions.cart_mandate_id, cartMandateId))
      .limit(1);

    // Over-limit transactions are queued for merchant approval. They must NOT
    // settle until the merchant approves them from the console.
    if (paymentAction?.status === "pending_approval") {
      return NextResponse.json(
        {
          success: false,
          status: "pending_approval",
          error: "TRANSACTION_PENDING_MERCHANT_APPROVAL",
          message:
            "This transaction exceeds the merchant's configured limit and is queued for merchant approval. It will settle once approved.",
          paymentActionId: paymentAction.id,
        },
        { status: 202 },
      );
    }

    const simulatedPaymentId = `pay_sim_${generateId()}`;
    const simulatedOrderId = `order_sim_${generateId()}`;

    // Resolve the budget hold for this cart on EVERY path, not only when the
    // payment action is missing.
    //
    // This block used to sit behind `if (!paymentAction)`, yet the id was then
    // consumed as `budgetResId!` in every rail's write transaction. On a replay
    // — the exact case idempotency is supposed to absorb — `budgetResId` was
    // `undefined`, so the non-null assertion was a lie and the insert minted a
    // brand-new reservation under its column DEFAULT. That is how replays
    // silently inflated a buyer's committed 30-day spend.
    //
    // Resolution order: the reservation already bound to this payment action,
    // then the one linked to this cart (cart_mandate_id), then the mandate's
    // only hold. The unique index `uniq_budget_reservation_per_cart` now makes
    // the final INSERT a hard database backstop rather than a soft duplicate.
    const [actionBoundRes] = paymentAction?.budget_reservation_id
      ? await db
          .select()
          .from(budgetReservations)
          .where(eq(budgetReservations.id, paymentAction.budget_reservation_id))
          .limit(1)
      : [];

    const [cartBoundRes] = await db
      .select()
      .from(budgetReservations)
      .where(eq(budgetReservations.cart_mandate_id, cartMandateId))
      .limit(1);

    const [existingRes] =
      (actionBoundRes ?? cartBoundRes)
        ? [actionBoundRes ?? cartBoundRes]
        : await db
            .select()
            .from(budgetReservations)
            .where(
              eq(budgetReservations.intent_mandate_id, cart.intent_mandate_id),
            )
            .limit(1);

    const budgetResId = existingRes?.id || generateId("bres");

    // For a real Razorpay checkout the order must be created before any DB
    // write; for simulated UAP and Stripe the settlement commits in ONE
    // transaction (Stripe confirms the intent inside its own branch above).
    // A stripe-rail quote carries no Razorpay order yet — if the buyer still
    // asks for a razorpay_checkout, create the order here on demand so a real
    // checkout link is always produced.
    let preparedPayment: Awaited<ReturnType<typeof preparePayment>> | undefined;

    if (
      paymentMethod === "razorpay_checkout" &&
      (!paymentAction || !paymentAction.razorpay_order_id)
    ) {
      preparedPayment = await preparePayment({
        cartMandateId,
        decisionId: decision.id,
        budgetReservationId: budgetResId,
        traceId,
      });
    }

    if (isStripe) {
      // ─── AUTONOMOUS STRIPE SETTLEMENT ─────────────────────────────────────
      // The buyer agent presents a payment-method token (test: `pm_card_visa`).
      // The server creates AND confirms a Stripe PaymentIntent in one call.
      // On `succeeded` everything commits atomically (reservation + payment
      // action + cart completion + inventory decrement) — the same single-txn
      // structure as the simulated path, but against real money. Stripe
      // `requires_action`/`processing` intents settle later via the webhook.
      if (!paymentMethodId) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Stripe settlement requires a paymentToken from the buyer agent (test: pm_card_visa).",
            decision: "DENY",
            status: "payment_method_required",
          },
          { status: 400 },
        );
      }

      const alreadySettled = paymentAction?.status === "completed";
      if (alreadySettled) {
        return NextResponse.json({
          success: true,
          status: "completed",
          paymentActionId: paymentAction.id,
          amountMinor: cart.total_minor,
          currency: cart.currency,
          completedAt: paymentAction.updated_at.toISOString(),
          agentAuth: {
            mode: auth.mode,
            agentId: auth.agentId,
            rateLimitRemaining: auth.rateLimitInfo.remaining,
          },
        });
      }

      let intent: StripePaymentResult;
      try {
        intent = await confirmStripePaymentIntent({
          amountMinor: cart.total_minor,
          currency: cart.currency,
          paymentMethodId,
          description: `MerchantGate order ${cartMandateId}`,
          // Stable per cart: a retried confirm resolves to the same
          // PaymentIntent instead of charging the buyer a second time.
          idempotencyKey: `mg_cart_${cartMandateId}`,
          metadata: {
            cartMandateId,
            intentMandateId: cart.intent_mandate_id,
            merchantId: cart.merchant_id,
          },
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Stripe declined the payment.";
        await logAuditEvent({
          traceId,
          actorType: "agent",
          actorId: auth.agentId || "buyer_agent",
          eventType: "payment_settlement_failed",
          cartMandateId,
          explanation: `Stripe PaymentIntent create/confirm failed: ${message}`,
          metadata: { paymentProvider: "stripe", paymentMethodId },
        });
        return NextResponse.json(
          {
            success: false,
            error: "STRIPE_PAYMENT_FAILED",
            message,
            decision: "DENY",
            cartMandateId,
          },
          { status: 402 },
        );
      }

      if (intent.status !== "succeeded") {
        // Deferred settlement (3DS / processing) — persist the pending state so
        // the Stripe webhook can settle it later. Amount is frozen by the cart.
        const st = paymentAction ?? {
          id: generateId("pact"),
          cart_mandate_id: cartMandateId,
          decision_id: decision?.id || decisionId || generateId("dec"),
          budget_reservation_id: budgetResId,
          amount_minor: cart.total_minor,
          currency: cart.currency,
          status: "pending_payment" as const,
          razorpay_order_id: intent.id,
          razorpay_payment_id: null,
          provider_metadata: {},
          created_at: new Date(),
          updated_at: new Date(),
        };

        await runTransaction([
          ...(!existingRes && !paymentAction
            ? [
                toStatement(
                  db.insert(budgetReservations).values({
                    id: budgetResId,
                    cart_mandate_id: cartMandateId,
                    intent_mandate_id: cart.intent_mandate_id,
                    amount_minor: cart.total_minor,
                    status: "reserved",
                    expires_at: cart.quote_expires_at,
                  }),
                ),
              ]
            : []),
          toStatement(
            paymentAction
              ? db
                  .update(paymentActions)
                  .set({
                    status: "pending_payment",
                    razorpay_order_id: intent.id,
                    provider_metadata: {
                      ...((paymentAction.provider_metadata as Record<
                        string,
                        unknown
                      >) || {}),
                      provider: "stripe",
                      method: "stripe_card",
                      paymentIntentId: intent.id,
                      clientSecret: intent.clientSecret || null,
                    },
                    updated_at: new Date(),
                  })
                  .where(eq(paymentActions.id, paymentAction.id))
              : db.insert(paymentActions).values({
                  id: st.id,
                  cart_mandate_id: st.cart_mandate_id,
                  decision_id: st.decision_id,
                  budget_reservation_id: st.budget_reservation_id,
                  amount_minor: st.amount_minor,
                  currency: st.currency,
                  status: "pending_payment",
                  razorpay_order_id: st.razorpay_order_id,
                  razorpay_payment_id: st.razorpay_payment_id,
                  provider_metadata: {
                    provider: "stripe",
                    method: "stripe_card",
                    paymentIntentId: intent.id,
                    clientSecret: intent.clientSecret || null,
                  },
                }),
          ),
          toStatement(
            db
              .update(cartMandates)
              .set({ status: "payment_pending" })
              .where(eq(cartMandates.id, cartMandateId)),
          ),
        ]);

        return NextResponse.json({
          success: false,
          status: intent.status,
          requiresClientAction: intent.status === "requires_action",
          paymentIntentId: intent.id,
          clientSecret: intent.clientSecret || null,
          amountMinor: cart.total_minor,
          currency: cart.currency,
          cartMandateId,
          agentAuth: {
            mode: auth.mode,
            agentId: auth.agentId,
          },
        });
      }

      // ─── succeeded: atomic settlement ──────────────────────────────────────
      const items =
        (cart.items as Array<{ variantId: string; quantity: number }>) || [];
      const stripePaymentId = intent.chargeId || intent.id;
      // Provenance of THIS settlement: whether it reached Stripe, and which
      // dashboard it lives under. Persisted so the Orders ledger can label a
      // `pi_sim_…` row as simulated and deep-link a real `pi_…` row correctly.
      const liveMode = !intent.isMock && isStripeLiveMode();
      const pa = paymentAction ?? {
        id: generateId("pact"),
        cart_mandate_id: cartMandateId,
        decision_id: decision?.id || decisionId || generateId("dec"),
        budget_reservation_id: budgetResId,
        amount_minor: cart.total_minor,
        currency: cart.currency,
        status: "pending_payment" as const,
        razorpay_order_id: null,
        razorpay_payment_id: null,
        provider_metadata: {},
        created_at: new Date(),
        updated_at: new Date(),
      };
      const paId = pa.id;

      const statements: DbStatement[] = [
        ...(!existingRes && !paymentAction
          ? [
              toStatement(
                db.insert(budgetReservations).values({
                  id: budgetResId,
                  cart_mandate_id: cartMandateId,
                  intent_mandate_id: cart.intent_mandate_id,
                  amount_minor: cart.total_minor,
                  status: "reserved",
                  expires_at: cart.quote_expires_at,
                }),
              ),
            ]
          : []),
        toStatement(
          paymentAction
            ? db
                .update(paymentActions)
                .set({
                  status: "completed",
                  razorpay_order_id: intent.id,
                  razorpay_payment_id: stripePaymentId,
                  provider_metadata: {
                    ...((paymentAction.provider_metadata as Record<
                      string,
                      unknown
                    >) || {}),
                    provider: "stripe",
                    method: "stripe_card",
                    paymentIntentId: intent.id,
                    chargeId: stripePaymentId,
                    isMock: intent.isMock,
                    liveMode,
                  },
                  updated_at: new Date(),
                })
                .where(eq(paymentActions.id, paId))
            : db.insert(paymentActions).values({
                id: paId,
                cart_mandate_id: pa.cart_mandate_id,
                decision_id: pa.decision_id,
                budget_reservation_id: pa.budget_reservation_id,
                amount_minor: pa.amount_minor,
                currency: pa.currency,
                status: "completed",
                razorpay_order_id: intent.id,
                razorpay_payment_id: stripePaymentId,
                provider_metadata: {
                  provider: "stripe",
                  method: "stripe_card",
                  paymentIntentId: intent.id,
                  chargeId: stripePaymentId,
                  isMock: intent.isMock,
                  liveMode,
                },
              }),
        ),
        toStatement(
          db
            .update(cartMandates)
            .set({ status: "completed" })
            .where(eq(cartMandates.id, cartMandateId)),
        ),
        ...(items.length > 0 && !alreadySettled
          ? [
              toStatement(
                db
                  .update(products)
                  .set({
                    stock_quantity: sql`GREATEST(0, ${products.stock_quantity} - data.qty)`,
                  })
                  .from(
                    sql`(VALUES ${sql.join(
                      items.map(
                        (i) =>
                          sql`(${i.variantId}::text, ${i.quantity}::bigint)`,
                      ),
                      sql.raw(", "),
                    )}) AS data(variant_id, qty)`,
                  )
                  .where(sql`${products.variant_id} = data.variant_id`),
              ),
            ]
          : []),
      ];
      await runTransaction(statements);

      await logAuditEvent({
        traceId,
        actorType: "agent",
        actorId: auth.agentId || "buyer_agent",
        eventType: "payment_settled",
        cartMandateId,
        decisionId,
        paymentActionId: paId,
        explanation: `Autonomous Stripe payment of ${cart.currency} ${(cart.total_minor / 100).toFixed(2)} completed by buyer agent. PaymentIntent ${intent.id} confirmed server-side (${
          intent.isMock ? "simulated" : "real Stripe test charge"
        }).`,
        providerRefs: {
          stripePaymentIntent: intent.id,
          stripeChargeId: stripePaymentId,
          method: "stripe_card",
        },
        metadata: {
          paymentProvider: "stripe",
          agentAuthMode: auth.mode,
          rateLimitRemaining: auth.rateLimitInfo.remaining,
          isMock: intent.isMock,
          liveMode,
        },
      });

      return NextResponse.json({
        success: true,
        paymentActionId: paId,
        status: "completed",
        paymentIntentId: intent.id,
        chargeId: stripePaymentId,
        razorpayOrderId: intent.id,
        razorpayPaymentId: stripePaymentId,
        amountMinor: cart.total_minor,
        currency: cart.currency,
        // Provenance, so a buyer agent (and the dashboard) never has to guess
        // whether this settlement exists at Stripe or was faked by the offline
        // fallback. `isMock: true` means NO Stripe object was created.
        isMock: intent.isMock,
        liveMode,
        stripeDashboardUrl: intent.isMock
          ? null
          : `https://dashboard.stripe.com/${liveMode ? "" : "test/"}payments/${intent.id}`,
        completedAt: new Date().toISOString(),
        expiresAt: cart.quote_expires_at.toISOString(),
        agentAuth: {
          mode: auth.mode,
          agentId: auth.agentId,
          rateLimitRemaining: auth.rateLimitInfo.remaining,
        },
      });
    }

    if (paymentMethod === "simulated_uap") {
      // Simulated settlement: reservation (if absent) + payment action +
      // cart completion + inventory decrement in ONE atomic request.
      // Inventory is decremented with one batched UPDATE ... FROM (VALUES ...)
      // instead of an UPDATE-per-line-item loop (N+1 → 1).
      const settlementExisted = Boolean(paymentAction);
      if (!settlementExisted) {
        paymentAction = {
          id: generateId("pact"),
          cart_mandate_id: cartMandateId,
          // Always bind to the cart's authoritative policy decision (read
          // from the DB earlier), never a client-supplied decision id.
          decision_id: decision?.id || decisionId || generateId("dec"),
          budget_reservation_id: budgetResId,
          amount_minor: cart.total_minor,
          currency: cart.currency,
          status: "completed",
          razorpay_order_id: simulatedOrderId,
          razorpay_payment_id: simulatedPaymentId,
          provider_metadata: { method: "simulated_uap" },
          created_at: new Date(),
          updated_at: new Date(),
        };
      } else {
        paymentAction = {
          ...paymentAction,
          status: "completed",
          razorpay_payment_id: simulatedPaymentId,
          updated_at: new Date(),
        };
      }
      const pa = paymentAction as NonNullable<typeof paymentAction>;

      const items =
        (cart.items as Array<{ variantId: string; quantity: number }>) || [];

      const statements: DbStatement[] = [
        ...(!existingRes
          ? [
              toStatement(
                db.insert(budgetReservations).values({
                  id: budgetResId,
                  cart_mandate_id: cartMandateId,
                  intent_mandate_id: cart.intent_mandate_id,
                  amount_minor: cart.total_minor,
                  status: "reserved",
                  expires_at: cart.quote_expires_at,
                }),
              ),
            ]
          : []),
        toStatement(
          settlementExisted
            ? db
                .update(paymentActions)
                .set({
                  status: "completed",
                  razorpay_payment_id: simulatedPaymentId,
                  updated_at: new Date(),
                })
                .where(eq(paymentActions.id, pa.id))
            : db.insert(paymentActions).values({
                id: pa.id,
                cart_mandate_id: pa.cart_mandate_id,
                decision_id: pa.decision_id,
                budget_reservation_id: pa.budget_reservation_id,
                amount_minor: pa.amount_minor,
                currency: pa.currency,
                status: "completed",
                razorpay_order_id: pa.razorpay_order_id,
                razorpay_payment_id: pa.razorpay_payment_id,
                provider_metadata: pa.provider_metadata,
              }),
        ),
        toStatement(
          db
            .update(cartMandates)
            .set({ status: "completed" })
            .where(eq(cartMandates.id, cartMandateId)),
        ),
        // Inventory is a once-per-cart side effect. This guard was missing on
        // the simulated rail — it fired purely on `items.length` — so replaying
        // `simulated_uap` against a completed cart decremented stock again every
        // time, and the damage compounded because `GREATEST(0, …)` silently
        // clamped at zero instead of failing. The Stripe branch already had the
        // equivalent `!alreadySettled` guard.
        ...(items.length > 0 && !settlementExisted
          ? [
              toStatement(
                db
                  .update(products)
                  .set({
                    stock_quantity: sql`GREATEST(0, ${products.stock_quantity} - data.qty)`,
                  })
                  .from(
                    sql`(VALUES ${sql.join(
                      items.map(
                        (i) =>
                          sql`(${i.variantId}::text, ${i.quantity}::bigint)`,
                      ),
                      sql.raw(", "),
                    )}) AS data(variant_id, qty)`,
                  )
                  .where(sql`${products.variant_id} = data.variant_id`),
              ),
            ]
          : []),
      ];
      await runTransaction(statements);

      // Log Audit Event
      await logAuditEvent({
        traceId,
        actorType: "agent",
        actorId: auth.agentId || "simulated_buyer",
        eventType: "payment_settled",
        cartMandateId,
        decisionId,
        paymentActionId: paymentAction.id,
        explanation: `Simulated UAP payment of ${cart.currency} ${(cart.total_minor / 100).toFixed(2)} completed successfully.`,
        providerRefs: {
          razorpayPaymentId: simulatedPaymentId,
          method: "simulated_uap",
        },
        metadata: {
          agentAuthMode: auth.mode,
          rateLimitRemaining: auth.rateLimitInfo.remaining,
          settlementPrincipal,
        },
      });

      return NextResponse.json({
        success: true,
        paymentActionId: paymentAction.id,
        status: "completed",
        razorpayOrderId: paymentAction.razorpay_order_id || simulatedOrderId,
        razorpayPaymentId: simulatedPaymentId,
        amountMinor: cart.total_minor,
        currency: cart.currency,
        completedAt: new Date().toISOString(),
        expiresAt: cart.quote_expires_at.toISOString(),
        agentAuth: {
          mode: auth.mode,
          agentId: auth.agentId,
          rateLimitRemaining: auth.rateLimitInfo.remaining,
        },
      });
    }

    // Human present / Razorpay Checkout. Order creation is NEVER treated as
    // payment: creating/returning the Razorpay order only moves the order to
    // `payment_pending`. It becomes `completed` (paid) exclusively via a
    // verified webhook/payment capture.
    const razorpayPaymentExisted = Boolean(paymentAction);
    const attachOrderToExisting =
      razorpayPaymentExisted && !paymentAction!.razorpay_order_id;
    if (!razorpayPaymentExisted) {
      paymentAction = {
        id: generateId("pact"),
        cart_mandate_id: cartMandateId,
        decision_id: decision?.id || decisionId || generateId("dec"),
        budget_reservation_id: budgetResId,
        amount_minor: cart.total_minor,
        currency: cart.currency,
        status: "pending_payment",
        razorpay_order_id: preparedPayment!.razorpayOrderId,
        razorpay_payment_id: null,
        provider_metadata: {
          method: paymentMethod,
          razorpayKeyId: preparedPayment!.razorpayKeyId,
        },
        created_at: new Date(),
        updated_at: new Date(),
      };
    } else if (attachOrderToExisting) {
      paymentAction = {
        ...paymentAction!,
        razorpay_order_id: preparedPayment!.razorpayOrderId,
        razorpay_payment_id: null,
        provider_metadata: {
          method: paymentMethod,
          razorpayKeyId: preparedPayment!.razorpayKeyId,
        },
        updated_at: new Date(),
      };
    }
    const rp = paymentAction as NonNullable<typeof paymentAction>;

    await runTransaction([
      ...(!existingRes
        ? [
            toStatement(
              db.insert(budgetReservations).values({
                id: budgetResId,
                cart_mandate_id: cartMandateId,
                intent_mandate_id: cart.intent_mandate_id,
                amount_minor: cart.total_minor,
                status: "reserved",
                expires_at: cart.quote_expires_at,
              }),
            ),
          ]
        : []),
      ...(!razorpayPaymentExisted
        ? [
            toStatement(
              db.insert(paymentActions).values({
                id: rp.id,
                cart_mandate_id: rp.cart_mandate_id,
                decision_id: rp.decision_id,
                budget_reservation_id: rp.budget_reservation_id,
                amount_minor: rp.amount_minor,
                currency: rp.currency,
                status: "pending_payment",
                razorpay_order_id: rp.razorpay_order_id,
                razorpay_payment_id: rp.razorpay_payment_id,
                provider_metadata: rp.provider_metadata,
              }),
            ),
          ]
        : []),
      ...(attachOrderToExisting
        ? [
            toStatement(
              db
                .update(paymentActions)
                .set({
                  razorpay_order_id: rp.razorpay_order_id,
                  razorpay_payment_id: rp.razorpay_payment_id,
                  provider_metadata: rp.provider_metadata,
                  updated_at: new Date(),
                })
                .where(eq(paymentActions.id, rp.id)),
            ),
          ]
        : []),
      toStatement(
        db
          .update(cartMandates)
          .set({ status: "payment_pending" })
          .where(eq(cartMandates.id, cartMandateId)),
      ),
    ]);

    return NextResponse.json({
      success: true,
      paymentActionId: paymentAction.id,
      status: "payment_pending",
      razorpayOrderId: paymentAction.razorpay_order_id || "",
      razorpayKeyId:
        ((paymentAction.provider_metadata as Record<string, unknown> | null)
          ?.razorpayKeyId as string | undefined) ||
        process.env.RAZORPAY_KEY_ID ||
        "rzp_test_simulated_key",
      amountMinor: cart.total_minor,
      currency: cart.currency,
      expiresAt: cart.quote_expires_at.toISOString(),
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

    console.error("Error in checkout confirm:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      {
        success: false,
        error: `Internal server error confirming checkout: ${message}`,
      },
      { status: 500 },
    );
  }
}
