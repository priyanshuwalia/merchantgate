"use client";

import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Cpu,
  DollarSign,
  Layers,
  Package,
  ShieldAlert,
  ShoppingBag,
  TrendingUp,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Header } from "@/components/dashboard/Header";
import { LiveActivityPanel } from "@/components/dashboard/LiveActivityPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  publishApprovalCheckout,
  publishMerchantControl,
  subscribeMerchantControl,
} from "@/lib/broadcast/agentpay-bus";
import { formatMinorUnits } from "@/lib/utils";

interface DashboardMetrics {
  totalGmvMinor: number;
  totalTransactions: number;
  completedOrders: number;
  activeProposals: number;
  conversionRate: number;
  stepUpRequests: number;
  allowedRequests: number;
  deniedRequests: number;
  productsCount: number;
  totalStock: number;
}

interface ProposalItem {
  title?: string;
  variantId?: string;
}

interface Proposal {
  id: string;
  request_id?: string;
  items?: ProposalItem[];
  total_minor: number;
  currency: string;
  status: string;
  content_hash?: string;
}

interface AuditEvent {
  id: string;
  event_type: string;
  actor_type: string;
  actor_id: string;
  trace_id: string;
  explanation: string;
  timestamp: string;
}

interface DashboardStats {
  metrics: DashboardMetrics;
  recentProposals: Proposal[];
  recentAudit: AuditEvent[];
  merchant?: {
    config?: {
      aiSalesEnabled?: boolean;
    };
  };
}

