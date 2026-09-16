import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import {
  cartMandates,
  db,
  paymentActions,
  products,
  refundActions,
  runTransaction,
  toStatement,
  webhookEvents,
} from "@/db";
import { logAuditEvent } from "@/lib/audit/logger";
import { verifyWebhookSignature } from "@/lib/payments/razorpay";
import { generateId, generateTraceId } from "@/lib/utils";
import type {
  WebhookDedupeCheck,
  WebhookLogStatus,
} from "@/lib/webhooks/inspector-store";
import { webhookInspectorStore } from "@/lib/webhooks/inspector-store";

export const dynamic = "force-dynamic";

interface RazorpayWebhookPayload {
  event?: string;
  id?: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        error_description?: string;
      };
    };
    order?: {
      entity?: {
        id?: string;
      };
    };
    refund?: {
      entity?: {
        id?: string;
        payment_id?: string;
        error_description?: string;
      };
    };
  };
}

/**
 * Razorpay webhook handler.
 *
 * Hardening:
 *  1. Claims the event FIRST (`INSERT ... ON CONFLICT DO NOTHING`) so at-most-one
 *     worker holds it — no select-then-process race allows double settlement or
 *     double inventory decrement on duplicate deliveries.
 *  2. Browser/state-machine writes commit through `runTransaction` (one atomic
 *     HTTP request, serializable) — a mid-processing failure rolls back and
 *     leaves the event `failed` for the next delivery to take over.
 *  3. `processed` events are acknowledgements-only idempotent skips; `failed`
 *     events are re-clamed on retry. Signature-mismatch events are rejected
 *     before any claim.
 */
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

    let payload: RazorpayWebhookPayload = {};
    try {
      payload = JSON.parse(rawBody) as RazorpayWebhookPayload;
    } catch {
      payload = { raw: rawBody } as RazorpayWebhookPayload;
    }

    const eventType = payload.event || "unknown";
    const providerEventId =
      eventIdHeader || payload.id || `evt_${generateId()}`;

    if (!isSignatureValid) {
      webhookInspectorStore.addLog({
        provider: "razorpay",
        providerEventId,
        eventType,
        rawBody: rawBody.slice(0, 300),
        receivedSignature: signature || "(missing)",
        computedHmac,
        signatureMatch: false,
        dedupeCheck: "NEW_EVENT",
        action:
          "❌ REJECTED: Cryptographic HMAC signature mismatch. Webhook discarded.",
        status: "REJECTED_SIGNATURE",
      });

      return NextResponse.json(
        { error: "Invalid webhook signature" },
        { status: 401 },
      );
    }

    const inspectorLog = (overrides: {
      dedupeCheck: WebhookDedupeCheck;
      status: WebhookLogStatus;
      action: string;
    }) =>
      webhookInspectorStore.addLog({
        provider: "razorpay",
        providerEventId,
        eventType,
        rawBody: rawBody.slice(0, 300),
        receivedSignature: signature,
        computedHmac,
        signatureMatch: true,
        ...overrides,
      });

    // (1) Claim the event. At-most-one caller inserts the row; a conflicting
    // insert returns no row, which means someone else owns or finished it.
    const [claim] = await db
      .insert(webhookEvents)
      .values({
        provider_event_id: providerEventId,
        provider: "razorpay",
        raw_payload: payload,
        status: "received",
      })
      .onConflictDoNothing()
      .returning({ id: webhookEvents.id });

    if (claim) {
      try {
        await processEvent({
          payload,
          eventType,
          webhookEventId: claim.id,
          traceId,
        });
        inspectorLog({
          dedupeCheck: "NEW_EVENT",
          status: "PROCESSED",
          action: `✅ FORWARDED: Valid HMAC match. Forwarding to merchant state machine (event: ${eventType}).`,
        });
        return NextResponse.json({ status: "success", received: true });
      } catch (error) {
        // DLQ marker: keep the row, flip to `failed`, and let the provider's
        // retry take the event over. Never double-ack.
        await db
          .update(webhookEvents)
          .set({
            status: "failed",
            raw_payload: {
              ...payload,
              error: error instanceof Error ? error.message : String(error),
            },
          })
          .where(eq(webhookEvents.id, claim.id));
        inspectorLog({
          dedupeCheck: "FAILED_DLQ",
          status: "FAILED_DLQ",
          action: `⛔ PROCESSING FAILED → webhook ${providerEventId} parked as 'failed' for retry.`,
        });
        return NextResponse.json(
          { error: "Webhook processing failed" },
          { status: 500 },
        );
      }
    }

    // (2) Not the claimer. Figure out whether to ack, skip, or take over.
    const [existing] = await db
      .select({ id: webhookEvents.id, status: webhookEvents.status })
      .from(webhookEvents)
      .where(eq(webhookEvents.provider_event_id, providerEventId))
      .limit(1);

    if (!existing || existing.status === "processed") {
      inspectorLog({
        dedupeCheck: "DUPLICATE_SKIPPED",
        status: "SKIPPED_DUPLICATE",
        action:
          "⏭️ SKIPPED: Event already processed by state machine (idempotent no-op).",
      });
      return NextResponse.json(
        { status: "already_processed" },
        { status: 200 },
      );
    }

    if (existing.status === "received") {
      // A concurrent worker is mid-flight on it — acknowledge without racing.
      inspectorLog({
        dedupeCheck: "IN_FLIGHT",
        status: "IN_FLIGHT",
        action: "⏳ ACK: Event is being processed by another invocation.",
      });
      return NextResponse.json(
        { status: "already_processing" },
        { status: 200 },
      );
    }

    // status === "failed": take the event over atomically (only one retry can,
    // because the takeover UPDATE is conditioned on the failed state machine).
    const [takeover] = await db
      .update(webhookEvents)
      .set({ status: "received" })
      .where(
        and(
          eq(webhookEvents.provider_event_id, providerEventId),
          eq(webhookEvents.status, "failed"),
        ),
      )
      .returning({ id: webhookEvents.id });

    if (takeover) {
      try {
        await processEvent({
          payload,
          eventType,
          webhookEventId: takeover.id,
          traceId,
        });
        inspectorLog({
          dedupeCheck: "RETRY_TAKEOVER",
          status: "PROCESSED",
          action: `♻️ RETRIED: Failed webhook ${providerEventId} taken over and re-processed.`,
        });
        return NextResponse.json({
          status: "success",
          retried: true,
          received: true,
        });
      } catch (error) {
        await db
          .update(webhookEvents)
          .set({
            status: "failed",
            raw_payload: {
              ...payload,
              error: error instanceof Error ? error.message : String(error),
            },
          })
          .where(eq(webhookEvents.id, takeover.id));
        inspectorLog({
          dedupeCheck: "RETRY_TAKEOVER",
          status: "FAILED_DLQ",
          action: `⛔ RETRY FAILED → webhook ${providerEventId} re-parked as 'failed'.`,
        });
        return NextResponse.json(
          { error: "Webhook retry processing failed" },
          { status: 500 },
        );
      }
    }

    // Lost the takeover (another retry won) — acknowledge.
    inspectorLog({
      dedupeCheck: "TAKEOVER_LOST",
      status: "SKIPPED_DUPLICATE",
      action: "⏭️ SKIPPED: Another retry took the failed event over.",
    });
    return NextResponse.json({ status: "already_processing" }, { status: 200 });
  } catch (error) {
    console.error("Error processing Razorpay webhook:", error);
    return NextResponse.json(
      { error: "Internal webhook processing error" },
      { status: 500 },
    );
  }
}

