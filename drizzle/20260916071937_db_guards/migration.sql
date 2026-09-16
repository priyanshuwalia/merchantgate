-- Database-level guards: data-integrity CHECK constraints + a trigger that
-- enforces the rolling-30-day budget ceiling at reservation-insert time.
-- Everything here is idempotent so it can re-run safely on any environment.

--> statement-breakpoint
-- CHECK constraints (amounts are never negative; stock never goes below zero)
DO $$ BEGIN
  ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_amount_non_negative" CHECK ("amount_minor" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_actions" ADD CONSTRAINT "payment_actions_amount_non_negative" CHECK ("amount_minor" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "refund_actions" ADD CONSTRAINT "refund_actions_amount_non_negative" CHECK ("amount_minor" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "products" ADD CONSTRAINT "products_stock_non_negative" CHECK ("stock_quantity" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "products" ADD CONSTRAINT "products_price_positive" CHECK ("base_price_minor" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_discount_bps_range" CHECK ("discount_bps" >= 0 AND "discount_bps" <= 10000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_budget_non_negative" CHECK ("budget_minor" IS NULL OR "budget_minor" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_spent_non_negative" CHECK ("spent_minor" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "intent_mandates" ADD CONSTRAINT "intent_mandates_max_transaction_non_negative" CHECK ("max_transaction_minor" IS NULL OR "max_transaction_minor" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
-- Rollback budget ceiling: when a reservation lands, re-derive the mandate's
-- committed 30-day usage (reservations + completed payments) and refuse the
-- insert — aborting the whole checkout transaction — if the ceiling is busted.
-- Runs BEFORE INSERT so the batch (mandate/cart/decision/reservation/payment)
-- commits or rolls back atomically.
CREATE OR REPLACE FUNCTION enforce_rolling_budget() RETURNS trigger AS $$
DECLARE
  ceiling_minor BIGINT;
  committed_minor BIGINT;
BEGIN
  SELECT COALESCE((mandate_json->'constraints'->>'rolling30dAmountMinor')::bigint, 0)
    INTO ceiling_minor
    FROM "intent_mandates"
    WHERE id = NEW."intent_mandate_id";

  IF ceiling_minor > 0 THEN
    SELECT COALESCE(SUM(r."amount_minor"), 0) + NEW."amount_minor"
      INTO committed_minor
      FROM "budget_reservations" r
      WHERE r."intent_mandate_id" = NEW."intent_mandate_id"
        AND r."status" IN ('reserved', 'completed')
        AND r."created_at" >= now() - interval '30 days';

    IF committed_minor > ceiling_minor THEN
      RAISE EXCEPTION 'ROLLING_BUDGET_EXHAUSTED: committed % exceeds ceiling %',
        committed_minor, ceiling_minor;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "enforce_rolling_budget_before_insert" ON "budget_reservations";
--> statement-breakpoint
CREATE TRIGGER "enforce_rolling_budget_before_insert"
BEFORE INSERT ON "budget_reservations"
FOR EACH ROW EXECUTE FUNCTION enforce_rolling_budget();