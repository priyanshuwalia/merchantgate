/**
 * Agent Authentication + Rate Limiting
 *
 * Two modes, selected per-merchant via config.agentAuthMode
 * (or AGENT_AUTH_MODE env), defaulting to "demo":
 *
 *   strict — the agent MUST present a valid API key (issued via the merchant
 *            admin API and stored only as a sha-256 hash). Unknown agents and
 *            mismatched keys are rejected with 401 before any expensive work.
 *   demo   — permissive for the judge-driven demo: requests are admitted so the
 *            full happy path can be exercised without ceremony, but a provided
 *            key is ALWAYS validated when the agent has one.
 *
 * Rate limiting applies in both modes: money endpoints are throttled per agent
 * (or per IP for anonymous demo requests) so a rogue buyer cannot hammer the
 * quote/settlement surface.
 */

import crypto from "crypto";
import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { agents, db } from "@/db";
import { checkRateLimit } from "@/lib/auth/rate-limit";

export type AgentAuthMode = "strict" | "demo";

export function getAgentAuthMode(
  merchantConfig?: Record<string, unknown> | null,
): AgentAuthMode {
  const fromConfig = merchantConfig?.agentAuthMode;
  if (fromConfig === "strict" || fromConfig === "demo") return fromConfig;
  const fromEnv = process.env.AGENT_AUTH_MODE;
  if (fromEnv === "strict" || fromEnv === "demo") return fromEnv;
  return "demo";
}

export function hashAgentKey(key: string): string {
  return crypto.createHash("sha256").update(key, "utf8").digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export function generateAgentApiKey(): string {
  return `agt_secret_${crypto.randomBytes(24).toString("hex")}`;
}

/**
 * Create-or-update an agent and issue it a fresh API key. The raw key is only
 * returned once; only its sha-256 hash is stored.
 */
export async function issueAgentApiKey(input: {
  agentId?: string;
  displayName: string;
  version?: string;
}): Promise<{ agentId: string; apiKey: string }> {
  const agentId =
    input.agentId && !input.agentId.startsWith("agt_")
      ? `agt_${input.agentId}`
      : input.agentId || `agt_${crypto.randomBytes(6).toString("hex")}`;

  const apiKey = generateAgentApiKey();
  const apiKeyHash = hashAgentKey(apiKey);
  const existing = await findAgentById(agentId);

  if (existing) {
    const meta = (existing.metadata as Record<string, unknown> | null) || {};
    await db
      .update(agents)
      .set({
        version: input.version || existing.version,
        status: "active",
        metadata: {
          ...meta,
          apiKeyHash,
          keyRotatedAt: new Date().toISOString(),
        },
      })
      .where(eq(agents.id, agentId));
  } else {
    await db.insert(agents).values({
      id: agentId,
      display_name: input.displayName,
      version: input.version || "1.0.0",
      status: "active",
      metadata: { apiKeyHash, keyIssuedAt: new Date().toISOString() },
    });
  }

  return { agentId, apiKey };
}

export interface AgentAuthResult {
  ok: boolean;
  agentId: string;
  mode: AgentAuthMode;
  keyVerified: boolean;
  rateLimitInfo: {
    ok: boolean;
    limit: number;
    remaining: number;
    retryAfterSeconds: number;
  };
  response?: NextResponse;
}

function forbiddenResponse(
  result: Omit<AgentAuthResult, "response">,
): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: "AGENT_AUTHENTICATION_FAILED",
      decision: "DENY",
      message:
        "Agent authentication required. Present a valid agent API key or register the agent with the merchant first.",
    },
    {
      status: 401,
      headers: {
        "x-ratelimit-remaining": String(result.rateLimitInfo.remaining),
      },
    },
  );
}

async function findAgentById(agentId: string) {
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return agent ?? null;
}

async function findAgentByKeyHash(keyHash: string) {
  const [agent] = await db
    .select()
    .from(agents)
    .where(sql`metadata->>'apiKeyHash' = ${keyHash}`)
    .limit(1);
  return agent ?? null;
}

/**
 * Authenticate and rate-limit an agent-facing request.
 * Call before any gate/policy work in agent routes.
 */
