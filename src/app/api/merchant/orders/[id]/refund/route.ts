import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db, paymentActions, refundActions } from "@/db";
import { logAuditEvent } from "@/lib/audit/logger";
import { requireMerchantAuth } from "@/lib/auth/guard";
import { refundPayment } from "@/lib/payments/razorpay";
import { generateId, generateTraceId } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireMerchantAuth(request);
  if (auth instanceof NextResponse) return auth;

  const traceId = generateTraceId();

  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const reason =
      body.reason || "Customer requested refund via merchant console";

    const [action] = await db
      .select()
      .from(paymentActions)
      .where(eq(paymentActions.id, id))
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

    // Idempotency / duplicate-refund guard: a payment action may only ever be
    // refunded once. Refuse if a refund already exists for this payment.
    const [existingRefund] = await db
      .select()
      .from(refundActions)
      .where(eq(refundActions.payment_action_id, action.id))
      .limit(1);
    if (existingRefund) {
      return NextResponse.json({
        success: true,
        refundId: existingRefund.id,
        razorpayRefundId: existingRefund.razorpay_refund_id,
        amountMinor: existingRefund.amount_minor,
        currency: action.currency,
        status: existingRefund.status,
        duplicate: true,
      });
    }

    const refundId = generateId("ref");
    const paymentId = action.razorpay_payment_id || "";
    const isRealPayment =
      paymentId.startsWith("pay_") && !paymentId.includes("sim");

    let razorpayRefundId: string | null = null;
    let provider = "simulated";

    // B4: when the order was actually captured by Razorpay (real payment id)
    // AND the merchant has configured keys, issue a REAL refund via the
    // Razorpay API. The webhook then reconciles refund.* events idempotently.
    if (isRealPayment) {
      const refund = await refundPayment({
        paymentId,
        amountMinor: action.amount_minor,
        notes: {
          refundActionId: refundId,
          reason,
          merchant: "mch_nimbus_gear_001",
        },
      });

      if (refund) {
        razorpayRefundId = refund.id;
        provider = "razorpay";
      } else {
        // Real payment but the provider call failed (network/keys/eligibility).
        // Never fake success — surface the failure so the merchant can retry.
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
      // Simulated settlement fallback for local demo (pay_sim_* / no keys).
      razorpayRefundId = `rfrp_sim_${generateId()}`;
    }

    await db.insert(refundActions).values({
      id: refundId,
      payment_action_id: action.id,
      amount_minor: action.amount_minor,
      razorpay_refund_id: razorpayRefundId,
      status: "completed",
      idempotency_key: `idemp_refund_${action.id}`,
      reason,
    });

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
        razorpayRefundId,
        razorpayPaymentId: paymentId,
        provider,
      },
      metadata: {
        refundId,
        provider,
        isRealPayment,
        amountMinor: action.amount_minor,
      },
    });

    return NextResponse.json({
      success: true,
      refundId,
      razorpayRefundId,
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
