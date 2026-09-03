/**
 * Fixed-window in-memory rate limiter.
 *
 * Deliberately lightweight and process-local: sufficient to stop a single
 * abusive buyer/agent from hammering money endpoints in a demo, without adding
 * a cache dependency. Sliding-window leaders can be swapped in for production.
 */

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
