import { eq, sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db, paymentActions, refundActions } from "@/db";
import { logAuditEvent } from "@/lib/audit/logger";
import { requireMerchantAuth } from "@/lib/auth/guard";
import { rateLimitRequest } from "@/lib/auth/rate-limit";
import { refundPayment } from "@/lib/payments/razorpay";
import {
  isStripePaymentAction,
  refundStripePayment,
} from "@/lib/payments/stripe";
import { generateId, generateTraceId } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * Release a refund claim that never reached the provider.
 *
 * The claim exists to stop two concurrent refunds from both paying out. If the
 * provider call comes back without a refund object, nothing was returned, so the
 * claim must be rolled back — otherwise the row sits at `pending` forever and
 * every subsequent attempt is answered as a "duplicate" refund that will never
 * complete. Only ever called on a definitive provider failure.
 */
async function releaseRefundClaim(refundId: string): Promise<void> {
  try {
    await db.delete(refundActions).where(eq(refundActions.id, refundId));
  } catch (err) {
    // Never mask the provider failure with a cleanup failure.
    console.error(`Failed to release refund claim ${refundId}:`, err);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireMerchantAuth(request);
  if (auth instanceof NextResponse) return auth;

  // Refunds move real money (Razorpay). Cap per-client so an abused session or
  // stray client cannot trigger a refund storm.
  const limited = rateLimitRequest(request, {
    namespace: "merchant-refund",
    limit: Number(process.env.RATE_LIMIT_REFUND) || 30,
  });
  if (limited) return limited;

  const traceId = generateTraceId();

  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const reason =
      body.reason || "Customer requested refund via merchant console";

    const [action] = await db
      .select()
      .from(paymentActions)
      .where(
        sql`${paymentActions.id} = ${id} AND ${paymentActions.cart_mandate_id} IN (
          SELECT id FROM cart_mandates WHERE merchant_id = ${auth.merchantId}
        )`,
      )
      .limit(1);

    if (!action) {
      return NextResponse.json(
        { error: "Payment action not found" },
        { status: 404 },
      );
    }

    if (action.status !== "completed") {
      return NextResponse.json(
        { error: `Cannot refund order with status '${action.status}'` },
        { status: 409 },
      );
    }

    // ─── CLAIM THE REFUND BEFORE TOUCHING THE PROVIDER ─────────────────────    // The previous order of operations was: SELECT for an existing refund →
    // call the provider → INSERT. Two concurrent requests both saw no refund
    // row, both called the provider, and the UNIQUE(payment_action_id) violation
    // only surfaced on the later INSERT — by which time real money had already
    // been returned twice. A unique index cannot fix a race that happens
    // *before* it, so the row is claimed first and the provider call is gated on
    // winning that claim.
    //
    // `ON CONFLICT DO NOTHING` + RETURNING means the database elects one winner;
    // the loser sees zero rows and returns the already-recorded refund without
    // calling the provider at all.
    const claimedRefunds = await db
      .insert(refundActions)
      .values({
        payment_action_id: action.id,
        amount_minor: action.amount_minor,
        status: "pending",
        reason: body.reason || "Customer requested refund via merchant console",
        idempotency_key:
          request.headers.get("idempotency-key") || generateId("ref"),
      })
      .onConflictDoNothing()
      .returning({ id: refundActions.id });

    if (claimedRefunds.length === 0) {
      const [existingRefund] = await db
        .select()
        .from(refundActions)
        .where(eq(refundActions.payment_action_id, action.id))
        .limit(1);

      return NextResponse.json({
        success: true,
        refundId: existingRefund?.id,
        razorpayRefundId: existingRefund?.razorpay_refund_id,
        amountMinor: existingRefund?.amount_minor ?? action.amount_minor,
        currency: action.currency,
        status: existingRefund?.status ?? "unknown",
        duplicate: true,
        message:
          "A refund for this payment was already recorded. No additional provider refund was issued.",
      });
    }

    // Winner: the provider call below is now gated on having won the claim.
    const refundId = claimedRefunds[0].id;

    const paymentId = action.razorpay_payment_id || "";
    const orderIntentRef = action.razorpay_order_id || "";
    const isStripeAction = isStripePaymentAction(action);
    const isRealStripePayment =
      isStripeAction &&
      orderIntentRef.startsWith("pi_") &&
      !orderIntentRef.includes("sim");
    const isRealRazorpayPayment =
      !isStripeAction &&
      paymentId.startsWith("pay_") &&
      !paymentId.includes("sim");

    let razorpayRefundId: string | null = null;
    let provider = "simulated";

    // B4: when the order was actually captured by the provider (real payment
    // id) AND the merchant has configured keys, issue a REAL refund via the
    // provider API. The provider webhook then reconciles refund events
    // idempotently. Stripe refunds target the PaymentIntent; Razorpay refunds
    // target the captured payment id.
    if (isRealStripePayment) {
      const refund = await refundStripePayment({
        paymentIntentId: orderIntentRef,
        amountMinor: action.amount_minor,
        // Stable per payment action, so a retry after a provider timeout cannot
        // return the money twice.
        idempotencyKey: `mg_refund_${action.id}`,
        metadata: {
          refundActionId: refundId,
          merchant: auth.merchantId,
        },
      });

      if (refund) {
        razorpayRefundId = refund.id;
        provider = "stripe";
      } else {
        // Release the claim. No refund object came back, so the provider created
        // nothing and there is no money to reconcile — leaving the row `pending`
        // would block every future retry behind a permanent duplicate response.
        await releaseRefundClaim(refundId);
        return NextResponse.json(
          {
            error:
              "Stripe refund failed to create. The payment is captured and can be retried.",
            paymentActionId: action.id,
          },
          { status: 502 },
        );
      }
    } else if (isRealRazorpayPayment) {
      const refund = await refundPayment({
        paymentId,
        amountMinor: action.amount_minor,
        notes: {
          refundActionId: refundId,
          reason,
          merchant: auth.merchantId,
        },
      });

      if (refund) {
        razorpayRefundId = refund.id;
        provider = "razorpay";
      } else {
        // Real payment but the provider call failed (network/keys/eligibility).
        // Never fake success — surface the failure so the merchant can retry.
        // Release the claim for the same reason as the Stripe branch above.
        await releaseRefundClaim(refundId);
        return NextResponse.json(
          {
            error:
              "Razorpay refund failed to create. The payment is captured and can be retried.",
            paymentActionId: action.id,
          },
          { status: 502 },
        );
      }
    } else {
      // Simulated settlement fallback for local demo (pay_sim_*/pi_sim_*/no keys).
      razorpayRefundId = `rfrp_sim_${generateId()}`;
    }

    // The refund row was CLAIMED before the provider call, so this is now an
    // update rather than an insert. Keeping it as an INSERT would violate the
    // new UNIQUE(payment_action_id) constraint that the claim relies on.
    await db
      .update(refundActions)
      .set({
        razorpay_refund_id: razorpayRefundId,
        status: "completed",
        reason,
      })
      .where(eq(refundActions.id, refundId));

    await db
      .update(paymentActions)
      .set({
        status: "refunded",
        updated_at: new Date(),
      })
      .where(eq(paymentActions.id, action.id));

    await logAuditEvent({
      traceId,
      actorType: "merchant",
      actorId: "merchant_admin",
      eventType: "merchant_order_refunded",
      paymentActionId: action.id,
      cartMandateId: action.cart_mandate_id,
      explanation: `Issued full refund of ${action.currency} ${(action.amount_minor / 100).toFixed(2)} via ${provider}. Reason: ${reason}`,
      providerRefs: {
        [provider === "stripe" ? "stripeRefundId" : "razorpayRefundId"]:
          razorpayRefundId,
        stripePaymentIntent: isStripeAction
          ? action.razorpay_order_id
          : undefined,
        razorpayPaymentId: isStripeAction ? undefined : paymentId,
        provider,
      },
      metadata: {
        refundId,
        provider,
        isRealPayment: isRealStripePayment || isRealRazorpayPayment,
        amountMinor: action.amount_minor,
      },
    });

    return NextResponse.json({
      success: true,
      refundId,
      razorpayRefundId,
      stripeRefundId: provider === "stripe" ? razorpayRefundId : undefined,
      amountMinor: action.amount_minor,
      currency: action.currency,
      status: "completed",
      provider,
    });
  } catch (error) {
    console.error("Error processing refund:", error);
    return NextResponse.json(
      { error: "Internal error processing refund." },
      { status: 500 },
    );
  }
}
