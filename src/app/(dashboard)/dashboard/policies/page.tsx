"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Play,
  Save,
  Sparkles,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Header } from "@/components/dashboard/Header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  evaluatePolicy,
  type PolicyEvaluationResult,
} from "@/lib/policy/engine";

export default function PoliciesPage() {
  const [_loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);

  // Policy Settings
  // == COMMENTED OUT: maxAgentTransactionAmount logic ==
  // const [maxAmountInr, setMaxAmountInr] = useState(5000);
  const [slippageBps, setSlippageBps] = useState(200);
  // == COMMENTED OUT: maxAgentTransactionAmount logic ==
  // const [agentRequiresApproval, setAgentRequiresApproval] = useState(true);
  const [autoProcessOrders, setAutoProcessOrders] = useState(false);

  // Sandbox Tester State
  const [testAmountInr, setTestAmountInr] = useState(3499);
  const [testDiscoveryInr, setTestDiscoveryInr] = useState(3000);
  const [testCategory, setTestCategory] = useState("electronics");
  const [testResult, setTestResult] = useState<PolicyEvaluationResult | null>(
    null,
  );

  useEffect(() => {
    async function loadSettings() {
      try {
        const res = await fetch("/api/merchant/settings");
        const data = await res.json();
        if (data.config) {
          setSlippageBps(data.config.priceSlippageToleranceBps ?? 200);
          // setAgentRequiresApproval(data.config.agentRequiresApproval ?? true);
          setAutoProcessOrders(data.config.autoProcessAgentOrders ?? false);
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    loadSettings();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSaved(false);
      const res = await fetch("/api/merchant/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // maxAgentTransactionAmount: Math.round(maxAmountInr * 100),
          priceSlippageToleranceBps: Number(slippageBps),
          // agentRequiresApproval,
          autoProcessAgentOrders: autoProcessOrders,
        }),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 6000);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const runPolicyTest = () => {
    const mockMandate: import("@/lib/policy/engine").IntentMandate = {
      type: "intent_mandate.v1",
      id: "int_test_sandbox",
      revision: 1,
      principal: { userId: "user_test" },
      delegate: { agentId: "agent_test", agentVersion: "1.0.0" },
      constraints: {
        currency: "INR",
        // Sandbox test ceiling (₹1,000) — was `maxAmountInr * 100` when the
        // max-agent-transaction-amount field was still configurable.
        maxTransactionAmountMinor: 100000,
        allowedCategories: ["electronics", "audio", "accessories"],
        maxPriceSlippageBps: slippageBps,
      },
      validity: {
        notBefore: new Date(Date.now() - 3600000).toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
    };

    const mockCart: import("@/lib/policy/engine").CartMandateQuote = {
      merchantId: "mch_nimbus_gear_001",
      items: [
        {
          productId: "prod_test",
          variantId: "test_sku",
          category: testCategory,
          title: "Test Item",
          quantity: 1,
          unitAmountMinor: Math.round(testAmountInr * 100),
          lineAmountMinor: Math.round(testAmountInr * 100),
          discoveryPriceMinor: Math.round(testDiscoveryInr * 100),
          returnable: true,
        },
      ],
      totals: {
        subtotalMinor: Math.round(testAmountInr * 100),
        discountMinor: 0,
        shippingMinor: 0,
        taxMinor: 0,
        grandTotalMinor: Math.round(testAmountInr * 100),
        currency: "INR",
      },
      fulfillment: { country: "IND" },
      terms: { refundable: true, returnWindowDays: 7 },
    };

    const result = evaluatePolicy(mockMandate, mockCart, {
      // maxAgentTransactionAmount: maxAmountInr * 100,
      priceSlippageToleranceBps: slippageBps,
      // agentRequiresApproval,
      autoProcessAgentOrders: autoProcessOrders,
    });

    setTestResult(result);
  };

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Policy & Limits Configuration"
        description="Define deterministic bounding boxes, spending limits, slippage tolerances, and approval rules."
      />

      <div className="p-6 space-y-6 max-w-6xl">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Main Form Card */}
          <div className="lg:col-span-7 space-y-6">
            <Card className="p-6">
              <form onSubmit={handleSave} className="space-y-6 text-xs">
                <div className="flex items-center justify-between border-b border-border pb-4">
                  <div>
                    <CardTitle>Merchant Spending Policies</CardTitle>
                    <CardDescription>
                      Configure gate parameters applied to all AI agent
                      transactions.
                    </CardDescription>
                  </div>
                  {saved && (
                    <Badge variant="success" className="gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Saved!
                    </Badge>
                  )}
                </div>

                {/* == COMMENTED OUT: maxAgentTransactionAmount logic ==
                Setting 1 (Max Agent Transaction Amount) is disabled — every
                payment now goes through a real Razorpay test checkout, so the
                merchant's configured ceiling no longer gates orders.
                <div>
                  ...
                </div>
                */}

                {/* Setting 2: Price Slippage Tolerance */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label
                      htmlFor="slippage-bps"
                      className="text-foreground font-medium"
                    >
                      Price Slippage Tolerance (Basis Points)
                    </label>
                    <span className="text-primary font-mono font-semibold">
                      {slippageBps} bps ({(slippageBps / 100).toFixed(2)}%)
                    </span>
                  </div>
                  <p className="text-muted-foreground mb-2 text-[11px]">
                    If product price increases between discovery and cart
                    checkout by more than this tolerance, the request triggers a
                    STEP_UP requirement.
                  </p>
                  <input
                    id="slippage-bps"
                    type="range"
                    min="0"
                    max="1000"
                    step="25"
                    value={slippageBps}
                    onChange={(e) => setSlippageBps(Number(e.target.value))}
                    className="w-full accent-[#0066ff] cursor-pointer"
                  />
                </div>

                {/* Toggles */}
                <div className="space-y-4 pt-2 border-t border-border">
                  {/* == COMMENTED OUT: maxAgentTransactionAmount logic ==
                  Require-Merchant-Approval for high-value orders is disabled —
                  every payment opens the Razorpay test checkout directly.
                  <label className="flex items-start gap-3 cursor-pointer">
                    ...
                  </label>
                  */}

                  <label
                    htmlFor="auto-process-orders"
                    className="flex items-start gap-3 cursor-pointer"
                  >
                    <input
                      id="auto-process-orders"
                      type="checkbox"
                      checked={autoProcessOrders}
                      onChange={(e) => setAutoProcessOrders(e.target.checked)}
                      className="mt-0.5 rounded border-input text-[#0066ff] focus:ring-[#0066ff]/20"
                    />
                    <div>
                      <div className="font-medium text-foreground">
                        Auto-Process Verified Agent Orders
                      </div>
                      <p className="text-muted-foreground text-[11px]">
                        Allows fully automated autonomous checkout without
                        human-in-the-loop when all mandate criteria pass.
                      </p>
                    </div>
                  </label>
                </div>

                <div className="pt-4 border-t border-border flex justify-end">
                  <Button type="submit" size="sm" className="gap-1.5">
                    <Save className="w-3.5 h-3.5" />
                    <span>Save Policy Rules</span>
                  </Button>
                </div>
              </form>
            </Card>
          </div>

          {/* Live Policy Simulator Sandbox */}
          <div className="lg:col-span-5 space-y-4">
            <Card className="p-6 space-y-4 text-xs">
              <div className="flex items-center gap-2 border-b border-border pb-3">
                <Sparkles className="w-4 h-4 text-primary" />
                <CardTitle>Live Policy Gate Evaluator</CardTitle>
              </div>

              <CardDescription>
                Test how current policy parameters react to simulated agent
                mandate requests.
              </CardDescription>

              <div className="space-y-3">
                <div>
                  <label
                    htmlFor="test-quoted-price"
                    className="block text-foreground mb-1"
                  >
                    Quoted Cart Price (₹)
                  </label>
                  <Input
                    id="test-quoted-price"
                    type="number"
                    value={testAmountInr}
                    onChange={(e) => setTestAmountInr(Number(e.target.value))}
                    className="font-mono"
                  />
                </div>

                <div>
                  <label
                    htmlFor="test-discovery-price"
                    className="block text-foreground mb-1"
                  >
                    Agent Discovery Price (₹)
                  </label>
                  <Input
                    id="test-discovery-price"
                    type="number"
                    value={testDiscoveryInr}
                    onChange={(e) =>
                      setTestDiscoveryInr(Number(e.target.value))
                    }
                    className="font-mono"
                  />
                </div>

                <div>
                  <label
                    htmlFor="test-category"
                    className="block text-foreground mb-1"
                  >
                    Item Category
                  </label>
                  <select
                    id="test-category"
                    value={testCategory}
                    onChange={(e) => setTestCategory(e.target.value)}
                    className="h-9 w-full px-3 rounded-lg bg-white border border-input text-xs text-foreground focus:outline-none focus:border-primary focus:shadow-[0_0_0_3px_rgba(0,102,255,0.1)]"
                  >
                    <option value="electronics">electronics (Allowed)</option>
                    <option value="audio">audio (Allowed)</option>
                    <option value="restricted_goods">
                      restricted_goods (Disallowed)
                    </option>
                  </select>
                </div>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={runPolicyTest}
                  className="w-full gap-1.5"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>Evaluate Gate Decision</span>
                </Button>
              </div>

              {testResult && (
                <div
                  className={`p-4 rounded-xl border mt-4 space-y-2 animate-in fade-in ${
                    testResult.decision === "ALLOW"
                      ? "bg-[#00b874]/[0.08] border-[#00b874]/25 text-[#00875c]"
                      : testResult.decision === "STEP_UP"
                        ? "bg-[#ffb822]/[0.12] border-[#ffb822]/35 text-[#946400]"
                        : "bg-destructive/[0.06] border-destructive/25 text-destructive"
                  }`}
                >
                  <div className="flex items-center justify-between font-bold text-sm font-mono">
                    <span>Decision: [{testResult.decision}]</span>
                    {testResult.decision === "ALLOW" ? (
                      <CheckCircle2 className="w-4 h-4 text-[#00875c]" />
                    ) : testResult.decision === "STEP_UP" ? (
                      <AlertTriangle className="w-4 h-4 text-[#946400]" />
                    ) : (
                      <XCircle className="w-4 h-4 text-destructive" />
                    )}
                  </div>
                  <p className="text-[11px] font-sans text-text-secondary">
                    {testResult.explanation}
                  </p>
                  <div className="text-[10px] font-mono text-muted-foreground">
                    Reason Codes: {testResult.reasonCodes.join(", ")}
                  </div>
                </div>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
