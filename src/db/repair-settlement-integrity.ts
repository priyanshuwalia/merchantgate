/**
 * Settlement integrity repair.
 *
 * Heals damage left behind by the pre-hardening settlement paths:
 *
 *   1. ORPHAN RESERVATIONS — `reserved` budget holds whose payment action (and
 *      therefore cart) does not exist. They are pure phantom spend: they inflate
 *      the buyer's committed rolling-30-day usage forever, so the buyer is denied
 *      budget they still own. Released to `released` so the money frees up.
 *
 *   2. MISSING CART LINKS — reservations that DO have a payment action but no
 *      `cart_mandate_id`. Backfilled so the new one-live-reservation-per-cart
 *      index can actually protect them.
 *
 *   3. NON-ALLOW SETTLEMENTS — carts that reached `completed` while their policy
 *      decision was `STEP_UP` or `DENY`. These are reported, NOT auto-reversed:
 *      silently un-settling a paid order is a worse failure than a reported
 *      anomaly, and stock may have already been consumed. A human decides.
 *
 * Every action is idempotent and re-runnable. Defaults to a dry run: nothing is
 * written without `--apply`. Prints a JSON report and exits non-zero if it finds
 * anything to fix, so it can be wired into CI or a scheduled job as a monitor.
 *
 *   pnpm tsx src/db/repair-settlement-integrity.ts            # dry run
 *   pnpm tsx src/db/repair-settlement-integrity.ts --apply    # write
 *   pnpm tsx src/db/repair-settlement-integrity.ts --json     # machine-readable
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { budgetReservations, cartMandates, db, policyDecisions } from "./index";

export interface RepairReport {
  mode: "dry-run" | "apply";
  orphanReservations: {
    total: number;
    released: number;
    ids: string[];
  };
  backfilledCartLinks: {
    total: number;
    updated: number;
    ids: string[];
  };
  nonAllowSettlements: {
    total: number;
    items: Array<{
      cartMandateId: string;
      status: string;
      decision: string;
      reasonCodes: string[];
      totalMinor: number;
      currency: string;
    }>;
  };
  ok: boolean;
}

export async function runRepair(apply: boolean): Promise<RepairReport> {
  // ── 1. Orphan reservations ──────────────────────────────────────────────
  // A reservation is an orphan when nothing references it from payment_actions.
  const orphans = await db
    .select({
      id: budgetReservations.id,
      amountMinor: budgetReservations.amount_minor,
      status: budgetReservations.status,
      intentMandateId: budgetReservations.intent_mandate_id,
    })
    .from(budgetReservations)
    .where(
      and(
        sql`NOT EXISTS (
          SELECT 1 FROM payment_actions pa
           WHERE pa.budget_reservation_id = ${budgetReservations.id}
        )`,
        sql`${budgetReservations.status} = 'reserved'`,
      ),
    );

  let released = 0;
  if (apply && orphans.length > 0) {
    const res = await db
      .update(budgetReservations)
      .set({ status: "released" })
      .where(
        and(
          sql`${budgetReservations.id} IN ${sql.join(
            orphans.map((o) => sql`${o.id}::text`),
            sql.raw(", "),
          )}`,
          sql`${budgetReservations.status} = 'reserved'`,
        ),
      )
      .returning({ id: budgetReservations.id });
    released = res.length;
  }

  // ── 2. Backfill cart links ──────────────────────────────────────────────
  // Guarded on cart_mandate_id IS NULL, so re-running is a no-op.
  const backfillable = await db
    .select({ id: budgetReservations.id })
    .from(budgetReservations)
    .where(
      and(
        isNull(budgetReservations.cart_mandate_id),
        sql`EXISTS (
          SELECT 1 FROM payment_actions pa
           WHERE pa.budget_reservation_id = ${budgetReservations.id}
        )`,
      ),
    );

  let updated = 0;
  if (apply && backfillable.length > 0) {
    const res = await db.execute(sql`
      UPDATE budget_reservations br
         SET cart_mandate_id = pa.cart_mandate_id
        FROM payment_actions pa
       WHERE pa.budget_reservation_id = br.id
         AND br.cart_mandate_id IS NULL
      RETURNING br.id
    `);
    updated = (res as { rows?: unknown[] }).rows?.length ?? 0;
  }

  // ── 3. Non-ALLOW settlements (reported only) ────────────────────────────
  const badSettlements = await db
    .select({
      cartMandateId: cartMandates.id,
      status: cartMandates.status,
      decision: policyDecisions.decision,
      reasonCodes: policyDecisions.reason_codes,
      totalMinor: cartMandates.total_minor,
      currency: cartMandates.currency,
    })
    .from(cartMandates)
    .innerJoin(
      policyDecisions,
      eq(policyDecisions.cart_mandate_id, cartMandates.id),
    )
    .where(
      and(
        eq(cartMandates.status, "completed"),
        sql`${policyDecisions.decision} <> 'ALLOW'`,
      ),
    );

  const report: RepairReport = {
    mode: apply ? "apply" : "dry-run",
    orphanReservations: {
      total: orphans.length,
      released,
      ids: orphans.map((o) => o.id),
    },
    backfilledCartLinks: {
      total: backfillable.length,
      updated,
      ids: backfillable.map((b) => b.id),
    },
    nonAllowSettlements: {
      total: badSettlements.length,
      items: badSettlements.map((b) => ({
        cartMandateId: b.cartMandateId,
        status: b.status,
        decision: b.decision,
        reasonCodes: (b.reasonCodes as string[]) ?? [],
        totalMinor: b.totalMinor,
        currency: b.currency,
      })),
    },
    ok: orphans.length === 0 && backfillable.length === 0,
  };

  return report;
}

// Only execute when invoked directly, not when imported by a test.
if (process.argv[1]?.endsWith("repair-settlement-integrity.ts")) {
  const apply = process.argv.includes("--apply");
  const asJson = process.argv.includes("--json");

  runRepair(apply)
    .then((report) => {
      if (asJson) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`\n=== settlement integrity (${report.mode}) ===`);
        console.log(
          `orphan reservations:  ${report.orphanReservations.total} found, ${report.orphanReservations.released} released`,
        );
        console.log(
          `missing cart links:  ${report.backfilledCartLinks.total} found, ${report.backfilledCartLinks.updated} backfilled`,
        );
        console.log(
          `non-ALLOW settled:   ${report.nonAllowSettlements.total} (reported only — needs a human decision)`,
        );
        for (const item of report.nonAllowSettlements.items) {
          console.log(
            `  - ${item.cartMandateId} ${item.status} under ${item.decision} [${item.reasonCodes.join(", ")}] ${item.currency} ${(item.totalMinor / 100).toFixed(2)}`,
          );
        }
        if (!apply) {
          console.log(`\n(dry run — pass --apply to write)`);
        }
      }
      // Non-zero exit when something still needs attention, so this doubles as
      // a monitor.
      process.exit(report.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error("repair failed:", err);
      process.exit(2);
    });
}
