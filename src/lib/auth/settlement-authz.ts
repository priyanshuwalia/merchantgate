import { NextResponse } from "next/server";
import {
  type AgentAuthResult,
  authenticateAgentRequest,
} from "@/lib/auth/agent-auth";
import { getSessionMerchantFromRequest } from "@/lib/auth/guard";

/**
 * Settlement authorization.
 *
 * Discovery is a public product surface — catalogue, search and negotiation are
 * meant to be reachable by any buyer agent. MOVING MONEY IS NOT. Before this
 * gate, `/v1/agent/checkout/confirm` called `authenticateAgentRequest` and threw
 * the result away, so a deployment running the default `demo` mode accepted
 * settlements from anyone on the internet: the route answered `404 Cart
 * mandate not found` to a request bearing a deliberately invalid API key, which
 * means it sailed past authentication into the cart lookup.
 *
 * Two credentials authorize a settlement:
 *
 *   1. A VERIFIED agent API key. `auth.keyVerified` is only true when the
 *      presented key hashes to a registered agent's stored `apiKeyHash` — a
 *      merely *present* key is not enough, because `demo` mode tolerates an
 *      invalid one by design.
 *   2. A valid merchant SESSION. This keeps the Agent Sandbox working without
 *      issuing agent keys: the operator is already signed in to the dashboard
 *      and the browser attaches the SameSite=Strict cookie to same-origin
 *      fetches automatically. The operator owns the platform, so letting them
 *      drive their own simulator is not a privilege escalation — and because
 *      `/api/simulation/run` is session-guarded and forwards the cookie, the
 *      server-side buyer agent is covered by the same path.
 *
 * Everything else is rejected. In particular there is no third path that
 * settles on a quote with neither credential.
 */
export interface SettlementAuthz {
  ok: boolean;
  /** How the caller proved itself; surfaced in audit events and responses. */
  principal: "agent_key" | "merchant_session" | null;
  agentId: string;
  merchantId: string | null;
  response?: NextResponse;
}

export async function authorizeSettlement(
  request: Request,
  merchantConfig: Record<string, unknown> | null,
): Promise<SettlementAuthz> {
  const agent: AgentAuthResult = await authenticateAgentRequest(request, {
    merchantConfig,
  });

  // Strict mode already produced a hard rejection (bad key, or over the limit).
  // Returning it here is what makes `AGENT_AUTH_MODE=strict` actually mean
  // anything on these routes.
  if (!agent.ok && agent.response) {
    return {
      ok: false,
      principal: null,
      agentId: agent.agentId,
      merchantId: null,
      response: agent.response,
    };
  }

  if (agent.keyVerified) {
    return {
      ok: true,
      principal: "agent_key",
      agentId: agent.agentId,
      merchantId: null,
    };
  }

  const merchantId = getSessionMerchantFromRequest(request);
  if (merchantId) {
    return {
      ok: true,
      principal: "merchant_session",
      agentId: agent.agentId,
      merchantId,
    };
  }

  return {
    ok: false,
    principal: null,
    agentId: agent.agentId,
    merchantId: null,
    response: NextResponse.json(
      {
        success: false,
        error: "SETTLEMENT_NOT_AUTHORIZED",
        decision: "DENY",
        message:
          "Settlement requires either a verified agent API key or an authenticated merchant session. Catalogue and negotiation remain open; money movement does not.",
        agentAuthMode: agent.mode,
        rateLimitRemaining: agent.rateLimitInfo.remaining,
      },
      { status: 401 },
    ),
  };
}
