import { createHash } from "node:crypto";

/**
 * Deterministically stringify a JavaScript object using canonical JSON formatting (sorted keys).
 *
 * Undefined values are normalised to match `JSON.stringify` semantics — the
 * same semantics PostgreSQL `jsonb` uses when persisting data — so a snapshot
 * hashed in-memory exactly matches the hash recomputed from a row read back
 * from the database. Specifically: object keys whose value is `undefined` are
 * omitted and `undefined` array/root values become `null`.
 */
export function canonicalJsonStringify(obj: unknown): string {
  if (obj === undefined) {
    return "null";
  }

  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return `[${obj.map((item) => canonicalJsonStringify(item)).join(",")}]`;
  }

  const record = obj as Record<string, unknown>;
  const sortedKeys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const pairs = sortedKeys.map(
    (key) => `${JSON.stringify(key)}:${canonicalJsonStringify(record[key])}`,
  );

  return `{${pairs.join(",")}}`;
}

/**
 * Generate SHA-256 hex digest of an object using canonical JSON serialization.
 */
export function generateCanonicalDigest(obj: unknown): string {
  const canonicalString = canonicalJsonStringify(obj);
  return createHash("sha256").update(canonicalString, "utf8").digest("hex");
}

/**
 * Verify if an object matches a given SHA-256 digest.
 */
export function verifyCanonicalDigest(
  obj: unknown,
  expectedDigest: string,
): boolean {
  const actualDigest = generateCanonicalDigest(obj);
  return actualDigest.toLowerCase() === expectedDigest.toLowerCase();
}

export interface CartMandateSnapshotInput {
  id: string;
  intent_mandate_id: string;
  merchant_id: string;
  quote_expires_at: Date | string;
  total_minor: number;
  currency: string;
  items: unknown;
  fulfillment: unknown;
  terms: unknown;
}

export function buildCartMandateSnapshot(cart: CartMandateSnapshotInput) {
  return {
    id: cart.id,
    intentMandateId: cart.intent_mandate_id,
    merchantId: cart.merchant_id,
    quoteExpiresAt:
      cart.quote_expires_at instanceof Date
        ? cart.quote_expires_at.toISOString()
        : new Date(cart.quote_expires_at).toISOString(),
    totalMinor: cart.total_minor,
    currency: cart.currency,
    items: cart.items,
    fulfillment: cart.fulfillment,
    terms: cart.terms,
  };
}

export function generateCartMandateSnapshotHash(
  cart: CartMandateSnapshotInput,
): string {
  return generateCanonicalDigest(buildCartMandateSnapshot(cart));
}
