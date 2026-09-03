"use client";

import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Code2,
  Eye,
  Lock,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type ApprovalCheckoutPayload,
  publishApprovalCheckout,
  subscribeMerchantControl,
} from "@/lib/broadcast/agentpay-bus";
import { formatMinorUnits } from "@/lib/utils";

export default function AgentRequestsPage() {
  const [proposals, setProposals] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [selectedProposal, setSelectedProposal] = useState<any>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // Razorpay test checkout (approving an over-limit / step-up order surfaces
  // a real payment to complete).
  const [checkout, setCheckout] = useState<ApprovalCheckoutPayload | null>(
    null,
  );
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  const fetchRequests = async () => {
    // Keep existing rows visible on silent refreshes; only the very first load
    // (empty table) shows the full "Loading agent proposals..." state.
    if (proposals.length === 0) {
      setLoading(true);
    }
    try {
      const res = await fetch("/api/merchant/stats");
      const data = await res.json();
      if (data.recentProposals) {
        setProposals(data.recentProposals);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  // Always call the latest fetchRequests from listeners without re-subscribing.
  const fetchRequestsRef = useRef(fetchRequests);
  fetchRequestsRef.current = fetchRequests;

  // No background polling. The list refreshes on mount, when the tab regains
  // focus/visibility, and whenever the merchant console broadcasts a control
  // change (e.g. Surge Pricing re-flagging in-flight transactions from the
  // Overview dashboard). Actions in this page refetch explicitly.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fetchRequests is deliberately refreshed through the ref.
  useEffect(() => {
    const load = () => fetchRequestsRef.current();
    load();

    const onFocus = () => load();
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    const unsubscribe = subscribeMerchantControl((message) => {
      if (message.control === "surge") load();
    });

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      unsubscribe();
    };
  }, []);

  const handleApprove = async (id: string, action: "approve" | "reject") => {
    try {
      setActionLoading(true);
      const res = await fetch(`/api/merchant/requests/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        setIsDetailOpen(false);
        // Approval authorizes the spend and leaves a real Razorpay order
        // pending. Surface the test checkout here AND broadcast it so any
        // other open tab (Simulation Lab) opens it in real time too.
        if (data?.razorpayOrderId) {
          const payload: ApprovalCheckoutPayload = {
            cartMandateId: id,
            paymentActionId: data.paymentActionId,
            razorpayOrderId: data.razorpayOrderId,
            razorpayKeyId: data.razorpayKeyId,
            amountMinor: data.amountMinor,
            currency: data.currency || "INR",
            grandTotalMinor: data.grandTotalMinor ?? data.amountMinor,
            quantity: data.quantity ?? 1,
          };
          setCheckout(payload);
          setPayError(null);
          publishApprovalCheckout(payload);
        }
        fetchRequests();
      }
    } catch (e) {
      console.error("Action failed:", e);
    } finally {
      setActionLoading(false);
    }
  };

  /** Load the Razorpay checkout SDK (test mode) once, then open the modal. */
  const loadRazorpayCheckout = (): Promise<any> => {
    return new Promise((resolve) => {
      const w = window as any;
      if (w.Razorpay) return resolve(w.Razorpay);
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.async = true;
      script.onload = () => resolve(w.Razorpay);
      script.onerror = () => resolve(null);
      document.body.appendChild(script);
    });
  };

  const handleRazorpayCheckout = async () => {
    if (!checkout || paying) return;
    setPayError(null);
    setPaying(true);
    try {
      const RazorpayCtor = await loadRazorpayCheckout();
      if (!RazorpayCtor) {
        setPayError(
          "Razorpay checkout SDK could not be loaded. Set a Razorpay TEST key (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET) and retry.",
        );
        return;
      }
      const orderId = checkout.razorpayOrderId;
      const options = {
        key: checkout.razorpayKeyId,
        amount: checkout.amountMinor,
        currency: checkout.currency,
        name: "AgentPay Merchant — Test Checkout",
        description: `AgentPay order ${orderId}`,
        order_id: orderId,
        handler: async (response: any) => {
          const verify = await fetch("/v1/agent/payments/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              razorpayOrderId: orderId,
              razorpayPaymentId: response.razorpay_payment_id,
              razorpaySignature: response.razorpay_signature,
            }),
          });
          const verifyData = await verify.json();
          if (verify.ok && verifyData.success) {
            setCheckout(null);
            fetchRequests();
          } else {
            setPayError(verifyData?.error || "Payment could not be verified.");
          }
        },
        modal: {
          ondismiss: () => {
            setPaying(false);
          },
        },
      };
      const rzp = new RazorpayCtor(options);
      rzp.on("payment.failed", (res: any) => {
        setPayError(
          res?.error?.description || "Payment failed on the Razorpay side.",
        );
      });
      rzp.open();
    } catch (e) {
      console.error("Razorpay checkout error:", e);
      setPayError("Could not open Razorpay checkout.");
    } finally {
      setPaying(false);
    }
  };

  const filteredProposals = proposals.filter((p) => {
    if (filter === "step_up") return p.status === "flagged";
    if (filter === "completed") return p.status === "completed";
    if (filter === "proposed") return p.status === "proposed";
    return true;
  });

  // == COMMENTED OUT: maxAgentTransactionAmount logic ==
  // The over-merchant-limit queue is disabled — every payment now opens a real
  // Razorpay test checkout instead of being queued for approval. Flagged
  // proposals are only ever STEP_UP for price slippage / discount approvals.
  //   const isOverLimitQueued = (p: ProposalLike) =>
  //     p.status === "flagged" &&
  //     Array.isArray(p?.policyDecision?.reasonCodes) &&
  //     p.policyDecision.reasonCodes.includes("MERCHANT_LIMIT_EXCEEDED");
  const SURGE_REASON = "SURGE_PRICING_ACTIVE";

  const isOverLimitQueued = (_p: unknown) => false;

  // Did Surge Pricing drive this proposal's STEP_UP? Reads the decision's own
  // metadata (surge_reason / surge_multiplier) in addition to the reason codes.
  const isSurgeFlagged = (p: any): boolean => {
    if (reasonCodesFor(p)?.includes(SURGE_REASON)) return true;
    const dj = (p?.policyDecision?.decisionJSON || {}) as Record<
      string,
      unknown
    >;
    return dj.surge_reason === SURGE_REASON;
  };

  const surgeMultiplierFor = (p: any): number | null => {
    const dj = (p?.policyDecision?.decisionJSON || {}) as Record<
      string,
      unknown
    >;
    const m = Number(dj.surge_multiplier);
    return Number.isFinite(m) && m > 0 ? m : null;
  };

  const reasonCodesFor = (p: any): string[] | null => {
    const codes = p?.policyDecision?.reasonCodes;
    return Array.isArray(codes) && codes.length > 0
      ? (codes as string[])
      : null;
  };

  const ReasonPills = ({ p }: { p: any }) => {
    const codes = reasonCodesFor(p);
    if (!codes || codes.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-1 pt-1.5">
        {codes.map((code) => {
          const surged = code === SURGE_REASON;
          const multiplier = surgeMultiplierFor(p);
          return (
            <span
              key={code}
              title={
                surged
                  ? `Merchant Surge Pricing re-priced this quote +${Math.round(
                      ((multiplier ?? 1.15) - 1) * 100,
                    )}% and escalated it to STEP_UP for approval.`
                  : code
              }
              className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-mono font-semibold ${
                surged
                  ? "bg-[#ffb822]/15 text-[#946400] border border-[#ffb822]/40"
                  : "bg-muted text-text-muted"
              }`}
            >
              {surged
                ? `Price surged +${Math.round(
                    ((multiplier ?? 1.15) - 1) * 100,
                  )}%`
                : code}
            </span>
          );
        })}
      </div>
    );
  };

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Agent Requests & Step-Up Monitor"
        description="Monitor incoming Cart Mandates and provide human-in-the-loop authorization for Step-Up policies."
      />

      <div className="p-6 space-y-6">
        {/* Filters and Controls */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {["all", "step_up", "proposed", "completed"].map((tab) => (
              <Button
                key={tab}
                variant={filter === tab ? "default" : "outline"}
                size="sm"
                onClick={() => setFilter(tab)}
                className="capitalize text-xs"
              >
                {tab === "step_up" ? "Flagged Step-Up" : tab}
              </Button>
            ))}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={fetchRequests}
            className="gap-1.5 text-xs"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </Button>
        </div>

        {/* Requests Table Card */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Incoming Mandates & Authoritative Quotes</CardTitle>
            <CardDescription>
              Live telemetry of agent checkout requests
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cart Mandate ID</TableHead>
                  <TableHead>Intent Mandate</TableHead>
                  <TableHead>Items / SKU</TableHead>
                  <TableHead>Total Amount</TableHead>
                  <TableHead>Status & Policy</TableHead>
                  <TableHead>Quote Expiry</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-8 text-center text-muted-foreground font-sans"
                    >
                      Loading agent proposals...
                    </TableCell>
                  </TableRow>
                ) : filteredProposals.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-8 text-center text-muted-foreground font-sans"
                    >
                      No agent requests found in this view.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredProposals.map((p) => {
                    const isExpired = new Date() > new Date(p.quote_expires_at);
                    const items = Array.isArray(p.items) ? p.items : [];

                    return (
                      <TableRow key={p.id}>
                        <TableCell className="font-mono font-semibold text-primary">
                          {p.id}
                        </TableCell>
                        <TableCell className="font-mono text-muted-foreground">
                          {p.intent_mandate_id}
                        </TableCell>
                        <TableCell className="text-foreground">
                          <span className="font-mono text-muted-foreground font-medium">
                            {items.length} item(s):
                          </span>{" "}
                          {items
                            .map((i: any) => i.title || i.variantId)
                            .join(", ")}
                        </TableCell>
                        <TableCell className="font-mono font-semibold text-foreground">
                          {formatMinorUnits(p.total_minor, p.currency)}
                        </TableCell>
                        <TableCell>
                          {p.status === "completed" ? (
                            <Badge variant="success" className="gap-1">
                              <CheckCircle2 className="w-3 h-3" /> Completed
                            </Badge>
                          ) : p.status === "flagged" && isOverLimitQueued(p) ? (
                            <Badge
                              variant="warning"
                              className="gap-1 animate-pulse"
                            >
                              <AlertTriangle className="w-3 h-3" /> Over-Limit ·
                              Awaiting Approval
                            </Badge>
                          ) : p.status === "flagged" ? (
                            <div>
                              <Badge
                                variant="warning"
                                className="gap-1 animate-pulse"
                              >
                                <AlertTriangle className="w-3 h-3" /> STEP_UP
                                Required
                              </Badge>
                              {isSurgeFlagged(p) && (
                                <div className="mt-1 inline-flex items-center gap-1 rounded bg-[#ffb822]/15 border border-[#ffb822]/40 px-1.5 py-0.5 text-[9px] font-semibold text-[#946400]">
                                  <TrendingUp className="w-3 h-3" />
                                  Price surged +15% while in flight
                                </div>
                              )}
                              <ReasonPills p={p} />
                            </div>
                          ) : isExpired ? (
                            <Badge variant="secondary" className="gap-1">
                              <Clock className="w-3 h-3" /> Expired
                            </Badge>
                          ) : (
                            <Badge variant="cyan" className="gap-1">
                              <CheckCircle2 className="w-3 h-3" /> Proposed
                              Quote
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-muted-foreground text-[10px]">
                          {new Date(p.quote_expires_at).toLocaleTimeString()}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setSelectedProposal(p);
                              setIsDetailOpen(true);
                            }}
                            className="gap-1 text-xs"
                          >
                            <Eye className="w-3 h-3" />
                            <span>Inspect</span>
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {/* Proposal Detail & Step-Up Approval Modal */}
      <Dialog open={isDetailOpen} onOpenChange={setIsDetailOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          {selectedProposal && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2 mb-1">
                  <ShieldCheck className="w-5 h-5 text-primary" />
                  <DialogTitle>Cart Mandate & Policy Inspection</DialogTitle>
                </div>
                <DialogDescription className="font-mono">
                  Mandate ID: {selectedProposal.id}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 text-xs">
                {/* Summary Cards */}
                <div className="grid grid-cols-3 gap-3">
                  <Card className="p-3">
                    <span className="text-muted-foreground text-[10px]">
                      Total Minor
                    </span>
                    <div className="text-sm font-bold text-foreground font-mono mt-1">
                      {formatMinorUnits(
                        selectedProposal.total_minor,
                        selectedProposal.currency,
                      )}
                    </div>
                  </Card>

                  <Card className="p-3">
                    <span className="text-muted-foreground text-[10px]">
                      Status
                    </span>
                    <div className="text-sm font-bold text-[#946400] font-mono mt-1 capitalize">
                      {selectedProposal.status}
                    </div>
                    {selectedProposal.policyDecision?.decision && (
                      <div className="mt-0.5 text-[10px] font-mono text-text-muted">
                        {selectedProposal.policyDecision.decision}
                      </div>
                    )}
                    <ReasonPills p={selectedProposal} />
                  </Card>

                  <Card className="p-3">
                    <span className="text-muted-foreground text-[10px]">
                      Proof Hash
                    </span>
                    <div className="text-[10px] text-primary font-mono truncate mt-1">
                      {selectedProposal.content_hash}
                    </div>
                  </Card>
                </div>

                {/* Items in Cart */}
                <Card className="p-3">
                  <span className="text-muted-foreground text-[10px] uppercase font-semibold">
                    Cart Line Items
                  </span>
                  <div className="mt-2 space-y-2">
                    {(selectedProposal.items || []).map(
                      (item: any, idx: number) => (
                        <div
                          key={idx}
                          className="flex items-center justify-between text-xs py-1 border-b border-border last:border-none"
                        >
                          <div>
                            <span className="font-medium text-foreground">
                              {item.title}
                            </span>
                            <div className="text-[10px] font-mono text-muted-foreground">
                              {item.variantId} × {item.quantity}
                            </div>
                          </div>
                          <span className="font-mono text-foreground font-medium">
                            {formatMinorUnits(
                              item.lineAmountMinor,
                              selectedProposal.currency,
                            )}
                          </span>
                        </div>
                      ),
                    )}
                  </div>
                </Card>

                {/* JSON Payload Viewer */}
                <div className="p-3 rounded-lg bg-muted border border-border">
                  <div className="flex items-center justify-between text-[11px] text-text-muted mb-1">
                    <span className="font-mono flex items-center gap-1">
                      <Code2 className="w-3.5 h-3.5 text-primary" />
                      Authoritative Cart Mandate JSON (v1)
                    </span>
                    <span className="text-[10px] text-[#00875c] flex items-center gap-1">
                      <Lock className="w-3 h-3" /> Signed devProof
                    </span>
                  </div>
                  <pre className="p-2.5 rounded-md bg-card border border-border text-text-secondary font-mono text-[10px] max-h-40 overflow-y-auto">
                    {JSON.stringify(selectedProposal, null, 2)}
                  </pre>
                </div>

                {/* Step-Up Actions if Flagged */}
                {selectedProposal.status === "flagged" && (
                  <div className="p-4 rounded-xl bg-[#ffb822]/[0.12] border border-[#ffb822]/35 flex items-center justify-between">
                    <div>
                      <div className="font-semibold text-[#946400]">
                        {isSurgeFlagged(selectedProposal)
                          ? "Surge Pricing Step-Up — Approve at the surged price"
                          : isOverLimitQueued(selectedProposal)
                            ? "Over-Limit Transaction — Approve to Settle"
                            : "Step-Up Approval Required"}
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        {isSurgeFlagged(selectedProposal)
                          ? "Surge Pricing is active — this in-flight quote was re-priced +15% and escalated to STEP_UP (SURGE_PRICING_ACTIVE). Approving authorizes a Razorpay test checkout at the surged total; rejecting cancels it."
                          : isOverLimitQueued(selectedProposal)
                            ? "This amount exceeds your configured transaction limit. Approving will surface a Razorpay test checkout to complete the payment; rejecting will cancel the payment intent."
                            : "This purchase flagged policy rules (slippage or high amount). Approving authorizes a Razorpay test checkout; declining cancels it."}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() =>
                          handleApprove(selectedProposal.id, "reject")
                        }
                        disabled={actionLoading}
                        className="gap-1"
                      >
                        <X className="w-3.5 h-3.5" />
                        <span>Reject</span>
                      </Button>
                      <Button
                        size="sm"
                        onClick={() =>
                          handleApprove(selectedProposal.id, "approve")
                        }
                        disabled={actionLoading}
                        className="gap-1 bg-[#00b874] hover:bg-[#00a568] text-white"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>
                          {isOverLimitQueued(selectedProposal)
                            ? "Approve & Checkout"
                            : "Approve Step-Up"}
                        </span>
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Razorpay test checkout to complete an approved order */}
      <Dialog open={!!checkout} onOpenChange={(o) => !o && setCheckout(null)}>
        <DialogContent className="max-w-md border-primary/40">
          <DialogHeader>
            <div className="flex items-center gap-2 mb-1">
              <PlugZap className="w-5 h-5 text-primary" />
              <DialogTitle>Complete Razorpay test payment</DialogTitle>
            </div>
            <DialogDescription className="text-xs text-text-secondary">
              Order approved. Complete a real test-mode payment to mark it paid
              (use e.g.`4111 1111 1111 1111` with any future expiry/CVV).
            </DialogDescription>
          </DialogHeader>

          {checkout && (
            <div className="space-y-3 text-sm">
              <div className="rounded-lg border border-border bg-muted px-3 py-2.5 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-secondary">
                    {checkout.quantity} unit
                    {checkout.quantity > 1 ? "s" : ""}
                  </span>
                  <span className="font-semibold">
                    {formatMinorUnits(
                      checkout.grandTotalMinor,
                      checkout.currency,
                    )}
                  </span>
                </div>
                <p className="text-[11px] font-mono text-text-muted break-all">
                  Order: {checkout.razorpayOrderId}
                </p>
              </div>

              {payError && (
                <p className="text-[11px] text-red-600 bg-red-50 border border-red-200 rounded-md px-2 py-1.5">
                  {payError}
                </p>
              )}

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={() => setCheckout(null)}
                  disabled={paying}
                >
                  Later
                </Button>
                <Button
                  size="sm"
                  className="flex-1 gap-1"
                  onClick={handleRazorpayCheckout}
                  disabled={paying}
                >
                  {paying ? (
                    <>
                      <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Opening…
                    </>
                  ) : (
                    <>
                      <PlugZap className="w-3.5 h-3.5" />
                      Pay{" "}
                      {formatMinorUnits(
                        checkout.amountMinor,
                        checkout.currency,
                      )}{" "}
                      via Razorpay Test
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
