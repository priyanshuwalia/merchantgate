# AGENTS.md

## AgentPay: Merchant Implementation for AI-Native Commerce

### Project Overview

This document serves as the comprehensive implementation guide for **AgentPay Merchant**, a merchant platform designed to be fully compatible with AI buyer agents. Unlike the original AgentPay concept that focused on building an AI buyer agent, this project **inverts the architecture**: you will build a merchant system that can be discovered, queried, and transacted with by AI buyer agents.

**Core Philosophy:**

> **AI agents are the new customers. Build your merchant infrastructure for them.**

The merchant platform implements the verification, quoting, and checkout protocols that AI buyer agents expect, while providing human merchants with full visibility and control through a modern dashboard.

---

## Table of Contents

1. [Project Vision](#project-vision)
2. [Technology Stack](#technology-stack)
3. [Architecture Overview](#architecture-overview)
4. [Project Structure](#project-structure)
5. [Core Data Models](#core-data-models)
6. [API Contract for AI Agents](#api-contract-for-ai-agents)
7. [Merchant Dashboard](#merchant-dashboard)
8. [Payment Integration](#payment-integration)
9. [Simulation Environment](#simulation-environment)
10. [Security & Compliance](#security--compliance)
11. [Deployment](#deployment)
12. [Testing Strategy](#testing-strategy)
13. [Developer Setup](#developer-setup)

---

## Project Vision

### The Shift in Perspective

The original AgentPay document describes a world where AI buyer agents exist. This project **prepares merchants for that world**. You are building the storefront that AI agents will visit, browse, and purchase from.

### What You're Building

1. **A merchant catalogue** that AI agents can discover and search programmatically
2. **A checkout API** that generates authoritative, time-bound quotes
3. **A verification system** that validates agent mandates and policies
4. **A merchant dashboard** for monitoring and managing AI agent transactions
5. **Complete Razorpay integration** for real test-mode payments
6. **Full simulation capabilities** for demos and testing

### User Stories

- **As a merchant**, I want to list my products in a machine-readable format so AI agents can discover them
- **As a merchant**, I want to receive checkout requests from AI agents with their mandate proofs
- **As a merchant**, I want to generate authoritative quotes that freeze prices and availability
- **As a merchant**, I want to see all AI agent transactions in my dashboard
- **As a merchant**, I want to set policies for which agents can buy what
- **As a merchant**, I want to simulate the entire AI buyer flow for demonstrations

---

## Technology Stack

### Frontend

- **Framework**: Next.js 15+ (App Router)
- **Language**: TypeScript 5+
- **Styling**: Tailwind CSS 4+
- **UI Components**: shadcn/ui with Radix UI primitives
- **State Management**: Zustand or Jotai
- **Data Fetching**: TanStack Query (React Query)
- **Forms**: React Hook Form + Zod
- **Charts**: Recharts for analytics

### Backend

- **API Framework**: Next.js API Routes (App Router)
- **Runtime**: Node.js 20+ (LTS)
- **ORM**: Drizzle ORM
- **Database**: Neon PostgreSQL
- **Validation**: Zod
- **Authentication**: NextAuth.js / Auth.js
- **Payment**: Razorpay Node SDK
- **AI Integration**: OpenAI / Vercel AI SDK

### Development & Deployment

- **Repository**: Monorepo (PNPM workspaces)
- **Package Manager**: PNPM 9+
- **Build Tool**: TurboRepo
- **Deployment**: Vercel (frontend) + Neon (database)
- **CI/CD**: GitHub Actions
- **Testing**: Vitest + Playwright

### Key Libraries

- **ID Generation**: Ulid / UUIDv7
- **HTTP Client**: Fetch API / Ky
- **Date Handling**: date-fns
- **Logging**: Pino / Winston
- **Environment**: Zod-env

---

## Architecture Overview

### System Context

```
┌─────────────────────────────────────────────────────────────────┐
│                     AI Buyer Agent                              │
│  (Intent Mandate + Cart Request + Policy Proof)                │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTPS / JSON
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    AgentPay Merchant API                        │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────────────┐     │
│  │ Discovery   │  │  Checkout   │  │  Verification     │     │
│  │ Endpoints   │  │  Endpoints  │  │  Endpoints        │     │
│  └─────────────┘  └─────────────┘  └────────────────────┘     │
│                                                                 │
└────────────────────────────┬────────────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│   PostgreSQL    │ │   Razorpay      │ │   Audit Store   │
│   (Neon)        │ │   (Test Mode)   │ │                 │
└─────────────────┘ └─────────────────┘ └─────────────────┘
         ▲                   ▲                   ▲
         │                   │                   │
         └───────────────────┼───────────────────┘
                             │
                      ┌──────┴──────┐
                      │  Merchant   │
                      │  Dashboard  │
                      └─────────────┘
```

### Architecture Principles

1. **The LLM proposes; deterministic code disposes** - AI agents may suggest purchases, but merchants generate authoritative quotes
2. **Every transaction has a lineage** - From discovery request to payment confirmation
3. **Concurrent spend is atomic** - Budget reservations use database transactions with row-level locking
4. **Merchant is the source of truth** - Prices, availability, and taxes are merchant-controlled
5. **Fraud prevention at the boundary** - Razorpay webhooks are cryptographically verified

---

## Project Structure

### Monorepo Layout

```
agentpay-merchant/
├── apps/
│   ├── web/                          # Next.js application
│   │   ├── app/
│   │   │   ├── (auth)/               # Authentication routes
│   │   │   ├── (dashboard)/          # Merchant dashboard
│   │   │   ├── api/                  # API routes
│   │   │   │   ├── agent/            # Agent-facing endpoints
│   │   │   │   ├── merchant/         # Merchant-facing endpoints
│   │   │   │   └── webhooks/         # Provider webhooks
│   │   │   ├── layout.tsx
│   │   │   └── page.tsx
│   │   ├── components/
│   │   │   ├── ui/                   # shadcn/ui components
│   │   │   ├── dashboard/            # Dashboard-specific components
│   │   │   └── agent/                # Agent simulation components
│   │   ├── lib/
│   │   │   ├── db/                   # Database client
│   │   │   ├── api/                  # API client
│   │   │   └── utils/
│   │   └── middleware.ts
│   │
│   └── docs/                         # Documentation site (optional)
│
├── packages/
│   ├── database/                     # Database schema and migrations
│   │   ├── src/
│   │   │   ├── schema/
│   │   │   ├── migrations/
│   │   │   └── index.ts
│   │   └── drizzle.config.ts
│   │
│   ├── api-contract/                 # Shared API types
│   │   ├── src/
│   │   │   ├── agent/
│   │   │   ├── merchant/
│   │   │   └── shared/
│   │   └── index.ts
│   │
│   ├── protocols/                    # Agent commerce protocols
│   │   ├── src/
│   │   │   ├── mandate/              # Mandate validation
│   │   │   ├── policy/               # Policy evaluation
│   │   │   └── audit/                # Audit trail
│   │   └── index.ts
│   │
│   ├── simulation/                   # AI agent simulation
│   │   ├── src/
│   │   │   ├── buyer/                # Simulated buyer agent
│   │   │   ├── scenarios/            # Pre-built scenarios
│   │   │   └── runner.ts
│   │   └── index.ts
│   │
│   └── types/                        # TypeScript types
│       ├── src/
│       │   ├── agent.ts
│       │   ├── merchant.ts
│       │   ├── payment.ts
│       │   └── audit.ts
│       └── index.ts
│
├── turbo.json                         # TurboRepo configuration
├── pnpm-workspace.yaml
├── package.json
├── .env.example
├── .eslintrc.js
├── .prettierrc
└── README.md
```

### Package Dependencies

**Root `package.json`**:

```json
{
  "name": "agentpay-merchant",
  "version": "0.1.0",
  "private": true,
  "packageManager": "pnpm@9.0.0",
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "lint": "turbo run lint",
    "test": "turbo run test",
    "db:generate": "pnpm --filter database generate",
    "db:migrate": "pnpm --filter database migrate",
    "db:seed": "pnpm --filter database seed"
  },
  "devDependencies": {
    "turbo": "^2.0.0",
    "typescript": "^5.5.0"
  }
}
```

---

## Core Data Models

### Database Schema (Drizzle ORM)

#### Merchants Table

```typescript
export const merchants = pgTable("merchants", {
  id: text("id")
    .primaryKey()
    .$default(() => generateUlid()),
  name: text("name").notNull(),
  description: text("description"),
  logoUrl: text("logo_url"),
  website: text("website"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  metadata: jsonb("metadata").default({}),
});

export const merchantSettings = pgTable("merchant_settings", {
  id: text("id")
    .primaryKey()
    .$default(() => generateUlid()),
  merchantId: text("merchant_id")
    .references(() => merchants.id)
    .notNull(),
  currency: text("currency").notNull().default("INR"),
  autoProcessAgentOrders: boolean("auto_process_agent_orders").default(false),
  agentRequiresApproval: boolean("agent_requires_approval").default(true),
  maxAgentTransactionAmount: integer("max_agent_transaction_amount").default(
    500000,
  ),
  priceSlippageToleranceBps: integer("price_slippage_tolerance_bps").default(
    200,
  ),
  webhookUrl: text("webhook_url"),
  razorpayKeyId: text("razorpay_key_id"),
  razorpayKeySecret: text("razorpay_key_secret"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

#### Products Table

```typescript
export const products = pgTable("products", {
  id: text("id")
    .primaryKey()
    .$default(() => generateUlid()),
  merchantId: text("merchant_id")
    .references(() => merchants.id)
    .notNull(),
  productId: text("product_id").notNull(), // SKU
  title: text("title").notNull(),
  description: text("description"),
  category: text("category").notNull(),
  tags: text("tags").array().default([]),
  priceMinor: integer("price_minor").notNull(),
  currency: text("currency").notNull().default("INR"),
  inventory: integer("inventory").notNull().default(0),
  status: text("status").notNull().default("active"),
  attributes: jsonb("attributes").default({}),
  images: text("images").array().default([]),
  returnable: boolean("returnable").default(false),
  returnWindowDays: integer("return_window_days").default(7),
  version: text("version").notNull().default("1.0.0"),
  lastUpdatedAt: timestamp("last_updated_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const productVariants = pgTable("product_variants", {
  id: text("id")
    .primaryKey()
    .$default(() => generateUlid()),
  productId: text("product_id")
    .references(() => products.id)
    .notNull(),
  variantId: text("variant_id").notNull(),
  title: text("title").notNull(),
  priceMinor: integer("price_minor").notNull(),
  currency: text("currency").notNull().default("INR"),
  inventory: integer("inventory").notNull().default(0),
  attributes: jsonb("attributes").default({}),
  sku: text("sku"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

#### Agent Requests Table

```typescript
export const agentRequests = pgTable("agent_requests", {
  id: text("id")
    .primaryKey()
    .$default(() => generateUlid()),
  traceId: text("trace_id").notNull(),
  requestId: text("request_id").notNull().unique(),
  agentId: text("agent_id").notNull(),
  agentVersion: text("agent_version"),
  intentMandateId: text("intent_mandate_id"),
  intentMandate: jsonb("intent_mandate"),
  type: text("type").notNull(), // 'discovery', 'checkout', 'payment'
  status: text("status").notNull().default("pending"),
  payload: jsonb("payload").notNull(),
  response: jsonb("response"),
  merchantId: text("merchant_id")
    .references(() => merchants.id)
    .notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  processedAt: timestamp("processed_at"),
});
```

#### Checkout Proposals Table

```typescript
export const checkoutProposals = pgTable("checkout_proposals", {
  id: text("id")
    .primaryKey()
    .$default(() => generateUlid()),
  merchantId: text("merchant_id")
    .references(() => merchants.id)
    .notNull(),
  requestId: text("request_id")
    .references(() => agentRequests.requestId)
    .notNull(),
  cartMandateId: text("cart_mandate_id").notNull().unique(),
  intentMandateId: text("intent_mandate_id").notNull(),
  items: jsonb("items").notNull(),
  totals: jsonb("totals").notNull(),
  fulfillment: jsonb("fulfillment"),
  terms: jsonb("terms"),
  status: text("status").notNull().default("draft"),
  expiresAt: timestamp("expires_at").notNull(),
  devProof: jsonb("dev_proof"),
  razorpayOrderId: text("razorpay_order_id"),
  razorpayOrderStatus: text("razorpay_order_status"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
});

export const checkoutLineItems = pgTable("checkout_line_items", {
  id: text("id")
    .primaryKey()
    .$default(() => generateUlid()),
  checkoutProposalId: text("checkout_proposal_id")
    .references(() => checkoutProposals.id)
    .notNull(),
  variantId: text("variant_id").notNull(),
  productId: text("product_id").notNull(),
  quantity: integer("quantity").notNull().default(1),
  unitAmountMinor: integer("unit_amount_minor").notNull(),
  lineAmountMinor: integer("line_amount_minor").notNull(),
  metadata: jsonb("metadata").default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

#### Agent Registrations (Optional - for agent verification)

```typescript
export const agentRegistrations = pgTable("agent_registrations", {
  id: text("id")
    .primaryKey()
    .$default(() => generateUlid()),
  agentId: text("agent_id").notNull().unique(),
  displayName: text("display_name").notNull(),
  version: text("version").notNull(),
  operatorId: text("operator_id").notNull(),
  status: text("status").notNull().default("pending"),
  scopes: text("scopes").array().default([]),
  publicKey: text("public_key"),
  verificationMethod: text("verification_method"),
  verifiedAt: timestamp("verified_at"),
  expiresAt: timestamp("expires_at"),
  registeredAt: timestamp("registered_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

#### Audit Log Table

```typescript
export const auditEvents = pgTable("audit_events", {
  id: text("id")
    .primaryKey()
    .$default(() => generateUlid()),
  traceId: text("trace_id").notNull(),
  sequenceNo: bigint("sequence_no", { mode: "number" }).notNull(),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
  actorType: text("actor_type").notNull(), // 'agent', 'merchant', 'system'
  actorId: text("actor_id").notNull(),
  eventType: text("event_type").notNull(),
  intentMandateId: text("intent_mandate_id"),
  cartMandateId: text("cart_mandate_id"),
  decisionId: text("decision_id"),
  paymentActionId: text("payment_action_id"),
  reasonCodes: jsonb("reason_codes"),
  providerRefs: jsonb("provider_refs"),
  snapshotHash: text("snapshot_hash"),
  prevEventHash: text("prev_event_hash"),
  explanation: text("explanation").notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Indexes
export const auditIndexes = {
  traceIdIdx: index("audit_trace_id_idx").on(auditEvents.traceId),
  actorIdx: index("audit_actor_idx").on(
    auditEvents.actorType,
    auditEvents.actorId,
  ),
  eventTypeIdx: index("audit_event_type_idx").on(auditEvents.eventType),
};
```

---

## API Contract for AI Agents

### Discovery Endpoints

#### GET `/.well-known/agent-commerce.json`

Agent discovery endpoint. AI agents first check this to understand merchant capabilities.

**Response:**

```typescript
{
  protocol: "agentpay-commerce.v1",
  merchantId: string;
  merchantName: string;
  description?: string;
  capabilities: {
    catalogSearch: boolean;
    authoritativeCheckout: boolean;
    returns: boolean;
    agentVerification: boolean;
  };
  endpoints: {
    catalog: "/v1/agent/catalog";
    product: "/v1/agent/products/{variant_id}";
    checkout: "/v1/agent/checkout";
    verify: "/v1/agent/verify";
  };
  money: {
    currencies: ["INR"];
    minorUnits: true;
  };
  paymentHandlers: [
    {
      type: "razorpay_test";
      mode: "human_present";
    },
    {
      type: "simulated_uap";
      mode: "delegated_demo";
    }
  ];
}
```

#### GET `/v1/agent/catalog`

Search the merchant catalogue. Supports filtering, sorting, and pagination.

**Query Parameters:**

```typescript
{
  q?: string;           // Search query
  category?: string;    // Filter by category
  minPrice?: number;    // Minimum price in minor units
  maxPrice?: number;    // Maximum price in minor units
  inStock?: boolean;    // Only show in-stock items
  limit?: number;       // Default 20, max 100
  cursor?: string;      // Pagination cursor
}
```

**Response:**

```typescript
{
  items: Array<{
    productId: string;
    variantId: string;
    merchantId: string;
    title: string;
    description?: string;
    category: string;
    tags: string[];
    attributes: Record<string, unknown>;
    discoveryPrice: {
      amountMinor: number;
      currency: string;
    };
    availability: {
      status: "in_stock" | "limited" | "out_of_stock";
      quantityBand?: string;
    };
    returnable: boolean;
    returnWindowDays?: number;
    images: string[];
    version: string;
    updatedAt: string;
  }>;
  nextCursor?: string;
  total: number;
}
```

#### GET `/v1/agent/products/{variant_id}`

Fetch a specific product variant.

**Response:**

```typescript
{
  productId: string;
  variantId: string;
  merchantId: string;
  title: string;
  description?: string;
  category: string;
  tags: string[];
  attributes: Record<string, unknown>;
  pricing: {
    amountMinor: number;
    currency: string;
    isPromotional?: boolean;
    originalAmountMinor?: number;
  };
  availability: {
    status: "in_stock" | "limited" | "out_of_stock";
    quantityBand?: string;
    estimatedRestockDate?: string;
  };
  returnable: boolean;
  returnWindowDays?: number;
  images: string[];
  version: string;
  updatedAt: string;
}
```

### Checkout Endpoints

#### POST `/v1/agent/verify`

Verify an agent's mandate and registration.

**Request:**

```typescript
{
  agentId: string;
  agentVersion: string;
  intentMandate: {
    type: "intent_mandate.v1";
    id: string;
    revision: number;
    principal: {
      userId: string;
    };
    delegate: {
      agentId: string;
      agentVersion: string;
    };
    instruction: string;
    mode: "delegated";
    constraints: {
      currency: string;
      maxTransactionAmountMinor: number;
      rolling30dAmountMinor: number;
      allowedMerchants: string[];
      allowedCategories: string[];
      quantityMax: number;
      maxPriceSlippageBps: number;
      requiresRefundability: boolean;
      fulfillment: {
        country: string;
        postalCode?: string;
      };
    };
    validity: {
      notBefore: string;
      expiresAt: string;
    };
    status: "active";
    policyProfile: string;
    approval: {
      method: string;
      approvedBy: string;
      approvedAt: string;
    };
    devProof: {
      type: "sha256-canonical-json";
      digest: string;
    };
  };
  intentMandateId: string;
  proof?: Record<string, unknown>;
}
```

**Response:**

```typescript
{
  verified: boolean;
  decision: "ALLOW" | "STEP_UP" | "DENY";
  reasonCodes: string[];
  explanation: string;
  verificationId: string;
  expiresAt: string;
  missingRequirements?: string[];
  applicableLimits?: {
    maxTransactionAmountMinor: number;
    rollingBudgetRemainingMinor: number;
  };
}
```

#### POST `/v1/agent/checkout`

Request an authoritative checkout quote.

**Request:**

```typescript
{
  intentMandateId: string;
  verificationId: string; // From /verify endpoint
  items: Array<{
    variantId: string;
    quantity: number;
  }>;
  delivery: {
    country: string;
    postalCode?: string;
    state?: string;
    city?: string;
    addressLine1?: string;
  };
  metadata?: Record<string, unknown>;
}
```

**Response:**

```typescript
{
  success: boolean;
  cartMandate: {
    type: "cart_mandate.v1";
    id: string;
    intentMandateId: string;
    merchantId: string;
    quote: {
      quoteId: string;
      version: number;
      issuedAt: string;
      expiresAt: string;
    };
    items: Array<{
      productId: string;
      variantId: string;
      category: string;
      title: string;
      quantity: number;
      unitAmountMinor: number;
      lineAmountMinor: number;
    }>;
    totals: {
      subtotalMinor: number;
      discountMinor: number;
      shippingMinor: number;
      taxMinor: number;
      grandTotalMinor: number;
      currency: string;
    };
    fulfillment: {
      country: string;
      postalCode: string;
      estimatedDeliveryDays?: number;
    };
    terms: {
      refundable: boolean;
      returnWindowDays: number;
      shippingPolicy?: string;
    };
    devProof: {
      type: "sha256-canonical-json";
      digest: string;
    };
  };
  policyEvaluation: {
    decisionId: string;
    decision: "ALLOW" | "STEP_UP" | "DENY";
    reasonCodes: string[];
    money: {
      requestedMinor: number;
      transactionLimitMinor: number;
      rollingBudgetRemainingAfterReservationMinor: number;
      currency: string;
    };
    expiresAt: string;
  };
  paymentRequired: boolean;
  razorpayOrderId?: string;
  razorpayKeyId?: string;
}
```

#### POST `/v1/agent/checkout/confirm`

Confirm a checkout proposal and proceed to payment.

**Request:**

```typescript
{
  cartMandateId: string;
  decisionId: string;
  paymentMethod: "razorpay_checkout" | "simulated_uap";
}
```

**Response:**

```typescript
{
  success: boolean;
  paymentActionId: string;
  status: "pending_payment" | "awaiting_confirmation";
  razorpayOrderId: string;
  razorpayKeyId: string;
  amountMinor: number;
  currency: string;
  expiresAt: string;
}
```

### Payment Status Endpoints

#### GET `/v1/agent/payments/{payment_action_id}`

Check payment status.

**Response:**

```typescript
{
  paymentActionId: string;
  status: "pending" | "completed" | "failed" | "refunded";
  amountMinor: number;
  currency: string;
  razorpayOrderId: string;
  razorpayPaymentId?: string;
  completedAt?: string;
  failureReason?: string;
  refundStatus?: "pending" | "completed" | "failed";
  refundAmountMinor?: number;
  traceId: string;
}
```

---

## Merchant Dashboard

### Dashboard Features

#### 1. Overview Dashboard

- Total AI agent transactions (today, week, month)
- Revenue from AI agents
- Active checkout proposals
- Agent activity log
- Quick actions (view pending, approve quotes)

#### 2. Product Management

- CRUD operations for products and variants
- Bulk import/export (CSV/JSON)
- Price and inventory management
- Category and tag management
- Product status toggles (active/inactive)
- Version tracking

#### 3. Agent Request Monitor

- Real-time feed of agent requests
- Filter by status, agent, date range
- Detailed request view with payloads
- Approval/denial workflow for STEP_UP decisions
- Request analytics

#### 4. Order Management

- View all orders from AI agents
- Order details with full audit trail
- Order status tracking
- Refund processing
- Mark as fulfilled

#### 5. Policy Configuration

- Agent acceptance criteria
- Transaction limits
- Price slippage tolerance
- Auto-approval rules
- Agent allowlist/blocklist

#### 6. Analytics & Reporting

- Agent transaction volume
- Popular products
- Conversion rates
- Revenue analytics
- Agent performance metrics

#### 7. Settings

- Merchant profile
- Payment configuration (Razorpay keys)
- Webhook configuration
- Notification preferences
- Team management

### UI Component Examples

```typescript
// Dashboard layout
<Layout>
  <Sidebar>
    <NavItem icon={DashboardIcon}>Overview</NavItem>
    <NavItem icon={ProductIcon}>Products</NavItem>
    <NavItem icon={AgentIcon}>Agent Requests</NavItem>
    <NavItem icon={OrderIcon}>Orders</NavItem>
    <NavItem icon={PolicyIcon}>Policies</NavItem>
    <NavItem icon={ChartIcon}>Analytics</NavItem>
    <NavItem icon={SettingsIcon}>Settings</NavItem>
  </Sidebar>
  <Main>
    <Header>
      <Breadcrumb />
      <UserMenu />
    </Header>
    <Content>
      {children}
    </Content>
  </Main>
</Layout>
```

---

## Payment Integration

### Razorpay Integration

#### Setup

```typescript
// lib/payments/razorpay.ts
import Razorpay from "razorpay";

export const razorpayClient = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

// Test mode check
export const isTestMode =
  process.env.NODE_ENV !== "production" || process.env.RAZORPAY_MODE === "test";
```

#### Create Order

```typescript
// POST /api/payments/create-order
async function createOrder(params: {
  amountMinor: number;
  currency: string;
  receipt: string;
  notes: Record<string, string>;
}) {
  const order = await razorpayClient.orders.create({
    amount: params.amountMinor,
    currency: params.currency,
    receipt: params.receipt,
    notes: params.notes,
    payment_capture: 1, // Auto-capture
  });

  return order;
}
```

#### Verify Webhook

```typescript
import crypto from "crypto";

function verifyWebhook(
  rawBody: Buffer,
  signature: string,
  secret: string,
): boolean {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

#### Webhook Handlers

```typescript
// POST /api/webhooks/razorpay
async function handleWebhook(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature")!;
  const eventId = request.headers.get("x-razorpay-event-id")!;

  // 1. Verify signature
  if (!verifyWebhook(Buffer.from(rawBody), signature, webhookSecret)) {
    return new Response("Unauthorized", { status: 401 });
  }

  // 2. Deduplicate
  const existing = await db.webhookEvents.findUnique({
    where: { eventId },
  });
  if (existing) {
    await logDuplicateEvent(eventId);
    return new Response("OK");
  }

  // 3. Process event
  const event = JSON.parse(rawBody);
  await processRazorpayEvent(event);

  // 4. Record
  await db.webhookEvents.create({
    data: { eventId, eventType: event.event, payload: event },
  });

  return new Response("OK");
}
```

#### Checkout Flow

```typescript
// Components/Checkout.tsx
const CheckoutButton = ({ orderId, amount, currency }) => {
  const handlePayment = async () => {
    const options = {
      key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
      order_id: orderId,
      amount: amount,
      currency: currency,
      name: "AgentPay Merchant",
      description: "AI Agent Purchase",
      handler: async (response) => {
        await verifyPayment(response);
      },
      modal: {
        ondismiss: () => {
          // Handle modal close
        }
      }
    };

    const razorpay = new (window as any).Razorpay(options);
    razorpay.open();
  };

  return <Button onClick={handlePayment}>Pay Now</Button>;
};
```

---

## Simulation Environment

### Purpose

The simulation environment allows:

1. **Development testing** - Test merchant API without real AI agents
2. **Demonstration** - Show the complete AI buyer flow
3. **QA** - Validate edge cases and security
4. **Training** - Teach merchants about AI agent commerce

### Simulated Buyer Agent

```typescript
// packages/simulation/src/buyer/agent.ts
export class SimulatedBuyerAgent {
  constructor(
    private config: {
      agentId: string;
      userId: string;
      intentMandate: IntentMandate;
    },
  ) {}

  async discoverMerchant(merchantUrl: string) {
    // Fetch .well-known/agent-commerce.json
  }

  async searchCatalog(query: string) {
    // Call merchant catalog API
  }

  async selectProduct(variantId: string) {
    // Select product for purchase
  }

  async requestCheckout(items: Array<{ variantId: string; quantity: number }>) {
    // Call merchant checkout API
  }

  async confirmAndPay(cartMandateId: string, decisionId: string) {
    // Confirm checkout and process payment
  }
}
```

### Pre-built Scenarios

```typescript
// packages/simulation/src/scenarios/
export const scenarios = {
  // Happy path - everything works
  happyPath: {
    name: "Happy Path - Complete Purchase",
    steps: [
      { type: "discover", merchant: "demo-store" },
      { type: "search", query: "mechanical keyboard" },
      { type: "select", variantId: "kbd_nimbus_75_black_brown" },
      {
        type: "checkout",
        items: [{ variantId: "kbd_nimbus_75_black_brown", quantity: 1 }],
      },
      { type: "confirm", paymentMethod: "razorpay_test" },
    ],
  },

  // Price change - should trigger STEP_UP
  priceChange: {
    name: "Price Change - STEP_UP Required",
    steps: [
      { type: "discover", merchant: "demo-store" },
      { type: "search", query: "mechanical keyboard" },
      { type: "select", variantId: "kbd_nimbus_75_black_brown" },
      {
        type: "checkout",
        items: [{ variantId: "kbd_nimbus_75_black_brown", quantity: 1 }],
      },
      {
        type: "changePrice",
        variantId: "kbd_nimbus_75_black_brown",
        newPrice: 405900,
      },
      {
        type: "checkout",
        items: [{ variantId: "kbd_nimbus_75_black_brown", quantity: 1 }],
      },
    ],
  },

  // Limit exceeded
  overLimit: {
    name: "Transaction Limit Exceeded",
    steps: [
      { type: "discover", merchant: "demo-store" },
      { type: "search", query: "gaming laptop" },
      { type: "select", variantId: "laptop_gaming_pro" },
      {
        type: "checkout",
        items: [{ variantId: "laptop_gaming_pro", quantity: 1 }],
      },
    ],
  },

  // Malicious product description - security test
  promptInjection: {
    name: "Prompt Injection Attempt",
    steps: [
      { type: "discover", merchant: "demo-store" },
      { type: "search", query: "special-offer" },
      { type: "select", variantId: "malicious_product_001" },
      {
        type: "checkout",
        items: [{ variantId: "malicious_product_001", quantity: 1 }],
      },
    ],
  },
};
```

### Simulation Runner

```typescript
// packages/simulation/src/runner.ts
export class SimulationRunner {
  constructor(private agent: SimulatedBuyerAgent) {}

  async run(scenario: Scenario): Promise<SimulationResult> {
    const traceId = generateTraceId();
    const events: SimulationEvent[] = [];

    for (const step of scenario.steps) {
      const event = await this.executeStep(step, traceId);
      events.push(event);

      if (event.error) {
        break;
      }
    }

    return {
      traceId,
      scenario: scenario.name,
      events,
      success: events.every((e) => !e.error),
      summary: this.generateSummary(events),
    };
  }

  private async executeStep(
    step: Step,
    traceId: string,
  ): Promise<SimulationEvent> {
    // Execute each step with full logging
  }
}
```

### Simulation UI

```typescript
// apps/web/components/simulation/SimulationDashboard.tsx
export const SimulationDashboard = () => {
  const [scenario, setScenario] = useState<Scenario>();
  const [results, setResults] = useState<SimulationResult>();

  const runSimulation = async () => {
    const runner = new SimulationRunner(createAgent());
    const result = await runner.run(scenario);
    setResults(result);
  };

  return (
    <div className="simulation-dashboard">
      <div className="simulation-controls">
        <Select value={scenario} onValueChange={setScenario}>
          {Object.entries(scenarios).map(([key, value]) => (
            <SelectItem key={key} value={key}>{value.name}</SelectItem>
          ))}
        </Select>
        <Button onClick={runSimulation}>Run Simulation</Button>
      </div>

      {results && (
        <div className="simulation-results">
          <div className="result-summary">
            <Badge variant={results.success ? 'success' : 'destructive'}>
              {results.success ? 'Success' : 'Failed'}
            </Badge>
            <span>{results.summary}</span>
          </div>

          <div className="event-timeline">
            {results.events.map((event, i) => (
              <EventCard key={i} event={event} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
```

---

## Security & Compliance

### Security Checklist

- [ ] **API Authentication**: All agent-facing endpoints validate agent identity
- [ ] **Input Validation**: Zod schemas for all request bodies
- [ ] **Rate Limiting**: Prevent abuse and DoS attacks
- [ ] **CORS**: Restrict to known agent origins (or configure properly)
- [ ] **Webhook Signatures**: Razorpay webhooks verified with HMAC-SHA256
- [ ] **Secrets Management**: Environment variables for all secrets
- [ ] **SQL Injection**: Use parameterized queries via Drizzle ORM
- [ ] **Audit Logging**: All financial actions logged with trace IDs
- [ ] **Idempotency**: Unique constraints prevent duplicate processing
- [ ] **HTTPS**: Enforce HTTPS in production
- [ ] **Security Headers**: Implement CSP, HSTS, X-Frame-Options

### Data Privacy

- **PII Handling**: Customer data should be minimal (only what's needed for fulfillment)
- **Data Retention**: Define and implement data retention policies
- **Encryption**: Encrypt sensitive data at rest
- **Access Control**: Dashboard access limited to authorized merchants

### Fraud Prevention

1. **Rate Limiting**: Limit requests per agent per time period
2. **Anomaly Detection**: Flag unusual patterns (high volume, high value)
3. **Mandate Verification**: Validate agent mandates before quoting
4. **Price Slippage Protection**: Prevent price manipulation
5. **Inventory Validation**: Check real-time inventory before checkout
6. **Duplicate Detection**: Prevent duplicate order processing
7. **Refund Controls**: Gate refunds with internal approval

---

## Deployment

### Vercel Deployment

**`vercel.json`**:

```json
{
  "functions": {
    "api/**/*.ts": {
      "maxDuration": 10
    }
  },
  "env": {
    "DATABASE_URL": "@database-url",
    "RAZORPAY_KEY_ID": "@razorpay-key-id",
    "RAZORPAY_KEY_SECRET": "@razorpay-key-secret",
    "RAZORPAY_WEBHOOK_SECRET": "@razorpay-webhook-secret"
  }
}
```

### Neon Database Setup

1. **Create Neon project**: Sign up at [neon.tech](https://neon.tech)
2. **Get connection string**: Copy from Neon dashboard
3. **Set environment variables**: Add to `.env.local` and Vercel

### Deployment Commands

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run database migrations
pnpm db:migrate

# Seed database
pnpm db:seed

# Deploy to Vercel
vercel --prod
```

### CI/CD Pipeline (GitHub Actions)

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup PNPM
        uses: pnpm/action-setup@v2
        with:
          version: 9

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: "pnpm"

      - name: Install dependencies
        run: pnpm install

      - name: Run tests
        run: pnpm test

      - name: Build
        run: pnpm build

      - name: Deploy to Vercel
        uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.ORG_ID }}
          vercel-project-id: ${{ secrets.PROJECT_ID }}
```

---

## Testing Strategy

### Unit Tests (Vitest)

```typescript
// tests/policy/checkout.test.ts
describe("Checkout Policy", () => {
  it("should ALLOW valid checkout within mandate", () => {
    const result = evaluateCheckout(validCheckout);
    expect(result.decision).toBe("ALLOW");
  });

  it("should STEP_UP when price exceeds slippage", () => {
    const result = evaluateCheckout(priceChangedCheckout);
    expect(result.decision).toBe("STEP_UP");
    expect(result.reasonCodes).toContain("PRICE_SLIPPAGE_EXCEEDED");
  });

  it("should DENY when merchant is not allowed", () => {
    const result = evaluateCheckout(disallowedMerchantCheckout);
    expect(result.decision).toBe("DENY");
    expect(result.reasonCodes).toContain("MERCHANT_NOT_ALLOWED");
  });
});
```

### Integration Tests

```typescript
// tests/api/checkout.test.ts
describe("Checkout API", () => {
  it("should return cart mandate for valid request", async () => {
    const response = await request(app)
      .post("/v1/agent/checkout")
      .send(validCheckoutRequest);

    expect(response.status).toBe(200);
    expect(response.body.cartMandate).toBeDefined();
    expect(response.body.policyEvaluation.decision).toBe("ALLOW");
  });
});
```

### End-to-End Tests (Playwright)

```typescript
// tests/e2e/checkout-flow.spec.ts
test("complete AI agent purchase flow", async ({ page }) => {
  // Navigate to merchant discovery
  await page.goto("/.well-known/agent-commerce.json");

  // Search catalog
  const catalog = await page.request.get("/v1/agent/catalog?q=keyboard");
  const product = await catalog.json().then((d) => d.items[0]);

  // Request checkout
  const checkout = await page.request.post("/v1/agent/checkout", {
    data: {
      intentMandateId: "int_01K3...",
      items: [{ variantId: product.variantId, quantity: 1 }],
    },
  });

  // Process payment
  // ... complete the flow
});
```

### Security Tests

```typescript
// tests/security/webhook.test.ts
describe("Webhook Security", () => {
  it("should reject webhook with invalid signature", async () => {
    const response = await request(app)
      .post("/api/webhooks/razorpay")
      .set("x-razorpay-signature", "invalid")
      .send({ event: "payment.captured" });

    expect(response.status).toBe(401);
  });

  it("should deduplicate webhook events", async () => {
    const eventId = "evt_123";
    // Send first event
    await sendWebhook(eventId);
    // Send duplicate
    const response = await sendWebhook(eventId);
    expect(response.status).toBe(200);
    const logs = await db.auditEvents.findMany({ where: { eventId } });
    expect(logs).toHaveLength(1);
  });
});
```

---

## Developer Setup

### Prerequisites

- Node.js 20+
- PNPM 9+
- PostgreSQL 15+ (or Neon account)
- Git

### Initial Setup

```bash
# Clone repository
git clone https://github.com/your-org/agentpay-merchant.git
cd agentpay-merchant

# Install dependencies
pnpm install

# Copy environment variables
cp .env.example .env.local

# Generate database migration
pnpm db:generate

# Apply migration
pnpm db:migrate

# Seed database
pnpm db:seed

# Start development server
pnpm dev
```

### Environment Variables

```env
# .env.local
DATABASE_URL="postgresql://user:password@localhost:5432/agentpay"

# Razorpay (Test Mode)
RAZORPAY_KEY_ID="rzp_test_xxxxx"
RAZORPAY_KEY_SECRET="xxxxxxxxxxxxxxxx"
RAZORPAY_WEBHOOK_SECRET="xxxxxxxxxxxxxxxx"

# AI (for simulation)
MODEL_API_KEY="sk-xxxxx"

# App
APP_BASE_URL="http://localhost:3000"
DEMO_MODE=true

# Security
SESSION_SECRET="xxxxxxxxxxxxxxxx"
```

### Development Commands

```bash
# Start all services in development
pnpm dev

# Start only web app
pnpm dev:web

# Run database studio
pnpm db:studio

# Generate migration
pnpm db:generate

# Run migration
pnpm db:migrate

# Seed database
pnpm db:seed

# Run tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Lint
pnpm lint

# Build
pnpm build
```

### Database Management

```bash
# Generate migration from schema changes
pnpm db:generate

# Run migrations
pnpm db:migrate

# Rollback migration
pnpm db:rollback

# Seed development data
pnpm db:seed

# Open Drizzle Studio
pnpm db:studio
```

### Git Workflow

```bash
# Feature branch
git checkout -b feature/checkout-api

# Make changes, commit
git add .
git commit -m "feat: implement checkout API"

# Push
git push origin feature/checkout-api

# Create PR
# ... open PR on GitHub
```

### Troubleshooting

**Database connection issues**:

- Verify `DATABASE_URL` in `.env.local`
- Check Neon dashboard for connection settings
- Ensure database is running (if local)

**Razorpay integration**:

- Verify API keys are correct
- Check that webhook URL is publicly accessible
- Test with Test Mode keys first

**Build issues**:

- Clear `.turbo` and `node_modules`:
  ```bash
  rm -rf .turbo node_modules
  pnpm install
  ```

---

## Success Metrics

### MVP Definition of Done

- [ ] Merchant can create products in the catalogue
- [ ] AI agent can discover and search the catalogue
- [ ] AI agent can request a checkout quote
- [ ] Merchant generates authoritative cart mandate
- [ ] Policy verification returns ALLOW/STEP_UP/DENY
- [ ] Razorpay order is created for ALLOW decisions
- [ ] Checkout UI processes payment via Razorpay Test Mode
- [ ] Webhook verification validates payment
- [ ] Audit log records every transaction
- [ ] Merchant dashboard displays orders
- [ ] Simulation environment demonstrates happy path
- [ ] Simulation environment demonstrates failure scenarios

### Quality Metrics

- **Test Coverage**: >80% for core business logic
- **API Response Time**: <500ms for catalog searches
- **Checkout Time**: <2s for quote generation
- **Idempotency**: 100% - no duplicate orders
- **Audit Completeness**: Every financial action logged
- **Security**: No hardcoded secrets; all webhooks verified

---

## Resources & References

### Documentation

- [Next.js Documentation](https://nextjs.org/docs)
- [Drizzle ORM Docs](https://orm.drizzle.team)
- [Neon PostgreSQL](https://neon.tech/docs)
- [Razorpay API Docs](https://razorpay.com/docs/api)
- [shadcn/ui Docs](https://ui.shadcn.com)

### Protocol References

- [UPI Circle - NPCI](https://www.npci.org.in/product/upi-circle)
- [Google AP2 Protocol](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol)
- [OpenAI ACP](https://developers.openai.com/commerce)
- [Google UCP](https://developers.googleblog.com/under-the-hood-universal-commerce-protocol-ucp/)

### Community & Support

- GitHub Issues: [Create an issue](https://github.com/your-org/agentpay-merchant/issues)
- Discord: [Join our Discord](https://discord.gg/your-invite)
- Email: support@agentpay.dev

---

## Conclusion

This AGENTS.md document provides a complete blueprint for building a merchant platform that AI agents can discover, query, and transact with. The architecture is:

- **AI-Native**: Designed from the ground up for AI agent customers
- **Merchant-First**: Complete dashboard and controls for human merchants
- **Secure**: Verified mandates, cryptographically signed webhooks, idempotent transactions
- **Testable**: Simulation environment with pre-built scenarios
- **Production-Ready**: Deployable to Vercel with Neon database

**The future of commerce is AI agents purchasing from AI-native merchants. You're building the merchant infrastructure for that future.**

---

## Appendix: Quick Reference

### API Endpoints Summary

| Method | Endpoint                           | Purpose             |
| ------ | ---------------------------------- | ------------------- |
| GET    | `/.well-known/agent-commerce.json` | Discovery           |
| GET    | `/v1/agent/catalog`                | Search products     |
| GET    | `/v1/agent/products/{id}`          | Get product details |
| POST   | `/v1/agent/verify`                 | Verify mandate      |
| POST   | `/v1/agent/checkout`               | Get quote           |
| POST   | `/v1/agent/checkout/confirm`       | Confirm and pay     |
| GET    | `/v1/agent/payments/{id}`          | Check status        |

### Database Tables

| Table                 | Purpose               |
| --------------------- | --------------------- |
| `merchants`           | Merchant profiles     |
| `products`            | Product catalogue     |
| `product_variants`    | Product variants      |
| `agent_requests`      | Agent request log     |
| `checkout_proposals`  | Checkout quotes       |
| `checkout_line_items` | Line items for quotes |
| `agent_registrations` | Agent verification    |
| `audit_events`        | Audit trail           |

### Environment Variables

| Variable                  | Required | Purpose                     |
| ------------------------- | -------- | --------------------------- |
| `DATABASE_URL`            | Yes      | Neon database connection    |
| `RAZORPAY_KEY_ID`         | Yes      | Razorpay API key (Test)     |
| `RAZORPAY_KEY_SECRET`     | Yes      | Razorpay secret (Test)      |
| `RAZORPAY_WEBHOOK_SECRET` | Yes      | Webhook verification secret |
| `APP_BASE_URL`            | Yes      | Application URL             |
| `DEMO_MODE`               | No       | Enable demo features        |

---

**AgentPay Merchant**: Building the bridge between AI agents and commerce.

---

_Last Updated: August 2026_  
_Version: 1.0.0_

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
