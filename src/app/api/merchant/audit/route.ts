import { and, desc, eq, sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { auditEvents, db } from "@/db";
import { requireMerchantAuth } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

const SAFE_EVENT_TYPES = new Set([
  "agent_verification",
  "checkout_quoted",
  "campaign_created",
  "campaign_ended",
  "campaign_discount_applied",
  "negotiation_opened",
  "negotiation_responded",
  "negotiation_agreed",
  "payment_settled",
  "payment_failed",
  "payment_verified_settled",
  "merchant_order_refunded",
  "security_payment_signature_failed",
  "security_toctou_violation",
  "surge_settlement_blocked",
  "upsell_offers_generated",
  "agent_api_key_issued",
  "webhook_received",
  "webhook_payment_captured",
  "webhook_payment_failed",
  "webhook_refund_confirmed",
  "webhook_refund_failed",
  "merchant_gate_changed",
]);

function stripUnsafeTypes(value: string | null): string | undefined {
  if (!value || !SAFE_EVENT_TYPES.has(value)) return undefined;
  return value;
}

/**
 * GET /api/merchant/audit — time-ordered audit trail for the merchant console.
 *
 * Query params (all optional):
 *   limit   — page size (default 30, max 100)
 *   eventType — filter by event type
 *   traceId — filter by trace id
 *   actorType — filter by actor (agent/merchant/system)
 */
export async function GET(request: NextRequest) {
  const auth = requireMerchantAuth(request);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);
  const limit = Math.max(
    1,
    Math.min(100, Number(searchParams.get("limit")) || 30),
  );
  const eventType = stripUnsafeTypes(searchParams.get("eventType"));
  const traceId = searchParams.get("traceId")?.trim() || undefined;
  const actorType = ["agent", "merchant", "system"].includes(
    searchParams.get("actorType") || "",
  )
    ? searchParams.get("actorType")
    : undefined;

  const conditions = [];
  if (eventType) conditions.push(eq(auditEvents.event_type, eventType));
  if (traceId) conditions.push(eq(auditEvents.trace_id, traceId));
  if (actorType) conditions.push(eq(auditEvents.actor_type, actorType));

  try {
    const [rows, totalRow] = await Promise.all([
      db
        .select()
        .from(auditEvents)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(auditEvents.timestamp))
        .limit(limit),
      db
        .select({ count: sql<number>`count(*)` })
        .from(auditEvents)
        .where(conditions.length ? and(...conditions) : undefined),
    ]);

    return NextResponse.json({
      events: rows.map((row) => ({
        id: row.id,
        traceId: row.trace_id,
        sequenceNo: row.seq_no,
        timestamp: row.timestamp.toISOString(),
        actorType: row.actor_type,
        actorId: row.actor_id,
        eventType: row.event_type,
        intentMandateId: row.intent_mandate_id,
        cartMandateId: row.cart_mandate_id,
        decisionId: row.decision_id,
        paymentActionId: row.payment_action_id,
        reasonCodes: row.reason_codes,
        providerRefs: row.provider_refs,
        snapshotHash: row.snapshot_hash,
        explanation: row.explanation,
        metadata: row.metadata,
      })),
      total: Number(totalRow[0]?.count || 0),
      appliedFilters: {
        eventType: eventType || null,
        traceId: traceId || null,
        actorType: actorType || null,
      },
    });
  } catch (error) {
    console.error("Error fetching audit trail:", error);
    return NextResponse.json(
      { error: "Internal error fetching audit trail." },
      { status: 500 },
    );
  }
}