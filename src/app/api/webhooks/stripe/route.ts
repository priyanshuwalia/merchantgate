import { eq, sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import {
  cartMandates,
  db,
  paymentActions,
  refundActions,
  runTransaction,
  sqlClient,
  toStatement,
  webhookEvents,
} from "@/db";
import { logAuditEvent } from "@/lib/audit/logger";
import { claimSettlementSql } from "@/lib/payments/settlement-claim";
import { verifyStripeWebhook } from "@/lib/payments/stripe";
import { generateTraceId } from "@/lib/utils";
import type {
  WebhookDedupeCheck,
  WebhookLogStatus,
} from "@/lib/webhooks/inspector-store";
import { webhookInspectorStore } from "@/lib/webhooks/inspector-store";

export const dynamic = "force-dynamic";

/**
 * Stripe webhook handler.
 *
 * Settles autonomously-created PaymentIntents that confirm asynchronously
 * (`processing` / `requires_action`) and reconciles Stripe refunds. Security
 * posture mirrors the Razorpay webhook:
 *  - signature verified with `stripe.webhooks.constructEvent` (fail closed),
 *  - claim-first `webhook_events` dedup (`ON CONFLICT DO NOTHING`) so a payout
 *    can only settle once,
 *  - state transitions commit through `runTransaction`; failed events are
 *    atomically taken over by a retry delivery.
 */
export async function POST(request: NextRequest) {
  const traceId = generateTraceId();

  try {
    const rawBody = await request.text();
    const signature = request.headers.get("stripe-signature") || "";
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error(
        "[webhook] STRIPE_WEBHOOK_SECRET is not configured; rejecting webhook.",
      );
      return NextResponse.json(
        { error: "Webhook secret not configured." },
        { status: 503 },
      );
    }

    let event: ReturnType<typeof verifyStripeWebhook>;
    try {
      event = verifyStripeWebhook(rawBody, signature, webhookSecret);
    } catch {
      webhookInspectorStore.addLog({
        provider: "stripe",
        providerEventId: `evt_${generateTraceId()}`,
        eventType: "unknown",
        rawBody: rawBody.slice(0, 300),
        receivedSignature: signature || "(missing)",
        computedHmac: "(stripe v1 signature — no hmac)",
        signatureMatch: false,
        dedupeCheck: "NEW_EVENT",
        action:
          "❌ REJECTED: Stripe signature validation failed. Webhook discarded.",
        status: "REJECTED_SIGNATURE",
      });
      return NextResponse.json(
        { error: "Invalid webhook signature" },
        { status: 401 },
      );
    }

    const eventType = event.type;
    const providerEventId = event.id;

    const inspectorLog = (overrides: {
      dedupeCheck: WebhookDedupeCheck;
      status: WebhookLogStatus;
      action: string;
    }) =>
      webhookInspectorStore.addLog({
        provider: "stripe",
        providerEventId,
        eventType,
        rawBody: rawBody.slice(0, 300),
        receivedSignature: signature,
        computedHmac: "(stripe v1 signature — no hmac)",
        signatureMatch: true,
        ...overrides,
      });

    // (1) Claim the event. At-most-one caller inserts the row.
    const [claim] = await db
      .insert(webhookEvents)
      .values({
        provider_event_id: providerEventId,
        provider: "stripe",
        raw_payload: JSON.parse(rawBody),
        status: "received",
      })
      .onConflictDoNothing()
      .returning({ id: webhookEvents.id });

    if (claim) {
      try {
        await processEvent({
          payload: event as unknown as StripeWebhookEvent,
          eventType,
          webhookEventId: claim.id,
          traceId,
        });
        inspectorLog({
          dedupeCheck: "NEW_EVENT",
          status: "PROCESSED",
          action: `✅ FORWARDED: Valid Stripe signature. Forwarding to merchant state machine (event: ${eventType}).`,
        });
        return NextResponse.json({ status: "success", received: true });
      } catch (error) {
        await db
          .update(webhookEvents)
          .set({
            status: "failed",
            raw_payload: {
              ...event,
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

    // (2) Not the claimer: ack, skip, or take over a failed event.
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

    const [takeover] = await db
      .update(webhookEvents)
      .set({ status: "received" })
      .where(
        sql`${webhookEvents.provider_event_id} = ${providerEventId} AND ${webhookEvents.status} = 'failed'`,
      )
      .returning({ id: webhookEvents.id });

    if (takeover) {
      try {
        await processEvent({
          payload: event as unknown as StripeWebhookEvent,
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
              ...event,
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

    inspectorLog({
      dedupeCheck: "TAKEOVER_LOST",
      status: "SKIPPED_DUPLICATE",
      action: "⏭️ SKIPPED: Another retry took the failed event over.",
    });
    return NextResponse.json({ status: "already_processing" }, { status: 200 });
  } catch (error) {
    console.error("Error processing Stripe webhook:", error);
    return NextResponse.json(
      { error: "Internal webhook processing error" },
      { status: 500 },
    );
  }
}

interface StripeWebhookEvent {
  type: string;
  id: string;
  data: {
    object: {
      id?: string;
      payment_intent?: string;
      status?: string;
      failure_message?: string | null;
      latest_charge?: string;
      refunds?: { data?: Array<{ id?: string }> };
    };
  };
}

async function processEvent(params: {
  payload: StripeWebhookEvent;
  eventType: string;
  webhookEventId: string;
  traceId: string;
}) {
  const { payload, eventType, webhookEventId, traceId } = params;
  const obj = payload.data.object;
  const paymentIntentId = obj.payment_intent || obj.id;

  if (eventType === "payment_intent.succeeded") {
    if (!paymentIntentId) {
      await markProcessed(webhookEventId);
      return;
    }

    // Look up the payment action whose (generic) provider-intent ref is this
    // Stripe PaymentIntent id.
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
      .where(eq(paymentActions.razorpay_order_id, paymentIntentId))
      .limit(1);

    if (!row) {
      await logAuditEvent({
        traceId,
        actorType: "system",
        actorId: "stripe_webhook",
        eventType: "webhook_orphan_payment",
        explanation: `Stripe ${eventType} for unknown PaymentIntent ${paymentIntentId}. No payment action references this intent.`,
        providerRefs: { stripePaymentIntent: paymentIntentId },
      });
      await markProcessed(webhookEventId);
      return;
    }

    // The CTE claim below is what actually decides, in the database, whether
    // this delivery settles. Reading the action status first and branching in JS
    // was the same TOCTOU that let two Stripe events (e.g.
    // `payment_intent.succeeded` and `charge.succeeded`) both decrement stock
    // for one payment.

    const chargeId = obj.latest_charge || obj.id || paymentIntentId;
    const items =
      (row.cart.items as Array<{ variantId: string; quantity: number }>) || [];

    const claim = claimSettlementSql({
      actionId: row.action.id,
      cartId: row.cart.id,
      items,
      providerPaymentId: chargeId,
    });
    const claimResult = await sqlClient.query(claim.sql, claim.params);
    const didClaim = Number(claimResult[0]?.claimed_count ?? 0) > 0;

    // Provenance bookkeeping is independent of the claim and stays idempotent.
    await runTransaction([
      toStatement(
        db
          .update(paymentActions)
          .set({
            provider_metadata: {
              ...((row.action.provider_metadata as Record<string, unknown>) ||
                {}),
              provider: "stripe",
              method:
                (row.action.provider_metadata as Record<string, unknown> | null)
                  ?.method || "stripe_card",
              chargeId,
              settledVia: didClaim ? "webhook" : "api",
            },
            updated_at: new Date(),
          })
          .where(eq(paymentActions.id, row.action.id)),
      ),
      toStatement(
        db
          .update(webhookEvents)
          .set({ status: "processed" })
          .where(eq(webhookEvents.id, webhookEventId)),
      ),
    ]);

    if (!didClaim) {
      await logAuditEvent({
        traceId,
        actorType: "system",
        actorId: "webhook_replay_guard",
        eventType: "security_duplicate_settlement_rejected",
        paymentActionId: row.action.id,
        cartMandateId: row.cart.id,
        explanation:
          "Rejected duplicate settlement: this payment action was already completed, so no stock or cart effect was applied.",
        metadata: {
          paymentIntentId,
          chargeId,
          webhookEventId,
          claimed: false,
          idempotentReplay: true,
        },
      });
    }

    await logAuditEvent({
      traceId,
      actorType: "system",
      actorId: "stripe_webhook",
      eventType: "webhook_payment_captured",
      cartMandateId: row.cart.id,
      paymentActionId: row.action.id,
      explanation: `Stripe PaymentIntent ${paymentIntentId} succeeded${!didClaim ? " (duplicate settlement rejected; no re-processing)" : ""}. Charge ${chargeId} captured via webhook.`,
      providerRefs: {
        stripePaymentIntent: paymentIntentId,
        stripeChargeId: chargeId,
      },
    });
    return;
  }

  if (eventType === "payment_intent.payment_failed") {
    if (!paymentIntentId) {
      await markProcessed(webhookEventId);
      return;
    }

    const [action] = await db
      .select()
      .from(paymentActions)
      .where(eq(paymentActions.razorpay_order_id, paymentIntentId))
      .limit(1);

    if (action && action.status !== "completed") {
      await runTransaction([
        toStatement(
          db
            .update(paymentActions)
            .set({ status: "failed", updated_at: new Date() })
            .where(eq(paymentActions.id, action.id)),
        ),
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
        actorId: "stripe_webhook",
        eventType: "webhook_payment_failed",
        cartMandateId: action.cart_mandate_id,
        paymentActionId: action.id,
        explanation: `Stripe PaymentIntent ${paymentIntentId} failed: ${obj.failure_message || "Unknown reason"}.`,
        providerRefs: { stripePaymentIntent: paymentIntentId },
      });
    } else {
      await markProcessed(webhookEventId);
    }
    return;
  }

  if (eventType === "charge.refunded") {
    // The Stripe refund id (re_…) is stored in the refund action's provider
    // ref column. Find it via the refunds list on the charge.
    const refundId = obj.refunds?.data?.[0]?.id;
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
        actorId: "stripe_webhook",
        eventType: "webhook_refund_confirmed",
        paymentActionId: refundAction.payment_action_id,
        cartMandateId: action?.cart_mandate_id,
        explanation: `Stripe confirmed refund ${refundId} (event ${eventType}). Refund action ${refundAction.id} marked completed.`,
        providerRefs: { stripeRefundId: refundId },
      });
    } else {
      await markProcessed(webhookEventId);
    }
    return;
  }

  // Unhandled event type: ack without side effects.
  await markProcessed(webhookEventId);
}

async function markProcessed(webhookEventId: string) {
  await db
    .update(webhookEvents)
    .set({ status: "processed" })
    .where(eq(webhookEvents.id, webhookEventId));
}