export default function DashboardOverview() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [_refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [optimisticState, setOptimisticState] = useState<boolean | null>(null);

  // Surge Pricing control state (two-way toggle with a live countdown).
  const [surge, setSurge] = useState<{
    active: boolean;
    remainingSeconds: number;
  } | null>(null);
  const [surgeToggling, setSurgeToggling] = useState(false);
  const [lastSurgeAffected, setLastSurgeAffected] = useState<number | null>(
    null,
  );

  const fetchStats = async () => {
    try {
      setRefreshing(true);
      setError(null);
      const res = await fetch("/api/merchant/stats");
      if (!res.ok) throw new Error(`Stats request failed: ${res.status}`);
      const data = await res.json();
      setStats(data);
    } catch (e) {
      console.error(e);
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleApproveProposal = async (
    id: string,
    action: "approve" | "reject",
  ) => {
    try {
      setApproving(id);
      const res = await fetch(`/api/merchant/requests/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok && action === "approve") {
        const data = await res.json().catch(() => null);
        // Broadcast the approval so any open Simulation Lab tab surfaces the
        // Razorpay test checkout in real time (cross-tab, same origin).
        if (data?.razorpayOrderId) {
          publishApprovalCheckout({
            cartMandateId: id,
            paymentActionId: data.paymentActionId,
            razorpayOrderId: data.razorpayOrderId,
            razorpayKeyId: data.razorpayKeyId,
            amountMinor: data.amountMinor,
            currency: data.currency || "INR",
            grandTotalMinor: data.grandTotalMinor ?? data.amountMinor,
            quantity: data.quantity ?? 1,
          });
        }
      }
      fetchStats();
    } catch (e) {
      console.error("Approval failed:", e);
    } finally {
      setApproving(null);
    }
  };

  const syncSurgeState = async () => {
    try {
      const res = await fetch("/api/merchant/surge");
      const data = await res.json();
      setSurge({
        active: Boolean(data.active),
        remainingSeconds: Number(data.remainingSeconds) || 0,
      });
    } catch {
      /* non-fatal */
    }
  };

  const toggleSurge = async () => {
    if (surgeToggling) return;
    setSurgeToggling(true);
    try {
      const wasActive = surge?.active ?? false;
      const res = await fetch("/api/merchant/surge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !wasActive, durationSeconds: 60 }),
      });
      const data = await res.json().catch(() => null);
      if (data?.success) {
        setSurge({
          active: Boolean(data.active),
          remainingSeconds: Number(data.remainingSeconds) || 0,
        });
        if (data.active) {
          setLastSurgeAffected(Number(data.affectedCarts) || 0);
        }
        // Tell any other open tab (Agent Requests monitor, Simulation Lab) to
        // re-fetch — no polling anywhere.
        publishMerchantControl({
          control: "surge",
          active: Boolean(data.active),
        });
      }
    } catch (e) {
      console.error("Failed to toggle surge:", e);
    } finally {
      setSurgeToggling(false);
    }
  };

  // No background polling. Stats refresh on mount, when the tab regains
  // focus/visibility, and whenever the console broadcasts a control change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate one-time subscription; fetchStats only uses stable setters.
  useEffect(() => {
    fetchStats();
    syncSurgeState();

    const onFocus = () => {
      fetchStats();
      syncSurgeState();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        fetchStats();
        syncSurgeState();
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    const unsubscribe = subscribeMerchantControl((message) => {
      if (message.control === "surge") {
        syncSurgeState();
        fetchStats();
      }
    });

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      unsubscribe();
    };
  }, []);

  // Live countdown while surge is active.
  useEffect(() => {
    if (!surge?.active) return;
    const t = setInterval(() => {
      setSurge((prev) => {
        if (!prev || !prev.active) return prev;
        const remaining = Math.max(0, prev.remainingSeconds - 1);
        return { ...prev, remainingSeconds: remaining, active: remaining > 0 };
      });
    }, 1000);
    return () => clearInterval(t);
  }, [surge?.active]);

  // Calculate isEnabled here, outside of JSX
  const isEnabled =
    optimisticState !== null
      ? optimisticState
      : stats?.merchant?.config?.aiSalesEnabled !== false;

  const metrics = stats?.metrics || {
    totalGmvMinor: 0,
    totalTransactions: 0,
    completedOrders: 0,
    activeProposals: 0,
    conversionRate: 0,
    stepUpRequests: 0,
    allowedRequests: 0,
    deniedRequests: 0,
    productsCount: 0,
    totalStock: 0,
  };

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Merchant Overview"
        description="Real-time monitoring of AI buyer agents, authoritative quotes, and policy gates."
      />

      <div className="space-y-6">
        {/* Top Control Bar with AI Sales Kill-Switch & Surge Pricing */}
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 p-4 rounded-xl bg-card border border-border shadow-sm">
          <div>
            <span className="text-xs font-medium text-text-secondary">
              Live Agent Commerce Gateway
            </span>
          </div>

          {/* Interactive Controls & Judge Demos */}
          <div className="flex items-center flex-wrap gap-2">
            {/* AI Sales Channel Kill-Switch Toggle */}
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-text-secondary">
                AI Sales
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={isEnabled}
                disabled={isLoading}
                onClick={async () => {
                  if (isLoading) return;

                  const current =
                    stats?.merchant?.config?.aiSalesEnabled !== false;
                  const nextState = !current;

                  // Optimistically update the UI
                  setOptimisticState(nextState);
                  setIsLoading(true);

                  try {
                    await fetch("/api/merchant/settings", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ aiSalesEnabled: nextState }),
                    });
                    await fetchStats();
                  } catch (error) {
                    console.error("Failed to toggle AI sales:", error);
                    // Revert optimistic update on error
                    setOptimisticState(current);
                  } finally {
                    setIsLoading(false);
                    // Clear optimistic state after fetchStats completes
                    setOptimisticState(null);
                  }
                }}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-[3px] focus-visible:ring-[#0066ff]/20 ${
                  isLoading
                    ? "bg-[#d3dbe4] cursor-not-allowed"
                    : isEnabled
                      ? "bg-primary"
                      : "bg-[#d3dbe4]"
                }`}
              >
                {isLoading ? (
                  <div className="flex items-center justify-center w-full h-full">
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : (
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200 ${
                      isEnabled ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                )}
              </button>
              <span
                className={`text-sm font-medium min-w-[52px] ${isEnabled ? "text-[#00875c]" : "text-text-muted"}`}
              >
                {isLoading ? "" : isEnabled ? "Active" : "Paused"}
              </span>
            </div>

            {/* Surge Pricing Toggle — two-state switch with live countdown.
                Enabling also re-prices any in-flight transaction to STEP_UP. */}
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-text-secondary">
                Surge
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={surge?.active ?? false}
                disabled={surgeToggling}
                onClick={toggleSurge}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-[3px] focus-visible:ring-[#ffb822]/20 ${
                  surgeToggling
                    ? "bg-[#d3dbe4] cursor-not-allowed"
                    : surge?.active
                      ? "bg-[#ffb822]"
                      : "bg-[#d3dbe4]"
                }`}
              >
                {surgeToggling ? (
                  <div className="flex items-center justify-center w-full h-full">
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : (
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200 ${
                      surge?.active ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                )}
              </button>
              <span
                className={`text-sm font-medium min-w-[72px] tabular-nums ${
                  surge?.active ? "text-[#946400]" : "text-text-muted"
                }`}
              >
                {surgeToggling
                  ? ""
                  : surge?.active
                    ? `+15% · ${surge.remainingSeconds}s`
                    : "Off"}
              </span>
            </div>
            <Link href="/dashboard/webhook-inspector">
              <Button variant="outline" size="sm" className="gap-1.5">
                <ShieldAlert className="w-3.5 h-3.5" />
                <span>HMAC Inspector</span>
              </Button>
            </Link>
            <Link href="/dashboard/simulator">
              <Button size="sm" className="gap-1.5">
                <Cpu className="w-3.5 h-3.5" />
                <span>AI Simulator Lab</span>
              </Button>
            </Link>
          </div>
        </div>

        {surge?.active && (
          <div className="flex items-center gap-2 p-3 rounded-lg border border-[#ffb822]/40 bg-[#ffb822]/[0.08] text-xs text-[#946400]">
            <Zap className="w-3.5 h-3.5 shrink-0" />
            <span>
              Surge Pricing active (+15%). New checkouts quote at the surged
              price and require approval.{" "}
              {lastSurgeAffected !== null && lastSurgeAffected > 0 ? (
                <strong>
                  {lastSurgeAffected} in-flight transaction
                  {lastSurgeAffected > 1 ? "s were" : " was"} re-priced to
                  STEP_UP — approve or reject them in Agent Requests.
                </strong>
              ) : (
                <span>No in-flight quotes were open to re-price.</span>
              )}
            </span>
          </div>
        )}

        {error && (
          <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-destructive/25 bg-destructive/[0.05] text-sm text-destructive">
            <span>Could not load dashboard stats: {error}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setLoading(true);
                fetchStats();
              }}
            >
              Retry
            </Button>
          </div>
        )}

        {/* Metric Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Card 1: Total Agent GMV */}
          <Card className="hover:border-primary/40 transition-all">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <span className="text-xs font-medium text-text-muted">
                Total Agent GMV
              </span>
              <div className="w-8 h-8 rounded-lg bg-accent text-primary flex items-center justify-center">
                <DollarSign className="w-4 h-4" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-[28px] leading-9 font-bold text-foreground tracking-tight">
                {loading ? (
                  <Skeleton className="h-8 w-28" />
                ) : (
                  formatMinorUnits(metrics.totalGmvMinor, "INR")
                )}
              </div>
              <div className="mt-1 flex items-center gap-1 text-xs text-[#00875c]">
                <TrendingUp className="w-3.5 h-3.5" />
                {loading ? (
                  <Skeleton className="h-3 w-36" />
                ) : (
                  <span>{metrics.completedOrders} completed orders</span>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Card 2: Active Proposals */}
          <Card className="hover:border-primary/40 transition-all">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <span className="text-xs font-medium text-text-muted">
                Active Time-bound Quotes
              </span>
              <div className="w-8 h-8 rounded-lg bg-accent text-primary flex items-center justify-center">
                <ShoppingBag className="w-4 h-4" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-[28px] leading-9 font-bold text-foreground tracking-tight">
                {loading ? (
                  <Skeleton className="h-8 w-10" />
                ) : (
                  metrics.activeProposals
                )}
              </div>
              <div className="mt-1 text-xs text-text-muted">
                15-min price freeze
              </div>
            </CardContent>
          </Card>

          {/* Card 3: Step-Up Requests */}
          <Card className="hover:border-[#ffb822]/50 transition-all">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <span className="text-xs font-medium text-text-muted">
                Step-Up Approvals Pending
              </span>
              <div className="w-8 h-8 rounded-lg bg-[#ffb822]/15 text-[#946400] flex items-center justify-center">
                <ShieldAlert className="w-4 h-4" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-[28px] leading-9 font-bold text-foreground tracking-tight">
                {loading ? (
                  <Skeleton className="h-8 w-10" />
                ) : (
                  metrics.stepUpRequests
                )}
              </div>
              <Link
                href="/dashboard/requests"
                className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-[#946400] hover:underline"
              >
                <span>Review flagged proposals</span>
                <ArrowUpRight className="w-3 h-3" />
              </Link>
            </CardContent>
          </Card>

          {/* Card 4: Agent Conversion Rate */}
          <Card className="hover:border-[#00b874]/50 transition-all">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <span className="text-xs font-medium text-text-muted">
                Agent Conversion Rate
              </span>
              <div className="w-8 h-8 rounded-lg bg-[#00b874]/10 text-[#00875c] flex items-center justify-center">
                <Activity className="w-4 h-4" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-[28px] leading-9 font-bold text-foreground tracking-tight">
                {loading ? (
                  <Skeleton className="h-8 w-16" />
                ) : (
                  `${metrics.conversionRate}%`
                )}
              </div>
              <div className="mt-1 text-xs text-text-muted">
                {loading ? (
                  <Skeleton className="h-3 w-32" />
                ) : (
                  `${metrics.totalTransactions} total quote requests`
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Policy Decision Ratio & Catalog Status */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Policy Decision Breakdown */}
          <Card className="lg:col-span-2">
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Policy Engine Verifications</CardTitle>
                <CardDescription>
                  Automated gate decisions for incoming buyer agents
                </CardDescription>
              </div>
              <Link href="/dashboard/policies">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-primary gap-1"
                >
                  <span>Edit Policy</span>
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </Button>
              </Link>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="p-4 rounded-lg bg-[#00b874]/[0.05] border border-[#00b874]/20 flex flex-col justify-between">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-[#00875c]">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>ALLOW</span>
                  </div>
                  <div className="my-2 text-xl font-bold text-[#00754d]">
                    {loading ? (
                      <Skeleton className="h-5 w-6" />
                    ) : (
                      metrics.allowedRequests
                    )}
                  </div>
                  <span className="text-xs text-text-muted">
                    Autonomous Settlement
                  </span>
                </div>

                <div className="p-4 rounded-lg bg-[#ffb822]/[0.07] border border-[#ffb822]/25 flex flex-col justify-between">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-[#946400]">
                    <AlertTriangle className="w-4 h-4" />
                    <span>STEP_UP</span>
                  </div>
                  <div className="my-2 text-xl font-bold text-[#7d5500]">
                    {loading ? (
                      <Skeleton className="h-5 w-6" />
                    ) : (
                      metrics.stepUpRequests
                    )}
                  </div>
                  <span className="text-xs text-text-muted">
                    Slippage / Approval
                  </span>
                </div>

                <div className="p-4 rounded-lg bg-destructive/[0.04] border border-destructive/20 flex flex-col justify-between">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-destructive">
                    <XCircle className="w-4 h-4" />
                    <span>DENY</span>
                  </div>
                  <div className="my-2 text-xl font-bold text-[#d32f2f]">
                    {loading ? (
                      <Skeleton className="h-5 w-6" />
                    ) : (
                      metrics.deniedRequests
                    )}
                  </div>
                  <span className="text-xs text-text-muted">
                    Budget Exceeded
                  </span>
                </div>
              </div>

              <div className="p-4 rounded-lg bg-muted border border-border text-sm space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-foreground">
                    Deterministic Gate Rule:
                  </span>
                  <span className="text-xs font-medium text-primary">
                    The LLM proposes; code disposes
                  </span>
                </div>
                <p className="text-xs text-text-muted">
                  All agent purchases must satisfy mandate signature
                  verification, 200 bps slippage threshold, and budget caps
                  before locking inventory.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Quick Actions */}
          <Card className="flex flex-col justify-between">
            <CardHeader>
              <CardTitle>Quick Actions</CardTitle>
              <CardDescription>
                Manage products, test flows, inspect protocols
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Link href="/dashboard/products" className="block">
                <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-white text-sm text-foreground transition-colors duration-200 hover:bg-muted">
                  <div className="flex items-center gap-2.5">
                    <Package className="w-4 h-4 text-primary" />
                    <span>
                      Manage Catalogue{" "}
                      {loading ? (
                        <Skeleton className="inline-block h-3 w-6 align-middle" />
                      ) : (
                        `(${metrics.productsCount} SKUs)`
                      )}
                    </span>
                  </div>
                  <ArrowUpRight className="w-3.5 h-3.5 text-text-muted" />
                </div>
              </Link>

              <Link href="/dashboard/simulator" className="block">
                <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-white text-sm text-foreground transition-colors duration-200 hover:bg-muted">
                  <div className="flex items-center gap-2.5">
                    <Cpu className="w-4 h-4 text-primary" />
                    <span>Run Simulated Buyer Flow</span>
                  </div>
                  <ArrowUpRight className="w-3.5 h-3.5 text-text-muted" />
                </div>
              </Link>

              <Link href="/dashboard/requests" className="block">
                <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-white text-sm text-foreground transition-colors duration-200 hover:bg-muted">
                  <div className="flex items-center gap-2.5">
                    <Layers className="w-4 h-4 text-[#946400]" />
                    <span>Inspect Agent Requests</span>
                  </div>
                  <ArrowUpRight className="w-3.5 h-3.5 text-text-muted" />
                </div>
              </Link>

              <div className="p-3 rounded-lg bg-accent/60 border border-primary/15 text-xs space-y-1 mt-4">
                <span className="font-semibold text-primary">
                  Ready for Agent Customers:
                </span>
                <p className="text-text-secondary">
                  Endpoint{" "}
                  <code className="font-mono text-primary">
                    /.well-known/agent-commerce.json
                  </code>{" "}
                  is active.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Live Agent Activity — streaming audit trail snapshot */}
        <LiveActivityPanel />

        {/* Pending Checkout Approvals — Merchant can approve/reject STEP_UP proposals inline */}
        {(stats?.recentProposals?.filter(
          (p: Proposal) => p.status === "flagged",
        ).length ?? 0) > 0 && (
          <Card className="border-[#ffb822]/35 bg-[#fffaf0]">
            {(() => {
              const flagged =
                stats?.recentProposals?.filter(
                  (p: Proposal) => p.status === "flagged",
                ) ?? [];
              return (
                <>
                  <CardHeader className="flex flex-row items-center justify-between pb-3">
                    <div>
                      <CardTitle className="flex items-center gap-2 text-[#7d5500]">
                        <AlertTriangle className="w-4 h-4" />
                        Pending Checkout Approvals
                      </CardTitle>
                      <CardDescription>
                        These AI agent checkout proposals require your manual
                        authorization (STEP_UP policy triggered).
                      </CardDescription>
                    </div>
                    <Badge variant="warning" className="animate-pulse">
                      {flagged.length} pending
                    </Badge>
                  </CardHeader>
                  <CardContent className="p-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Cart Mandate ID</TableHead>
                          <TableHead>Items</TableHead>
                          <TableHead>Total</TableHead>
                          <TableHead>Snapshot Hash</TableHead>
                          <TableHead className="text-right">
                            Merchant Action
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {flagged.map((p: Proposal) => (
                          <TableRow key={p.id}>
                            <TableCell className="font-mono font-semibold text-[#946400] text-xs">
                              {p.id}
                            </TableCell>
                            <TableCell className="text-sm text-text-secondary">
                              {Array.isArray(p.items)
                                ? p.items
                                    .map(
                                      (i: ProposalItem) =>
                                        i.title || i.variantId,
                                    )
                                    .join(", ")
                                : "—"}
                            </TableCell>
                            <TableCell className="font-mono font-bold text-foreground">
                              {formatMinorUnits(p.total_minor, p.currency)}
                            </TableCell>
                            <TableCell className="font-mono text-xs text-text-muted max-w-35 truncate">
                              {p.content_hash?.slice(0, 16)}…
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex items-center justify-end gap-2">
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  disabled={approving === p.id}
                                  onClick={() =>
                                    handleApproveProposal(p.id, "reject")
                                  }
                                  className="gap-1 h-7 text-xs"
                                >
                                  <X className="w-3 h-3" />
                                  Reject
                                </Button>
                                <Button
                                  size="sm"
                                  disabled={approving === p.id}
                                  onClick={() =>
                                    handleApproveProposal(p.id, "approve")
                                  }
                                  className="gap-1 h-7 text-xs bg-[#00b874] hover:bg-[#00a568] text-white"
                                >
                                  <Check className="w-3 h-3" />
                                  {approving === p.id
                                    ? "Processing…"
                                    : "Approve Checkout"}
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </>
              );
            })()}
          </Card>
        )}

        {/* Live Audit Log Stream */}

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Append-Only Audit Trail</CardTitle>
              <CardDescription>
                Cryptographically verifiable lineage for all agent actions
              </CardDescription>
            </div>
            <Badge variant="outline">
              {stats?.recentAudit?.length || 0} events recorded
            </Badge>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event Type</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Trace ID</TableHead>
                  <TableHead>Explanation</TableHead>
                  <TableHead className="text-right">Timestamp</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats?.recentAudit && stats.recentAudit.length > 0 ? (
                  stats.recentAudit.slice(0, 8).map((evt: AuditEvent) => (
                    <TableRow key={evt.id}>
                      <TableCell className="font-mono font-medium text-primary">
                        {evt.event_type}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">
                          {evt.actor_type}:{evt.actor_id}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-text-muted truncate max-w-40">
                        {evt.trace_id}
                      </TableCell>
                      <TableCell className="text-foreground text-sm max-w-md truncate">
                        {evt.explanation}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-text-muted">
                        {new Date(evt.timestamp).toLocaleTimeString()}
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="py-8 text-center text-text-muted"
                    >
                      No audit events recorded yet. Run a simulation to see live
                      telemetry!
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
