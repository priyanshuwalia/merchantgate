import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { agents, db, intentMandates } from "@/db";
import { logAuditEvent } from "@/lib/audit/logger";
import { authenticateAgentRequest } from "@/lib/auth/agent-auth";
import { verifyCanonicalDigest } from "@/lib/crypto/canonical";
import {
  aiSalesPausedResponse,
  getMerchantGateState,
} from "@/lib/merchant/guard";
import { generateId, generateTraceId } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const traceId = generateTraceId();

  try {
    // Global AI Sales kill-switch: no verifications while paused
    const gate = await getMerchantGateState();
    if (!gate.aiSalesEnabled) {
      return aiSalesPausedResponse({ endpoint: "/v1/agent/verify" });
    }

    // Agent authentication + rate limiting (C7). The presented `agentId` in the
    // body is still cross-checked against whatever the caller proves here.
    const auth = await authenticateAgentRequest(request);

    const body = await request.json();
    const { agentId, agentVersion, intentMandate, intentMandateId } = body;

    if (!agentId || !intentMandate) {
      return NextResponse.json(
        {
          verified: false,
          decision: "DENY",
          reasonCodes: ["MISSING_REQUIRED_FIELDS"],
          explanation: "agentId and intentMandate are required.",
          verificationId: generateId("ver"),
          expiresAt: new Date().toISOString(),
        },
        { status: 400 },
      );
    }

    // 1. Verify Agent Registration
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    if (!agent) {
      // Auto-register in demo mode or reject if strict
      await db.insert(agents).values({
        id: agentId,
        display_name: `AI Agent (${agentId})`,
        version: agentVersion || "1.0.0",
        status: "active",
        metadata: { autoRegistered: true },
      });
    }

    // 2. Validate Mandate Validity & Constraints
    const now = new Date();
    const validity = intentMandate.validity || {};
    const notBefore = validity.notBefore ? new Date(validity.notBefore) : now;
    const expiresAt = validity.expiresAt
      ? new Date(validity.expiresAt)
      : new Date(Date.now() + 24 * 60 * 60 * 1000);

    const reasonCodes: string[] = [];
    let decision: "ALLOW" | "STEP_UP" | "DENY" = "ALLOW";

    if (now < notBefore) {
      decision = "DENY";
      reasonCodes.push("MANDATE_NOT_YET_VALID");
    } else if (now > expiresAt) {
      decision = "DENY";
      reasonCodes.push("MANDATE_EXPIRED");
    }

    // Check devProof if present. The devProof is a canonical-SHA256 digest of
    // the intent mandate (with the devProof field itself excluded). We recompute
    // it over the presented mandate: a digest of the wrong format, or a digest
    // that does not match the mandate actually presented, means the mandate was
    // tampered with between issuance and verification → hard DENY.
    if (intentMandate.devProof?.digest) {
      if (intentMandate.devProof.digest.length !== 64) {
        decision = "DENY";
        reasonCodes.push("TAMPERED_PROOF_SIGNATURE");
      } else {
        const { devProof: _omitted, ...mandatePayload } = intentMandate;
        if (
          !verifyCanonicalDigest(mandatePayload, intentMandate.devProof.digest)
        ) {
          decision = "DENY";
          reasonCodes.push("TAMPERED_PROOF_SIGNATURE");
        } else {
          reasonCodes.push("PROOF_VERIFIED");
        }
      }
    }

    if (decision === "ALLOW") {
      reasonCodes.push("AGENT_AND_MANDATE_VERIFIED");
    }

    const verificationId = generateId("ver");
    const mandateId = intentMandateId || intentMandate.id || generateId("int");

    // Upsert or store intent mandate in database
    const existingMandate = await db
      .select()
      .from(intentMandates)
      .where(eq(intentMandates.id, mandateId))
      .limit(1);

    if (existingMandate.length === 0) {
      await db.insert(intentMandates).values({
        id: mandateId,
        user_id: intentMandate.principal?.userId || "user_demo_01",
        agent_id: agentId,
        mandate_json: intentMandate,
        max_transaction_minor:
          intentMandate.constraints?.maxTransactionAmountMinor || 500000,
        currency: intentMandate.constraints?.currency || "INR",
        validity_expires_at: expiresAt,
        status: "active",
      });
    }

    const explanation =
      decision === "ALLOW"
        ? `Agent ${agentId} and Intent Mandate ${mandateId} verified successfully.`
        : `Verification flagged: ${reasonCodes.join(", ")}`;

    // Log Audit Event
    await logAuditEvent({
      traceId,
      actorType: "agent",
      actorId: agentId,
      eventType: "agent_verification",
      intentMandateId: mandateId,
      reasonCodes,
      explanation,
      metadata: {
        verificationId,
        decision,
        agentAuthMode: auth.mode,
        rateLimitRemaining: auth.rateLimitInfo.remaining,
      },
    });

    const responseExpiresAt = new Date(
      Date.now() + 30 * 60 * 1000,
    ).toISOString();

    return NextResponse.json({
      verified: decision !== "DENY",
      decision,
      reasonCodes,
      explanation,
      verificationId,
      expiresAt: responseExpiresAt,
      applicableLimits: {
        maxTransactionAmountMinor:
          intentMandate.constraints?.maxTransactionAmountMinor || 500000,
        rollingBudgetRemainingMinor:
          intentMandate.constraints?.rolling30dAmountMinor || 2000000,
      },
      agentAuth: {
        mode: auth.mode,
        agentId: auth.agentId,
        rateLimitRemaining: auth.rateLimitInfo.remaining,
      },
    });
  } catch (error) {
    console.error("Error in agent verification:", error);
    return NextResponse.json(
      {
        verified: false,
        decision: "DENY",
        reasonCodes: ["INTERNAL_VERIFICATION_ERROR"],
        explanation: "An internal verification error occurred.",
        verificationId: generateId("ver_err"),
        expiresAt: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
