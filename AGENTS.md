# AGENTS.md

## MerchantGate: Agent Commerce Infrastructure

### Project Overview

**MerchantGate** is a merchant platform designed for AI buyer agents. Inverts the "build an AI shopper" idea: this is the **merchant infrastructure** that AI buyer agents can discover, query, negotiate with, and transact against — with a full human-facing management dashboard on top.

It is a **single Next.js 16 (App Router) application** written in TypeScript, deployed to Vercel (Vercel Functions, region `bom1`) with a Neon PostgreSQL database, Drizzle ORM, and Razorpay (test mode) for payments.

> Historical note: an earlier AGENTS.md described this as a pnpm monorepo (`apps/` + `packages/`) with shared contract packages. **That is not what exists.** This file documents the actual codebase. Read it, not the old plan.

**Core philosophy:**
> **AI agents are the new customers. Build your merchant infrastructure for them.**

**Design principles implemented in code:**

1. **The LLM proposes; deterministic code disposes.** AI agents may request purchases; the merchant's deterministic policy engine publishes authoritative, time-bound quotes. Prices are never set by the LLM.
2. **Every transaction has a lineage.** From discovery request to payment confirmation, every step carries a `trace_id` and writes to an append-only audit trail with a SHA-256 hash chain.
3. **Concurrent spend is atomic.** Rolling 30-day budget reservations are enforced at policy time against committed spend (reservations + completed payments).
4. **The merchant is the source of truth.** Prices, availability, taxes, and policy are merchant-controlled; buyer-supplied intent mandates are sanitised and bounded before they ever reach the policy engine.
5. **Fraud prevention at the boundary.** Razorpay webhooks are HMAC-SHA256 verified, **claim-first deduplicated** (DB `ON CONFLICT DO NOTHING` claim + state machine statuses `received`/`processed`/`failed`, with atomic takeover of `failed` events on retry), and the cart snapshot hash is re-checked at settlement (TOCTOU guard). State transitions + inventory decrement + dedupe status commit through the same `runTransaction` batch.

---

## Technology Stack (actual)

| Layer | Technology |
| --- | --- |
| Framework | Next.js 16 (App Router, Vercel Functions) |
| Language | TypeScript 5 |
| Styling | Tailwind CSS 4 + shadcn/ui + Base UI |
| Icons | lucide-react, @hugeicons/react |
| Database | Neon PostgreSQL + Drizzle ORM (1.0 rc) |
| Orm tooling | drizzle-kit (generate/migrate/studio) |
| Payments | Razorpay Node SDK (test mode) + simulated UAP |
| AI | Vercel AI SDK + OpenAI-compatible providers (`@ai-sdk/openai`) |
| Validation | Zod 4 |
| Dashboard auth | Session cookie signed with HMAC (password = `MERCHANT_ADMIN_PASSWORD`) |
| Agent auth | Per-merchant `agentAuthMode`: `demo` (default) or `strict` |
| Rate limiting | In-memory token bucket per agent+route namespace |
| Linting/Formatting | Biome 2 |
| Tests | Node built-in test runner via `tsx --test` |
| CI | GitHub Actions (`pnpm build` + `pnpm test` + `pnpm lint`) |
| Deployment | Vercel + Neon |

---

## Architecture Overview (actual)