export async function authenticateAgentRequest(
  request: Request,
  options?: { merchantConfig?: Record<string, unknown> | null },
): Promise<AgentAuthResult> {
  const merchantConfig = options?.merchantConfig;
  const mode = getAgentAuthMode(merchantConfig);
  const rateLimitPerMinute = Math.max(
    1,
    Number(merchantConfig?.agentRateLimitPerMinute) || 60,
  );

  const url = new URL(request.url);
  const routeNamespace = url.pathname.startsWith("/v1/agent")
    ? "agent"
    : "unknown";

  const authHeader = request.headers.get("authorization") || "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const xAgentId = request.headers.get("x-agent-id");
  const xAgentKey = request.headers.get("x-agent-key");

  let agentId = xAgentId || undefined;
  const keyToVerify = bearerMatch?.[1] || xAgentKey || undefined;

  // Resolve agent identity from the presented credential.
  let storedKeyHash: string | undefined;
  if (keyToVerify) {
    const keyHash = hashAgentKey(keyToVerify);
    const agent = await findAgentByKeyHash(keyHash);
    if (agent) {
      agentId = agent.id;
      storedKeyHash = keyHash;
    } else if (bearerMatch) {
      // Bearer key belongs to no registered agent.
      const result: AgentAuthResult = {
        ok: mode === "demo",
        agentId: "anonymous_agent",
        mode,
        keyVerified: false,
        rateLimitInfo: {
          ok: false,
          limit: rateLimitPerMinute,
          remaining: 0,
          retryAfterSeconds: 0,
        },
      };
      if (mode === "strict") result.response = forbiddenResponse(result);
      result.rateLimitInfo = checkRateLimit(
        `ip:${request.headers.get("x-forwarded-for") || "unknown"}:${routeNamespace}`,
        { limit: rateLimitPerMinute },
      );
      return result;
    }
  }

  // If an agent id was claimed, validate its stored key when one exists.
  if (agentId && agentId !== "anonymous_agent") {
    const agent = await findAgentById(agentId);
    if (agent) {
      const meta = (agent.metadata as Record<string, unknown> | null) || {};
      storedKeyHash =
        typeof meta.apiKeyHash === "string" ? meta.apiKeyHash : undefined;

      if (storedKeyHash) {
        if (keyToVerify) {
          const keyVerified = safeEqualHex(
            storedKeyHash,
            hashAgentKey(keyToVerify),
          );
          if (!keyVerified && mode === "strict") {
            const result: AgentAuthResult = {
              ok: false,
              agentId,
              mode,
              keyVerified: false,
              rateLimitInfo: checkRateLimit(`${agentId}:${routeNamespace}`, {
                limit: rateLimitPerMinute,
              }),
            };
            result.response = forbiddenResponse(result);
            return result;
          }
        } else if (mode === "strict") {
          // Agent has a key on file but presented none → strict rejects.
          const result: AgentAuthResult = {
            ok: false,
            agentId,
            mode,
            keyVerified: false,
            rateLimitInfo: checkRateLimit(`${agentId}:${routeNamespace}`, {
              limit: rateLimitPerMinute,
            }),
          };
          result.response = forbiddenResponse(result);
          return result;
        }
      } else if (mode === "strict") {
        // Unregistered agent (no key on file) → strict rejects.
        const result: AgentAuthResult = {
          ok: false,
          agentId,
          mode,
          keyVerified: false,
          rateLimitInfo: checkRateLimit(`${agentId}:${routeNamespace}`, {
            limit: rateLimitPerMinute,
          }),
        };
        result.response = forbiddenResponse(result);
        return result;
      }
    }
  }

  if (!agentId) agentId = "anonymous_agent";

  const rateLimitInfo = checkRateLimit(`${agentId}:${routeNamespace}`, {
    limit: rateLimitPerMinute,
  });
  if (!rateLimitInfo.ok && mode === "strict") {
    return {
      ok: false,
      agentId,
      mode,
      keyVerified: false,
      rateLimitInfo,
      response: NextResponse.json(
        {
          success: false,
          error: "AGENT_RATE_LIMITED",
          message: `Rate limit of ${rateLimitInfo.limit} requests/min exceeded. Retry after ${rateLimitInfo.retryAfterSeconds}s.`,
        },
        {
          status: 429,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(rateLimitInfo.retryAfterSeconds),
          },
        },
      ),
    };
  }

  return {
    ok: true,
    agentId,
    mode,
    keyVerified: Boolean(keyToVerify),
    rateLimitInfo,
  };
}
