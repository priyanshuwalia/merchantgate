import { sql } from "drizzle-orm";

export interface SettlementClaimResult {
  /** True when THIS call is the one that moved the action to `completed`. */
  claimed: boolean;
}

/**
 * Atomically claim a payment action for settlement and apply its side effects.
 *
 * Why a CTE rather than "read status, then write": every earlier implementation
 * read `action.status`, decided in JavaScript whether this was the first
 * settlement, and then ran the writes. That is a textbook TOCTOU. Two webhook
 * deliveries describing the same payment with *different* `provider_event_id`
 * values both sail past the event-level dedupe (which only protects against a
 * repeated identical event), both observe `status !== 'completed'`, and both
 * decrement stock. On a real catalogue that silently oversells.
 *
 * The fix moves the decision into the database and into the SAME statement as
 * the side effects, using a data-modifying CTE:
 *
 *   claimed  — an UPDATE ... RETURNING that only fires when the action was not
 *              already `completed`. Exactly one concurrent caller can win.
 *   inv      — decrements stock, but only `WHERE EXISTS (SELECT 1 FROM claimed)`.
 *   cart     — completes the cart, under the same guard.
 *
 * All three see one snapshot, so the losers of a race perform no writes at all.
 * This closes the "at most once" guarantee at the storage layer rather than
 * trusting callers to behave.
 *
 * `payment_actions.razorpay_payment_id` is reused for Stripe references too —
 * see the known Razorpay-shaped-storage limitation in AGENTS.md.
 */
export function claimSettlementSql(opts: {
  actionId: string;
  cartId: string;
  items: Array<{ variantId: string; quantity: number }>;
  providerPaymentId?: string | null;
}): { sql: string; params: unknown[] } {
  const params: unknown[] = [
    opts.actionId,
    opts.cartId,
    opts.providerPaymentId ?? null,
  ];

  // Always parameterise the provider id so a null never rewrites the column.
  const inv = opts.items.length
    ? sql`
        , inv AS (
            UPDATE "products" p
               SET "stock_quantity" = GREATEST(0, p."stock_quantity" - data.qty)
              FROM (VALUES ${sql.join(
                opts.items.map((i, idx) => {
                  params.push(i.variantId, i.quantity);
                  return sql`(${String(idx * 2 + 3)}::text, ${String(idx * 2 + 4)}::bigint)`;
                }, sql.raw(", ")),
              )}) AS data(pidx, qty)
             WHERE p."variant_id" = data.pidx
               AND EXISTS (SELECT 1 FROM claimed)
            RETURNING 1
          )`
    : sql``;

  const text = `
    WITH claimed AS (
      UPDATE "payment_actions"
         SET "status" = 'completed',
             "razorpay_payment_id" = COALESCE($3::text, "razorpay_payment_id"),
             "updated_at" = now()
       WHERE "id" = $1::text
         AND "status" <> 'completed'
      RETURNING "id"
    )${inv}
    , cart AS (
      UPDATE "cart_mandates"
         SET "status" = 'completed'
       WHERE "id" = $2::text
         AND EXISTS (SELECT 1 FROM claimed)
      RETURNING 1
    )
    SELECT (SELECT count(*)::int FROM claimed) AS claimed_count`;

  return { sql: text, params };
}