async function processEvent(params: {
  payload: RazorpayWebhookPayload;
  eventType: string;
  webhookEventId: string;
  traceId: string;
}) {
  const { payload, eventType, webhookEventId, traceId } = params;

  if (eventType === "payment.captured" || eventType === "order.paid") {
    const paymentEntity = payload.payload?.payment?.entity || {};
    const orderId =
      paymentEntity.order_id || payload.payload?.order?.entity?.id;
    const paymentId = paymentEntity.id || `pay_${generateId()}`;

    if (!orderId) {
      // Unknown order reference — nothing to settle; mark processed.
      await db
        .update(webhookEvents)
        .set({ status: "processed" })
        .where(eq(webhookEvents.id, webhookEventId));
      return;
    }

    // Single read: payment action + its cart in one JOIN.
    const [row] = await db
      .select({
        action: paymentActions,
        cart: cartMandates,
      })
      .from(paymentActions)
      .innerJoin(
        cartMandates,
        eq(cartMandates.id, paymentActions.cart_mandate_id),
      )
      .where(eq(paymentActions.razorpay_order_id, orderId))
      .limit(1);

    if (!row) {
      // Payment for an order we never issued — log for visibility, ack.
      await logAuditEvent({
        traceId,
        actorType: "system",
        actorId: "razorpay_webhook",
        eventType: "webhook_orphan_payment",
        explanation: `Razorpay ${eventType} for unknown order ${orderId}. No payment action exists for this order.`,
        providerRefs: {
          razorpayOrderId: orderId,
          razorpayPaymentId: paymentId,
        },
      });
      await db
        .update(webhookEvents)
        .set({ status: "processed" })
        .where(eq(webhookEvents.id, webhookEventId));
      return;
    }

    const alreadySettled = row.action.status === "completed";
    const items =
      (row.cart.items as Array<{ variantId: string; quantity: number }>) || [];

    const statements = [
      toStatement(
        db
          .update(paymentActions)
          .set({
            status: "completed",
            razorpay_payment_id: paymentId,
            updated_at: new Date(),
          })
          .where(eq(paymentActions.id, row.action.id)),
      ),
      // Only decrement inventory on the FIRST settlement — a duplicate or a
      // reprocessed delivery must never double-count stock.
      ...(!alreadySettled
        ? [
            toStatement(
              db
                .update(cartMandates)
                .set({ status: "completed" })
                .where(eq(cartMandates.id, row.cart.id)),
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
                        )}) AS data(variant_id, qty)`,
                      )
                      .where(sql`${products.variant_id} = data.variant_id`),
                  ),
                ]
              : []),
          ]
        : []),
      toStatement(
        db
          .update(webhookEvents)
          .set({ status: "processed" })
          .where(eq(webhookEvents.id, webhookEventId)),
      ),
    ];
    await runTransaction(statements);

    await logAuditEvent({
      traceId,
      actorType: "system",
      actorId: "razorpay_webhook",
      eventType: "webhook_payment_captured",
      cartMandateId: row.cart.id,
      paymentActionId: row.action.id,
      explanation: `Razorpay payment ${paymentId} captured for order ${orderId}${alreadySettled ? " (already settled; no re-processing)" : ""}.`,
      providerRefs: {
        razorpayPaymentId: paymentId,
        razorpayOrderId: orderId,
      },
    });
    return;
  }

  if (eventType === "payment.failed") {
    const paymentEntity = payload.payload?.payment?.entity || {};
    const orderId = paymentEntity.order_id;

    if (orderId) {
      const [action] = await db
        .select()
        .from(paymentActions)
        .where(eq(paymentActions.razorpay_order_id, orderId))
        .limit(1);

      if (action && action.status !== "completed") {
        await runTransaction([
          toStatement(
            db
              .update(paymentActions)
              .set({ status: "failed", updated_at: new Date() })
              .where(eq(paymentActions.id, action.id)),
          ),
          // The order leaves `payment_pending` and becomes `failed` — it is
          // never (and was never) treated as paid.
          toStatement(
            db
              .update(cartMandates)
              .set({ status: "failed" })
              .where(eq(cartMandates.id, action.cart_mandate_id)),
          ),
          toStatement(
            db
              .update(webhookEvents)
              .set({ status: "processed" })
              .where(eq(webhookEvents.id, webhookEventId)),
          ),
        ]);

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
      } else {
        await db
          .update(webhookEvents)
          .set({ status: "processed" })
          .where(eq(webhookEvents.id, webhookEventId));
      }
    } else {
      await db
        .update(webhookEvents)
        .set({ status: "processed" })
        .where(eq(webhookEvents.id, webhookEventId));
    }
    return;
  }

  if (
    eventType === "refund.created" ||
    eventType === "refund.processed" ||
    eventType === "refund.completed"
  ) {
    const refundEntity = payload.payload?.refund?.entity || {};
    const refundId = refundEntity.id;
    const paymentId = refundEntity.payment_id;

    const [refundAction] = refundId
      ? await db
          .select()
          .from(refundActions)
          .where(eq(refundActions.razorpay_refund_id, refundId))
          .limit(1)
      : [];

    if (refundAction) {
      const [action] = await db
        .select()
        .from(paymentActions)
        .where(eq(paymentActions.id, refundAction.payment_action_id))
        .limit(1);

      await runTransaction([
        toStatement(
          db
            .update(refundActions)
            .set({ status: "completed" })
            .where(eq(refundActions.id, refundAction.id)),
        ),
        ...(action
          ? [
              toStatement(
                db
                  .update(paymentActions)
                  .set({ status: "refunded", updated_at: new Date() })
                  .where(eq(paymentActions.id, action.id)),
              ),
            ]
          : []),
        toStatement(
          db
            .update(webhookEvents)
            .set({ status: "processed" })
            .where(eq(webhookEvents.id, webhookEventId)),
        ),
      ]);

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
    } else {
      await db
        .update(webhookEvents)
        .set({ status: "processed" })
        .where(eq(webhookEvents.id, webhookEventId));
    }
    return;
  }

  if (eventType === "refund.failed") {
    const refundEntity = payload.payload?.refund?.entity || {};
    const refundId = refundEntity.id;
    const [refundAction] = refundId
      ? await db
          .select()
          .from(refundActions)
          .where(eq(refundActions.razorpay_refund_id, refundId))
          .limit(1)
      : [];

    if (refundAction) {
      await runTransaction([
        toStatement(
          db
            .update(refundActions)
            .set({ status: "failed" })
            .where(eq(refundActions.id, refundAction.id)),
        ),
        toStatement(
          db
            .update(webhookEvents)
            .set({ status: "processed" })
            .where(eq(webhookEvents.id, webhookEventId)),
        ),
      ]);

      await logAuditEvent({
        traceId,
        actorType: "system",
        actorId: "razorpay_webhook",
        eventType: "webhook_refund_failed",
        paymentActionId: refundAction.payment_action_id,
        explanation: `Razorpay reported refund ${refundId} as failed: ${refundEntity.error_description || "Unknown reason"}. The refund may be retried from the merchant console.`,
        providerRefs: { razorpayRefundId: refundId },
      });
    } else {
      await db
        .update(webhookEvents)
        .set({ status: "processed" })
        .where(eq(webhookEvents.id, webhookEventId));
    }
    return;
  }

  // Unhandled event type: ack without side effects.
  await db
    .update(webhookEvents)
    .set({ status: "processed" })
    .where(eq(webhookEvents.id, webhookEventId));
}
