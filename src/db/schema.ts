import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

// 1. Merchants

export const merchants = pgTable("merchants", {
  id: text("id").primaryKey().default(sql`'mch_' || gen_random_uuid()`),

  name: text("name").notNull(),

  api_key_hash: text("api_key_hash").notNull(),

  webhook_secret: text("webhook_secret").notNull(),

  status: text("status").notNull().default("active"),

  config: jsonb("config").notNull().default({}),

  created_at: timestamp("created_at").notNull().defaultNow(),

  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

// 1b. Campaigns (Merchant Promotions)

export const campaigns = pgTable(
  "campaigns",
  {
    id: text("id").primaryKey().default(sql`'cmp_' || gen_random_uuid()`),

    merchant_id: text("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),

    name: text("name").notNull(),

    description: text("description"),

    type: text("type").notNull(), // CATEGORY_DISCOUNT | FLAT_DISCOUNT | BUNDLE_DISCOUNT | FLASH_SALE | TIERED_DISCOUNT | AGENT_TARGETED

    category: text("category"),

    variant_ids: jsonb("variant_ids").default([]), // string[]

    discount_bps: integer("discount_bps").notNull().default(0),

    min_order_minor: integer("min_order_minor"),

    starts_at: timestamp("starts_at").notNull(),

    ends_at: timestamp("ends_at").notNull(),

    status: text("status").notNull().default("active"), // draft | active | paused | ended

    target_audience: text("target_audience"),

    target_agents: jsonb("target_agents").default([]), // string[]

    budget_minor: integer("budget_minor"),

    spent_minor: integer("spent_minor").notNull().default(0),

    priority: integer("priority").notNull().default(0),

    flash_price_minor: integer("flash_price_minor"),

    tiers: jsonb("tiers").default([]), // CampaignTier[]

    stackable: boolean("stackable").notNull().default(false),

    ab_group: text("ab_group"), // "A" | "B"

    schedule_days: jsonb("schedule_days").default([]), // number[]

    created_at: timestamp("created_at").notNull().defaultNow(),

    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_campaigns_merchant").on(table.merchant_id),
    index("idx_campaigns_status").on(table.status),
    index("idx_campaigns_type").on(table.type),
  ],
);

// 2. Products

export const products = pgTable(
  "products",
  {
    id: text("id").primaryKey().default(sql`'prod_' || gen_random_uuid()`),

    merchant_id: text("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),

    variant_id: text("variant_id").notNull().unique(),

    title: text("title").notNull(),

    description: text("description"),

    category: text("category").notNull(),

    attributes: jsonb("attributes").notNull().default({}),

    base_price_minor: integer("base_price_minor").notNull(),

    currency: text("currency").notNull().default("INR"),

    tax_rate_bps: integer("tax_rate_bps").notNull().default(1800),

    returnable: boolean("returnable").notNull().default(true),

    return_window_days: integer("return_window_days").default(7),

    stock_quantity: integer("stock_quantity").notNull().default(0),

    version: integer("version").notNull().default(1),

    created_at: timestamp("created_at").notNull().defaultNow(),

    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_products_merchant").on(table.merchant_id),
    index("idx_products_category").on(table.category),
  ],
);

// 3. Agents (AI Buyers)

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey().default(sql`'agt_' || gen_random_uuid()`),

    public_key: text("public_key").unique(),

    display_name: text("display_name").notNull(),

    version: text("version").notNull(),

    status: text("status").notNull().default("pending"),

    metadata: jsonb("metadata"),

    expires_at: timestamp("expires_at"),

    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("idx_agents_status").on(table.status)],
);

// 4. Intent Mandates (User Authority)

export const intentMandates = pgTable(
  "intent_mandates",
  {
    id: text("id").primaryKey().default(sql`'int_' || gen_random_uuid()`),

    user_id: text("user_id").notNull(),

    agent_id: text("agent_id")
      .notNull()
      .references(() => agents.id),

    mandate_json: jsonb("mandate_json").notNull(),

    max_transaction_minor: integer("max_transaction_minor").notNull(),

    currency: text("currency").notNull().default("INR"),

    validity_expires_at: timestamp("validity_expires_at").notNull(),

    status: text("status").notNull().default("active"),

    approved_at: timestamp("approved_at").notNull().defaultNow(),

    revoked_at: timestamp("revoked_at"),
  },
  (table) => [
    index("idx_intent_agent").on(table.agent_id),

    index("idx_intent_user").on(table.user_id),

    index("idx_intent_expiry")
      .on(table.validity_expires_at)
      .where(sql`status = 'active'`),
  ],
);

// 5. Cart Mandates (Merchant Quotes)

export const cartMandates = pgTable(
  "cart_mandates",
  {
    id: text("id").primaryKey().default(sql`'cart_' || gen_random_uuid()`),

    intent_mandate_id: text("intent_mandate_id")
      .notNull()
      .references(() => intentMandates.id),

    merchant_id: text("merchant_id")
      .notNull()
      .references(() => merchants.id),

    quote_expires_at: timestamp("quote_expires_at").notNull(),

    total_minor: integer("total_minor").notNull(),

    currency: text("currency").notNull().default("INR"),

    items: jsonb("items").notNull(),

    fulfillment: jsonb("fulfillment").notNull(),

    terms: jsonb("terms").notNull(),

    content_hash: text("content_hash").notNull(),

    status: text("status").notNull().default("proposed"),

    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_cart_intent").on(table.intent_mandate_id),

    index("idx_cart_merchant").on(table.merchant_id),

    index("idx_cart_expiry")
      .on(table.quote_expires_at)
      .where(sql`status = 'proposed'`),
  ],
);

// 6. Policy Decisions (The Gate)

export const policyDecisions = pgTable(
  "policy_decisions",
  {
    id: text("id").primaryKey().default(sql`'dec_' || gen_random_uuid()`),

    intent_mandate_id: text("intent_mandate_id")
      .notNull()
      .references(() => intentMandates.id),

    cart_mandate_id: text("cart_mandate_id")
      .notNull()
      .references(() => cartMandates.id),

    decision: text("decision").notNull(), // ALLOW, DENY, STEP_UP

    reason_codes: jsonb("reason_codes").notNull(),

    decision_json: jsonb("decision_json").notNull(),

    expires_at: timestamp("expires_at").notNull(),

    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    // Enforce that a Cart Mandate is evaluated only ONCE
    unique("idx_policy_active_unique").on(table.cart_mandate_id),

    index("idx_policy_cart").on(table.cart_mandate_id),

    index("idx_policy_intent").on(table.intent_mandate_id),
  ],
);

// 7. Budget Reservations (Atomic)

export const budgetReservations = pgTable(
  "budget_reservations",
  {
    id: text("id").primaryKey().default(sql`'bres_' || gen_random_uuid()`),

    intent_mandate_id: text("intent_mandate_id")
      .notNull()
      .references(() => intentMandates.id),

    amount_minor: integer("amount_minor").notNull(),

    status: text("status").notNull().default("reserved"),

    expires_at: timestamp("expires_at").notNull(),

    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_budget_intent")
      .on(table.intent_mandate_id)
      .where(sql`status = 'reserved'`),
  ],
);

// 8. Payment Actions

export const paymentActions = pgTable(
  "payment_actions",
  {
    id: text("id").primaryKey().default(sql`'pact_' || gen_random_uuid()`),

    cart_mandate_id: text("cart_mandate_id")
      .notNull()
      .unique()
      .references(() => cartMandates.id),

    decision_id: text("decision_id")
      .notNull()
      .unique()
      .references(() => policyDecisions.id),

    budget_reservation_id: text("budget_reservation_id")
      .notNull()
      .unique()
      .references(() => budgetReservations.id),

    amount_minor: integer("amount_minor").notNull(),

    currency: text("currency").notNull().default("INR"),

    status: text("status").notNull().default("pending_approval"),

    razorpay_order_id: text("razorpay_order_id").unique(),

    razorpay_payment_id: text("razorpay_payment_id").unique(),

    provider_metadata: jsonb("provider_metadata"),

    created_at: timestamp("created_at").notNull().defaultNow(),

    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_payment_order")
      .on(table.razorpay_order_id)
      .where(sql`razorpay_order_id IS NOT NULL`),
  ],
);

// 9. Refund Actions

export const refundActions = pgTable("refund_actions", {
  id: text("id").primaryKey().default(sql`'ref_' || gen_random_uuid()`),

  payment_action_id: text("payment_action_id")
    .notNull()
    .references(() => paymentActions.id),

  amount_minor: integer("amount_minor").notNull(),

  razorpay_refund_id: text("razorpay_refund_id").unique(),

  status: text("status").notNull().default("pending"),

  idempotency_key: text("idempotency_key").notNull().unique(),

  reason: text("reason"),

  created_at: timestamp("created_at").notNull().defaultNow(),
});

// 10. Webhook Events (Deduplication)

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: text("id").primaryKey().default(sql`'we_' || gen_random_uuid()`),

    provider_event_id: text("provider_event_id").notNull().unique(),

    provider: text("provider").notNull().default("razorpay"),

    raw_payload: jsonb("raw_payload").notNull(),

    status: text("status").notNull().default("processed"),

    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("idx_webhook_provider").on(table.provider_event_id)],
);

// 11. Audit Trail (Append-Only)

export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedByDefaultAsIdentity(),

    trace_id: text("trace_id").notNull(),

    seq_no: integer("seq_no").notNull(),

    timestamp: timestamp("timestamp").notNull().defaultNow(),

    actor_type: text("actor_type").notNull(),

    actor_id: text("actor_id").notNull(),

    event_type: text("event_type").notNull(),

    intent_mandate_id: text("intent_mandate_id"),

    cart_mandate_id: text("cart_mandate_id"),

    decision_id: text("decision_id"),

    payment_action_id: text("payment_action_id"),

    reason_codes: jsonb("reason_codes"),

    provider_refs: jsonb("provider_refs"),

    snapshot_hash: text("snapshot_hash"),

    explanation: text("explanation").notNull(),

    metadata: jsonb("metadata").notNull().default({}),
  },
  (table) => [index("idx_audit_trace").on(table.trace_id, table.seq_no)],
);
