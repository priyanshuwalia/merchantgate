-- Strict settlement idempotency.
--
-- Three duplicate-order classes are being closed here:
--   1. Replayed quote requests minted a second cart_mandate, a second budget
--      reservation, a second provider order and a second campaign spend.
--   2. Replayed confirm requests double-decremented inventory and inserted
--      phantom budget reservations (budget_reservations.id has a DEFAULT, so a
--      NULL/undefined id silently became a brand-new row).
--   3. Concurrent refunds both passed the existence check and both called the
--      provider, returning real money twice.
--
-- The invariant is pushed down into the schema so it holds even if a handler
-- regresses: at most one cart per idempotency key, at most one live budget
-- reservation per cart, at most one refund per payment.
--
-- Every statement is idempotent so re-running this file is safe.

ALTER TABLE "cart_mandates" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD COLUMN IF NOT EXISTS "cart_mandate_id" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "budget_reservations"
    ADD CONSTRAINT "budget_reservations_cart_mandate_id_fkey"
    FOREIGN KEY ("cart_mandate_id") REFERENCES "cart_mandates"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- Backfill: payment_actions.budget_reservation_id is already UNIQUE, so each
-- reservation maps to at most one cart and the backfill is deterministic.
-- Reservations with no payment action stay NULL and are excluded from the
-- partial unique index below.
UPDATE "budget_reservations" br
   SET "cart_mandate_id" = pa."cart_mandate_id"
  FROM "payment_actions" pa
 WHERE pa."budget_reservation_id" = br."id"
   AND br."cart_mandate_id" IS NULL;
--> statement-breakpoint

-- At most one quote per client-supplied idempotency key.
DO $$ BEGIN
  CREATE UNIQUE INDEX "uniq_cart_idempotency"
    ON "cart_mandates" ("idempotency_key")
    WHERE "idempotency_key" IS NOT NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- At most one live budget hold per cart. This is the schema-level backstop for
-- the phantom-reservation bug: a duplicate insert now aborts the transaction
-- instead of silently inflating the buyer's committed 30-day spend.
DO $$ BEGIN
  CREATE UNIQUE INDEX "uniq_budget_reservation_per_cart"
    ON "budget_reservations" ("cart_mandate_id")
    WHERE "cart_mandate_id" IS NOT NULL AND "status" = 'reserved';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- One refund per payment. Previously two concurrent refund requests both saw no
-- existing refund row, both called the provider, and the UNIQUE violation on
-- the later INSERT arrived *after* the money had already been returned.
DO $$ BEGIN
  ALTER TABLE "refund_actions"
    ADD CONSTRAINT "refund_actions_payment_action_id_key"
    UNIQUE ("payment_action_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
