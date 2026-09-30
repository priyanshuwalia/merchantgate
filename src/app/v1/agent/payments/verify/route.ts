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
import { authorizeSettlement } from "@/lib/auth/settlement-authz";
import { getMerchantContext } from "@/lib/merchant/context";
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

    // Settlement authorization. This route had NO authentication at all — it
    // sat under the public `/v1/agent` prefix with no credential check, so any
    // caller who could guess or harvest a `razorpay_order_id` could drive the
    // completion path. Reading a public order id must not be authority to mark
    // it paid.
    const context = await getMerchantContext();
    const authz = await authorizeSettlement(
      request,
      context.merchant.config as Record<string, unknown> | null,
    );
    if (!authz.ok && authz.response) {
      await logAuditEvent({
        traceId,
        actorType: "system",
        actorId: "payment_verify_authz",
        eventType: "security_settlement_unauthorized",
        cartMandateId: action.cart_mandate_id,
        paymentActionId: action.id,
        explanation:
          "Rejected payment verification: no verified agent API key and no merchant session.",
        metadata: {
          claimedAgentId: authz.agentId,
          orderId,
          remoteIp:
            request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
            null,
        },
      });
      return authz.response;
    }
    const authAgentId = authz.agentId;

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
      // Unsigned settlement bypass. This used to be implied by `NODE_ENV !==
      // "production"` alone, which meant "ship without a signature check" was
      // one careless env var away on a real deployment. It is now an explicit,
      // opt-in flag that defaults OFF, so the safe state is the default state.
      const allowUnsigned =
        process.env.ALLOW_UNSIGNED_SETTLEMENT === "true" ||
        process.env.ALLOW_UNSIGNED_SETTLEMENT === "1";
      if (allowUnsigned) {
        // Test-mode settlement without an external signature (no real keys).
        verified = true;
      } else {
        await logAuditEvent({
          traceId,
          actorType: "system",
          actorId: "payment_verify_guard",
          eventType: "security_unsigned_settlement_blocked",
          paymentActionId: action.id,
          cartMandateId: action.cart_mandate_id,
          explanation:
            "Rejected unsigned payment verification: ALLOW_UNSIGNED_SETTLEMENT is not enabled.",
          metadata: { orderId, paymentId, noSettlement: true },
        });
        return NextResponse.json(
          {
            success: false,
            error: "SIGNATURE_REQUIRED",
            decision: "DENY",
            message:
              "razorpaySignature is required. Unsigned settlement is disabled.",
          },
          { status: 403 },
        );
      }
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

    // ─── ATOMIC SETTLEMENT CLAIM ───────────────────────────────────────────
    // This endpoint used to read the action, check a status, then write — with no
    // auth, no transaction, and an unguarded per-item stock decrement. Two
    // concurrent calls (or one replayed call) both passed the check and both
    // decremented stock, and anyone could complete an arbitrary order.
    //
    // The claim is a single conditional UPDATE ... RETURNING, so the database
    // itself elects exactly one winner. Side effects run only for that winner,
    // inside one transaction. Losers return the already-settled result instead
    // of doing damage.
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
        actorType: "system",
        actorId: "payment_verify_replay_guard",
        eventType: "security_duplicate_settlement_rejected",
        paymentActionId: action.id,
        cartMandateId: action.cart_mandate_id,
        explanation:
          "Rejected replayed payment verification: this action was already completed, so no stock, cart or payment side effect was applied.",
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
            "This payment was already verified and settled. No additional stock or payment effect was applied.",
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
      // One batched UPDATE ... FROM (VALUES ...) rather than a loop, matching
      // the confirm route's N+1 fix.
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
      actorType: "agent",
      actorId: authAgentId || "agent_payment_verify",
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
