# MerchantGate — Agent-Payable Merchant Platform

> **AI agents are the new customers.** MerchantGate exposes a discovery,
> quoting, checkout, and payment API that AI buyer agents understand, while
> giving human merchants a full dashboard for visibility and control.

This is a **Next.js 16.3.2 (App Router)** application built with
**TypeScript**, **Tailwind CSS 4**, **Drizzle ORM + Neon PostgreSQL**, and the
**Razorpay** Node SDK in test mode. The full architecture and implementation
guide lives in [`AGENTS.md`](./AGENTS.md).

## Quick Start

```bash
pnpm install
cp .env.example .env.local        # fill in DATABASE_URL, Razorpay test keys
pnpm db:generate                  # scaffold drizzle SQL migrations
pnpm db:migrate                   # apply schema to the database
pnpm db:seed                      # seed the merchant catalogue + accessories
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). The merchant dashboard
covers catalogue, orders, audit trail, live agent activity, policy engine,
surge/campaign pricing, live negotiation, and the simulated buyer flow.

## What's Implemented

### Agent-facing API (`/v1/agent/*`)
- `GET /.well-known/agent-commerce.json` — machine-readable merchant discovery
- `GET /v1/agent/catalog`, `GET /v1/agent/products/{id}` — catalogue search
- `POST /v1/agent/verify` — mandate + agent identity verification
- `POST /v1/agent/checkout` — authoritative, time-bound cart mandate quote
- `POST /v1/agent/checkout/confirm` — confirm a quote and open a Razorpay order
- `GET /v1/agent/payments/{id}` — payment status
- `POST /v1/agent/upsell` — content-addressed upsell offers
- `POST /v1/agent/negotiate` — live price negotiation sessions

### Money safety (deterministic + auditable)
- **Authoritative quoting** — the merchant (not the LLM) sets price,
  availability, and tax; quotes carry a canonical JSON `devProof` digest and
  `expiresAt`.
- **Policy gate** — every checkout goes through `ALLOW / STEP_UP / DENY` with
  `reasonCodes`; STEP_UP requires a merchant approval in the dashboard.
- **Rolling budget** — reservations are atomic per trace; enforces
  `ROLLING_BUDGET_EXHAUSTED` when exhausted.
- **Campaign discounts** — only lower list price pre-negotiation, never during
  surge, capped at 4000 bps; surge never re-prices negotiated lines.
- **Deterministic upsell ids** — `upsellOfferId` is `SHA-256` content-derived so
  it survives the upsell → checkout round trip.
- **Append-only audit trail** — every action writes `audit_events` with
  `snapshot_hash`, `prev_event_hash`, and `reason_codes`.

### Payments
- **Razorpay orders** created at `checkout/confirm`; real `pay_*` payments are
  refunded via the Razorpay API (provider failure → HTTP 502, never a fake
  success); simulated payments use `rfrp_sim_*` ids.
- **Webhooks** on `payment.captured`, `payment.failed`, and `refund.*` are
  verified with HMAC-SHA256 and deduplicated by event id.

### Agent authentication
- `demo` (default, permissive + rate-limited) vs `strict` mode
  (`AGENT_AUTH_MODE` / `config.agentAuthMode`).
- API keys `agt_secret_<48 hex>`; only the SHA-256 hash is stored. Issue keys
  via `GET/POST /api/merchant/agents`.

### Merchant dashboard
- Overview (with **Live Agent Activity**), products, agent requests & STEP_UP
  approval, orders & refunds, policies, analytics, **Audit Trail explorer**,
  simulator, and settings.
- Merchant-facing APIs: `/api/merchant/stats`, `/api/merchant/requests`,
  `/api/merchant/orders/[id]/refund`, `/api/merchant/agents`,
  `/api/merchant/campaigns`, `/api/merchant/audit`.

## Testing

```bash
pnpm test     # tsx unit tests in src/tests/unit (31+ cases)
pnpm lint     # biome check
pnpm build    # typecheck + production build
```

CI (`.github/workflows/ci.yml`) runs build, unit tests, and lint on every push
and PR. Deployment config is in [`vercel.json`](./vercel.json).

## Reseeding after catalogue changes

New accessory variants (`acc_*`) were added to the seed. To refresh a local
catalogue:

```bash
pnpm db:seed
```

## Environment

| Variable                  | Required | Purpose                            |
| ------------------------- | -------- | ---------------------------------- |
| `DATABASE_URL`            | Yes      | Neon PostgreSQL connection         |
| `RAZORPAY_KEY_ID`         | Yes      | Razorpay API key (test)            |
| `RAZORPAY_KEY_SECRET`     | Yes      | Razorpay secret (test)             |
| `RAZORPAY_WEBHOOK_SECRET` | Yes      | Webhook HMAC secret                |
| `AGENT_AUTH_MODE`         | No       | `demo` (default) or `strict`       |
| `APP_BASE_URL`            | No       | Public app URL                     |

Full protocol reference: see [`AGENTS.md`](./AGENTS.md).
