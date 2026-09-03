"use client";

import { Filter, Package, ShoppingBag, TrendingUp } from "lucide-react";
import { useEffect, useState } from "react";
import { Header } from "@/components/dashboard/Header";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatMinorUnits } from "@/lib/utils";

interface FunnelData {
  catalogViews: number;
  cartsCreated: number;
  policyApproved: number;
  paid: number;
  isDemoData: boolean;
}

interface AttributionData {
  aiMinor: number;
  humanMinor: number;
  isDemoData: boolean;
}

interface TopSku {
  variantId: string;
  title: string;
  units: number;
  revenueMinor: number;
}

/** Dependency-free SVG donut for the revenue attribution split. */
function DonutChart({
  segments,
}: {
  segments: Array<{ label: string; value: number; color: string }>;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const radius = 60;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <svg viewBox="0 0 160 160" className="h-40 w-40 -rotate-90">
      <circle
        cx="80"
        cy="80"
        r={radius}
        fill="none"
        stroke="#e8edf2"
        strokeWidth="22"
      />
      {segments.map((seg) => {
        const fraction = seg.value / total;
        const dash = fraction * circumference;
        const el = (
          <circle
            key={seg.label}
            cx="80"
            cy="80"
            r={radius}
            fill="none"
            stroke={seg.color}
            strokeWidth="22"
            strokeDasharray={`${dash} ${circumference - dash}`}
            strokeDashoffset={-offset}
            className="transition-all duration-500"
          />
        );
        offset += dash;
        return el;
      })}
    </svg>
  );
}

