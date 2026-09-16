import { desc } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { agents, db } from "@/db";
import { logAuditEvent } from "@/lib/audit/logger";
import { issueAgentApiKey } from "@/lib/auth/agent-auth";
import { requireMerchantAuth } from "@/lib/auth/guard";
import { generateTraceId } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * GET /api/merchant/agents — list registered buyer agents and whether they
 * hold a provisioned API key (never the key itself).
 */
export async function GET(request: NextRequest) {
  const auth = requireMerchantAuth(request);
  if (auth instanceof NextResponse) return auth;

  const rows = await db
    .select()
    .from(agents)
    .orderBy(desc(agents.created_at))
    .limit(100);

  return NextResponse.json({
    agents: rows.map((agent) => {
      const meta = (agent.metadata as Record<string, unknown> | null) || {};
      return {
        agentId: agent.id,
        displayName: agent.display_name,
        version: agent.version,
        status: agent.status,
        hasApiKey: Boolean(meta.apiKeyHash),
        keyIssuedAt: meta.keyIssuedAt || meta.keyRotatedAt || null,
        createdAt: agent.created_at.toISOString(),
      };
    }),
  });
}

/**
 * POST /api/merchant/agents — create-or-update an agent and issue a fresh API
 * key. The raw key is returned exactly once (as agent credentials); only its
 * sha-256 hash is stored.
 *
 * Body: { agentId?, agentName, version? }
 */
export async function POST(request: NextRequest) {
  const auth = requireMerchantAuth(request);
  if (auth instanceof NextResponse) return auth;

  const traceId = generateTraceId();

  try {
    const body = await request.json().catch(() => ({}));
    const displayName = String(body.agentName || body.displayName || "").trim();
    if (!displayName) {
      return NextResponse.json(
        { error: "agentName is required." },
        { status: 400 },
      );
    }

    const agentId = body.agentId ? String(body.agentId).trim() : undefined;
    const version = body.version ? String(body.version) : undefined;

    const { agentId: issuedAgentId, apiKey } = await issueAgentApiKey({
      agentId,
      displayName,
      version,
    });

    await logAuditEvent({
      traceId,
      actorType: "merchant",
      actorId: "merchant_admin",
      eventType: "agent_api_key_issued",
      explanation: `Issued a fresh agent API key for agent ${issuedAgentId} (${displayName}). Raw key returned once; only the sha-256 hash is stored.`,
      metadata: { agentId: issuedAgentId, version: version || "1.0.0" },
    });

    return NextResponse.json({
      success: true,
      agentId: issuedAgentId,
      displayName,
      apiKey,
      note: "Store this key securely. It is only returned once.",
    });
  } catch (error) {
    console.error("Error issuing agent API key:", error);
    return NextResponse.json(
      { error: "Internal error issuing agent API key." },
      { status: 500 },
    );
  }
}
