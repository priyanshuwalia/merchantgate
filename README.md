<div align="center">

<img src="public/logos/merchantgate-mark.svg" alt="MerchantGate" width="400" />
<span>MerchantGate</span>

### The merchant platform built for AI buyers.

**Discovery. Verification. Checkout. Payment. — all in a protocol AI agents understand.**

[![CI](https://github.com/your-org/merchantgate/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/merchantgate/actions)

[Documentation](#how-it-works) · [API Reference](#agent-facing-api) · [Quick Start](#quick-start) · [Deploy](#deployment)

</div>

---

<!-- PLACEHOLDER: Hero GIF — full agent-to-merchant flow (discovery → checkout → payment) -->

<br/>

## Live Demo

**[merchantgate.vercel.app](https://merchantgate.vercel.app/)**

|                        |                                                                               |
| ---------------------- | ----------------------------------------------------------------------------- |
| **Dashboard Password** | `MerchantPassword`                                                            |
| **Mode**               | Razorpay Test Mode — no real money moves                                      |
| **What to try**        | Login → Simulator tab → run "Happy Path" → watch the full flow in Audit Trail |

---

## The Problem

AI buyer agents — from OpenAI's Operator to Google's AP2-powered assistants — can now browse, compare, and purchase products on behalf of users. But merchants have no infrastructure for them. Their storefronts are built for human eyes and human clicks.

**MerchantGate fixes this.** It gives merchants a standards-compliant agent commerce API alongside a full management dashboard — so AI agents can discover products, negotiate prices, request authoritative quotes, and complete payments, all while the merchant retains full control and visibility.

---

## How It Works

```
┌──────────────────┐         ┌─────────────────────────┐         ┌──────────────┐
│  AI Buyer Agent  │────────▶│     MerchantGate API     │────────▶│   Razorpay   │
│                  │  JSON   │                         │  Order  │  (Test Mode) │
│  Intent Mandate  │◀────────│  Discovery · Verify ·   │◀────────│              │
│  Cart Request    │  Quote  │  Negotiate · Checkout   │  Webhook│              │
└──────────────────┘         └─────────────────────────┘         └──────────────┘
                                      │
                               ┌──────┴──────┐
                               │  Merchant   │
                               │  Dashboard  │
                               └─────────────┘
```

**1. Discovery** — Agent hits `/.well-known/agent-commerce.json` to learn what the merchant sells, what payment methods are available, and which endpoints to call.

**2. Catalog Search** — Agent queries `/v1/agent/catalog` with filters (price, category, stock). Gets back structured product data with variant-level pricing.

**3. Verify** — Agent presents an intent mandate (proof of user delegation, spending limits, allowed merchants). Merchant gate evaluates it and returns `ALLOW`, `STEP_UP` (needs human approval), or `DENY`.

**4. Negotiate** — Optional multi-round price negotiation within merchant-configured bounds. Each round is bounded and logged.

**5. Checkout** — Agent selects items, merchant generates an **authoritative cart mandate** — a time-bound, cryptographically signed quote. The LLM does not set prices. The merchant does.

**6. Pay** — Razorpay order is created. Agent or user completes payment. Webhook confirms. Audit trail records every step.

---

<!-- PLACEHOLDER: Screenshot — Merchant Dashboard showing live agent activity + audit trail -->

<br/>

## Features

### For AI Agents

| Endpoint                           | Method | What it does                            |
| ---------------------------------- | ------ | --------------------------------------- |
| `/.well-known/agent-commerce.json` | GET    | Machine-readable merchant discovery     |
| `/v1/agent/catalog`                | GET    | Search products with filters            |
| `/v1/agent/products/{id}`          | GET    | Fetch a specific product variant        |
| `/v1/agent/verify`                 | POST   | Verify agent mandate and identity       |
| `/v1/agent/negotiate`              | POST   | Multi-round price negotiation           |
| `/v1/agent/checkout`               | POST   | Request an authoritative quote          |
| `/v1/agent/checkout/confirm`       | POST   | Confirm quote, open Razorpay order      |
| `/v1/agent/payments/{id}`          | GET    | Check payment status                    |
| `/v1/agent/upsell`                 | POST   | Get cross-sell / upsell recommendations |

### For Merchants

| Capability             | Details                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| **Product Management** | CRUD, inventory tracking, variant-level pricing, categories & tags                              |
| **Policy Engine**      | Transaction limits, price slippage tolerance, merchant allowlists, rolling 30-day budgets       |
| **Agent Approval**     | STEP_UP decisions surface in dashboard for human review before quote is released                |
| **Campaigns**          | Flash sales, volume discounts, bundle deals, loyalty tiers, clearance, category-wide promotions |
| **Surge Pricing**      | Dynamic pricing simulation with configurable multipliers                                        |
| **Upsell Engine**      | Market basket analysis generates content-addressed upsell offers                                |
| **Negotiation UI**     | Merchants can respond to agent negotiation rounds in real-time                                  |
| **Order Management**   | View orders, process refunds via Razorpay API                                                   |
| **Audit Trail**        | Append-only log with SHA-256 hash chain — every action traceable                                |
| **Webhook Inspector**  | Real-time SSE stream of incoming Razorpay webhooks                                              |
| **Global Kill Switch** | Disable AI sales across the board with one toggle                                               |

### Built-in Simulation

Run pre-built scenarios to demonstrate the full flow without external agents:

- **Happy Path** — Complete purchase from discovery to payment
- **Policy Step-Up** — Transaction exceeds limits, requires merchant approval
- **Policy Deny** — Agent blocked by policy, graceful error with reason codes
- **Security Defense** — Prompt injection attempt in product description, caught and logged

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/your-org/merchantgate.git
cd merchantgate
pnpm install

# 2. Configure environment
cp .env.example .env.local
# Fill in DATABASE_URL, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET

# 3. Set up database
pnpm db:generate
pnpm db:migrate
pnpm db:seed

# 4. Start development server
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) to access the merchant dashboard.

### Try It as an AI Agent

```bash
# Discovery
curl https://merchantgate.vercel.app/.well-known/agent-commerce.json

# Search catalog
curl "https://merchantgate.vercel.app/v1/agent/catalog?q=keyboard&inStock=true"

# Get product details
curl https://merchantgate.vercel.app/v1/agent/products/kbd_nimbus_75_black_brown

# Run a full simulation
curl -X POST https://merchantgate.vercel.app/api/simulation/run \
  -H "Content-Type: application/json" \
  -d '{"scenario": "happyPath"}'
```

---

## Money Safety

Every financial action in MerchantGate is **explainable, bounded, and gated**:

- **The LLM proposes; deterministic code disposes.** Prices, taxes, and availability are merchant-controlled. AI agents request quotes — they never set prices.
- **Policy gate on every checkout.** Returns `ALLOW`, `STEP_UP`, or `DENY` with explicit `reasonCodes`. STEP_UP requires a human merchant to approve in the dashboard before the quote is released.
- **Atomic budget reservations.** Spending is tracked per-agent with row-level locking. When the rolling 30-day budget is exhausted, the system returns `ROLLING_BUDGET_EXHAUSTED` — never overspends.
- **Cryptographic quote integrity.** Every cart mandate carries a `devProof` — a SHA-256 digest of the canonical JSON quote. Any tampering breaks the hash.
- **Append-only audit trail.** Every event writes to `audit_events` with `snapshot_hash` and `prev_event_hash`, forming an unbroken chain. Every event includes `reason_codes` explaining what happened and why.
- **Negotiation bounds.** Merchant-configured minimum price floors and maximum discount caps. Multi-round negotiation sessions are time-bounded and logged.

---

<!-- PLACEHOLDER: Screenshot — Simulation running through a full checkout flow with audit trail -->

<br/>

## Tech Stack

| Layer      | Technology                                  |
| ---------- | ------------------------------------------- |
| Framework  | Next.js 16 (App Router)                     |
| Language   | TypeScript 5                                |
| Styling    | Tailwind CSS 4 + shadcn/ui                  |
| Database   | Neon PostgreSQL + Drizzle ORM               |
| Payments   | Razorpay Node SDK (test mode)               |
| AI         | Vercel AI SDK + OpenAI-compatible providers |
| Validation | Zod                                         |
| Testing    | Node test runner + Vitest                   |
| CI/CD      | GitHub Actions                              |
| Deployment | Vercel                                      |

---

## Project Structure

```
src/
├── app/
│   ├── (auth)/                    # Login
│   ├── (dashboard)/dashboard/     # Merchant UI (11 pages)
│   ├── v1/agent/                  # Agent-facing API endpoints
│   ├── api/merchant/              # Merchant-facing API
│   ├── api/webhooks/              # Razorpay webhook handler
│   └── api/simulation/            # Simulation runner
├── components/
│   ├── ui/                        # shadcn/ui primitives
│   ├── dashboard/                 # Dashboard-specific components
│   └── simulation/                # Simulation UI
├── lib/
│   ├── payments/                  # Razorpay integration + orchestrator
│   ├── policy/                    # Policy engine + budget tracker
│   ├── merchant/                  # Negotiation, campaigns, upsell, surge
│   ├── simulation/                # Scenario runner + buyer agent
│   ├── auth/                      # Agent auth, sessions, rate limiting
│   ├── ai/                        # LLM provider config + prompts
│   └── audit/                     # Audit logger with hash chain
├── db/
│   ├── schema.ts                  # 15+ tables (Drizzle ORM)
│   ├── seed.ts                    # Demo catalogue + products
│   └── migrations/                # Auto-generated SQL migrations
└── tests/unit/                    # 31+ test cases
```

---

## Deployment

### Vercel + Neon (Recommended)

1. Push to GitHub
2. Connect repo to Vercel
3. Set environment variables in Vercel dashboard
4. Create a Neon database and run `pnpm db:migrate`
5. Deploy

### Environment Variables

| Variable                  | Required | Description                            |
| ------------------------- | -------- | -------------------------------------- |
| `DATABASE_URL`            | Yes      | Neon PostgreSQL connection string      |
| `RAZORPAY_KEY_ID`         | Yes      | Razorpay API key (test mode)           |
| `RAZORPAY_KEY_SECRET`     | Yes      | Razorpay secret (test mode)            |
| `RAZORPAY_WEBHOOK_SECRET` | Yes      | HMAC secret for webhook verification   |
| `MERCHANT_ADMIN_PASSWORD` | Yes      | Dashboard login password (min 8 chars) |
| `AGENT_AUTH_MODE`         | No       | `demo` (default) or `strict`           |
| `APP_BASE_URL`            | No       | Public app URL (for webhooks)          |

---

## Testing

```bash
pnpm test     # Unit tests — 31+ cases across policy, campaigns, negotiation, upsell, auth
pnpm lint     # Biome linter
pnpm build    # TypeScript check + production build
```

CI runs all three on every push and PR via [GitHub Actions](.github/workflows/ci.yml).

---

## API Reference

<details>
<summary><strong>GET /.well-known/agent-commerce.json</strong> — Discovery</summary>

Returns merchant capabilities, supported endpoints, payment handlers, and currency configuration.

```json
{
  "protocol": "agentpay-commerce.v1",
  "merchantId": "mch_nimbus_gear_001",
  "merchantName": "Nimbus Gear",
  "capabilities": {
    "catalogSearch": true,
    "authoritativeCheckout": true,
    "negotiation": true,
    "upsell": true
  },
  "money": { "currencies": ["INR"], "minorUnits": true }
}
```

</details>

<details>
<summary><strong>POST /v1/agent/verify</strong> — Mandate Verification</summary>

Validates an agent's intent mandate. Returns `ALLOW`, `STEP_UP`, or `DENY` with reason codes.

```json
// Request
{
  "agentId": "agt_01K3...",
  "intentMandate": { "type": "intent_mandate.v1", "..." : "..." },
  "intentMandateId": "int_01K3..."
}

// Response
{
  "verified": true,
  "decision": "ALLOW",
  "reasonCodes": [],
  "verificationId": "ver_01K3...",
  "expiresAt": "2026-09-04T12:00:00Z"
}
```

</details>

<details>
<summary><strong>POST /v1/agent/checkout</strong> — Authoritative Quote</summary>

Agent sends cart items. Merchant returns a time-bound cart mandate with frozen prices.

```json
// Request
{
  "intentMandateId": "int_01K3...",
  "verificationId": "ver_01K3...",
  "items": [{ "variantId": "kbd_nimbus_75_black_brown", "quantity": 1 }]
}

// Response
{
  "success": true,
  "cartMandate": {
    "type": "cart_mandate.v1",
    "totals": { "grandTotalMinor": 1599900, "currency": "INR" },
    "expiresAt": "2026-09-04T12:05:00Z"
  },
  "policyEvaluation": { "decision": "ALLOW" },
  "razorpayOrderId": "order_abc123"
}
```

</details>

<details>
<summary><strong>POST /v1/agent/negotiate</strong> — Price Negotiation</summary>

Multi-round negotiation within merchant-configured bounds. Each round logs intent and response.

```json
{
  "sessionId": "neg_01K3...",
  "offerPriceMinor": 1499900,
  "message": "Can you do ₹14,999 for this keyboard?"
}

// Response
{
  "accepted": false,
  "counterPriceMinor": 1549900,
  "roundsRemaining": 3,
  "floorMinor": 1439900
}
```

</details>

---

<div align="center">

**Built for the merchants who will sell to machines.**

</div>