function FunnelStage({
  label,
  value,
  maxValue,
  color,
  conversion,
}: {
  label: string;
  value: number;
  maxValue: number;
  color: string;
  conversion?: number;
}) {
  const pct = Math.max(4, Math.round((value / (maxValue || 1)) * 100));
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-text-secondary">{label}</span>
        <span className="flex items-center gap-2">
          {conversion !== undefined && (
            <span className="text-xs text-[#00875c] font-medium">
              {conversion}% convert
            </span>
          )}
          <span className="font-bold tabular-nums">
            {value.toLocaleString("en-IN")}
          </span>
        </span>
      </div>
      <div className="h-6 rounded-md bg-muted overflow-hidden">
        <div
          style={{ width: `${pct}%` }}
          className={`h-full rounded-md ${color} transition-all duration-700`}
        />
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadStats() {
      try {
        const res = await fetch("/api/merchant/stats");
        const data = await res.json();
        setStats(data);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    loadStats();
    const t = setInterval(loadStats, 30000);
    return () => clearInterval(t);
  }, []);

  const attribution: AttributionData = stats?.attribution || {
    aiMinor: 1240000,
    humanMinor: 4126600,
    isDemoData: true,
  };

  const funnel: FunnelData = stats?.funnel || {
    catalogViews: 150,
    cartsCreated: 22,
    policyApproved: 18,
    paid: 15,
    isDemoData: true,
  };

  const topSkus: TopSku[] = stats?.topSkus || [];
  const demoSkus: TopSku[] = [
    {
      variantId: "kbd_nimbus_75_black_brown",
      title: "Nimbus 75 Mechanical Keyboard",
      units: 8,
      revenueMinor: 2799200,
    },
    {
      variantId: "aud_echo_anc_pro",
      title: "Echo ANC Pro Headphones",
      units: 5,
      revenueMinor: 599500,
    },
    {
      variantId: "acc_riser_alu",
      title: "Aluminium Laptop Riser",
      units: 4,
      revenueMinor: 119600,
    },
  ];
  const skus = topSkus.length > 0 ? topSkus : demoSkus;
  const skusAreDemo = topSkus.length === 0;

  const totalAttribution = attribution.aiMinor + attribution.humanMinor || 1;
  const aiSharePct = Math.round((attribution.aiMinor / totalAttribution) * 100);

  const funnelStages = [
    { label: "Catalog Views", key: "catalogViews", color: "bg-primary/30" },
    { label: "Carts Created", key: "cartsCreated", color: "bg-primary/55" },
    { label: "Policy Approved", key: "policyApproved", color: "bg-primary/80" },
    { label: "Paid", key: "paid", color: "bg-primary" },
  ] as const;

  const maxFunnel = Math.max(funnel.catalogViews, 1);

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Agent Analytics & Performance"
        description="Revenue attribution, AI conversion funnel, and agent purchase preferences."
      />

      <div className="space-y-6">
        {/* 1. Revenue Attribution */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-primary" />
              <div>
                <CardTitle>Revenue Attribution</CardTitle>
                <CardDescription>
                  AI-driven sales vs traditional human sales channel
                </CardDescription>
              </div>
            </div>
            {stats?.attribution?.isDemoData && (
              <Badge variant="warning">Demo data</Badge>
            )}
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-center">
              {/* Big headline metric */}
              <div className="md:col-span-2 space-y-4">
                <div>
                  <div className="text-sm font-medium text-text-muted">
                    AI-driven sales this week
                  </div>
                  <div className="mt-1 text-[32px] leading-10 font-bold tracking-tight text-foreground">
                    {formatMinorUnits(attribution.aiMinor, "INR")}
                  </div>
                  <div className="mt-1 text-sm text-text-secondary">
                    from settled AI buyer-agent transactions
                  </div>
                </div>

                <div className="flex items-center gap-3 p-3 rounded-lg bg-accent/50 border border-primary/15">
                  <ShoppingBag className="w-8 h-8 text-primary" />
                  <p className="text-sm font-medium text-primary">
                    {formatMinorUnits(attribution.aiMinor, "INR")} in AI-driven
                    sales this week
                  </p>
                </div>
              </div>

              {/* Pie chart */}
              <div className="flex flex-col items-center gap-3">
                <DonutChart
                  segments={[
                    {
                      label: "AI Sales",
                      value: attribution.aiMinor,
                      color: "#0066ff",
                    },
                    {
                      label: "Human Sales",
                      value: attribution.humanMinor,
                      color: "#00b874",
                    },
                  ]}
                />
                <div className="space-y-1.5 text-sm w-full">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-text-secondary">
                      <span className="w-2.5 h-2.5 rounded-full bg-primary" />
                      AI Sales
                    </span>
                    <span className="font-semibold tabular-nums">
                      {aiSharePct}%
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-text-secondary">
                      <span className="w-2.5 h-2.5 rounded-full bg-[#00b874]" />
                      Human Sales
                    </span>
                    <span className="font-semibold tabular-nums">
                      {100 - aiSharePct}%
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 2. Conversion Funnel */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-primary" />
              <div>
                <CardTitle>AI Agent Conversion Funnel</CardTitle>
                <CardDescription>
                  Proof that agents browse → commit → pass policy → pay
                </CardDescription>
              </div>
            </div>
            {funnel.isDemoData && <Badge variant="warning">Demo data</Badge>}
          </CardHeader>
          <CardContent className="space-y-4">
            {funnelStages.map((stage, i) => {
              const value = funnel[stage.key];
              const prevValue =
                i === 0 ? null : funnel[funnelStages[i - 1].key];
              const conversion =
                prevValue && prevValue > 0
                  ? Math.round((value / prevValue) * 100)
                  : undefined;
              return (
                <FunnelStage
                  key={stage.key}
                  label={stage.label}
                  value={value}
                  maxValue={maxFunnel}
                  color={stage.color}
                  conversion={conversion}
                />
              );
            })}

            <div className="pt-2 grid grid-cols-3 gap-3 text-center">
              <div className="rounded-lg border border-border bg-muted px-3 py-2">
                <div className="text-lg font-bold">
                  {Math.round(
                    (funnel.cartsCreated / (funnel.catalogViews || 1)) * 100,
                  )}
                  %
                </div>
                <div className="text-xs text-text-muted">View → Cart</div>
              </div>
              <div className="rounded-lg border border-border bg-muted px-3 py-2">
                <div className="text-lg font-bold">
                  {Math.round(
                    (funnel.paid / (funnel.policyApproved || 1)) * 100,
                  )}
                  %
                </div>
                <div className="text-xs text-text-muted">Approved → Paid</div>
              </div>
              <div className="rounded-lg border border-border bg-muted px-3 py-2">
                <div className="text-lg font-bold">
                  {Math.round((funnel.paid / (funnel.catalogViews || 1)) * 100)}
                  %
                </div>
                <div className="text-xs text-text-muted">End-to-end</div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 3. Top AI-Purchased SKUs */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="flex items-center gap-2">
              <Package className="w-4 h-4 text-primary" />
              <div>
                <CardTitle>Top AI-Purchased SKUs</CardTitle>
                <CardDescription>
                  What AI agents actually buy — actionable inventory signal
                </CardDescription>
              </div>
            </div>
            {skusAreDemo && <Badge variant="warning">Demo data</Badge>}
          </CardHeader>
          <CardContent>
            {skus.length === 0 ? (
              <p className="py-8 text-center text-sm text-text-muted">
                No AI purchases recorded yet. Run a simulation to generate agent
                orders.
              </p>
            ) : (
              <div className="space-y-3">
                {skus.map((sku, i) => {
                  const maxUnits = Math.max(...skus.map((s) => s.units), 1);
                  const widthPct = Math.max(
                    6,
                    Math.round((sku.units / maxUnits) * 100),
                  );
                  return (
                    <div
                      key={sku.variantId}
                      className="flex items-center gap-4 p-3 rounded-lg border border-border hover:bg-muted transition-colors"
                    >
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-bold text-primary">
                        {i + 1}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-foreground">
                          {sku.title}
                        </div>
                        <div className="font-mono text-xs text-text-muted truncate">
                          {sku.variantId}
                        </div>
                        <div className="mt-1.5 h-2 rounded-full bg-muted max-w-md overflow-hidden">
                          <div
                            style={{ width: `${widthPct}%` }}
                            className="h-full bg-primary rounded-full transition-all duration-700"
                          />
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-bold text-foreground">
                          {sku.units} units
                        </div>
                        <div className="text-xs text-text-muted tabular-nums">
                          {formatMinorUnits(sku.revenueMinor, "INR")}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {loading && (
        <div className="py-12 text-center text-sm text-text-muted">
          Loading analytics…
        </div>
      )}
    </div>
  );
}
