CREATE TABLE "campaigns" (
	"id" text PRIMARY KEY DEFAULT 'cmp_' || gen_random_uuid(),
	"merchant_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"category" text,
	"variant_ids" jsonb DEFAULT '[]',
	"discount_bps" integer DEFAULT 0 NOT NULL,
	"min_order_minor" integer,
	"starts_at" timestamp NOT NULL,
	"ends_at" timestamp NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"target_audience" text,
	"target_agents" jsonb DEFAULT '[]',
	"budget_minor" integer,
	"spent_minor" integer DEFAULT 0 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"flash_price_minor" integer,
	"tiers" jsonb DEFAULT '[]',
	"stackable" boolean DEFAULT false NOT NULL,
	"ab_group" text,
	"schedule_days" jsonb DEFAULT '[]',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_campaigns_merchant" ON "campaigns" ("merchant_id");--> statement-breakpoint
CREATE INDEX "idx_campaigns_status" ON "campaigns" ("status");--> statement-breakpoint
CREATE INDEX "idx_campaigns_type" ON "campaigns" ("type");--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_merchant_id_merchants_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE;