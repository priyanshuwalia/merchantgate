import { and, eq, ne, sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import {
  cartMandates,
  db,
  paymentActions,
  products,
  runTransaction,
  toStatement,
} from "@/db";
import { logAuditEvent } from "@/lib/audit/logger";
import { requireMerchantAuth } from "@/lib/auth/guard";
import { verifyPaymentSignature } from "@/lib/payments/razorpay";
import { generateTraceId } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * POST /api/merchant/payments/verify
 *
 * Server-side verification for the human-present (dashboard) Razorpay
 * checkout. The browser must NEVER be allowed to tell the server "the payment
 * succeeded" — instead it submits the payment/order ids and the Razorpay
 * signature, which this endpoint cryptographically verifies against the
 * merchant's key_secret before marking the payment action + cart completed.
 *
 * Simulated/test settlement (no signature) is only permitted outside
 * production so the demo flow keeps working without real keys.
 */
export async function POST(request: NextRequest) {
  const traceId = generateTraceId();
  const auth = requireMerchantAuth(request, { requireCsrf: true });
  if (auth instanceof NextResponse) return auth;

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

    // Idempotency: a completed payment never needs re-verification.
    if (action.status === "completed") {
      return NextResponse.json({
        success: true,
        status: "completed",
        alreadyCompleted: true,
        paymentActionId: action.id,
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
      // Simulated settlement path (test mode only).
      verified = true;
    }

    if (!verified) {
      await logAuditEvent({
        traceId,
        actorType: "system",
        actorId: "payment_verify_guard",
        eventType: "security_payment_signature_failed",
        paymentActionId: action.id,
        cartMandateId: action.cart_mandate_id,
        explanation:
          "Rejected client-submitted payment confirmation: Razorpay payment signature verification failed.",
        metadata: { orderId, paymentId, noSettlement: true },
      });
      return NextResponse.json(
        { success: false, error: "Payment signature verification failed." },
        { status: 403 },
      );
    }

    // ─── ATOMIC SETTLEMENT CLAIM ───────────────────────────────────────────
    // Same check-then-act replay hole as the agent-side verify route: an
    // unconditional UPDATE, then an unguarded per-item stock decrement. A
    // double-click (or a retried request) paid once but decremented stock twice.
    const claimed = await db
      .update(paymentActions)
      .set({
        status: "completed",
        razorpay_payment_id: paymentId || action.razorpay_payment_id,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(paymentActions.id, action.id),
          ne(paymentActions.status, "completed"),
        ),
      )
      .returning({ id: paymentActions.id });

    if (claimed.length === 0) {
      await logAuditEvent({
        traceId,
        actorType: "merchant",
        actorId: "merchant_admin",
        eventType: "security_duplicate_settlement_rejected",
        paymentActionId: action.id,
        cartMandateId: action.cart_mandate_id,
        explanation:
          "Rejected replayed merchant-side payment verification: the action was already completed, so no stock or payment side effect was applied.",
        metadata: {
          orderId,
          paymentId,
          claimed: false,
          idempotentReplay: true,
        },
      });

      return NextResponse.json(
        {
          success: true,
          idempotentReplay: true,
          status: "completed",
          paymentActionId: action.id,
          cartMandateId: action.cart_mandate_id,
          message:
            "This payment was already settled. No additional stock or payment effect was applied.",
        },
        { status: 200 },
      );
    }

    const [cart] = await db
      .select()
      .from(cartMandates)
      .where(eq(cartMandates.id, action.cart_mandate_id))
      .limit(1);
    const items =
      (cart?.items as Array<{ variantId: string; quantity: number }>) || [];

    await runTransaction([
      toStatement(
        db
          .update(cartMandates)
          .set({ status: "completed" })
          .where(eq(cartMandates.id, action.cart_mandate_id)),
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
                      (i) => sql`(${i.variantId}::text, ${i.quantity}::bigint)`,
                    ),
                    sql.raw(", "),
                  )}) AS data(variant_id, qty)`,
                )
                .where(sql`${products.variant_id} = data.variant_id`),
            ),
          ]
        : []),
    ]);

    await logAuditEvent({
      traceId,
      actorType: "merchant",
      actorId: "merchant_admin",
      eventType: "payment_verified_settled",
      paymentActionId: action.id,
      cartMandateId: action.cart_mandate_id,
      explanation: `Human-present Razorpay payment ${paymentId} for order ${orderId} verified and settled.`,
      providerRefs: { razorpayOrderId: orderId, razorpayPaymentId: paymentId },
    });

    return NextResponse.json({
      success: true,
      status: "completed",
      paymentActionId: action.id,
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
    });
  } catch (error) {
    console.error("Error verifying payment:", error);
    return NextResponse.json(
      { success: false, error: "Internal error verifying payment." },
      { status: 500 },
    );
  }
}
