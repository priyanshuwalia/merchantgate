-- Merchant signup: add per-merchant credentials + onboarding state.
-- All statements are idempotent so they re-run safely.

ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "email" text;
ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "password_hash" text;
ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "onboarding_completed" boolean NOT NULL DEFAULT false;
ALTER TABLE "merchants" ALTER COLUMN "api_key_hash" DROP NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  CREATE UNIQUE INDEX "idx_merchants_email_unique" ON "merchants" ("email") WHERE "email" IS NOT NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
