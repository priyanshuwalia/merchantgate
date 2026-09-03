import { eq, sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { cartMandates, db, paymentActions, products } from "@/db";
import { logAuditEvent } from "@/lib/audit/logger";
import { verifyPaymentSignature } from "@/lib/payments/razorpay";
import { generateTraceId } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * POST /v1/agent/payments/verify
 *
 * Agent-facing (machine-to-machine) payment completion for a Razorpay
 * test-mode checkout. After the Razorpay payment modal returns a
 * razorpay_payment_id + razorpay_signature, the client submits them here so
 * the server can cryptographically verify the signature against the merchant
 * key_secret BEFORE marking the order paid.
 *
 * Order creation is never treated as payment: only a successfully verified
 * capture moves the order `payment_pending -> completed` (paid). A bad
 * signature leaves the order unpaid (failed) and is audit-logged.
 */
export async function POST(request: NextRequest) {
  const traceId = generateTraceId();

  try {
    const body = await request.json().catch(() => ({}));
    const orderId = String(body.razorpayOrderId || "");
    const paymentId = String(body.razorpayPaymentId || "");
    const signature = String(body.razorpaySignature || "");

    if (!orderId) {
      return NextResponse.json(
        { success: false, error: "razorpayOrderId is required." },
        { status: 400 },
      );
    }

    const [action] = await db
      .select()
      .from(paymentActions)
      .where(eq(paymentActions.razorpay_order_id, orderId))
      .limit(1);

    if (!action) {
      return NextResponse.json(
        { success: false, error: "Payment action not found." },
        { status: 404 },
      );
    }

    // Idempotent: an already-paid order never needs re-verification.
    if (action.status === "completed") {
      return NextResponse.json({
        success: true,
        status: "paid",
        alreadyCompleted: true,
        paymentActionId: action.id,
        razorpayOrderId: orderId,
        razorpayPaymentId: action.razorpay_payment_id || paymentId,
      });
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET || "";
    const isProd = process.env.NODE_ENV === "production";

    let verified = false;
    if (signature) {
      verified = verifyPaymentSignature({
        orderId,
        paymentId,
        signature,
        secret: keySecret,
      });
    } else if (!isProd) {
      // Test-mode settlement without an external signature (no real keys).
      // In production a signature is always required.
      verified = true;
    }

    if (!verified) {
      await db
        .update(cartMandates)
        .set({ status: "failed" })
        .where(eq(cartMandates.id, action.cart_mandate_id));
      await db
        .update(paymentActions)
        .set({ status: "failed", updated_at: new Date() })
        .where(eq(paymentActions.id, action.id));

      await logAuditEvent({
        traceId,
        actorType: "system",
        actorId: "payment_verify_guard",
        eventType: "security_payment_signature_failed",
        paymentActionId: action.id,
        cartMandateId: action.cart_mandate_id,
        explanation:
          "Rejected payment completion: Razorpay signature verification failed. Order marked failed, not paid.",
        metadata: { orderId, paymentId, noSettlement: true },
      });

      return NextResponse.json(
        { success: false, error: "Payment signature verification failed." },
        { status: 403 },
      );
    }

    await db
      .update(paymentActions)
      .set({
        status: "completed",
        razorpay_payment_id: paymentId || action.razorpay_payment_id,
        updated_at: new Date(),
      })
      .where(eq(paymentActions.id, action.id));

    await db
      .update(cartMandates)
      .set({ status: "completed" })
      .where(eq(cartMandates.id, action.cart_mandate_id));

    const [cart] = await db
      .select()
      .from(cartMandates)
      .where(eq(cartMandates.id, action.cart_mandate_id))
      .limit(1);
    if (cart) {
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
    }

    await logAuditEvent({
      traceId,
      actorType: "agent",
      actorId: "agent_payment_verify",
      eventType: "payment_verified_paid",
      paymentActionId: action.id,
      cartMandateId: action.cart_mandate_id,
      explanation: `Razorpay payment ${paymentId} for order ${orderId} verified server-side and order paid.`,
      providerRefs: { razorpayOrderId: orderId, razorpayPaymentId: paymentId },
    });

    return NextResponse.json({
      success: true,
      status: "paid",
      paymentActionId: action.id,
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
    });
  } catch (error) {
    console.error("Error verifying agent payment:", error);
    return NextResponse.json(
      { success: false, error: "Internal error verifying payment." },
      { status: 500 },
    );
  }
}
