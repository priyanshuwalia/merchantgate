import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import {
  budgetReservations,
  cartMandates,
  db,
  paymentActions,
  policyDecisions,
} from "@/db";
import { logAuditEvent } from "@/lib/audit/logger";
import { requireMerchantAuth } from "@/lib/auth/guard";
import { rateLimitRequest } from "@/lib/auth/rate-limit";
import { generateCartMandateSnapshotHash } from "@/lib/crypto/canonical";
import { SURGE_PRICING_REASON } from "@/lib/merchant/surge";
import {
  CartSnapshotMismatchError,
  preparePayment,
} from "@/lib/payments/orchestrator";
import { generateId, generateTraceId } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireMerchantAuth(request);
  if (auth instanceof NextResponse) return auth;

  // Approving a request creates a real Razorpay order / budget reservation.
  // Cap per-client to prevent abuse of an authenticated session.
  const limited = rateLimitRequest(request, {
    namespace: "merchant-approve",
    limit: Number(process.env.RATE_LIMIT_APPROVE) || 60,
  });
  if (limited) return limited;

  const traceId = generateTraceId();

  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({ action: "approve" }));
    const action = body.action || "approve";

    const [cart] = await db
      .select()
      .from(cartMandates)
      .where(eq(cartMandates.id, id))
      .limit(1);
    if (!cart) {
      return NextResponse.json(
        { error: "Cart mandate not found" },
        { status: 404 },
      );
    }

    const [decision] = await db
      .select()
      .from(policyDecisions)
      .where(eq(policyDecisions.cart_mandate_id, id))
      .limit(1);

    if (!decision) {
      return NextResponse.json(
        { error: "Policy decision not found" },
        { status: 404 },
      );
    }

    const decisionJson =
      (decision.decision_json as Record<string, unknown>) || {};

    // Payment action (and its budget reservation) is created fresh in the generic
    // STEP_UP path below. (A pre-existing payment action only ever came from the
    // now-disabled over-limit approval queue.)
    const [existingPaymentAction] = await db
      .select()
      .from(paymentActions)
      .where(eq(paymentActions.cart_mandate_id, id))
      .limit(1);

    if (action === "reject") {
      await db
        .update(policyDecisions)
        .set({
          decision: "DENY",
          decision_json: {
            ...decisionJson,
            merchant_step_up: "rejected",
          },
        })
        .where(eq(policyDecisions.id, decision.id));

      await db
        .update(cartMandates)
        .set({ status: "rejected" })
        .where(eq(cartMandates.id, id));

      // Cancel any payment intent that was created for the queued proposal.
      if (existingPaymentAction) {
        await db
          .update(paymentActions)
          .set({
            status: "cancelled",
            provider_metadata: {
              ...((existingPaymentAction.provider_metadata as Record<
                string,
                unknown
              > | null) || {}),
              cancellationReason: "merchant_rejected",
            },
            updated_at: new Date(),
          })
          .where(eq(paymentActions.id, existingPaymentAction.id));
      }

      await logAuditEvent({
        traceId,
        actorType: "merchant",
        actorId: "merchant_admin",
        eventType: "merchant_step_up_rejected",
        cartMandateId: id,
        decisionId: decision.id,
        paymentActionId: existingPaymentAction?.id,
        explanation: `Merchant manually rejected ${existingPaymentAction?.status === "pending_approval" ? "over-limit" : "proposal"} ${id}.`,
        metadata: {
          overLimitQueued: existingPaymentAction?.status === "pending_approval",
        },
      });

      return NextResponse.json({ success: true, status: "rejected" });
    }

    // ---- Approve path ----
    const expectedHash = String(
      decisionJson.cart_snapshot_hash || cart.content_hash || "",
    );
    const recomputedHash = generateCartMandateSnapshotHash(cart);

    if (!expectedHash || recomputedHash !== expectedHash) {
      await logAuditEvent({
        traceId,
        actorType: "system",
        actorId: "toctou_guard",
        eventType: "cart_snapshot_mismatch",
        cartMandateId: id,
        decisionId: decision.id,
        explanation: "CART_SNAPSHOT_MISMATCH. Razorpay Order not created.",
        metadata: {
          expectedHash,
          recomputedHash,
          persistedContentHash: cart.content_hash,
          noRazorpayOrderCreated: true,
        },
      });

      return NextResponse.json(
        {
          error: "CART_SNAPSHOT_MISMATCH",
          message:
            "Cart contents were modified after policy gate approval. Payment aborted.",
          decision: "DENY",
        },
        { status: 409 },
      );
    }

    await db
      .update(policyDecisions)
      .set({
        decision: "ALLOW",
        decision_json: {
          ...decisionJson,
          decision: "ALLOW",
          merchant_step_up: "approved",
        },
      })
      .where(eq(policyDecisions.id, decision.id));

    // == COMMENTED OUT: maxAgentTransactionAmount logic ==
    // Over-limit queued proposals (status `pending_approval`) used to already
    // carry a payment intent created at checkout. With that merchant gate
    // disabled, no proposal is ever queued as `pending_approval`, so the whole
    // over-limit approval branch below is dead. Every approved order takes the
    // generic STEP_UP path and leaves the Razorpay order `payment_pending` to
    // be completed via a real test checkout.
    // if (existingPaymentAction?.status === "pending_approval") {
    //   const budgetResId = existingPaymentAction.budget_reservation_id;
    //   const meta = (existingPaymentAction.provider_metadata as Record<string, unknown> | null) || {};
    //
    //   await db.update(paymentActions).set({
    //     status: "pending_payment",
    //     provider_metadata: {
    //       ...meta,
    //       razorpayKeyId: process.env.RAZORPAY_KEY_ID || "rzp_test_simulated_key",
    //       merchant_step_up: "approved",
    //     },
    //     updated_at: new Date(),
    //   }).where(eq(paymentActions.id, existingPaymentAction.id));
    //
    //   await db.update(cartMandates).set({ status: "payment_pending" }).where(eq(cartMandates.id, id));
    //
    //   const items = (cart.items as Array<{ quantity?: number }>) || [];
    //   const quantity = items.reduce((sum: number, it: { quantity?: number }) => sum + (Number(it.quantity) || 1), 0);
    //
    //   await logAuditEvent({
    //     traceId, actorType: "merchant", actorId: "merchant_admin",
    //     eventType: "merchant_step_up_approved", cartMandateId: id,
    //     decisionId: decision.id, paymentActionId: existingPaymentAction.id,
    //     explanation: `Merchant approved over-limit transaction ${cart.currency} ${(cart.total_minor / 100).toFixed(2)}. Order is payment_pending — a real Razorpay test checkout (${existingPaymentAction.razorpay_order_id}) must be completed before it is paid.`,
    //     metadata: { overLimitQueued: true, budgetReservationId: budgetResId, razorpayOrderId: existingPaymentAction.razorpay_order_id, pendingRealCheckout: true },
    //   });
    //
    //   return NextResponse.json({
    //     success: true, status: "approved", needsCheckout: true,
    //     paymentActionId: existingPaymentAction.id,
    //     razorpayOrderId: existingPaymentAction.razorpay_order_id || "",
    //     razorpayKeyId: process.env.RAZORPAY_KEY_ID || "rzp_test_simulated_key",
    //     amountMinor: cart.total_minor, currency: cart.currency,
    //     grandTotalMinor: cart.total_minor, quantity,
    //   });
    // }

    // Generic STEP_UP (slippage / discount approval) — create the payment
    // intent now, then leave it pending payment for a real checkout.
    const items = (cart.items as Array<{ quantity?: number }>) || [];
    const quantity = items.reduce(
      (sum: number, it: { quantity?: number }) =>
        sum + (Number(it.quantity) || 1),
      0,
    );
    const checkoutResponse = {
      success: true,
      status: "approved",
      needsCheckout: true,
      amountMinor: cart.total_minor,
      currency: cart.currency,
      grandTotalMinor: cart.total_minor,
      quantity,
    };

    await db
      .update(cartMandates)
      .set({ status: "payment_pending" })
      .where(eq(cartMandates.id, id));

    const budgetReservationId = generateId("bres");
    await db.insert(budgetReservations).values({
      id: budgetReservationId,
      intent_mandate_id: cart.intent_mandate_id,
      amount_minor: cart.total_minor,
      status: "reserved",
      expires_at: cart.quote_expires_at,
    });

    const preparedPayment = await preparePayment({
      cartMandateId: cart.id,
      decisionId: decision.id,
      budgetReservationId,
      traceId,
    });

    if (preparedPayment.paymentAction) {
      return NextResponse.json({
        ...checkoutResponse,
        paymentActionId: preparedPayment.paymentAction.id,
        razorpayOrderId: preparedPayment.razorpayOrderId,
        razorpayKeyId: preparedPayment.razorpayKeyId,
      });
    }

    // Alias the (possibly re-priced) payment intent fields, narrowing the
    // preparePayment union with `in`-guards for reliable flow analysis.
    const staleAction =
      "existingPaymentAction" in preparedPayment
        ? preparedPayment.existingPaymentAction
        : null;
    const preparedOrder =
      "order" in preparedPayment ? preparedPayment.order : undefined;
    const razorpayOrderId = preparedPayment.razorpayOrderId;
    const razorpayKeyId = preparedPayment.razorpayKeyId;

    const paymentActionId = staleAction?.id ?? generateId("pact");

    if (staleAction) {
      // A stale payment intent (e.g. expired when Surge Pricing re-priced the
      // cart mid-flight) already exists for this cart. Unique constraints on
      // cart_mandate_id / decision_id forbid a second row, so refresh it in
      // place at the new (surged) amount with a fresh Razorpay order.
      const staleMeta =
        (staleAction.provider_metadata as Record<string, unknown> | null) || {};
      await db
        .update(paymentActions)
        .set({
          status: "pending_payment",
          amount_minor: cart.total_minor,
          currency: cart.currency,
          budget_reservation_id: budgetReservationId,
          razorpay_order_id: razorpayOrderId,
          provider_metadata: {
            ...staleMeta,
            restoredByMerchantApproval: true,
            razorpayKeyId,
            isMock: preparedOrder?.isMock,
          },
          updated_at: new Date(),
        })
        .where(eq(paymentActions.id, staleAction.id));
    } else {
      await db.insert(paymentActions).values({
        id: paymentActionId,
        cart_mandate_id: cart.id,
        decision_id: decision.id,
        budget_reservation_id: budgetReservationId,
        amount_minor: cart.total_minor,
        currency: cart.currency,
        status: "pending_payment",
        razorpay_order_id: razorpayOrderId,
        provider_metadata: {
          isMock: preparedOrder?.isMock,
          razorpayKeyId,
        },
      });
    }

    const surged =
      (decisionJson as Record<string, unknown>).surge_reason ===
      SURGE_PRICING_REASON;
    await logAuditEvent({
      traceId,
      actorType: "merchant",
      actorId: "merchant_admin",
      eventType: "merchant_step_up_approved",
      cartMandateId: id,
      decisionId: decision.id,
      paymentActionId,
      explanation: `Merchant approved step-up for ${cart.currency} ${(cart.total_minor / 100).toFixed(2)}. Razorpay order ${razorpayOrderId} generated — waiting on a real test checkout.${surged ? ` Surge pricing re-priced this transaction +15% before approval (${SURGE_PRICING_REASON}).` : ""}`,
      metadata: {
        razorpayOrderId,
        restoredStaleIntent: Boolean(staleAction),
        surged,
        surgeReason: surged ? SURGE_PRICING_REASON : null,
      },
    });

    return NextResponse.json({
      ...checkoutResponse,
      paymentActionId,
      razorpayOrderId: preparedPayment.razorpayOrderId,
      razorpayKeyId: preparedPayment.razorpayKeyId,
    });
  } catch (error) {
    if (error instanceof CartSnapshotMismatchError) {
      await logAuditEvent({
        traceId,
        actorType: "system",
        actorId: "payment_orchestrator",
        eventType: "cart_snapshot_mismatch",
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
          error: "CART_SNAPSHOT_MISMATCH",
          message:
            "Cart contents were modified after policy gate approval. Payment aborted.",
          decision: "DENY",
        },
        { status: 409 },
      );
    }

    console.error("Error approving step-up:", error);
    return NextResponse.json(
      { error: "Internal error approving request." },
      { status: 500 },
    );
  }
}
