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

  // Two reads, parallel: (1) reservations held against the mandate, (2)
  // completed payments joined to their cart mandate so the payment is attributed
  // to its owning intent WITHOUT a third sequential round-trip.
  const [reservations, ownedPayments] = await Promise.all([
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
      .select({
        amount_minor: paymentActions.amount_minor,
      })
      .from(paymentActions)
      .innerJoin(
        cartMandates,
        eq(cartMandates.id, paymentActions.cart_mandate_id),
      )
      .where(
        and(
          eq(paymentActions.status, "completed"),
          eq(cartMandates.intent_mandate_id, intentMandateId),
          gte(paymentActions.created_at, start),
        ),
      ),
  ]);

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
