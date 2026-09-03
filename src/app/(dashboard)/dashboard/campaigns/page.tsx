"use client";

import {
  BarChart3,
  Check,
  Clock,
  Copy,
  Flame,
  Layers,
  Megaphone,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Square,
  Target,
  Trash2,
  TrendingDown,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Header } from "@/components/dashboard/Header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatMinorUnits } from "@/lib/utils";

type CampaignStatus = "draft" | "active" | "paused" | "ended";

interface CampaignTier {
  minOrderMinor: number;
  discountBps: number;
}

interface Campaign {
  id: string;
  name: string;
  description?: string;
  type: string;
  category?: string;
  variantIds?: string[];
  discountBps: number;
  minOrderMinor?: number;
  startsAt: string;
  endsAt: string;
  status: CampaignStatus;
  targetAudience?: string;
  targetAgents?: string[];
  budgetMinor?: number;
  spentMinor?: number;
  priority?: number;
  flashPriceMinor?: number;
  tiers?: CampaignTier[];
  stackable?: boolean;
  abGroup?: "A" | "B";
  scheduleDays?: number[];
  createdAt: string;
  updatedAt?: string;
  liveNow?: boolean;
}

interface CampaignPerformance {
  campaign: Campaign;
  orders: number;
  unitsSold: number;
  revenueMinor: number;
  discountSpendMinor: number;
  roiBps: number;
  liveNow: boolean;
  budgetRemainingMinor: number | null;
  budgetPercentUsed: number | null;
}

const TYPE_META: Record<
  string,
  { label: string; hint: string; icon: typeof Flame; color: string; disabled?: boolean }
> = {
  CATEGORY_DISCOUNT: {
    label: "Category Discount",
    hint: "Off a whole category",
    icon: Layers,
    color: "text-[#0066ff]",
  },
  FLAT_DISCOUNT: {
    label: "Flat Discount",
    hint: "Off specific products",
    icon: Wallet,
    color: "text-[#00b874]",
  },
  BUNDLE_DISCOUNT: {
    label: "Bundle Discount",
    hint: "Managed by upsell engine — not a standalone campaign",
    icon: Copy,
    color: "text-[#94a3b8]",
    disabled: true,
  },
  FLASH_SALE: {
    label: "Flash Sale",
    hint: "Time + price floor",
    icon: Flame,
    color: "text-[#ff5f56]",
  },
  TIERED_DISCOUNT: {
    label: "Tiered Discount",
    hint: "Escalating with spend",
    icon: TrendingDown,
    color: "text-[#ffb822]",
  },
  AGENT_TARGETED: {
    label: "Agent Targeted",
    hint: "Only listed agents",
    icon: Target,
    color: "text-[#00a8e8]",
  },
};

const STATUS_COLOR: Record<CampaignStatus, string> = {
  active: "bg-[#00b874]/15 text-[#00875c] border-[#00b874]/25",
  paused: "bg-[#ffb822]/15 text-[#946400] border-[#ffb822]/30",
  draft: "bg-muted text-text-secondary border-border",
  ended: "bg-muted text-text-muted border-border",
};

const CAMPAIGN_TYPES = [
  "CATEGORY_DISCOUNT",
  "FLAT_DISCOUNT",
  "FLASH_SALE",
  "TIERED_DISCOUNT",
  "AGENT_TARGETED",
];

