import {
  ArrowRight,
  BadgeCheck,
  Bot,
  Code2,
  Globe,
  Lock,
  MessagesSquare,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { LogoLockup } from "@/components/branding/Logo";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground selection:bg-[#0066ff]/15 selection:text-primary">
      {/* Navigation */}
      <header className="relative z-10 mx-auto flex max-w-full items-center justify-between border-b border-border bg-white/80 px-6 py-4 backdrop-blur-md">
        <LogoLockup href="/dashboard" />

        <nav className="flex items-center gap-3">
          <Link
            href="/.well-known/agent-commerce.json"
            target="_blank"
            className="hidden items-center gap-1.5 rounded-md px-3 py-1.5 font-mono text-xs font-medium text-text-secondary transition-colors hover:bg-accent hover:text-primary sm:flex"
          >
            <Globe className="h-3.5 w-3.5" />
            <span>Discovery Manifest</span>
          </Link>

          <Link
            href="/dashboard/simulator"
            className="rounded-md border border-border bg-white px-3 py-1.5 text-xs font-semibold text-foreground transition-colors duration-200 hover:border-primary/30 hover:bg-accent/60"
          >
            Agent Simulator
          </Link>

          <Link
            href="/dashboard"
            className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-white shadow-sm transition-all duration-200 hover:bg-[#0052cc] hover:shadow-md"
          >
            <span>Open Dashboard</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </nav>
      </header>

      {/* Hero */}
      <main className="relative z-10 mx-auto max-w-6xl px-6">
        <section className="relative overflow-hidden pb-20 pt-24 text-center sm:pt-32">
          {/* Subtle grid background */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 [background-size:40px_40px] [background-image:linear-gradient(to_right,#e8edf2_1px,transparent_1px),linear-gradient(to_bottom,#e8edf2_1px,transparent_1px)] opacity-40"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-background via-transparent to-background"
          />

          <div className="space-y-6">
            <h1 className="font-sans text-4xl font-bold leading-[1.1] tracking-tight text-foreground sm:text-6xl lg:text-7xl">
              AI agents are the
              <br className="hidden sm:inline" />
              <span className="bg-gradient-to-r from-[#0066ff] to-[#0052cc] bg-clip-text text-transparent">
                {" "}
                new customers.
              </span>
              <br />
              Prepare your store.
            </h1>

            <p className="mx-auto max-w-2xl text-base font-normal leading-relaxed text-text-secondary sm:text-lg">
              The merchant backend that AI buyer agents can discover, query, and
              transact with. Deterministic policies, time-bound quotes, mandate
              verification, and Razorpay settlement — all in one platform.
            </p>

            <div className="flex flex-col items-center justify-center gap-3 pt-6 sm:flex-row">
              <Link
                href="/dashboard"
                className="group flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-7 py-3 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:bg-[#0052cc] hover:shadow-md sm:w-auto"
              >
                <Sparkles className="h-4 w-4 transition-transform group-hover:scale-110" />
                <span>Launch Merchant Console</span>
              </Link>

              <Link
                href="/dashboard/simulator"
                className="group flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-white px-7 py-3 text-sm font-semibold text-foreground transition-all duration-200 hover:border-primary/30 hover:bg-accent/60 hover:shadow-sm sm:w-auto"
              >
                <Bot className="h-4 w-4 text-text-secondary transition-colors group-hover:text-primary" />
                <span>Simulate AI Buyer Flow</span>
              </Link>
            </div>
          </div>
        </section>

        {/* How It Works — 4-step flow */}
        <section className="border-t border-border py-16">
          <div className="mb-10 text-center">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-text-muted">
              How it works
            </h2>
            <p className="mt-2 text-2xl font-bold tracking-tight text-foreground">
              Four steps from discovery to settlement
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                step: "01",
                icon: Globe,
                title: "Discover",
                desc: "Agent fetches your .well-known manifest and catalogues your SKU tree.",
                color: "text-[#0066ff]",
                bg: "bg-[#0066ff]/8",
              },
              {
                step: "02",
                icon: ShieldCheck,
                title: "Verify",
                desc: "Validates user intent mandate, budget limits, and merchant allowlists.",
                color: "text-[#7c5cff]",
                bg: "bg-[#7c5cff]/8",
              },
              {
                step: "03",
                icon: MessagesSquare,
                title: "Quote",
                desc: "Generates a time-bound, authoritative cart mandate with frozen prices.",
                color: "text-[#ffb822]",
                bg: "bg-[#ffb822]/8",
              },
              {
                step: "04",
                icon: Lock,
                title: "Settle",
                desc: "Razorpay order created, webhook verified, inventory locked, audit logged.",
                color: "text-[#00b874]",
                bg: "bg-[#00b874]/8",
              },
            ].map((item) => (
              <div
                key={item.step}
                className="group relative rounded-xl border border-border bg-card p-5 transition-all duration-200 hover:border-primary/20 hover:shadow-sm"
              >
                <div className="mb-4 flex items-center gap-3">
                  <div
                    className={`flex h-9 w-9 items-center justify-center rounded-lg ${item.bg}`}
                  >
                    <item.icon className={`h-4 w-4 ${item.color}`} />
                  </div>
                  <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-text-muted">
                    Step {item.step}
                  </span>
                </div>
                <h3 className="mb-1.5 text-sm font-semibold text-card-foreground">
                  {item.title}
                </h3>
                <p className="text-[13px] leading-relaxed text-text-secondary">
                  {item.desc}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Feature Grid */}
        <section className="border-t border-border py-16">
          <div className="mb-10 text-center">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-text-muted">
              Built for agents
            </h2>
            <p className="mt-2 text-2xl font-bold tracking-tight text-foreground">
              Everything AI buyers expect from a merchant
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {/* Discovery */}
            <div className="group rounded-xl border border-border bg-card p-6 transition-all duration-200 hover:border-[#0066ff]/30 hover:shadow-md">
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-[#0066ff]/8 text-[#0066ff]">
                <Globe className="h-5 w-5" />
              </div>
              <h3 className="mb-1.5 text-[15px] font-semibold text-card-foreground">
                Machine-Readable Discovery
              </h3>
              <p className="text-[13px] leading-relaxed text-text-secondary">
                Standard{" "}
                <code className="rounded bg-accent px-1.5 py-0.5 font-mono text-[11px] text-primary">
                  .well-known/agent-commerce.json
                </code>
                , catalog search in minor units, availability bands, and dynamic
                pricing for every variant.
              </p>
            </div>

            {/* Policy */}
            <div className="group rounded-xl border border-border bg-card p-6 transition-all duration-200 hover:border-[#7c5cff]/30 hover:shadow-md">
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-[#7c5cff]/8 text-[#7c5cff]">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <h3 className="mb-1.5 text-[15px] font-semibold text-card-foreground">
                Deterministic Policy Engine
              </h3>
              <p className="text-[13px] leading-relaxed text-text-secondary">
                Evaluates user intent mandates, slippage tolerances, budget
                limits, and triggers Step-Up approvals for price jumps before
                locking inventory.
              </p>
            </div>

            {/* Audit */}
            <div className="group rounded-xl border border-border bg-card p-6 transition-all duration-200 hover:border-[#00b874]/30 hover:shadow-md">
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-[#00b874]/8 text-[#00b874]">
                <Lock className="h-5 w-5" />
              </div>
              <h3 className="mb-1.5 text-[15px] font-semibold text-card-foreground">
                Immutable Audit Lineage
              </h3>
              <p className="text-[13px] leading-relaxed text-text-secondary">
                Every discovery, quote, step-up authorization, and webhook
                settlement is cryptographically hashed and logged to an
                append-only store.
              </p>
            </div>
          </div>
        </section>

        {/* Protocol Code Block */}
        <section className="border-t border-border py-16">
          <div className="mb-8 text-center">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-text-muted">
              Protocol
            </h2>
            <p className="mt-2 text-2xl font-bold tracking-tight text-foreground">
              Standard agentpay-commerce.v1 flow
            </p>
          </div>

          <div className="mx-auto max-w-3xl overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <div className="flex items-center gap-2">
                <Code2 className="h-4 w-4 text-primary" />
                <span className="text-xs font-semibold text-foreground">
                  Agent Interaction Flow
                </span>
              </div>
              <span className="rounded bg-accent px-2 py-0.5 font-mono text-[10px] font-medium text-primary">
                v1
              </span>
            </div>
            <div className="space-y-0 font-mono text-xs leading-6">
              {[
                {
                  key: "discover",
                  comment: "// 1. Discover capabilities",
                  code: "GET /.well-known/agent-commerce.json",
                  codeColor: "text-[#0066ff]",
                },
                {
                  key: "search",
                  comment: "// 2. Search SKU catalogue",
                  code: "GET /v1/agent/catalog?q=mechanical+keyboard&inStock=true",
                  codeColor: "text-[#0066ff]",
                },
                {
                  key: "checkout",
                  comment:
                    "// 3. Verify mandate & generate authoritative quote",
                  code: "POST /v1/agent/checkout { intentMandateId, items: [...] }",
                  codeColor: "text-[#7c5cff]",
                },
                {
                  key: "settle",
                  comment: "// 4. Settle payment & lock inventory",
                  code: 'POST /v1/agent/checkout/confirm { cartMandateId, paymentMethod: "razorpay" }',
                  codeColor: "text-[#00b874]",
                },
              ].map((item) => (
                <div
                  key={item.key}
                  className="border-b border-border/50 px-5 py-2.5 last:border-b-0"
                >
                  <div className="text-text-muted">{item.comment}</div>
                  <div className={`font-medium ${item.codeColor}`}>
                    {item.code}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Bottom CTA */}
        <section className="border-t border-border py-16 text-center">
          <div className="mx-auto max-w-lg space-y-4">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/8">
              <BadgeCheck className="h-6 w-6 text-primary" />
            </div>
            <h2 className="text-2xl font-bold tracking-tight text-foreground">
              Ready to go live?
            </h2>
            <p className="text-sm text-text-secondary">
              Set up your merchant profile, configure policies, and start
              accepting AI agent orders in minutes.
            </p>
            <div className="flex items-center justify-center gap-3 pt-2">
              <Link
                href="/dashboard"
                className="flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:bg-[#0052cc] hover:shadow-md"
              >
                <span>Open Dashboard</span>
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-border bg-card/50">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 sm:flex-row">
          <LogoLockup href="/dashboard" className="opacity-60" />
          <p className="text-xs text-text-muted">
            AgentPay Merchant &middot; Built for the future of AI Agent Commerce
          </p>
        </div>
      </footer>
    </div>
  );
}
