import crypto from "crypto";
import { eq, sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import {
  cartMandates,
  db,
  paymentActions,
  products,
  refundActions,
  webhookEvents,
} from "@/db";
import { logAuditEvent } from "@/lib/audit/logger";
import { verifyWebhookSignature } from "@/lib/payments/razorpay";
import { generateId, generateTraceId } from "@/lib/utils";
import { webhookInspectorStore } from "@/lib/webhooks/inspector-store";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const traceId = generateTraceId();

  try {
    const rawBody = await request.text();
    const signature = request.headers.get("x-razorpay-signature") || "";
    const eventIdHeader = request.headers.get("x-razorpay-event-id");

    // Fail closed: without a configured webhook secret there is no basis to
    // trust any Razorpay callback, so we reject all webhooks. No hardcoded
    // fallback secret is ever used.
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error(
        "[webhook] RAZORPAY_WEBHOOK_SECRET is not configured; rejecting webhook.",
      );
      return NextResponse.json(
        { error: "Webhook secret not configured." },
        { status: 503 },
      );
    }

    // Strict, timing-safe HMAC SHA-256 verification of the raw body. There is
    // deliberately no mock/debug bypass: an attacker must not be able to
    // forge a payment-confirmation webhook.
    const isSignatureValid = verifyWebhookSignature(
      rawBody,
      signature || "",
      webhookSecret,
    );

    // Expected digest is computed only for the inspection dashboard (logged,
    // never used to authorise), so the log stays informative for the merchant.
    const computedHmac = crypto
      .createHmac("sha256", webhookSecret)
      .update(rawBody)
      .digest("hex");

    let payload: any = {};
    try {
      payload = JSON.parse(rawBody);
    } catch {
      payload = { raw: rawBody };
    }

    const eventType = payload.event || "unknown";
    const providerEventId =
      eventIdHeader || payload.id || `evt_${generateId()}`;

    // Deduplication check
    const existing = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.provider_event_id, providerEventId))
      .limit(1);

    const isDuplicate = existing.length > 0;

    // Log to Live Webhook Inspector
    if (!isSignatureValid) {
      webhookInspectorStore.addLog({
        provider: "razorpay",
        providerEventId,
        eventType,
        rawBody: rawBody.slice(0, 300),
        receivedSignature: signature || "(missing)",
        computedHmac,
        signatureMatch: false,
        dedupeCheck: isDuplicate ? "DUPLICATE_SKIPPED" : "NEW_EVENT",
        action:
          "❌ REJECTED: Cryptographic HMAC signature mismatch. Webhook discarded.",
        status: "REJECTED_SIGNATURE",
      });

      return NextResponse.json(
        {
          error: "Invalid webhook signature",
        },
        { status: 401 },
      );
    }

    if (isDuplicate) {
      webhookInspectorStore.addLog({
        provider: "razorpay",
        providerEventId,
        eventType,
        rawBody: rawBody.slice(0, 300),
        receivedSignature: signature,
        computedHmac,
        signatureMatch: true,
        dedupeCheck: "DUPLICATE_SKIPPED",
        action:
          "⏭️ SKIPPED: Event ID already processed by state machine (idempotent no-op).",
        status: "SKIPPED_DUPLICATE",
      });

      return NextResponse.json(
        { status: "already_processed" },
        { status: 200 },
      );
    }

    webhookInspectorStore.addLog({
      provider: "razorpay",
      providerEventId,
      eventType,
      rawBody: rawBody.slice(0, 300),
      receivedSignature: signature,
      computedHmac,
      signatureMatch: true,
      dedupeCheck: "NEW_EVENT",
      action: `✅ FORWARDED: Valid HMAC match. Forwarding to merchant state machine (event: ${eventType}).`,
      status: "PROCESSED",
    });

    // Process event
    if (eventType === "payment.captured" || eventType === "order.paid") {
      const paymentEntity = payload.payload?.payment?.entity || {};
      const orderId =
        paymentEntity.order_id || payload.payload?.order?.entity?.id;
      const paymentId = paymentEntity.id || `pay_${generateId()}`;

      if (orderId) {
        const [action] = await db
          .select()
          .from(paymentActions)
          .where(eq(paymentActions.razorpay_order_id, orderId))
          .limit(1);

        if (action) {
          await db
            .update(paymentActions)
            .set({
              status: "completed",
              razorpay_payment_id: paymentId,
              updated_at: new Date(),
            })
            .where(eq(paymentActions.id, action.id));

          await db
            .update(cartMandates)
            .set({ status: "completed" })
            .where(eq(cartMandates.id, action.cart_mandate_id));

          // Decrement inventory
          const [cart] = await db
            .select()
            .from(cartMandates)
            .where(eq(cartMandates.id, action.cart_mandate_id))
            .limit(1);

          if (cart) {
            const items =
              (cart.items as Array<{ variantId: string; quantity: number }>) ||
              [];
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
            actorType: "system",
            actorId: "razorpay_webhook",
            eventType: "webhook_payment_captured",
            cartMandateId: action.cart_mandate_id,
            paymentActionId: action.id,
            explanation: `Razorpay payment ${paymentId} captured for order ${orderId}.`,
            providerRefs: {
              razorpayPaymentId: paymentId,
              razorpayOrderId: orderId,
            },
          });
        }
      }
    } else if (eventType === "payment.failed") {
      const paymentEntity = payload.payload?.payment?.entity || {};
      const orderId = paymentEntity.order_id;

      if (orderId) {
        const [action] = await db
          .select()
          .from(paymentActions)
          .where(eq(paymentActions.razorpay_order_id, orderId))
          .limit(1);

        if (action) {
          await db
            .update(paymentActions)
            .set({
              status: "failed",
              updated_at: new Date(),
            })
            .where(eq(paymentActions.id, action.id));

          // The order leaves `payment_pending` and becomes `failed` — it is
          // never (and was never) treated as paid.
          await db
            .update(cartMandates)
            .set({ status: "failed" })
            .where(eq(cartMandates.id, action.cart_mandate_id));

          await logAuditEvent({
            traceId,
            actorType: "system",
            actorId: "razorpay_webhook",
            eventType: "webhook_payment_failed",
            cartMandateId: action.cart_mandate_id,
            paymentActionId: action.id,
            explanation: `Payment failed for order ${orderId}: ${paymentEntity.error_description || "Unknown error"}`,
            providerRefs: { razorpayOrderId: orderId },
          });
        }
      }
    } else if (
      eventType === "refund.created" ||
      eventType === "refund.processed" ||
      eventType === "refund.completed"
    ) {
      // B4: reconcile a refund issued through the merchant console. The refund
      // action is matched by its Razorpay refund id and confirmed idempotently
      // (the refundActions unique constraints + the outer event dedupe both
      // protect against double-processing).
      const refundEntity = payload.payload?.refund?.entity || {};
      const refundId = refundEntity.id;
      const paymentId = refundEntity.payment_id;

      if (refundId) {
        const [refundAction] = await db
          .select()
          .from(refundActions)
          .where(eq(refundActions.razorpay_refund_id, refundId))
          .limit(1);

        if (refundAction) {
          const [action] = await db
            .select()
            .from(paymentActions)
            .where(eq(paymentActions.id, refundAction.payment_action_id))
            .limit(1);

          await db
            .update(refundActions)
            .set({ status: "completed" })
            .where(eq(refundActions.id, refundAction.id));

          if (action) {
            await db
              .update(paymentActions)
              .set({ status: "refunded", updated_at: new Date() })
              .where(eq(paymentActions.id, action.id));
          }

          await logAuditEvent({
            traceId,
            actorType: "system",
            actorId: "razorpay_webhook",
            eventType: "webhook_refund_confirmed",
            paymentActionId: refundAction.payment_action_id,
            cartMandateId: action?.cart_mandate_id,
            explanation: `Razorpay confirmed refund ${refundId} for payment ${paymentId} (event ${eventType}). Refund action ${refundAction.id} marked completed.`,
            providerRefs: {
              razorpayRefundId: refundId,
              razorpayPaymentId: paymentId,
            },
          });
        }
      }
    } else if (eventType === "refund.failed") {
      const refundEntity = payload.payload?.refund?.entity || {};
      const refundId = refundEntity.id;

      if (refundId) {
        const [refundAction] = await db
          .select()
          .from(refundActions)
          .where(eq(refundActions.razorpay_refund_id, refundId))
          .limit(1);

        if (refundAction) {
          await db
            .update(refundActions)
            .set({ status: "failed" })
            .where(eq(refundActions.id, refundAction.id));

          await logAuditEvent({
            traceId,
            actorType: "system",
            actorId: "razorpay_webhook",
            eventType: "webhook_refund_failed",
            paymentActionId: refundAction.payment_action_id,
            explanation: `Razorpay reported refund ${refundId} as failed: ${refundEntity.error_description || "Unknown reason"}. The refund may be retried from the merchant console.`,
            providerRefs: { razorpayRefundId: refundId },
          });
        }
      }
    }

    // Record webhook event in DB
    await db.insert(webhookEvents).values({
      id: generateId("we"),
      provider_event_id: providerEventId,
      provider: "razorpay",
      raw_payload: payload,
      status: "processed",
    });

    return NextResponse.json({ status: "success", received: true });
  } catch (error) {
    console.error("Error processing Razorpay webhook:", error);
    return NextResponse.json(
      {
        error: "Internal webhook processing error",
      },
      { status: 500 },
    );
  }
}
