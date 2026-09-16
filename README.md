<div align="center">

<img src="public/logos/merchantgate-mark.svg" alt="MerchantGate" width="100" height="100" />

# MerchantGate

### Agent Commerce Infrastructure

**AI agents are the new customers. MerchantGate is the merchant infrastructure they discover, query, negotiate with, and buy from — with a full human-facing management dashboard on top.**

[![CI](https://github.com/your-org/merchantgate/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/merchantgate/actions)

Documentation · [Agent-Facing API](#agent-facing-api) · [Quick Start](#quick-start) · [Deployment](#deployment)

</div>

> MerchantGate inverts the "build an AI shopper" idea. Instead of an agent that visits
> human storefronts, MerchantGate is a **storefront built for agents** — a discovery
> document, an authoritative quoting protocol, and a deterministic pricing core that no
> LLM can talk past.

---

## Live Demo

**[merchantgate.vercel.app](https://merchantgate.vercel.app/)** — login, open the **Agent Sandbox**, and watch an AI buyer run a full purchase: discovery → catalog → verify → negotiate → checkout → payment.

|                        |                                                              |
| ---------------------- | ------------------------------------------------------------ |
| **Dashboard Password** | `MERCHANT_ADMIN_PASSWORD` env var (demo deploy on request)   |
| **Mode**               | Razorpay Test Mode — no real money moves                     |
| **What to try**        | Sandbox → "Happy Path" → watch the audit trail hash chain    |

---

## Why This Exists

AI buyer agents can now browse, compare, and purchase on behalf of users. But **merchants have no infrastructure for them** — storefronts are built for human eyes and human clicks, and letting an LLM decide prices is a liability, not a feature.

MerchantGate gives a merchant:

1. a **machine-readable commerce protocol** AI agents can discover and transact against;
2. a **deterministic merchant core** so prices, availability, taxes, and policy stay merchant-controlled (agents request quotes — they never set prices);
3. a **management dashboard** with policy, approvals, campaigns, surge pricing, orders, and an append-only audit trail.

---

## Architecture

```
┌────────────────────────────  PUBLIC AGENT GATEWAY  ────────────────────────────┐
│  AI Buyer Agent ──▶ ✓/.well-known/agent-commerce.json      discovery           │
│  (intent mandate)    /v1/agent/verify            intent + identity gate       │
│                      /v1/agent/catalog, products[variant]   catalogue          │
│                      /v1/agent/negotiate         bounded multi-round pricing   │
│                      /v1/agent/checkout          authoritative quote (hot path)│
│                      /v1/agent/checkout/confirm  simulated_uap | razorpay      │
│                      /v1/agent/upsell            content-addressed cross-sell  │
│                      auth: demo | strict signed key · token-bucket rate limit  │
│                      every request carries a trace_id                          │
└──────────────────────────────────┬──────────────────────────────────────────────┘
                                   │
                           ┌───────▼────────┐
                           │ DETERMINISTIC  │   src/core/pricing.ts (pure, unit-tested)
                           │  MERCHANT CORE │   policy engine + atomic 30-day budget
                           │  (no LLM here) │   · campaign/surge/negotiation rules
                           └───────┬────────┘   · hashes + TOCTOU re-checks
                                   │
        ┌──────────────────────────┼──────────────────────────────┐
        ▼                          ▼                              ▼
   Neon PostgreSQL            Razorpay (test)               Merchant Dashboard
   Drizzle ORM · 12 tables    HMAC-SHA256 webhooks          session-authed · 11 pages
   audit hash chain           + SSE webhook inspector       requests, orders, policies,
                                                           campaigns, sandbox, audit
```

**The one-line rule:** *the LLM proposes; deterministic code disposes.* The agent layer is thin and audited; the pricing/policy core is pure TypeScript with no network or framework imports — so it can be unit-tested exhaustively and can never be persuaded to sell below floor.

---

## Design Decisions

| Decision | What the code does |
| --- | --- |
| **Deterministic pricing core** | `src/core/pricing.ts` — pure cart pricing (surge, campaigns, negotiated terms, taxes) with no I/O. Prices are never set by the LLM. |
| **Every transaction has lineage** | One `trace_id` flows from discovery request to payment webhook; every step appends to an SHA-256 hash-chained audit trail. |
| **Atomic concurrent spend** | Rolling 30-day budget reservations are enforced at policy time against committed spend (reservations + completed payments) — no overspend under concurrency. |
| **Merchant is source of truth** | Buyer-supplied intent mandates are sanitised/bounded before reaching the policy engine; availability, tax, and prices always come from the DB. |
| **Fraud prevention at the boundary** | Razorpay webhooks are HMAC-verified, deduplicated, and the cart snapshot hash is re-checked at settlement (TOCTOU guard). |
| **Single-tenant seam** | The demo merchant id lives in exactly one dependency-free module (`src/lib/merchant/tenant.ts`); every route resolves merchant context through it — multi-tenancy drops in at one seam. |

### Checkout hot path — DB round-trips

The quote endpoint is the money path, so it was tuned from ~17–19 database round-trips to **~6–8**:

| Step in `/v1/agent/checkout` | Before | After |
| --- | --- | --- |
| Merchant context (row + AI-sales gate + surge state) | 2 reads | 1 read |
| Cart mandate (existence check + full row) | 2 reads | 1 read, reused |
| Rolling 30-day budget usage | 4 reads | 2 parallel reads, single JOIN |
| Upsell market-basket candidates | 1 query per basket | 1 JOIN total |
| Writes (mandate + cart + decision + reservation + payment action) | 5 sequential inserts | 1 atomic HTTP transaction |
| Campaign spend recording | 1 update per campaign | 1 batched `UPDATE` |

*Metric is database round-trips, not wall-clock — latency depends on region (deployed to `bom1`).*

---

## Agent-Facing API

The wire protocol is published live at `/.well-known/agent-commerce.json`, with a machine-readable **OpenAPI 3.1 spec at `/api/openapi.json`** generated from the Zod wire contracts. All money is in **minor units** (INR paise).

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/.well-known/agent-commerce.json` | Capabilities + endpoint discovery |
| GET | `/v1/agent/catalog?q=&category=&inStock=&minPrice=&maxPrice=&limit=&cursor=` | Search catalogue |
| GET | `/v1/agent/products/{variant_id}` | Product variant detail |
| POST | `/v1/agent/verify` | Validate intent mandate + agent identity → `ALLOW` / `STEP_UP` / `DENY` |
| POST | `/v1/agent/negotiate` | Multi-round price negotiation, bounded by merchant rules |
| POST | `/v1/agent/checkout` | Request authoritative quote → `cart_mandate.v1` + policy evaluation |
| POST | `/v1/agent/checkout/confirm` | Confirm quote; settle via `simulated_uap` or `razorpay_checkout` |
| POST | `/v1/agent/upsell` | Content-addressed cross-sell offer |
| GET | `/v1/agent/payments/{id}` | Payment status |

Every endpoint returns explicit **reason codes** on policy decisions (`LimitExceeded`, `MERCHANT_NOT_ALLOWED`, `PRICE_SLIPPAGE_EXCEEDED`, `SURGE_PRICING_ACTIVE`, …), appends an **audit event** under the request `trace_id`, and honours the **global AI-sales kill switch**.

```json
// POST /v1/agent/checkout
{
  "intentMandateId": "int_01K3...",
  "verificationId": "ver_01K3...",
  "items": [{ "variantId": "kbd_nimbus_75_black_brown", "quantity": 1 }]
}
```

```json
// Response
{
  "success": true,
  "cartMandate": {
    "type": "cart_mandate.v1",
    "totals": { "grandTotalMinor": 1599900, "currency": "INR" },
    "contentHash": "sha256…",
    "expiresAt": "2026-09-04T12:05:00Z"
  },
  "policyEvaluation": { "decision": "ALLOW", "reasonCodes": [] }
}
```

---

## Merchant Dashboard

A session-authenticated React app (11 pages) for running the merchant side of the protocol:

| Page | Purpose |
| --- | --- |
| Overview | KPIs (GMV, orders, conversion, step-ups), surge kill-toggles, live activity |
| Products | Catalogue CRUD, inventory, status toggles |
| Requests | Live agent request feed; approve `STEP_UP` |
| Orders | Orders + refunds (Razorpay) |
| Policies | Policy engine config: limits, slippage, allowlists |
| Campaigns | Promotions lifecycle + performance |
| Agent Sandbox | Scenario runner + inventory LLM chat over the live catalogue |
| Analytics | Charts (Recharts) |
| Audit Trail | Append-only log explorer with hash chain |
| Webhooks | SSE live stream of incoming Razorpay webhooks |
| Settings | Merchant + payment configuration |

The **Agent Sandbox** is an intentional, externally visible testing surface — it exercises the exact same routes/policy the real agent gateway serves.

---

## Quick Start

```bash
git clone https://github.com/your-org/merchantgate.git
cd merchantgate
pnpm install

cp .env.example .env.local      # fill DATABASE_URL, RAZORPAY_* , MERCHANT_ADMIN_PASSWORD

pnpm db:migrate && pnpm db:seed
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) → login → **Agent Sandbox** → run "Happy Path".

### Try It as an AI Agent

```bash
curl https://merchantgate.vercel.app/.well-known/agent-commerce.json
curl "https://merchantgate.vercel.app/v1/agent/catalog?q=keyboard&inStock=true"
curl -X POST https://merchantgate.vercel.app/v1/agent/checkout \
  -H "Content-Type: application/json" \
  -d '{"intentMandateId":"int_demo","verificationId":"ver_demo","items":[{"variantId":"kbd_nimbus_75_black_brown","quantity":1}]}'
```

---

## Money Safety

Every financial action is **explainable, bounded, and gated**:

- **The LLM proposes; deterministic code disposes.** Prices, taxes, and availability are merchant-controlled; agents request authoritative, time-bound quotes.
- **Policy gate on every checkout** — `ALLOW` / `STEP_UP` / `DENY` with explicit `reasonCodes`. `STEP_UP` requires human approval in the dashboard before the quote is released.
- **Atomic budget reservations** — rolling 30-day spend (reservations + completed payments) is enforced at policy time **and re-verified by a Postgres trigger at commit time**, inside a serializable single-request transaction; exhaustion returns `ROLLING_BUDGET_EXHAUSTED`, never overspend. CHECK constraints keep money/stock non-negative at the database level.
- **Hash-chained audit trail** — append-only `audit_events` linked by `trace_id` + `seq_no`, checksummed with SHA-256 canonical snapshots.
- **Negotiation bounds** — price floors / discount caps configured per merchant; sessions are round- and time-bounded.

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| Framework | Next.js 16 (App Router, Vercel Functions, region `bom1`) |
| Language | TypeScript 5 |
| Styling | Tailwind CSS 4 + shadcn/ui |
| Database | Neon PostgreSQL + Drizzle ORM (12 tables) |
| Orm tooling | drizzle-kit (generate / migrate / studio) |
| Payments | Razorpay Node SDK (test mode) + simulated UAP |
| AI | Vercel AI SDK + OpenAI-compatible providers |
| Validation | Zod 4 |
| Dashboard auth | Session cookie signed with HMAC |
| Agent auth | `demo` (default) or `strict` signed keys + token-bucket rate limiting |
| Linting/Formatting | Biome 2 |
| Tests | Node built-in test runner via `tsx --test` (47 cases) |
| CI | GitHub Actions (`build` → `test` → `lint`) |
| Deployment | Vercel + Neon |

**Key package note:** the pricing core (`src/core/pricing.ts`) imports **zero** framework/database code — it is a pure TypeScript module with exhaustive unit tests, which is the guarantee that "no LLM sets a price".

---

## Project Structure

```
src/
├── app/                      # Next.js App Router
│   ├── page.tsx              # Public landing page
│   ├── login/                # Merchant sign-in
│   ├── (dashboard)/          # Session-protected route group (11 pages)
│   ├── v1/agent/             # PUBLIC agent-commerce protocol (10 endpoints)
│   ├── api/merchant/         # Merchant-facing JSON API
│   ├── api/simulation/       # Sandbox scenario runner
│   ├── api/webhooks/         # Razorpay webhook + SSE inspector
│   └── .well-known/          # agent-commerce.json discovery document
├── components/               # shadcn/ui primitives · dashboard · sandbox
├── core/                     # PURE merchant core (no I/O, no framework)
│   └── pricing.ts            #   deterministic cart pricing
├── lib/
│   ├── payments/             # razorpay client + HMAC + orchestrator
│   ├── policy/               # policy engine (ALLOW/STEP_UP/DENY) + budget
│   ├── merchant/             # context (1-read merchant ctx) · tenant seam ·
│   │                         #   campaigns · negotiation · upsell · surge
│   ├── simulation/           # buyer agent + scenario runner
│   ├── auth/                 # agent-auth · guard · session · rate-limit
│   ├── ai/                   # LLM provider + persona
│   ├── audit/                # append-only audit + hash chain
│   └── crypto/               # canonical JSON + SHA-256
├── db/                       # single Drizzle client (Neon) · 12-table schema · seed
└── tests/unit/               # 47 cases: policy engine, campaigns, negotiation,
                              #   upsell, pricing core, agent auth
```

---

## Deployment

1. Push to GitHub → connect to Vercel → add the env vars below.
2. Provision a Neon database; run `pnpm db:migrate` against it.
3. Deploy. Vercel Functions run in region `bom1` (configured in `vercel.json`).

### Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Neon PostgreSQL connection string |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Yes | Razorpay API keys (test mode) |
| `RAZORPAY_WEBHOOK_SECRET` | Yes | HMAC secret for webhook verification |
| `MERCHANT_ADMIN_PASSWORD` | Yes | Dashboard login password (min 8 chars) |
| `SESSION_SECRET` | Yes | Cookie HMAC signing secret |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID` | Yes | Browser-side Razorpay key |
| `AGENT_AUTH_MODE` | No | `demo` (default) or `strict` |
| `APP_BASE_URL` | No | Public app URL (webhooks) |
| `MODEL_API_KEY` | No | LLM provider key for AI features |
| `DEMO_MODE` | No | Demo conveniences |

---

## Testing

```bash
pnpm test      # tsx --test — 47 cases across 6 suites
pnpm lint      # Biome check
pnpm build     # TypeScript check + production build (typechecks tests too)
```

Suites: **policy engine** (decision semantics, budget boundaries, slippage, allowlists — the contract suite), pricing core, campaigns, negotiation, upsell, agent auth.

CI runs all three on every push/PR via [GitHub Actions](.github/workflows/ci.yml).

---

## Honest Inventory

This is a hackathon-born project being hardened toward production. Known limitations, documented truthfully:

- **Single-tenant seam** — one merchant resolved via `src/lib/merchant/tenant.ts` + `context.ts`; schema is multi-tenant-ready, request-credential resolution is next.
- **In-memory mutable state** — negotiation sessions/surge toggle live in `globalThis` maps, persisted to `merchants.config` jsonb; fine for single-region + light concurrency, not a durable store.
- **Fat route handlers** — pricing is extracted to a pure core, but checkout/confirm/webhook still orchestrate I/O + audit inline (no service layer yet).
- **No middleware.ts; observability is minimal** — auth is per-route (works, not centralized); `/api/health` + `/api/ready` + a small structured-logger exist, but there are no traces or a real metrics pipeline.
- **OpenAPI is a read-only artifact** — the 3.1 spec at `/api/openapi.json` is generated from the Zod wire contracts in `src/lib/api/schemas.ts`, but isn't yet wired into runtime validation or client generation.

The roadmap order: DB-level guards → webhook outbox/DLQ → multi-tenant credential resolution → wire the OpenAPI schema into runtime validation/client generation.