interface FormState {
  name: string;
  type: string;
  description: string;
  category: string;
  variantIds: string;
  discountBps: string;
  minOrderMinor: string;
  durationDays: string;
  budgetMinor: string;
  priority: string;
  flashPriceMinor: string;
  targetAgents: string;
  scheduleDays: string;
  stackable: boolean;
  abGroup: "" | "A" | "B";
  tiers: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  type: "CATEGORY_DISCOUNT",
  description: "",
  category: "",
  variantIds: "",
  discountBps: "1000",
  minOrderMinor: "",
  durationDays: "7",
  budgetMinor: "",
  priority: "0",
  flashPriceMinor: "",
  targetAgents: "",
  scheduleDays: "",
  stackable: false,
  abGroup: "",
  tiers: "",
};

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [performance, setPerformance] = useState<CampaignPerformance[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Campaign | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [listRes, perfRes] = await Promise.all([
        fetch("/api/merchant/campaigns"),
        fetch("/api/merchant/campaigns?analytics=1"),
      ]);
      const list = await listRes.json();
      const perf = await perfRes.json();
      if (list.campaigns) setCampaigns(list.campaigns);
      if (perf.performance) setPerformance(perf.performance);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  const totals = useMemo(() => {
    const active = campaigns.filter((c) => c.status === "active");
    const budgeted = campaigns.filter(
      (c) => c.budgetMinor && c.budgetMinor > 0,
    );
    const totalBudget = budgeted.reduce((s, c) => s + (c.budgetMinor || 0), 0);
    const totalSpent = campaigns.reduce((s, c) => s + (c.spentMinor || 0), 0);
    const ab = campaigns.filter((c) => c.abGroup).length;
    return {
      activeCount: active.length,
      totalBudget,
      totalSpent,
      ab,
      totalOrders: performance.reduce((s, p) => s + p.orders, 0),
      totalRevenue: performance.reduce((s, p) => s + p.revenueMinor, 0),
      totalDiscount: performance.reduce((s, p) => s + p.discountSpendMinor, 0),
    };
  }, [campaigns, performance]);

  const call = async (
    method: string,
    body: Record<string, unknown>,
  ): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/merchant/campaigns", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Request failed");
        return false;
      }
      await load();
      return true;
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async () => {
    const splitFirst = (s: string) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    const ok = await call("POST", {
      name: form.name,
      type: form.type,
      description: form.description || undefined,
      category: form.category || undefined,
      variantIds: splitFirst(form.variantIds),
      discountBps: form.discountBps ? Number(form.discountBps) : undefined,
      minOrderMinor: form.minOrderMinor
        ? Number(form.minOrderMinor)
        : undefined,
      durationDays: form.durationDays ? Number(form.durationDays) : undefined,
      budgetMinor: form.budgetMinor ? Number(form.budgetMinor) : undefined,
      priority: form.priority ? Number(form.priority) : undefined,
      flashPriceMinor: form.flashPriceMinor
        ? Number(form.flashPriceMinor)
        : undefined,
      targetAgents: splitFirst(form.targetAgents),
      scheduleDays: form.scheduleDays
        ? form.scheduleDays.split(",").map((x) => Number(x.trim()))
        : undefined,
      stackable: form.stackable,
      abGroup: form.abGroup || undefined,
      tiers: form.tiers
        ? form.tiers
            .split(";")
            .map((t) => t.trim())
            .filter(Boolean)
            .map((t) => {
              const [min, bps] = t.split(":").map((x) => Number(x.trim()));
              return { minOrderMinor: min || 0, discountBps: bps || 0 };
            })
        : undefined,
    });
    if (ok) {
      setCreateOpen(false);
      setForm(EMPTY_FORM);
    }
  };

  const openEdit = (c: Campaign) => {
    setEditTarget(c);
    setError(null);
  };

  const handleEditSave = async () => {
    if (!editTarget) return;
    const patch: Record<string, unknown> = { campaignId: editTarget.id };
    if (editTarget.description !== undefined)
      patch.description = editTarget.description;
    if (editTarget.category !== undefined) patch.category = editTarget.category;
    if (editTarget.variantIds) patch.variantIds = editTarget.variantIds;
    if (editTarget.budgetMinor !== undefined)
      patch.budgetMinor = editTarget.budgetMinor;
    if (editTarget.priority !== undefined) patch.priority = editTarget.priority;
    if (editTarget.flashPriceMinor !== undefined)
      patch.flashPriceMinor = editTarget.flashPriceMinor;
    if (editTarget.minOrderMinor !== undefined)
      patch.minOrderMinor = editTarget.minOrderMinor;
    if (editTarget.targetAgents) patch.targetAgents = editTarget.targetAgents;
    if (editTarget.discountBps !== undefined)
      patch.discountBps = editTarget.discountBps;
    if (editTarget.tiers !== undefined) patch.tiers = editTarget.tiers;
    const ok = await call("PATCH", patch);
    if (ok) setEditTarget(null);
  };

  const setEditField = <
    K extends keyof Omit<
      Campaign,
      | "id"
      | "createdAt"
      | "startsAt"
      | "endsAt"
      | "status"
      | "type"
      | "name"
      | "spentMinor"
      | "liveNow"
      | "scheduleDays"
    >,
  >(
    key: K,
    value: Campaign[K],
  ) => {
    setEditTarget((c) => (c ? { ...c, [key]: value } : c));
  };

  return (
    <div className="space-y-6">
      <Header
        title="Campaign Orchestrator"
        description="Stand up, budget, schedule and A/B-test merchant promotions — every discount is bounded and auditable."
      />

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
          {error}
        </div>
      )}

      {/* KPI row */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Active campaigns</CardDescription>
            <CardTitle className="text-3xl">{totals.activeCount}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-text-muted">
            across {campaigns.length} total · {totals.ab} in A/B test
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Committed discount budget</CardDescription>
            <CardTitle className="text-3xl">
              {formatMinorUnits(totals.totalBudget)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-text-muted">
            {formatMinorUnits(totals.totalSpent)} spent ·
            {totals.totalBudget > 0
              ? ` ${Math.round((totals.totalSpent / totals.totalBudget) * 100)}% used`
              : " unlimited"}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Agent orders</CardDescription>
            <CardTitle className="text-3xl">{totals.totalOrders}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-text-muted">
            {formatMinorUnits(totals.totalRevenue)} attributed revenue
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Discount paid out</CardDescription>
            <CardTitle className="text-3xl">
              {formatMinorUnits(totals.totalDiscount)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-text-muted">
            ROI{" "}
            {totals.totalRevenue > 0
              ? `${((totals.totalDiscount / totals.totalRevenue) * 100).toFixed(1)}% of revenue`
              : "—"}
          </CardContent>
        </Card>
      </div>

      {/* Campaign list */}
      <Card className="p-0 overflow-hidden">
        <div className="flex items-center justify-between px-5 pt-4">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Campaigns
            </h3>
            <p className="text-xs text-text-muted">
              Budget-capped, priority-orchestrated promotions
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            onClick={() => load()}
            disabled={loading}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            size="sm"
            className="gap-1"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="w-4 h-4" />
            New campaign
          </Button>
        </div>

        <div className="mt-3">
          {loading ? (
            <div className="grid gap-2 px-5 pb-5">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-24 animate-pulse rounded-xl bg-muted/60"
                />
              ))}
            </div>
          ) : campaigns.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-text-muted">
              No campaigns yet — create one to start driving AI-agent purchases.
            </p>
          ) : (
            <div className="grid gap-2 px-5 pb-5">
              {campaigns.map((c) => {
                const meta = TYPE_META[c.type] || TYPE_META.CATEGORY_DISCOUNT;
                const Icon = meta.icon;
                const perf = performance.find((p) => p.campaign.id === c.id);
                const budgetPct = c.budgetMinor
                  ? Math.min(
                      100,
                      Math.round(((c.spentMinor || 0) / c.budgetMinor) * 100),
                    )
                  : null;
                return (
                  <div
                    key={c.id}
                    className="rounded-xl border border-border bg-white p-4"
                  >
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                      <div className="flex items-start gap-3">
                        <span className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
                          <Icon className={`h-5 w-5 ${meta.color}`} />
                        </span>
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold text-text-primary">
                              {c.name}
                            </span>
                            <Badge
                              variant="outline"
                              className={`text-[10px] ${STATUS_COLOR[c.status]}`}
                            >
                              {c.status}
                            </Badge>
                            {c.liveNow && c.status === "active" && (
                              <Badge className="text-[10px] gap-1 bg-[#00b874]/15 text-[#00875c] border border-[#00b874]/25">
                                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#00b874]" />
                                live now
                              </Badge>
                            )}
                            {c.abGroup && (
                              <Badge
                                variant="outline"
                                className="text-[10px] text-[#7c5cff] border-[#7c5cff]/30"
                              >
                                A/B · {c.abGroup}
                              </Badge>
                            )}
                          </div>
                          <p className="mt-0.5 text-xs text-text-muted">
                            {meta.label} · {c.discountBps / 100}% off
                            {c.category ? ` · ${c.category}` : ""}
                            {c.targetAgents?.length
                              ? ` · ${c.targetAgents.length} agent(s)`
                              : c.type === "AGENT_TARGETED"
                                ? " · any agent"
                                : ""}
                            {c.priority ? ` · priority ${c.priority}` : ""}
                            {c.stackable ? " · stackable" : ""}
                          </p>
                          {c.description && (
                            <p className="mt-1 max-w-2xl text-xs text-text-secondary">
                              {c.description}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {c.status === "active" && (
                          <Button
                            size="xs"
                            variant="outline"
                            className="gap-1"
                            onClick={() =>
                              call("PATCH", {
                                campaignId: c.id,
                                action: "pause",
                              })
                            }
                            disabled={busy}
                          >
                            <Pause className="w-3 h-3" />
                            Pause
                          </Button>
                        )}
                        {c.status === "paused" && (
                          <Button
                            size="xs"
                            variant="outline"
                            className="gap-1"
                            onClick={() =>
                              call("PATCH", {
                                campaignId: c.id,
                                action: "resume",
                              })
                            }
                            disabled={busy}
                          >
                            <Play className="w-3 h-3" />
                            Resume
                          </Button>
                        )}
                        <Button
                          size="xs"
                          variant="outline"
                          className="gap-1"
                          onClick={() => openEdit(c)}
                        >
                          <Pencil className="w-3 h-3" />
                          Edit
                        </Button>
                        {c.status !== "ended" && (
                          <Button
                            size="xs"
                            variant="outline"
                            className="gap-1"
                            onClick={() => call("DELETE", { campaignId: c.id })}
                            disabled={busy}
                          >
                            <Square className="w-3 h-3" />
                            End
                          </Button>
                        )}
                        <Button
                          size="xs"
                          variant="outline"
                          className="gap-1 text-red-600"
                          onClick={() =>
                            call("DELETE", { campaignId: c.id, delete: true })
                          }
                          disabled={busy}
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>

                    {/* Budget + analytics strip */}
                    <div className="mt-3 grid gap-3 lg:grid-cols-3">
                      <div>
                        <div className="mb-1 flex items-center justify-between text-[11px]">
                          <span className="text-text-muted">
                            Discount budget
                          </span>
                          <span className="font-mono text-text-secondary">
                            {formatMinorUnits(c.spentMinor || 0)}
                            {c.budgetMinor
                              ? ` / ${formatMinorUnits(c.budgetMinor)}`
                              : ""}
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className={`h-full rounded-full ${
                              (budgetPct ?? 0) >= 100
                                ? "bg-red-500"
                                : "bg-[#0066ff]"
                            }`}
                            style={{ width: `${budgetPct ?? 0}%` }}
                          />
                        </div>
                        {budgetPct !== null && (
                          <p className="mt-1 text-[10px] text-text-muted">
                            {budgetPct}% consumed
                            {budgetPct >= 100
                              ? " — budget exhausted, paused automatically"
                              : ""}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs lg:justify-end">
                        <div className="text-right">
                          <p className="font-mono font-medium text-text-primary">
                            {perf?.orders ?? 0}
                          </p>
                          <p className="text-[10px] text-text-muted">orders</p>
                        </div>
                        <div className="text-right">
                          <p className="font-mono font-medium text-text-primary">
                            {perf ? formatMinorUnits(perf.revenueMinor) : "—"}
                          </p>
                          <p className="text-[10px] text-text-muted">revenue</p>
                        </div>
                        <div className="text-right">
                          <p className="font-mono font-medium text-text-primary">
                            {perf
                              ? formatMinorUnits(perf.discountSpendMinor)
                              : "—"}
                          </p>
                          <p className="text-[10px] text-text-muted">
                            discount
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-mono font-medium text-text-primary">
                            {perf ? `${(perf.roiBps / 100).toFixed(1)}%` : "—"}
                          </p>
                          <p className="text-[10px] text-text-muted">ROI</p>
                        </div>
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-text-muted">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {new Date(c.startsAt).toLocaleDateString()} →{" "}
                        {new Date(c.endsAt).toLocaleDateString()}
                      </span>
                      {c.scheduleDays?.length ? (
                        <span>days {c.scheduleDays.join(", ")}</span>
                      ) : null}
                      {c.tiers?.length ? (
                        <span>tiers: {c.tiers.length}</span>
                      ) : null}
                      {c.flashPriceMinor !== undefined ? (
                        <span>floor {formatMinorUnits(c.flashPriceMinor)}</span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Card>

      {/* Analytics table */}
      <Card className="p-0 overflow-hidden">
        <div className="border-b border-border px-5 py-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <BarChart3 className="w-4 h-4" />
            Campaign performance
          </h3>
          <p className="text-xs text-text-muted">
            Computed from the audit trail — orders, revenue and discount spend
            per campaign.
          </p>
        </div>
        <div className="px-5 py-4">
          {performance.length === 0 ? (
            <p className="text-sm text-text-muted">
              No campaign activity recorded yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-border text-text-muted">
                    <th className="py-2 pr-4 font-medium">Campaign</th>
                    <th className="py-2 pr-4 font-medium">Orders</th>
                    <th className="py-2 pr-4 font-medium">Units</th>
                    <th className="py-2 pr-4 font-medium">Revenue</th>
                    <th className="py-2 pr-4 font-medium">Discount</th>
                    <th className="py-2 pr-4 font-medium">ROI</th>
                    <th className="py-2 pr-4 font-medium">Budget</th>
                  </tr>
                </thead>
                <tbody>
                  {performance.map((p) => (
                    <tr
                      key={p.campaign.id}
                      className="border-b border-border/60 last:border-0"
                    >
                      <td className="py-2 pr-4">
                        <span className="font-medium text-text-primary">
                          {p.campaign.name}
                        </span>
                        <span className="ml-2 text-text-muted">
                          {p.campaign.type}
                        </span>
                      </td>
                      <td className="py-2 pr-4 font-mono">{p.orders}</td>
                      <td className="py-2 pr-4 font-mono">{p.unitsSold}</td>
                      <td className="py-2 pr-4 font-mono">
                        {formatMinorUnits(p.revenueMinor)}
                      </td>
                      <td className="py-2 pr-4 font-mono">
                        {formatMinorUnits(p.discountSpendMinor)}
                      </td>
                      <td className="py-2 pr-4 font-mono">
                        {(p.roiBps / 100).toFixed(1)}%
                      </td>
                      <td className="py-2 pr-4 font-mono">
                        {p.budgetPercentUsed === null
                          ? "unlimited"
                          : `${p.budgetPercentUsed}%`}
                        <span className="ml-1 text-text-muted">
                          ({formatMinorUnits(p.budgetRemainingMinor || 0)} left)
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      {/* Create campaign dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New campaign</DialogTitle>
            <DialogDescription>
              Stand up a budget-capped, priority-orchestrated promotion for AI
              buyer agents.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 text-xs">
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="campaign-name"
                  className="mb-1 block font-medium"
                >
                  Name
                </label>
                <Input
                  id="campaign-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Summer Accessory Sale"
                />
              </div>
              <div>
                <label
                  htmlFor="campaign-type"
                  className="mb-1 block font-medium"
                >
                  Type
                </label>
                <select
                  id="campaign-type"
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                  className="h-9 w-full px-2 rounded-md bg-white border border-input text-xs focus:outline-none focus:border-primary"
                >
                  {CAMPAIGN_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {TYPE_META[t].label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label
                htmlFor="campaign-description"
                className="mb-1 block font-medium"
              >
                Description
              </label>
              <Textarea
                id="campaign-description"
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
                placeholder="Who/what is this for?"
                rows={2}
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="campaign-category"
                  className="mb-1 block font-medium"
                >
                  Category
                </label>
                <Input
                  id="campaign-category"
                  value={form.category}
                  onChange={(e) =>
                    setForm({ ...form, category: e.target.value })
                  }
                  placeholder="accessories"
                />
              </div>
              <div>
                <label
                  htmlFor="campaign-variant-ids"
                  className="mb-1 block font-medium"
                >
                  Variant ids (comma-separated)
                </label>
                <Input
                  id="campaign-variant-ids"
                  value={form.variantIds}
                  onChange={(e) =>
                    setForm({ ...form, variantIds: e.target.value })
                  }
                  placeholder="acc_nimbus_deskmat, ..."
                />
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <label
                  htmlFor="campaign-discount-bps"
                  className="mb-1 block font-medium"
                >
                  Discount bps (0–4000)
                </label>
                <Input
                  id="campaign-discount-bps"
                  type="number"
                  value={form.discountBps}
                  onChange={(e) =>
                    setForm({ ...form, discountBps: e.target.value })
                  }
                />
              </div>
              <div>
                <label
                  htmlFor="campaign-min-order"
                  className="mb-1 block font-medium"
                >
                  Min order (₹)
                </label>
                <Input
                  id="campaign-min-order"
                  type="number"
                  value={form.minOrderMinor}
                  onChange={(e) =>
                    setForm({ ...form, minOrderMinor: e.target.value })
                  }
                  placeholder="optional"
                />
              </div>
              <div>
                <label
                  htmlFor="campaign-duration"
                  className="mb-1 block font-medium"
                >
                  Duration (days)
                </label>
                <Input
                  id="campaign-duration"
                  type="number"
                  value={form.durationDays}
                  onChange={(e) =>
                    setForm({ ...form, durationDays: e.target.value })
                  }
                />
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <label
                  htmlFor="campaign-budget"
                  className="mb-1 block font-medium"
                >
                  Budget cap (₹)
                </label>
                <Input
                  id="campaign-budget"
                  type="number"
                  value={form.budgetMinor}
                  onChange={(e) =>
                    setForm({ ...form, budgetMinor: e.target.value })
                  }
                  placeholder="optional"
                />
              </div>
              <div>
                <label
                  htmlFor="campaign-priority"
                  className="mb-1 block font-medium"
                >
                  Priority
                </label>
                <Input
                  id="campaign-priority"
                  type="number"
                  value={form.priority}
                  onChange={(e) =>
                    setForm({ ...form, priority: e.target.value })
                  }
                />
              </div>
              <div>
                <label
                  htmlFor="campaign-flash-floor"
                  className="mb-1 block font-medium"
                >
                  Flash floor (₹)
                </label>
                <Input
                  id="campaign-flash-floor"
                  type="number"
                  value={form.flashPriceMinor}
                  onChange={(e) =>
                    setForm({ ...form, flashPriceMinor: e.target.value })
                  }
                  placeholder="optional"
                />
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="campaign-target-agents"
                  className="mb-1 block font-medium"
                >
                  Agent ids (comma-separated, AGENT_TARGETED)
                </label>
                <Input
                  id="campaign-target-agents"
                  value={form.targetAgents}
                  onChange={(e) =>
                    setForm({ ...form, targetAgents: e.target.value })
                  }
                  placeholder="agt_apollo_buyer_v1"
                />
              </div>
              <div>
                <label
                  htmlFor="campaign-schedule-days"
                  className="mb-1 block font-medium"
                >
                  Schedule weekdays (0-6, comma)
                </label>
                <Input
                  id="campaign-schedule-days"
                  value={form.scheduleDays}
                  onChange={(e) =>
                    setForm({ ...form, scheduleDays: e.target.value })
                  }
                  placeholder="0,1,2,3,4,5,6"
                />
              </div>
            </div>
            <div>
              <label
                htmlFor="campaign-tiers"
                className="mb-1 block font-medium"
              >
                Tiered discounts (TIERED_DISCOUNT):{" "}
                <span className="text-text-muted">
                  minOrder:bps;minOrder:bps
                </span>
              </label>
              <Input
                id="campaign-tiers"
                value={form.tiers}
                onChange={(e) => setForm({ ...form, tiers: e.target.value })}
                placeholder="50000:500;100000:1000"
              />
            </div>
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.stackable}
                  onChange={(e) =>
                    setForm({ ...form, stackable: e.target.checked })
                  }
                  className="h-3.5 w-3.5"
                />
                Stackable with other promos
              </label>
              <label className="flex items-center gap-2">
                A/B group
                <select
                  value={form.abGroup}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      abGroup: e.target.value as "" | "A" | "B",
                    })
                  }
                  className="h-8 px-2 rounded-md bg-white border border-input text-xs"
                >
                  <option value="">None</option>
                  <option value="A">A</option>
                  <option value="B">B</option>
                </select>
              </label>
            </div>
            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="gap-1"
                onClick={handleCreate}
                disabled={busy || !form.name.trim()}
              >
                <Check className="w-4 h-4" />
                Create campaign
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit campaign dialog */}
      <Dialog
        open={editTarget !== null}
        onOpenChange={(o) => !o && setEditTarget(null)}
      >
        {editTarget && (
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Edit campaign</DialogTitle>
              <DialogDescription>
                Adjust targeting, budget and pricing. Lifecycle changes use
                Pause / Resume / End.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 text-xs">
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="edit-campaign-description"
                    className="mb-1 block font-medium"
                  >
                    Description
                  </label>
                  <Input
                    id="edit-campaign-description"
                    value={editTarget.description || ""}
                    onChange={(e) =>
                      setEditField("description", e.target.value)
                    }
                  />
                </div>
                <div>
                  <label
                    htmlFor="edit-campaign-category"
                    className="mb-1 block font-medium"
                  >
                    Category
                  </label>
                  <Input
                    id="edit-campaign-category"
                    value={editTarget.category || ""}
                    onChange={(e) => setEditField("category", e.target.value)}
                  />
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <div>
                  <label
                    htmlFor="edit-campaign-discount-bps"
                    className="mb-1 block font-medium"
                  >
                    Discount bps
                  </label>
                  <Input
                    id="edit-campaign-discount-bps"
                    type="number"
                    value={editTarget.discountBps}
                    onChange={(e) =>
                      setEditField("discountBps", Number(e.target.value))
                    }
                  />
                </div>
                <div>
                  <label
                    htmlFor="edit-campaign-min-order"
                    className="mb-1 block font-medium"
                  >
                    Min order (₹)
                  </label>
                  <Input
                    id="edit-campaign-min-order"
                    type="number"
                    value={editTarget.minOrderMinor || ""}
                    onChange={(e) =>
                      setEditField(
                        "minOrderMinor",
                        Number(e.target.value) || undefined,
                      )
                    }
                  />
                </div>
                <div>
                  <label
                    htmlFor="edit-campaign-priority"
                    className="mb-1 block font-medium"
                  >
                    Priority
                  </label>
                  <Input
                    id="edit-campaign-priority"
                    type="number"
                    value={editTarget.priority || 0}
                    onChange={(e) =>
                      setEditField("priority", Number(e.target.value))
                    }
                  />
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <div>
                  <label
                    htmlFor="edit-campaign-budget"
                    className="mb-1 block font-medium"
                  >
                    Budget cap (₹)
                  </label>
                  <Input
                    id="edit-campaign-budget"
                    type="number"
                    value={editTarget.budgetMinor || ""}
                    onChange={(e) =>
                      setEditField(
                        "budgetMinor",
                        Number(e.target.value) || undefined,
                      )
                    }
                  />
                </div>
                <div>
                  <label
                    htmlFor="edit-campaign-variant-ids"
                    className="mb-1 block font-medium"
                  >
                    Variant ids (comma)
                  </label>
                  <Input
                    id="edit-campaign-variant-ids"
                    value={editTarget.variantIds?.join(", ") || ""}
                    onChange={(e) =>
                      setEditField(
                        "variantIds",
                        e.target.value
                          .split(",")
                          .map((x) => x.trim())
                          .filter(Boolean),
                      )
                    }
                  />
                </div>
                <div>
                  <label
                    htmlFor="edit-campaign-target-agents"
                    className="mb-1 block font-medium"
                  >
                    Agent ids (comma)
                  </label>
                  <Input
                    id="edit-campaign-target-agents"
                    value={editTarget.targetAgents?.join(", ") || ""}
                    onChange={(e) =>
                      setEditField(
                        "targetAgents",
                        e.target.value
                          .split(",")
                          .map((x) => x.trim())
                          .filter(Boolean),
                      )
                    }
                  />
                </div>
              </div>
              {editTarget.type === "TIERED_DISCOUNT" && (
                <div>
                  <label
                    htmlFor="edit-campaign-tiers"
                    className="mb-1 block font-medium"
                  >
                    Tiered discounts (minOrder:bps;minOrder:bps)
                  </label>
                  <Input
                    id="edit-campaign-tiers"
                    value={
                      editTarget.tiers
                        ?.map((t) => `${t.minOrderMinor}:${t.discountBps}`)
                        .join(";") || ""
                    }
                    onChange={(e) => {
                      const tiers = e.target.value
                        .split(";")
                        .map((t) => t.trim())
                        .filter(Boolean)
                        .map((t) => {
                          const [min, bps] = t.split(":").map((x) => Number(x.trim()));
                          return { minOrderMinor: min || 0, discountBps: bps || 0 };
                        })
                        .filter((t) => t.minOrderMinor > 0);
                      setEditField("tiers", tiers.length > 0 ? tiers : []);
                    }}
                    placeholder="50000:500;100000:1000"
                  />
                </div>
              )}
              <div className="flex justify-end gap-2 border-t border-border pt-3">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEditTarget(null)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="gap-1"
                  onClick={handleEditSave}
                  disabled={busy}
                >
                  <Check className="w-4 h-4" />
                  Save changes
                </Button>
              </div>
            </div>
          </DialogContent>
        )}
      </Dialog>

      <div className="flex items-center gap-2 text-[11px] text-text-muted">
        <Megaphone className="w-3.5 h-3.5" />
        Campaign discounts only ever lower a quoted price within the mandate's
        ceilings — surge pricing always overrides promotions.
      </div>
    </div>
  );
}
