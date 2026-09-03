import {
  ArrowRight,
  Code2,
  Cpu,
  Globe,
  Lock,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { LogoLockup } from "@/components/branding/Logo";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground selection:bg-[#0066ff]/15 selection:text-primary">
      {/* Navigation */}
      <header className="relative z-10 mx-auto flex max-w-7xl items-center justify-between border-b border-border bg-white/80 px-6 py-4 backdrop-blur-md">
        <LogoLockup href="/dashboard" />

        <div className="flex items-center gap-4">
          <Link
            href="/.well-known/agent-commerce.json"
            target="_blank"
            className="hidden items-center gap-1.5 font-mono text-xs font-medium text-text-secondary transition-colors hover:text-primary sm:flex"
          >
            <Globe className="h-3.5 w-3.5 text-primary" />
            <span>Discovery Manifest</span>
          </Link>

          <Link
            href="/dashboard/simulator"
            className="rounded-md border border-border bg-white px-3 py-1.5 text-xs font-semibold text-primary transition-colors duration-200 hover:border-[#99c2ff] hover:bg-accent/60"
          >
            Agent Simulator
          </Link>

          <Link
            href="/dashboard"
            className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition-all duration-200 hover:bg-[#0052cc]"
          >
            <span>Open Dashboard</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </header>

      {/* Hero */}
      <main className="relative z-10 mx-auto max-w-5xl px-6 pb-28 pt-20 text-center">
        <div className="space-y-8">
          {/* Heading */}
          <h1 className="font-sans text-4xl font-bold leading-[1.15] tracking-tight text-foreground sm:text-6xl">
            AI agents are the <br className="hidden sm:inline" />
            <span className="text-primary">new customers.</span> Prepare your
            store.
          </h1>

          {/* Description */}
          <p className="mx-auto max-w-2xl text-base font-normal leading-relaxed text-text-secondary sm:text-lg">
            Build the merchant backend that AI buyer agents can discover, query,
            and transact with. Enforce deterministic policies, freeze time-bound
            quotes, verify mandates, and settle through Razorpay.
          </p>

          {/* CTA */}
          <div className="flex flex-col items-center justify-center gap-4 pt-4 sm:flex-row">
            <Link
              href="/dashboard"
              className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:bg-[#0052cc] sm:w-auto"
            >
              <Sparkles className="h-4 w-4" />
              <span>Launch Merchant Console</span>
            </Link>

            <Link
              href="/dashboard/simulator"
              className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-white px-6 py-3 text-sm font-semibold text-primary transition-all duration-200 hover:bg-accent/60 sm:w-auto"
            >
              <Cpu className="h-4 w-4" />
              <span>Simulate AI Buyer Flow</span>
            </Link>
          </div>
        </div>

        {/* Feature Grid */}
        <div className="grid grid-cols-1 gap-5 pt-16 text-left md:grid-cols-3">
          {/* Discovery */}
          <div className="group relative space-y-3 overflow-hidden rounded-xl border border-border bg-card p-6 shadow-sm transition-all duration-200 hover:border-primary/40 hover:shadow-md">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-primary">
              <Globe className="h-5 w-5" />
            </div>

            <h3 className="text-base font-semibold text-card-foreground">
              Machine-Readable Discovery
            </h3>

            <p className="text-sm leading-relaxed text-text-secondary">
              Exposes standard{" "}
              <code className="font-mono text-[11px] text-primary">
                .well-known/agent-commerce.json
              </code>
              , catalog search in minor units, availability bands, and dynamic
              pricing.
            </p>
          </div>

          {/* Policy */}
          <div className="group relative space-y-3 overflow-hidden rounded-xl border border-border bg-card p-6 shadow-sm transition-all duration-200 hover:border-primary/40 hover:shadow-md">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-primary">
              <ShieldCheck className="h-5 w-5" />
            </div>

            <h3 className="text-base font-semibold text-card-foreground">
              Deterministic Policy Engine
            </h3>

            <p className="text-sm leading-relaxed text-text-secondary">
              Evaluates user intent mandates, slippage tolerances, budget
              limits, and triggers Step-Up approvals for price jumps before
              locking inventory.
            </p>
          </div>

          {/* Audit */}
          <div className="group relative space-y-3 overflow-hidden rounded-xl border border-border bg-card p-6 shadow-sm transition-all duration-200 hover:border-[#00b874]/40 hover:shadow-md">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#00b874]/10 text-[#00875c]">
              <Lock className="h-5 w-5" />
            </div>

            <h3 className="text-base font-semibold text-card-foreground">
              Immutable Audit Lineage
            </h3>

            <p className="text-sm leading-relaxed text-text-secondary">
              Every discovery, quote generation, step-up authorization, and
              webhook settlement is cryptographically hashed and logged to an
              append-only store.
            </p>
          </div>
        </div>

        {/* Protocol */}
        <div className="mt-12 space-y-3 rounded-xl border border-border bg-card p-6 text-left font-mono text-xs shadow-sm">
          <div className="flex items-center justify-between border-b border-border pb-3 text-text-muted">
            <span className="flex items-center gap-2 font-medium text-primary">
              <Code2 className="h-4 w-4" />
              <span>Standard AI Agent Interaction Flow</span>
            </span>

            <span className="text-[10px] text-text-muted">
              protocol: agentpay-commerce.v1
            </span>
          </div>

          <div className="space-y-1">
            <div className="text-text-muted">
              {/* biome-ignore lint/suspicious/noCommentText: rendered display text */}
              // 1. Discover capabilities
            </div>
            <div className="font-medium text-primary">
              GET /.well-known/agent-commerce.json
            </div>

            <div className="pt-2 text-text-muted">
              {/* biome-ignore lint/suspicious/noCommentText: rendered display text */}
              // 2. Search SKU catalogue
            </div>

            <div className="font-medium text-primary">
              GET /v1/agent/catalog?q=mechanical+keyboard&inStock=true
            </div>

            <div className="pt-2 text-text-muted">
              {/* biome-ignore lint/suspicious/noCommentText: rendered display text */}
              // 3. Verify user mandate & generate authoritative quote
            </div>

            <div className="font-medium text-primary">
              POST /v1/agent/checkout {"{"} intentMandateId, items: [...] {"}"}
            </div>

            <div className="pt-2 text-text-muted">
              {/* biome-ignore lint/suspicious/noCommentText: rendered display text */}
              // 4. Settle payment & lock inventory
            </div>

            <div className="font-medium text-[#00875c]">
              POST /v1/agent/checkout/confirm {"{"} cartMandateId,
              paymentMethod: "razorpay_checkout" {"}"}
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border py-8 text-center text-sm text-text-muted">
        <p>AgentPay Merchant • Built for the future of AI Agent Commerce.</p>
      </footer>
    </div>
  );
}
