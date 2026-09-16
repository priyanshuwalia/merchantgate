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
import { authenticateAgentRequest } from "@/lib/auth/agent-auth";
import { generateCartMandateSnapshotHash } from "@/lib/crypto/canonical";
import { getMerchantContext } from "@/lib/merchant/context";
import { aiSalesPausedResponse } from "@/lib/merchant/guard";
import { SURGE_PRICING_REASON } from "@/lib/merchant/surge";
import {
  CartSnapshotMismatchError,
  preparePayment,
} from "@/lib/payments/orchestrator";
import { generateId, generateTraceId } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const traceId = generateTraceId();

  try {
    const body = await request.json();
    const { cartMandateId, decisionId, paymentMethod = "simulated_uap" } = body;

    const ALLOWED_PAYMENT_METHODS = ["simulated_uap", "razorpay_checkout"];
    if (!ALLOWED_PAYMENT_METHODS.includes(paymentMethod)) {
      return NextResponse.json(
        {
          success: false,
          error: `Unsupported payment method: ${paymentMethod}`,
        },
        { status: 400 },
      );
    }

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

    // Agent authentication + rate limiting (C7). In `demo` mode a missing or
    // invalid key is tolerated; in `strict` mode it is rejected outright.
    const auth = await authenticateAgentRequest(request);

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

    let budgetResId: string | undefined;
    let reservationExists = false;

    if (!paymentAction) {
      // Create budget reservation if missing
      const [existingRes] = await db
        .select()
        .from(budgetReservations)
        .where(eq(budgetReservations.intent_mandate_id, cart.intent_mandate_id))
        .limit(1);

      budgetResId = existingRes?.id || generateId("bres");
      reservationExists = Boolean(existingRes);
    }

    // For a real Razorpay checkout the order must be created before any DB
    // write; for simulated UAP the whole settlement commits in ONE transaction.
    let preparedPayment: Awaited<ReturnType<typeof preparePayment>> | undefined;

    if (!paymentAction && paymentMethod !== "simulated_uap") {
      if (!decision?.id) {
        return NextResponse.json(
          {
            success: false,
            error: "Policy decision is required before payment preparation.",
          },
          { status: 400 },
        );
      }

      // A payment intent can only be created for an ALLOW decision. A DENY /
      // STEP_UP cart carries no payment authorization — reject cleanly
      // instead of failing deep in preparePayment with a 500.
      if (decision.decision !== "ALLOW") {
        return NextResponse.json(
          {
            success: false,
            error: "TRANSACTION_NOT_AUTHORIZED",
            decision: decision.decision,
            message: `This cart's policy decision is ${decision.decision}, so no payment order can be created.`,
          },
          { status: 409 },
        );
      }

      preparedPayment = await preparePayment({
        cartMandateId,
        decisionId: decision.id,
        budgetReservationId: budgetResId!,
        traceId,
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
          budget_reservation_id: budgetResId!,
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
        ...(!reservationExists
          ? [
              toStatement(
                db.insert(budgetReservations).values({
                  id: budgetResId!,
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
        ...(items.length > 0
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
                    )}) AS data(variant_id text, qty bigint)`,
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
    if (!razorpayPaymentExisted) {
      paymentAction = {
        id: generateId("pact"),
        cart_mandate_id: cartMandateId,
        decision_id: decision?.id || decisionId || generateId("dec"),
        budget_reservation_id: budgetResId!,
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
    }
    const rp = paymentAction as NonNullable<typeof paymentAction>;

    await runTransaction([
      ...(!reservationExists
        ? [
            toStatement(
              db.insert(budgetReservations).values({
                id: budgetResId!,
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