Single Next.js app in `src/`. Two public surfaces segregated by route + auth:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Next.js 16 (Vercel Functions)                │
│                                                                     │
│  PUBLIC AGENT GATEWAY (no merchant session)                         │
│    /.well-known/agent-commerce.json        discovery                │
│    /v1/agent/{catalog,products,verify,     commerce protocol        │
│       checkout,checkout/confirm,           endpoints                │
│       negotiate,upsell,payments}                                   │
│      auth: agent-auth (demo key | strict signed key) + rate limit   │
│                                                                     │
│  AUTHENTICATED MERCHANT API (session cookie)                        │
│    /api/merchant/*          products, orders, requests, policies,   │
│                             settings, stats, agents, campaigns,     │
│                             surge, audit, agent-chat, ai-test       │
│    /api/auth/*              login / logout                          │
│    /api/simulation/*        scenario runner (Sandbox feature)       │
│    /api/webhooks/*          razorpay webhook + SSE inspector        │
│                                                                     │
│  MERCHANT DASHBOARD (React Server/Client components)                │
│    /login , /dashboard/* (11 pages), /admin/webhook-inspector       │
└───────────────┬─────────────────────────────────────────────────────┘
                │
        ┌───────┴────────┐        ┌──────────────────┐
        │ Neon PostgreSQL │        │ Razorpay (test)  │
        │ (Drizzle ORM)   │        │  + Razorpay      │
        └─────────────────┘        │  webhooks        │
                                   └──────────────────┘
```

Key property: **the deterministic merchant core (pricing) lives in `src/core` (pure, unit-tested) with policy/quoting in `src/lib/policy` and `src/lib/merchant`**, called from thin-to-moderate route handlers. See "Known Limitations" for the current state of this split.

---

## Project Structure (actual)

```
src/
├── app/                              # Next.js App Router
│   ├── layout.tsx                    # Root layout (light theme, Inter)
│   ├── page.tsx                      # Public landing page
│   ├── login/page.tsx                # Merchant sign-in
│   ├── (dashboard)/                  # Session-protected route group
│   │   ├── layout.tsx                #   requirePageAuth() + DashboardShell
│   │   └── dashboard/
│   │       ├── page.tsx              #   Overview (KPIs, surge kill-toggles)
│   │       ├── products/             #   catalogue CRUD
│   │       ├── requests/             #   live agent request monitor
│   │       ├── orders/               #   orders + refunds
│   │       ├── policies/             #   policy engine config
│   │       ├── campaigns/            #   promotions (6 types)
│   │       ├── sandbox/              #   Agent Sandbox (scenario runner + inventory chat)
│   │       ├── analytics/            #   charts
│   │       ├── audit/                #   audit trail explorer
│   │       ├── webhook-inspector/    #   SSE live webhook stream
│   │       └── settings/             #   merchant + payment config
│   ├── admin/webhook-inspector/      # Standalone inspector (dev tool)
│   ├── v1/agent/                     # PUBLIC agent-commerce protocol
│   │   ├── catalog/route.ts
│   │   ├── products/[id]/route.ts
│   │   ├── verify/route.ts
│   │   ├── negotiate/route.ts
│   │   ├── checkout/route.ts         # Authoritative quote (hot path — RT-tuned)
│   │   ├── checkout/confirm/route.ts
│   │   ├── upsell/route.ts
│   │   └── payments/{[id], verify}/route.ts
│   ├── api/
│   │   ├── auth/{login,logout}/route.ts
│   │   ├── merchant/.../route.ts     # merchant-facing JSON API
│   │   ├── simulation/run/route.ts   # sandbox scenario runner
│   │   ├── v1/catalog/route.ts       # legacy alias
│   │   └── webhooks/razorpay/route.ts + inspector/*
│   └── .well-known/agent-commerce.json/route.ts   # discovery doc
├── components/
│   ├── ui/                           # shadcn/ui primitives (card, button, …)
│   ├── dashboard/                    # Shell, Sidebar, TopNavbar, Header, LiveActivity
│   ├── sandbox/                      # SimulationRunner + InventoryAgentConsole (tabbed)
│   └── branding/Logo.tsx             # MerchantGate logo (mark)
├── core/                             # PURE merchant core (no Next.js, no DB, no I/O)
│   └── pricing.ts                    #   deterministic cart pricing (surge/campaign/negotiation)
├── lib/
│   ├── payments/                     # razorpay.ts (client+HMAC) + orchestrator.ts
│   ├── policy/                       # engine.ts (ALLOW/STEP_UP/DENY) + budget.ts
│   ├── merchant/                     # context.ts (1-read merchant ctx), tenant.ts, guard, campaigns,
│   │                                #   negotiation, upsell, surge, agent, runtime-state
│   ├── simulation/                   # buyer-agent, runner, scenarios
│   ├── auth/                         # agent-auth, guard, session, rate-limit
│   ├── ai/                           # llm, persona, provider
│   ├── audit/logger.ts               # append-only audit + hash chain
│   ├── broadcast/agentpay-bus.ts     # BroadcastChannel cross-tab events (browser)
│   ├── crypto/canonical.ts           # canonical JSON + SHA-256 helpers
│   └── utils.ts
├── db/
│   ├── index.ts                      # single drizzle client (Postgres)
│   ├── schema.ts                     # 12 tables, snake_case
│   └── seed.ts                       # demo catalogue + config (Nimbus Gear)
├── tests/
│   ├── unit/                         # policy, campaigns, negotiation, upsell, pricing-core, auth
│   ├── api-test.ts, test-suite.ts, sim-runner-test.ts   # dev/test helpers
└── (no middleware.ts — auth is per-route)
```

---

## Data Model (actual — 12 tables)

Full schema in `src/db/schema.ts`. Money is stored as **minor units** (`*_minor` integer columns), currency defaults to `INR`.

| Table | Purpose | Notable columns / constraints |
| --- | --- | --- |
| `merchants` | Merchant profile + config | `api_key_hash`, `webhook_secret`, `config` (jsonb: gate, surge, runtime-state) |
| `campaigns` | Promotions (6 types) | `discount_bps`, `budget_minor`, `spent_minor`, `priority`, `stackable`, `ab_group`, `target_agents` |
| `products` | Catalogue (variant-level) | `variant_id` (unique), `base_price_minor`, `tax_rate_bps`, `stock_quantity`, `version` |
| `agents` | AI buyer registry | `public_key`, `expires_at` |
| `intent_mandates` | Principal authority | `mandate_json`, `max_transaction_minor`, `validity_expires_at` |
| `cart_mandates` | Merchant authoritative quote | `content_hash`, `quote_expires_at`, partial index on active |
| `policy_decisions` | The gate | `decision` (ALLOW/STEP_UP/DENY), **unique per cart_mandate** (evaluated once) |
| `budget_reservations` | Atomic spend hold | `amount_minor`, `status`, partial index on reserved |
| `payment_actions` | Razorpay intent lifecycle | unique `cart_mandate_id`, `decision_id`, `budget_reservation_id`, partial index on order |
| `refund_actions` | Refunds | `idempotency_key` (unique) |
| `webhook_events` | Webhook dedup | `provider_event_id` (unique) |
| `audit_events` | Append-only trail | identity id, `snapshot_hash`, linked by `trace_id` + `seq_no`; hash chain via canonical snapshot |

DB-level guards (migration `20260916071937_db_guards`, idempotent):
- **CHECK constraints** enforce non-negative money/stock and bounded discount bps on `budget_reservations`, `payment_actions`, `refund_actions`, `products`, `campaigns`, `intent_mandates`.
- **`enforce_rolling_budget` trigger** (BEFORE INSERT on `budget_reservations`) re-derives the mandate's committed 30-day usage and raises `ROLLING_BUDGET_EXHAUSTED` if the ceiling would be busted — aborting the whole checkout batch. Checkout/confirm writes commit through `runTransaction()` (single atomic HTTP transaction in `src/db/index.ts`, serializable by default); the checkout route retries SQLSTATE 40001 serialization conflicts up to 3×.

---

## Agent-facing API (actual)

Wire protocol documented live in `/.well-known/agent-commerce.json`. All money in minor units (`INR` paise).

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/.well-known/agent-commerce.json` | Capabilities + endpoints discovery |
| GET | `/v1/agent/catalog?q=&category=&inStock=&minPrice=&maxPrice=&limit=&cursor=` | Search catalogue |
| GET | `/v1/agent/products/{variant_id}` | Product variant detail |
| POST | `/v1/agent/verify` | Validate intent mandate + agent identity → `ALLOW/STEP_UP/DENY` |
| POST | `/v1/agent/negotiate` | Multi-round price negotiation (bounded by merchant rules) |
| POST | `/v1/agent/checkout` | Request authoritative quote → `cart_mandate.v1` + `policyEvaluation` |
| POST | `/v1/agent/checkout/confirm` | Confirm quote; `simulated_uap` or `razorpay_checkout` |
| POST | `/v1/agent/upsell` | Content-addressed cross-sell offer |
| GET | `/v1/agent/payments/{id}` | Payment status |
| POST | `/v1/agent/payments/verify` | Verify a Razorpay capture (legacy helper) |

Every endpoint:
- returns **reason codes** on policy decisions (`LimitExceeded`, `MERCHANT_NOT_ALLOWED`, `PRICE_SLIPPAGE_EXCEEDED`, `SURGE_PRICING_ACTIVE`, …);
- writes an **audit event** with the request `trace_id`;
- honours the **global AI-sales kill switch** (`config.aiSalesEnabled`).

---

## Merchant Dashboard (actual — 11 pages)

| Page | Purpose |
| --- | --- |
| Overview | KPI cards (GMV, orders, conversion, step-ups), surge toggle, recent activity |
| Products | Catalogue CRUD, inventory, status toggles |
| Requests | Live agent request feed, filter by status, approve STEP_UP |
| Orders | Orders + refunds (Razorpay) |
| Policies | Policy engine config (limits, slippage, allowlists) |
| Campaigns | Promotions lifecycle + performance |
| Inventory Agent | LLM agent chat over catalogue + inventory (Sandbox) |
| Analytics | Charts (Recharts) |
| Simulator | Scenario runner: happy path, policy step-up, deny, prompt-injection (Sandbox) |
| Audit Trail | Append-only log explorer with hash chain |
| Webhooks | SSE live stream of incoming Razorpay webhooks |

The **Simulator** and **Inventory Agent** pages are packaged as the "Agent Sandbox" — an intentional, externally visible testing surface that exercises the same APIs the real agent gateway serves.

---

## Environment Variables (actual)

`.env.example` is authoritative. Required at runtime: `DATABASE_URL`, `SESSION_SECRET`, `MERCHANT_ADMIN_PASSWORD`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `NEXT_PUBLIC_RAZORPAY_KEY_ID`. Optional: `MODEL_API_KEY`, `APP_BASE_URL`, `AGENT_AUTH_MODE`, `DEMO_MODE`.

---

## Commands (actual)

```bash
pnpm dev              # next dev
pnpm build            # next build (also the typecheck gate in CI)
pnpm start            # next start
pnpm lint             # biome check
pnpm format           # biome format --write
pnpm test             # tsx --test 'src/tests/unit/**/*.test.ts'
pnpm db:generate      # drizzle-kit generate
pnpm db:migrate       # drizzle-kit migrate
pnpm db:studio        # drizzle-kit studio
pnpm db:seed          # tsx src/db/seed.ts
```

CI (`.github/workflows/ci.yml`): install → `pnpm build` → `pnpm test` (with a placeholder `DATABASE_URL` the test harness never connects to — see `src/tests/unit/_setup.ts`) → `pnpm lint`.

---

## Testing (actual)

- **Unit tests** (`src/tests/unit/*.test.ts`, Node test runner): policy engine, campaigns, negotiation, upsell, pricing core, agent auth. 47 cases.
- **Policy engine contract** is the most important suite — decision semantics (`ALLOW/STEP_UP/DENY`) with `reasonCodes`, budget boundary cases, slippage, merchant allowlists.
- Manual/integration helpers exist under `src/tests/` (api-test, test-suite, sim-runner) and the **Simulation Sandbox** drives the full flow against real route handlers + real DB.

---

## Known Limitations & Technical Debt (honest inventory)

Addressing these is the roadmap. They are the current state, not the goal.

1. **Single merchant tenant (single seam).** The demo tenant `"mch_nimbus_gear_001"` now exists ONLY in `src/lib/merchant/tenant.ts` (`DEFAULT_MERCHANT_ID`); every route/lib/page imports it through that module, and `src/lib/merchant/context.ts` resolves the acting merchant from it in one read. Multi-tenancy is scaffolded at the schema level (`merchants.api_key_hash`, per-row config) but not yet resolved from a request credential.
2. **In-memory mutable state in serverless functions.** Negotiation sessions and the surge toggle live in `globalThis` module maps and are snapshot/persisted to `merchants.config` jsonb via `src/lib/merchant/runtime-state.ts`. Works for a single region + light concurrency; not a durable store.
3. **Fat route handlers.** The pricing/policy/quoting math now lives in a pure `src/core/pricing.ts` (unit-tested), and the checkout hot path has been RT-tuned (single merchant read, single mandate read, JOIN batch reads, one write transaction, batched updates), but checkout/confirm/webhook routes still orchestrate I/O + audit inline rather than behind a service layer.
4. **Framework leakage into `src/lib`.** `agent-auth.ts`, `merchant/guard.ts`, and `rate-limit.ts` import `NextResponse`/`NextRequest`, coupling domain/auth code to Next.js.
5. **No shared contract package.** Mandate/quote/policy types are declared in `src/lib/policy/engine.ts` and partially re-declared across simulation and test files.
6. **No `middleware.ts`.** Auth is enforced per-route (works, but not centralized).
7. **No real observability pipeline.** Errors use `console.error`; audit logs the business truth but there are no structured logs / traces / health endpoints.
8. **OpenAPI artifact is read-only contract.** The OpenAPI 3.1 spec at `/api/openapi.json` is generated from the Zod wire contracts in `src/lib/api/schemas.ts` (served as an artifact), but it is documented/consumed, not yet wired into validation or client generation.
9. **Browser + server sharing a module tree.** `src/lib/broadcast/agentpay-bus.ts` uses `window`/`BroadcastChannel` but lives under `src/lib` without `server-only`/`client-only` guards.

---

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->