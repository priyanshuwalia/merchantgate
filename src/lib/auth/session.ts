import crypto from "node:crypto";

/** @constant Name of the signed session cookie used to authenticate the merchant dashboard. */
export const SESSION_COOKIE = "ap_merchant_session";

/** Session lifetime (12 hours). */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Resolve the server-side secret used to sign session cookies.
 *
 * Fails closed: in production a missing/too-short SESSION_SECRET is a hard
 * error so authentication can never silently degrade to a predictable key.
 */
export function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "SESSION_SECRET must be set to a random string of at least 32 characters.",
    );
  }
  return secret;
}

function hmac(payload: string): string {
  return crypto
    .createHmac("sha256", getSessionSecret())
    .update(payload)
    .digest("base64url");
}

/**
 * Create a signed session token bound to a merchant id.
 * Format: base64url(payload).hex(hmac) with an embedded expiry.
 */
export function createSessionToken(merchantId: string): {
  token: string;
  maxAge: number;
  expiresAt: Date;
} {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const payload = JSON.stringify({
    sub: merchantId,
    exp: expiresAt.getTime(),
  });
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64url");
  const sig = hmac(payloadB64);
  return {
    token: `${payloadB64}.${sig}`,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    expiresAt,
  };
}

/**
 * Verify a session token and return the merchant id it authenticates, or null
 * if invalid/expired/tampered. Timing-safe HMAC comparison prevents forgery.
 */
export function verifySessionToken(
  token: string | undefined | null,
): string | null {
  if (!token) return null;

  // Fail-safe: any error (including an unset/too-short server secret) must
  // never surface as an uncaught exception — treat it as unauthenticated.
  try {
    const dot = token.lastIndexOf(".");
    if (dot === -1) return null;
    const payloadB64 = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!payloadB64 || !sig) return null;

    const expectedSig = Buffer.from(hmac(payloadB64), "utf8");
    const providedSig = Buffer.from(sig, "utf8");
    if (
      expectedSig.length !== providedSig.length ||
      !crypto.timingSafeEqual(expectedSig, providedSig)
    ) {
      return null;
    }

    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as { sub?: string; exp?: number };
    if (!payload.sub || typeof payload.exp !== "number") return null;
    if (Date.now() >= payload.exp) return null;
    return payload.sub;
  } catch {
    return null;
  }
}
