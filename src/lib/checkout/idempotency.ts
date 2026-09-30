import { and, eq } from "drizzle-orm";
import { cartMandates, db, paymentActions, policyDecisions } from "@/db";

/**
 * Validate and normalise a client-supplied `Idempotency-Key`.
 *
 * Returns the key, or `false` when the header is present but unusable. `null`
 * means "no header supplied", which is a legitimate client choice — the route
 * still has the content-hash and unique-index backstops, it just has no explicit
 * key to key on.
 *
 * The length and charset limits are not cosmetic: the key is stored and later
 * used to build responses and audit metadata, so an unbounded header is both a
 * storage-abuse vector and a log-injection risk.
 */
export function normalizeIdempotencyKey(
  raw: string | null | undefined,
): string | null | false {
  if (raw === null || raw === undefined) return null;
  const key = raw.trim();
  if (key === "") return false;
  if (key.length < 8 || key.length > 200) return false;
  // Printable ASCII only — no control characters, no whitespace.
  if (!/^[\x21-\x7e]+$/.test(key)) return false;
  return key;
}

/**
 * Look up a previously-issued quote by client idempotency key.
 *
 * Scoped to the merchant so one tenant can never probe or collide with another
 * tenant's keys, and joined to the policy decision and payment action so the
 * replay returns a body the buyer agent can act on directly — a replay that
 * handed back less information than the original response would push agents into
 * retry loops, which is the very thing the key exists to prevent.
 */
export async function findQuoteByIdempotencyKey(
  merchantId: string,
  idempotencyKey: string,
): Promise<{
  cart: typeof cartMandates.$inferSelect;
  decision: typeof policyDecisions.$inferSelect | null;
  paymentAction: typeof paymentActions.$inferSelect | null;
} | null> {
  const [cart] = await db
    .select()
    .from(cartMandates)
    .where(
      and(
        eq(cartMandates.idempotency_key, idempotencyKey),
        eq(cartMandates.merchant_id, merchantId),
      ),
    )
    .limit(1);

  if (!cart) return null;

  const [decision] = await db
    .select()
    .from(policyDecisions)
    .where(eq(policyDecisions.cart_mandate_id, cart.id))
    .limit(1);

  const [paymentAction] = await db
    .select()
    .from(paymentActions)
    .where(eq(paymentActions.cart_mandate_id, cart.id))
    .limit(1);

  return {
    cart,
    decision: decision ?? null,
    paymentAction: paymentAction ?? null,
  };
}
