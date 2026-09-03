/**
 * Rolling 30-day budget accounting for an intent mandate.
 *
 * The principal's mandate authorises a rolling period spend
 * (`constraints.rolling30dAmountMinor`). The merchant tracks committed spend
 * across two append-only stores and surfaces the REAL remaining budget to the
 * policy engine instead of assuming the rolling ceiling is untouched:
 *
 *   usage = Σ budget_reservations (status reserved/completed, ≤ 30d)
 *         + Σ payment_actions    (status completed, ≤ 30d, owned by mandate)
 *
 * Released/expired reservations and failed/cancelled payments never scare the
 * buyer's budget; completed payments always count.
 */

import { and, eq, gte, inArray } from "drizzle-orm";
import { budgetReservations, cartMandates, db, paymentActions } from "@/db";

export function getRollingBudgetWindow(): { start: Date } {
  const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return { start };
}

export async function getRollingBudgetUsage(intentMandateId: string): Promise<{
  usageMinor: number;
  reservedCount: number;
  completedCount: number;
}> {
  const { start } = getRollingBudgetWindow();

  const [reservations, completedPayments] = await Promise.all([
    db
      .select()
      .from(budgetReservations)
      .where(
        and(
          eq(budgetReservations.intent_mandate_id, intentMandateId),
          inArray(budgetReservations.status, ["reserved", "completed"]),
          gte(budgetReservations.created_at, start),
        ),
      ),
    db
      .select()
      .from(paymentActions)
      .where(
        and(
          eq(paymentActions.status, "completed"),
          gte(paymentActions.created_at, start),
        ),
      ),
  ]);

  // payment_actions is not FK'd to the intent mandate; resolve ownership via
  // the cart mandate it was created against.
  const cartIds = completedPayments.map((p) => p.cart_mandate_id);
  const carts =
    cartIds.length > 0
      ? await db
          .select({
            id: cartMandates.id,
            intent_mandate_id: cartMandates.intent_mandate_id,
          })
          .from(cartMandates)
          .where(inArray(cartMandates.id, cartIds))
      : [];

  const ownedCartIds = new Set(
    carts
      .filter((c) => c.intent_mandate_id === intentMandateId)
      .map((c) => c.id),
  );
  const ownedPayments = completedPayments.filter((p) =>
    ownedCartIds.has(p.cart_mandate_id),
  );

  const usageMinor =
    reservations.reduce((sum, r) => sum + (Number(r.amount_minor) || 0), 0) +
    ownedPayments.reduce((sum, p) => sum + (Number(p.amount_minor) || 0), 0);

  return {
    usageMinor,
    reservedCount: reservations.length,
    completedCount: ownedPayments.length,
  };
}

export function formatUsage(usageMinor: number): string {
  return `₹${(usageMinor / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
