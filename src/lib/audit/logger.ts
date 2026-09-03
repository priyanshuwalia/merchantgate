import { auditEvents, db } from "@/db";
import { generateCanonicalDigest } from "@/lib/crypto/canonical";

export interface LogAuditParams {
  traceId: string;
  actorType: "agent" | "merchant" | "system";
  actorId: string;
  eventType: string;
  explanation: string;
  intentMandateId?: string;
  cartMandateId?: string;
  decisionId?: string;
  paymentActionId?: string;
  reasonCodes?: string[];
  providerRefs?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export async function logAuditEvent(params: LogAuditParams) {
  try {
    // Generate snapshot hash of this event's salient content
    const snapshotHash = generateCanonicalDigest({
      traceId: params.traceId,
      actorType: params.actorType,
      actorId: params.actorId,
      eventType: params.eventType,
      intentMandateId: params.intentMandateId,
      cartMandateId: params.cartMandateId,
      decisionId: params.decisionId,
      paymentActionId: params.paymentActionId,
      reasonCodes: params.reasonCodes,
      explanation: params.explanation,
      metadata: params.metadata,
    });

    // Sequence number per trace or global count
    const [inserted] = await db
      .insert(auditEvents)
      .values({
        trace_id: params.traceId,
        seq_no: 1, // Drizzle can auto-insert or we calculate
        actor_type: params.actorType,
        actor_id: params.actorId,
        event_type: params.eventType,
        intent_mandate_id: params.intentMandateId,
        cart_mandate_id: params.cartMandateId,
        decision_id: params.decisionId,
        payment_action_id: params.paymentActionId,
        reason_codes: params.reasonCodes || [],
        provider_refs: params.providerRefs || {},
        snapshot_hash: snapshotHash,
        explanation: params.explanation,
        metadata: params.metadata || {},
      })
      .returning();

    return inserted;
  } catch (error) {
    console.error("Failed to log audit event:", error);
    return null;
  }
}
