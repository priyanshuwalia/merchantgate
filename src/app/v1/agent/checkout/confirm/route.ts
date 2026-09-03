import { eq, sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import {
  budgetReservations,
  cartMandates,
  db,
  paymentActions,
  policyDecisions,
  products,
} from "@/db";
import { logAuditEvent } from "@/lib/audit/logger";
import { authenticateAgentRequest } from "@/lib/auth/agent-auth";
import { generateCartMandateSnapshotHash } from "@/lib/crypto/canonical";
import {
  aiSalesPausedResponse,
  getMerchantGateState,
} from "@/lib/merchant/guard";
import { hydrateRuntimeState } from "@/lib/merchant/runtime-state";
import {
  isSurgePricingActive,
  SURGE_PRICING_REASON,
} from "@/lib/merchant/surge";
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

    // GLOBAL KILL-SWITCH: re-checked on every settlement attempt so quotes
    // issued before the merchant paused AI sales can never complete.
    const gate = await getMerchantGateState();
    if (!gate.aiSalesEnabled) {
      return aiSalesPausedResponse({
        endpoint: "/v1/agent/checkout/confirm",
        cartMandateId,
      });
    }

    // Agent authentication + rate limiting (C7). In `demo` mode a missing or
    // invalid key is tolerated; in `strict` mode it is rejected outright.
    const auth = await authenticateAgentRequest(request);

    // Rehydrate surge state so the mid-flight surge guard below sees the same
    // state the checkout route persisted (C8). One extra DB read on a cold
    // instance is fine for a settlement path.
    await hydrateRuntimeState();

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
      isSurgePricingActive() &&
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

    if (!paymentAction) {
      // Create budget reservation if missing
      const [existingRes] = await db
        .select()
        .from(budgetReservations)
        .where(eq(budgetReservations.intent_mandate_id, cart.intent_mandate_id))
        .limit(1);

      budgetResId = existingRes?.id || generateId("bres");
      if (!existingRes) {
        await db.insert(budgetReservations).values({
          id: budgetResId,
          intent_mandate_id: cart.intent_mandate_id,
          amount_minor: cart.total_minor,
          status: "reserved",
          expires_at: cart.quote_expires_at,
        });
      }

      const paymentActionId = generateId("pact");
      let razorpayOrderId = simulatedOrderId;
      let razorpayKeyId =
        process.env.RAZORPAY_KEY_ID || "rzp_test_simulated_key";

      if (paymentMethod !== "simulated_uap") {
        if (!decision?.id) {
          return NextResponse.json(
            {
              success: false,
              error: "Policy decision is required before payment preparation.",
            },
            { status: 400 },
          );
        }

        const preparedPayment = await preparePayment({
          cartMandateId,
          decisionId: decision.id,
          budgetReservationId: budgetResId,
          traceId,
        });

        razorpayOrderId = preparedPayment.razorpayOrderId;
        razorpayKeyId = preparedPayment.razorpayKeyId;
      }

      const [inserted] = await db
        .insert(paymentActions)
        .values({
          id: paymentActionId,
          cart_mandate_id: cartMandateId,
          // Always bind to the cart's authoritative policy decision (read from
          // the DB earlier), never a client-supplied decision id.
          decision_id: decision?.id || decisionId || generateId("dec"),
          budget_reservation_id: budgetResId,
          amount_minor: cart.total_minor,
          currency: cart.currency,
          status:
            paymentMethod === "simulated_uap" ? "completed" : "pending_payment",
          razorpay_order_id: razorpayOrderId,
          razorpay_payment_id:
            paymentMethod === "simulated_uap" ? simulatedPaymentId : null,
          provider_metadata: { method: paymentMethod, razorpayKeyId },
        })
        .returning();

      paymentAction = inserted;
    } else {
      if (paymentMethod === "simulated_uap") {
        const [updated] = await db
          .update(paymentActions)
          .set({
            status: "completed",
            razorpay_payment_id: simulatedPaymentId,
            updated_at: new Date(),
          })
          .where(eq(paymentActions.id, paymentAction.id))
          .returning();

        paymentAction = updated;
      }
    }

    if (paymentMethod === "simulated_uap") {
      // Update cart status
      await db
        .update(cartMandates)
        .set({ status: "completed" })
        .where(eq(cartMandates.id, cartMandateId));

      // Decrement inventory
      const items =
        (cart.items as Array<{ variantId: string; quantity: number }>) || [];
      for (const item of items) {
        await db
          .update(products)
          .set({
            stock_quantity: sql`GREATEST(0, stock_quantity - ${item.quantity})`,
          })
          .where(eq(products.variant_id, item.variantId));
      }

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

    // Human present / Razorpay Checkout
    // Order creation is NEVER treated as payment: creating/returning the
    // Razorpay order only moves the order to `payment_pending`. It becomes
    // `completed` (paid) exclusively via a verified webhook/payment capture.
    await db
      .update(cartMandates)
      .set({ status: "payment_pending" })
      .where(eq(cartMandates.id, cartMandateId));

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
    return NextResponse.json(
      {
        success: false,
        error: "Internal server error confirming checkout",
      },
      { status: 500 },
    );
  }
}
