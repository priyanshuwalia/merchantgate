/**
 * Fixed-window in-memory rate limiter.
 *
 * Deliberately lightweight and process-local: sufficient to stop a single
 * abusive buyer/agent from hammering money endpoints in a demo, without adding
 * a cache dependency. Sliding-window leaders can be swapped in for production.
 */

import { NextResponse } from "next/server";

const globalStore = globalThis as unknown as {
  __agentpayRateLimits?: Map<string, { windowStart: number; count: number }>;
};

const store: Map<string, { windowStart: number; count: number }> =
  globalStore.__agentpayRateLimits || new Map();
globalStore.__agentpayRateLimits = store;

// Opportunistic prune so the map never grows past bounded agents.
function prune() {
  if (store.size > 5000) {
    const now = Date.now();
    for (const [key, rec] of store) {
      if (now - rec.windowStart > 60_000) store.delete(key);
    }
  }
}

export interface RateLimitInfo {
  ok: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

export function checkRateLimit(
  key: string,
  opts: { limit: number; windowSeconds?: number },
): RateLimitInfo {
  const windowSeconds = opts.windowSeconds ?? 60;
  const limit = Math.max(1, Math.floor(opts.limit));
  const now = Date.now();
  prune();

  const bucket = store.get(key);
  if (!bucket || now - bucket.windowStart >= windowSeconds * 1000) {
    store.set(key, { windowStart: now, count: 1 });
    return { ok: true, limit, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  if (bucket.count >= limit) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((bucket.windowStart + windowSeconds * 1000 - now) / 1000),
    );
    return { ok: false, limit, remaining: 0, retryAfterSeconds };
  }

  bucket.count += 1;
  return {
    ok: true,
    limit,
    remaining: limit - bucket.count,
    retryAfterSeconds: 0,
  };
}

export function rateLimitHeaders(info: RateLimitInfo): Record<string, string> {
  return {
    "x-ratelimit-limit": String(info.limit),
    "x-ratelimit-remaining": String(info.remaining),
    "x-ratelimit-reset": String(info.retryAfterSeconds),
  };
}

/** Best-effort client IP from reverse-proxy / Next headers. */
function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim() || "unknown";
  return (
    request.headers.get("x-real-ip") ||
    request.headers.get("cf-connecting-ip") ||
    "unknown"
  );
}

/**
 * Per-client rate limit for the internal HTTP API routes. Uses a namespace key
 * scoped to mount + client IP so a single abusive caller cannot hammer an
 * expensive/state-changing endpoint (LLM quota burning, brute-force login,
 * refunds, approvals, etc.). Returns a 429 NextResponse when the limit has been
 * exceeded (with standard headers), otherwise null so the caller proceeds.
 */
export function rateLimitRequest(
  request: Request,
  opts: { limit: number; windowSeconds?: number; namespace: string },
): NextResponse | null {
  const ip = clientIp(request);
  const info = checkRateLimit(`${opts.namespace}:${ip}`, {
    limit: opts.limit,
    windowSeconds: opts.windowSeconds,
  });
  if (info.ok) return null;
  return NextResponse.json(
    {
      error: "RATE_LIMITED",
      message: `Rate limit of ${info.limit} requests / ${opts.windowSeconds ?? 60}s exceeded. Retry after ${info.retryAfterSeconds}s.`,
    },
    { status: 429, headers: rateLimitHeaders(info) },
  );
}
