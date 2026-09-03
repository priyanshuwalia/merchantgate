"use client";

import {
  Bot,
  Boxes,
  Check,
  CircleHelp,
  FlaskConical,
  Loader2,
  Percent,
  Send,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMinorUnits } from "@/lib/utils";

interface MerchantAgentRules {
  enabled: boolean;
  agentName: string;
  bulkDiscountEnabled: boolean;
  bulkMinQuantity: number;
  bulkDiscountBps: number;
  maxDiscountBps: number;
  minimumMarginBps: number;
  requireApprovalAboveDiscountBps: number;
  negotiableCategories: string[];
  inventoryInstruction: string;
}

interface ChatMessage {
  id: string;
  role: "merchant" | "agent";
  content: string;
  appliedFields?: string[];
  missingFields?: string[];
}

interface SandboxTurn {
  id: string;
  actor: "buyer_agent" | "merchant_agent";
  message: string;
}

const QUICK_PROMPTS = [
  "Give 7% off when AI buyers order at least 5 units",
  "Never discount more than 12%, ask my approval above 10%",
  "Only negotiate on electronics and audio",
  "Pause the merchant agent entirely",
];

export default function InventoryAgentPage() {
  const [rules, setRules] = useState<MerchantAgentRules | null>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "intro",
      role: "agent",
      content:
        "Hi! I configure your negotiating agent. Tell me your inventory terms in plain English — bulk discounts, quantity thresholds, category limits, approval rules — and I'll apply them. If I'm missing a detail, I'll ask.",
    },
  ]);
  const [sending, setSending] = useState(false);

  // Rule editor state
  const [editBulkPct, setEditBulkPct] = useState("7");
  const [editMinQty, setEditMinQty] = useState("3");
  const [editMaxPct, setEditMaxPct] = useState("12");
  const [editApprovalPct, setEditApprovalPct] = useState("10");
  const [savingRules, setSavingRules] = useState(false);

  // Negotiation sandbox
  const [products, setProducts] = useState<
    Array<{
      id: string;
      title: string;
      variant_id: string;
      base_price_minor: number;
    }>
  >([]);
  const [productsLoading, setProductsLoading] = useState(true);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [sandboxVariant, setSandboxVariant] = useState("");
  const [sandboxQty, setSandboxQty] = useState(5);
  const [sandboxRunning, setSandboxRunning] = useState(false);
  const [sandboxTranscript, setSandboxTranscript] = useState<SandboxTurn[]>([]);
  const [sandboxSummary, setSandboxSummary] = useState<string>("");

  const chatBottomRef = useRef<HTMLDivElement>(null);

  const hydrateRules = useCallback((r: MerchantAgentRules) => {
    setRules(r);
    setEditBulkPct(String(Math.round(r.bulkDiscountBps / 100)));
    setEditMinQty(String(r.bulkMinQuantity));
    setEditMaxPct(String(Math.round(r.maxDiscountBps / 100)));
    setEditApprovalPct(
      String(Math.round(r.requireApprovalAboveDiscountBps / 100)),
    );
  }, []);

  useEffect(() => {
    fetch("/api/merchant/settings")
      .then((res) => res.json())
      .then((data) => {
        if (data.config?.merchantAgentRules) {
          hydrateRules(data.config.merchantAgentRules);
        }
      })
      .catch(() => undefined);

    fetch("/api/merchant/products")
      .then((res) => {
        if (!res.ok) throw new Error(`Products request failed: ${res.status}`);
        return res.json();
      })
      .then((list) => {
        if (Array.isArray(list)) {
          setProducts(list);
          if (list.length > 0) setSandboxVariant(list[0].variant_id);
        }
        setProductsError(null);
      })
      .catch((e) => setProductsError(String(e?.message ?? e)))
      .finally(() => setProductsLoading(false));
  }, [hydrateRules]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-scroll when a new message arrives
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = async (textOverride?: string) => {
    const text = (textOverride || input).trim();
    if (!text || sending) return;

    const historyPayload = messages.slice(-6).map((m) => ({
      role: m.role === "merchant" ? "user" : "assistant",
      content: m.content,
    }));

    setMessages((prev) => [
      ...prev,
      { id: `m_${Date.now()}`, role: "merchant", content: text },
    ]);
    setInput("");
    setSending(true);

    try {
      const res = await fetch("/api/merchant/agent-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history: historyPayload }),
      });
      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        {
          id: `a_${Date.now()}`,
          role: "agent",
          content: data.reply || "Done.",
          appliedFields: data.appliedFields || [],
          missingFields: data.missingFields || [],
        },
      ]);
      if (data.rules) hydrateRules(data.rules);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: `e_${Date.now()}`,
          role: "agent",
          content: "Something went wrong applying those rules. Please retry.",
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  const saveRulesDirectly = async () => {
    setSavingRules(true);
    try {
      const res = await fetch("/api/merchant/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merchantAgentRules: {
            ...(rules || {}),
            enabled: true,
            bulkDiscountEnabled: true,
            bulkDiscountBps: Math.round(Number(editBulkPct) * 100),
            bulkMinQuantity: Math.max(1, Number(editMinQty) || 1),
            maxDiscountBps: Math.round(Number(editMaxPct) * 100),
            requireApprovalAboveDiscountBps: Math.round(
              Number(editApprovalPct) * 100,
            ),
          },
        }),
      });
      const data = await res.json();
      if (data.merchant?.config?.merchantAgentRules) {
        hydrateRules(data.merchant.config.merchantAgentRules);
        setMessages((prev) => [
          ...prev,
          {
            id: `s_${Date.now()}`,
            role: "agent",
            content: "Rule panel changes saved directly.",
          },
        ]);
      }
    } finally {
      setSavingRules(false);
    }
  };

  const runSandbox = async () => {
    if (!sandboxVariant || sandboxRunning) return;
    setSandboxRunning(true);
    setSandboxTranscript([]);
    setSandboxSummary("");

    let turnCounter = 0;
    const turn = (
      actor: "buyer_agent" | "merchant_agent",
      message: string,
    ): SandboxTurn => ({
      id: `t_${turnCounter++}`,
      actor,
      message,
    });

    try {
      // Round 1: buyer opens
      const openRes = await fetch("/v1/agent/negotiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "open",
          items: [{ variantId: sandboxVariant, quantity: sandboxQty }],
          buyerMessage: `I want ${sandboxQty} units — what's your best bulk price?`,
        }),
      });
      const open = await openRes.json();
      if (!open.success) {
        setSandboxSummary(open.error || "Negotiation failed to start.");
        return;
      }
      setSandboxTranscript([
        turn(
          "buyer_agent",
          `I want ${sandboxQty} units — what's your best bulk price?`,
        ),
        turn("merchant_agent", open.merchantMessage),
      ]);

      if (open.outcome === "REJECTED") {
        setSandboxSummary(`No deal possible: ${open.reasonCodes?.join(", ")}`);
        return;
      }

      // Round 2: buyer haggles harder (+4%)
      const targetBps = Math.min(9900, open.discountBps + 400);
      const haggleRes = await fetch("/v1/agent/negotiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "respond",
          sessionId: open.sessionId,
          targetDiscountBps: targetBps,
          buyerMessage: `Can you do ${(targetBps / 100).toFixed(1)}%? My mandate works better at that rate.`,
        }),
      });
      const haggle = await haggleRes.json();
      setSandboxTranscript((prev) => [
        ...prev,
        turn(
          "buyer_agent",
          `Can you do ${(targetBps / 100).toFixed(1)}%? My mandate works better at that rate.`,
        ),
        turn("merchant_agent", haggle.merchantMessage),
      ]);

      if (haggle.outcome === "REJECTED") {
        setSandboxSummary(
          `No deal: ${haggle.merchantMessage || "merchant rejected the counter."}`,
        );
        return;
      }

      // Final round: accept standing offer (skip if merchant already agreed)
      if (haggle.outcome !== "AGREED") {
        const acceptRes = await fetch("/v1/agent/negotiate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "respond",
            sessionId: open.sessionId,
            acceptCurrentOffer: true,
            buyerMessage: "Deal — locking it in.",
          }),
        });
        const accepted = await acceptRes.json();

        const finalOutcome =
          accepted.outcome === "AGREED"
            ? `Agreed at ${(accepted.discountBps / 100).toFixed(1)}% off — saving ${formatMinorUnits(accepted.lineSavingsMinor || 0)} on the line.${accepted.requiresMerchantApproval ? " Note: exceeds approval threshold → checkout will require human STEP_UP." : ""}`
            : `Ended without agreement (${accepted.error || accepted.outcome}).`;
        if (accepted.outcome === "AGREED") {
          setSandboxTranscript((prev) => [
            ...prev,
            turn("buyer_agent", "Deal — locking it in."),
            turn("merchant_agent", accepted.merchantMessage),
          ]);
        }
        setSandboxSummary(finalOutcome);
      } else {
        setSandboxSummary(
          `Merchant met your target at ${(haggle.discountBps / 100).toFixed(1)}% off — deal locked without a third round.`,
        );
      }
    } catch (err) {
      setSandboxSummary(String(err));
    } finally {
      setSandboxRunning(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Inventory Agent Console"
        description="Chat with your negotiating agent to set inventory rules — then watch it bargain with AI buyers."
      />

      <div className="p-6 grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-5 items-start">
        {/* Chat Column */}
        <Card className="flex flex-col h-[calc(100vh-190px)] min-h-[520px]">
          <CardHeader className="pb-3 border-b border-border">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-base">
                <Bot className="w-4 h-4 text-primary" />
                Inventory Rule Assistant
              </CardTitle>
              <Badge
                variant={rules?.enabled === false ? "warning" : "success"}
                className="gap-1 text-[10px]"
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${rules?.enabled === false ? "bg-[#ffb822]" : "bg-[#00b874] animate-pulse"}`}
                />
                {rules?.enabled === false ? "Agent Paused" : "Agent Active"}
              </Badge>
            </div>
            <CardDescription>
              Natural language in, enforceable negotiation rules out.
            </CardDescription>
          </CardHeader>

          <CardContent className="flex-1 flex flex-col gap-3 pt-4 overflow-hidden">
            <div className="flex gap-2 flex-wrap">
              {QUICK_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => send(p)}
                  disabled={sending}
                  className="text-[11px] px-2.5 py-1 rounded-full border border-border bg-muted hover:border-primary/40 hover:text-primary transition-colors text-text-muted"
                >
                  {p}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 pr-1">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={
                    m.role === "merchant"
                      ? "ml-auto max-w-[80%]"
                      : "mr-auto max-w-[85%]"
                  }
                >
                  <div
                    className={
                      m.role === "merchant"
                        ? "rounded-xl rounded-br-sm bg-primary px-3.5 py-2.5 text-xs leading-relaxed text-white shadow-sm"
                        : "rounded-xl rounded-bl-sm bg-card border border-border px-3.5 py-2.5 text-xs leading-relaxed text-foreground whitespace-pre-line shadow-sm"
                    }
                  >
                    {m.content}
                  </div>
                  {Boolean(m.appliedFields?.length) && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {m.appliedFields?.map((f) => (
                        <Badge
                          key={f}
                          variant="success"
                          className="text-[9px] gap-0.5"
                        >
                          <Check className="w-2.5 h-2.5" /> {f}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {Boolean(m.missingFields?.length) && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {m.missingFields?.map((f) => (
                        <Badge
                          key={f}
                          variant="warning"
                          className="text-[9px] gap-0.5"
                        >
                          <CircleHelp className="w-2.5 h-2.5" /> needs: {f}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {sending && (
                <div className="flex items-center gap-2 text-[11px] text-text-muted">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                  Applying your instructions...
                </div>
              )}
              <div ref={chatBottomRef} />
            </div>

            <div className="flex gap-2 pt-2 border-t border-border">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()}
                placeholder='e.g. "8% off for orders of 10+ keyboards, approval above 12%"'
                className="text-xs"
              />
              <Button
                onClick={() => send()}
                disabled={sending || !input.trim()}
                size="sm"
                className="gap-1.5 shrink-0"
              >
                <Send className="w-3.5 h-3.5" />
                Apply
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Right Column */}
        <div className="space-y-5">
          {/* Live Rules */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Percent className="w-4 h-4 text-[#946400]" />
                Active Negotiation Rules
              </CardTitle>
              <CardDescription>
                Enforced deterministically at quote time.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1">
                  <span className="text-xs font-medium text-text-muted">
                    Bulk discount %
                  </span>
                  <Input
                    value={editBulkPct}
                    onChange={(e) => setEditBulkPct(e.target.value)}
                    type="number"
                    className="h-8 font-mono"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-text-muted">
                    Minimum qty
                  </span>
                  <Input
                    value={editMinQty}
                    onChange={(e) => setEditMinQty(e.target.value)}
                    type="number"
                    className="h-8 font-mono"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-text-muted">
                    Max ceiling %
                  </span>
                  <Input
                    value={editMaxPct}
                    onChange={(e) => setEditMaxPct(e.target.value)}
                    type="number"
                    className="h-8 font-mono"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-text-muted">
                    Approval above %
                  </span>
                  <Input
                    value={editApprovalPct}
                    onChange={(e) => setEditApprovalPct(e.target.value)}
                    type="number"
                    className="h-8 font-mono"
                  />
                </label>
              </div>
              <Button
                onClick={saveRulesDirectly}
                disabled={savingRules}
                size="sm"
                variant="outline"
                className="w-full text-xs"
              >
                {savingRules ? "Saving..." : "Save Panel Values"}
              </Button>
              <div className="pt-2 border-t border-border space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-text-muted flex items-center gap-1.5">
                    <Boxes className="w-3.5 h-3.5" /> Categories
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(rules?.negotiableCategories || []).map((c) => (
                    <Badge key={c} variant="outline" className="text-[10px]">
                      {c}
                    </Badge>
                  ))}
                  {!rules?.negotiableCategories?.length && (
                    <span className="text-[11px] text-text-muted">
                      All categories
                    </span>
                  )}
                </div>
                {rules?.inventoryInstruction && (
                  <p className="text-[11px] text-text-muted italic border-l-2 border-border pl-2 leading-relaxed">
                    "{rules.inventoryInstruction}"
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Negotiation Sandbox */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <FlaskConical className="w-4 h-4 text-[#00875c]" />
                Test the Agent
              </CardTitle>
              <CardDescription>
                Simulated buyer haggles against your live rules.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              {productsError ? (
                <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/25 bg-destructive/[0.05] px-2 py-1.5 text-[11px] text-destructive">
                  <span>Could not load products.</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-[11px]"
                    onClick={() => {
                      setProductsLoading(true);
                      setProductsError(null);
                      fetch("/api/merchant/products")
                        .then((res) => res.json())
                        .then((list) => {
                          if (Array.isArray(list)) setProducts(list);
                          setProductsError(null);
                        })
                        .catch((e) => setProductsError(String(e?.message ?? e)))
                        .finally(() => setProductsLoading(false));
                    }}
                  >
                    Retry
                  </Button>
                </div>
              ) : productsLoading ? (
                <Skeleton className="h-8 w-full" />
              ) : null}
              <div className="grid grid-cols-[1fr_80px] gap-2">
                <select
                  value={sandboxVariant}
                  onChange={(e) => setSandboxVariant(e.target.value)}
                  className="h-8 rounded-md bg-white border border-input px-2 text-xs text-foreground"
                  disabled={productsLoading}
                >
                  {productsLoading ? (
                    <option value="">Loading products…</option>
                  ) : products.length === 0 ? (
                    <option value="">No products available</option>
                  ) : (
                    products.map((p) => (
                      <option key={p.id} value={p.variant_id}>
                        {p.title.slice(0, 34)}
                      </option>
                    ))
                  )}
                </select>
                <Input
                  type="number"
                  min={1}
                  value={sandboxQty}
                  onChange={(e) =>
                    setSandboxQty(Math.max(1, Number(e.target.value) || 1))
                  }
                  className="h-8 font-mono"
                  title="Quantity"
                />
              </div>
              <Button
                onClick={runSandbox}
                disabled={sandboxRunning || !sandboxVariant}
                size="sm"
                className="w-full gap-1.5 text-xs"
              >
                {sandboxRunning ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <FlaskConical className="w-3.5 h-3.5" />
                )}
                {sandboxRunning ? "Negotiating..." : "Run 3-Round Negotiation"}
              </Button>

              {sandboxTranscript.length > 0 && (
                <div className="rounded-lg border border-border bg-muted p-3 space-y-2">
                  {sandboxTranscript.map((t) => (
                    <div
                      key={t.id}
                      className={
                        t.actor === "buyer_agent"
                          ? "mr-auto max-w-[92%]"
                          : "ml-auto max-w-[92%]"
                      }
                    >
                      <div
                        className={
                          t.actor === "buyer_agent"
                            ? "rounded-lg bg-accent border border-primary/25 px-2.5 py-1.5 text-[11px] leading-relaxed text-primary"
                            : "rounded-lg bg-[#00b874]/[0.08] border border-[#00b874]/25 px-2.5 py-1.5 text-[11px] leading-relaxed text-[#00875c]"
                        }
                      >
                        {t.message}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {sandboxSummary && (
                <div className="flex items-start gap-1.5 rounded-lg bg-muted border border-border p-2.5 text-[11px] text-text-secondary">
                  <ShieldAlert className="w-3.5 h-3.5 text-[#946400] shrink-0 mt-0.5" />
                  {sandboxSummary}
                </div>
              )}
            </CardContent>
          </Card>

          <p className="text-[11px] text-text-muted flex items-start gap-1.5 px-1">
            <Sparkles className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
            Rules are applied by a deterministic engine during checkout — LLM
            suggestions can never exceed your configured ceilings.
          </p>
        </div>
      </div>
    </div>
  );
}
