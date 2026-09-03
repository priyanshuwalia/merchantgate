"use client";

import {
  AlertTriangle,
  Bot,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Handshake,
  Key,
  ListTree,
  MessageSquare,
  MessagesSquare,
  PackagePlus,
  Play,
  PlugZap,
  Send,
  Sparkles,
  Tag,
  X,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Header } from "@/components/dashboard/Header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { subscribeApprovalCheckout } from "@/lib/broadcast/agentpay-bus";
import type {
  CustomSimulationConfig,
  SettlementInfo,
  SimulationCommunication,
  SimulationResult,
} from "@/lib/simulation/runner";
import { PRESET_SCENARIOS } from "@/lib/simulation/scenarios";
import { cn, formatMinorUnits } from "@/lib/utils";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface ConversationLine extends SimulationCommunication {
  id: string;
  stepLabel: string;
}

interface RazorpayPaymentResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface RazorpayCheckoutInstance {
  open: () => void;
  on: (event: string, handler: (response: unknown) => void) => void;
}

type RazorpayCtor = new (
  options: Record<string, unknown>,
) => RazorpayCheckoutInstance;

interface StepUpInfo {
  summary: string;
  cartMandateId?: string;
  surged?: boolean;
}

interface TransactionToastInfo {
  id: number;
  title: string;
  decision: "ALLOW" | "STEP_UP" | "DENY" | "ERROR";
  quantity: number;
  grandTotalMinor: number;
  perUnitMinor: number;
  bargain?: {
    discountBps: number;
    savingsMinor: number;
    outcome: string;
  };
}

/** Phrases that count as the user giving the buyer agent go-ahead. NOTE:
 * bare "buy ..." is deliberately NOT a confirmation — a purchase instruction
 * like "Buy 5 keyboards under 20k" must plan first and wait for "go ahead". */
const CONFIRMATION_RE =
  /^\s*(yes|yeah|yep|yup|ya|sure|ok|okay|k|go|go ahead|proceed|confirmed?|confirm|buy (?:it|now)|do it|run it|execute|make it happen|sounds good|looks good|affirmative|please (?:do|proceed|go ahead)|let'?s (?:do it|go)|fine)\b/i;

function extractConversation(result: SimulationResult): ConversationLine[] {
  const lines: ConversationLine[] = [];
  for (const evt of result.events) {
    for (const comm of evt.communications || []) {
      lines.push({
        ...comm,
        id: `${evt.stepIndex}-${lines.length}`,
        stepLabel: evt.description,
      });
    }
  }
  return lines;
}

export default function SimulatorPage() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<Record<number, boolean>>(
    {},
  );
  const [resultView, setResultView] = useState<"conversation" | "trace">(
    "conversation",
  );

  // Config tabs: chat planner or quick scenarios
  const [configTab, setConfigTab] = useState<string>("chat");

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "m0",
      role: "assistant",
      content:
        "Tell me what to buy — e.g. “Buy 5 mechanical keyboards for the office under ₹20,000”. I'll parse your request into a verifiable mandate and ask if anything's missing. Once the mandate is ready, just say “go ahead” (or yes / proceed / buy it) and I'll execute the run automatically.",
    },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [isChatSending, setIsChatSending] = useState(false);
  const [openRouterApiKey, setOpenRouterApiKey] = useState("");
  const [buyerLlmProvider, setBuyerLlmProvider] = useState("openrouter");
  const [buyerLlmModel, setBuyerLlmModel] = useState("");
  const [buyerLlmBaseUrl, setBuyerLlmBaseUrl] = useState("");
  const [isKeyDialogOpen, setIsKeyDialogOpen] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  // Buyer test state
  const [buyerTesting, setBuyerTesting] = useState(false);
  const [buyerTestResult, setBuyerTestResult] = useState<string | null>(null);

  // Merchant-side model (persisted via Settings API) — configurable right
  // here in the lab for parity with the buyer key dialog.
  const [merchantDialogOpen, setMerchantDialogOpen] = useState(false);
  const [mProvider, setMProvider] = useState("openrouter");
  const [mModel, setMModel] = useState("");
  const [mApiKey, setMApiKey] = useState("");
  const [mBaseUrl, setMBaseUrl] = useState("");
  const [merchantAi, setMerchantAi] = useState<{
    hasApiKey?: boolean;
    apiKeyMasked?: string | null;
    provider?: string;
    live?: boolean;
  } | null>(null);
  const [mSaving, setMSaving] = useState(false);
  const [mTesting, setMTesting] = useState(false);
  const [mTestResult, setMTestResult] = useState<string | null>(null);

  // Elapsed-seconds indicator while a run executes
  const [elapsedSecs, setElapsedSecs] = useState(0);

  // Mandate parameters (live-edited by chat parsing or by hand)
  const [customInstruction, setCustomInstruction] = useState(
    "Buy a brown-switch keyboard under ₹5,000",
  );
  const [customBudgetInr, setCustomBudgetInr] = useState<number | null>(5000);
  const [customTolerancePercent, setCustomTolerancePercent] =
    useState<number>(10);
  const [customSearchQuery, setCustomSearchQuery] = useState("keyboard");
  const [customCategory, setCustomCategory] = useState<string | null>(
    "electronics",
  );
  const [customQuantity, setCustomQuantity] = useState<number>(1);
  const [customMinRating, setCustomMinRating] = useState<number | null>(null);
  // The mandate that actually emerged from THIS conversation (returned by the
  // planner), kept separate from the editable pre-filled form so a greeting or
  // unrelated message never inherits the form's seed values as if confirmed.
  const [conversationMandate, setConversationMandate] = useState<
    Record<string, unknown> | undefined
  >(undefined);
  const [customStrategy, setCustomStrategy] = useState<
    "best_match_within_budget" | "lowest_price" | "maximize_quality"
  >("best_match_within_budget");
  const [selectedScenarioKey, setSelectedScenarioKey] =
    useState<string>("bulkNegotiation");

  // STEP_UP modal
  const [isStepUpModalOpen, setIsStepUpModalOpen] = useState(false);
  const [stepUpData, setStepUpData] = useState<StepUpInfo | null>(null);
  const [approvingStepUp, setApprovingStepUp] = useState(false);

  // Stacked transaction notifications — each toast is aligned sequentially
  // below the previous one (top-right) instead of overlapping in one spot.
  const [toasts, setToasts] = useState<TransactionToastInfo[]>([]);
  const toastIdRef = useRef(0);

  const dismissToast = useCallback(
    (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id)),
    [],
  );

  const pushToast = useCallback(
    (info: Omit<TransactionToastInfo, "id">) => {
      const id = toastIdRef.current++;
      // Newest toast appears at the very top (closest to the corner); older
      // ones slide down the stack sequentially.
      setToasts((prev) => [{ ...info, id }, ...prev]);
      setTimeout(() => dismissToast(id), 10000);
    },
    [dismissToast],
  );

  // Live Razorpay test checkout (surfaced for every ALLOW payment — the order
  // is left `payment_pending` until the human completes a real test checkout).
  const [paymentCheckout, setPaymentCheckout] = useState<{
    orderId: string;
    keyId: string;
    amountMinor: number;
    currency: string;
    grandTotalMinor: number;
    quantity: number;
  } | null>(null);
  const [isPaying, setIsPaying] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);

  // Upsell decision flow: the buyer agent offers a combo deal in the chat and
  // the user decides whether to add it. The Razorpay modal only opens AFTER
  // the decision (accept → re-checkout with upsellOfferId; decline → confirm
  // the original cart).
  const [upsellDecision, setUpsellDecision] = useState<
    "pending" | "accepting" | "accepting_checkout" | "declined"
  >("pending");
  const [acceptingOfferId, setAcceptingOfferId] = useState<string | null>(null);
  const [upsellError, setUpsellError] = useState<string | null>(null);

  const isMandateReady = Boolean(
    customBudgetInr && customBudgetInr > 0 && customSearchQuery.trim(),
  );
  const willNegotiate = customQuantity >= 2;
  const effectiveMaxCapInr =
    (customBudgetInr || 0) * (1 + customTolerancePercent / 100);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-scroll when messages change
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Load the merchant's saved model status for the header badge
  useEffect(() => {
    fetch("/api/merchant/settings")
      .then((r) => r.json())
      .then((d) => d?.ai && setMerchantAi(d.ai))
      .catch(() => {});
  }, []);

  // Tick a visible elapsed timer while the agent runs
  useEffect(() => {
    if (!running) return;
    setElapsedSecs(0);
    const t = setInterval(() => setElapsedSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  // Real-time cross-tab: when the merchant approves a pending over-limit or
  // step-up order from the console (any tab), surface the Razorpay test
  // checkout right here so the payment can be completed without re-running.
  useEffect(() => {
    return subscribeApprovalCheckout((message) => {
      if (!message?.razorpayOrderId) return;
      const grandTotalMinor = message.grandTotalMinor ?? message.amountMinor;
      setPaymentCheckout({
        orderId: message.razorpayOrderId,
        keyId: message.razorpayKeyId || "",
        amountMinor: message.amountMinor ?? grandTotalMinor,
        currency: message.currency || "INR",
        grandTotalMinor,
        quantity: message.quantity || 1,
      });
      setPaymentError(null);
      setIsStepUpModalOpen(false);
      pushToast({
        title: "Transaction approved — complete test payment",
        decision: "ALLOW",
        quantity: message.quantity || 1,
        grandTotalMinor,
        perUnitMinor: grandTotalMinor / Math.max(1, message.quantity || 1),
      });
    });
  }, [pushToast]);

  const loadMerchantAi = async () => {
    try {
      const res = await fetch("/api/merchant/settings");
      const data = await res.json();
      if (data?.ai) {
        setMerchantAi(data.ai);
        setMProvider(data.ai.provider || "openrouter");
        setMModel(data.ai.model || "");
        setMBaseUrl(data.ai.baseUrl || "");
      }
    } catch {
      /* non-fatal */
    }
  };

  const openMerchantDialog = async () => {
    setMTestResult(null);
    setMApiKey("");
    await loadMerchantAi();
    setMerchantDialogOpen(true);
  };

  const handleSaveMerchantModel = async () => {
    try {
      setMSaving(true);
      const res = await fetch("/api/merchant/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ai: {
            provider: mProvider,
            model: mModel,
            baseUrl: mBaseUrl,
            apiKey: mApiKey || undefined,
          },
        }),
      });
      const data = await res.json();
      if (data?.ai) setMerchantAi(data.ai);
      setMApiKey("");
      setMerchantDialogOpen(false);
    } catch {
      /* keep dialog open on failure */
    } finally {
      setMSaving(false);
    }
  };

  const handleTestModel = async () => {
    try {
      setMTesting(true);
      setMTestResult(null);
      const res = await fetch("/api/merchant/ai-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: mProvider,
          model: mModel,
          baseUrl: mBaseUrl,
          apiKey: mApiKey || undefined,
        }),
      });
      const data = await res.json();
      setMTestResult(data.message || String(data.error || "Unknown response"));
    } catch (e) {
      setMTestResult(String(e));
    } finally {
      setMTesting(false);
    }
  };

  const applyMandateUpdate = (mandate: Record<string, unknown> | undefined) => {
    if (!mandate) return;
    if (mandate.instruction) setCustomInstruction(String(mandate.instruction));
    if (mandate.searchQuery) setCustomSearchQuery(String(mandate.searchQuery));
    if (mandate.budgetInr) setCustomBudgetInr(Number(mandate.budgetInr));
    if (mandate.budgetTolerancePercent !== undefined)
      setCustomTolerancePercent(Number(mandate.budgetTolerancePercent));
    if (mandate.category) setCustomCategory(String(mandate.category));
    if (mandate.quantity)
      setCustomQuantity(Math.max(1, Number(mandate.quantity)));
    if (mandate.minRating !== undefined && mandate.minRating !== null)
      setCustomMinRating(Number(mandate.minRating));
  };

  const handleSendMessage = async (textOverride?: string) => {
    const text = (textOverride ?? chatInput).trim();
    if (!text || isChatSending) return;

    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      role: "user",
      content: text,
    };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setChatInput("");
    setIsChatSending(true);

    try {
      const res = await fetch("/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          apiKey: openRouterApiKey || undefined,
          provider: openRouterApiKey ? buyerLlmProvider : undefined,
          model: openRouterApiKey ? buyerLlmModel || undefined : undefined,
          baseUrl: openRouterApiKey ? buyerLlmBaseUrl || undefined : undefined,
          // Only forward the mandate that actually emerged from THIS
          // conversation (if any) — never the editable pre-filled form. This
          // keeps the returned mandate transaction-specific and prevents an
          // unrelated greeting from inheriting seed values as "confirmed".
          currentMandate: conversationMandate,
        }),
      });

      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        {
          id: `a_${Date.now()}`,
          role: "assistant",
          content: data.reply || "Done.",
        },
      ]);
      setConversationMandate(data.mandate);
      applyMandateUpdate(data.mandate);

      // Conversational execution: a "yes / go ahead"-style confirmation on a
      // complete mandate launches the buyer agent immediately — no button.
      // NOTE: the server already replies "Confirmed — executing your mandate
      // now…", so do NOT append a second assistant message here (it would
      // duplicate the confirmation in the chat transcript).
      const isConfirmation = CONFIRMATION_RE.test(text);
      const mandateComplete = Boolean(
        data?.mandate?.isMandateComplete ||
          (Array.isArray(data?.mandate?.missingRequired) &&
            data.mandate.missingRequired.length === 0),
      );
      if (isConfirmation && mandateComplete && !running) {
        await runSimulation({ customConfig: buildCustomConfig(data.mandate) });
      }
    } catch (err) {
      console.error("Chat planner error:", err);
      setMessages((prev) => [
        ...prev,
        {
          id: `e_${Date.now()}`,
          role: "assistant",
          content: "Something went wrong — please try again.",
        },
      ]);
    } finally {
      setIsChatSending(false);
    }
  };

  const runSimulation = async (payload: Record<string, unknown>) => {
    setRunning(true);
    setResult(null);
    setExpandedSteps({});
    setPaymentCheckout(null);
    setPaymentError(null);

    try {
      const res = await fetch("/api/simulation/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          // Buyer-side model powers genuine agent-to-agent dialogue
          llm: openRouterApiKey
            ? {
                provider: buyerLlmProvider,
                apiKey: openRouterApiKey,
                model: buyerLlmModel || undefined,
                baseUrl: buyerLlmBaseUrl || undefined,
              }
            : undefined,
        }),
      });
      const data: SimulationResult = await res.json();
      setResult(data);
      setResultView("conversation");

      if (data.settlement) {
        const s = data.settlement;
        const hasRealSavings =
          (s.discountBps ?? 0) > 0 && (s.savingsMinor ?? 0) > 0;
        pushToast({
          title:
            data.finalDecision === "ALLOW"
              ? s.needsCheckout && s.razorpayOrderId
                ? "Payment required — open test checkout"
                : "Transaction settled"
              : data.finalDecision === "DENY"
                ? "Transaction declined"
                : "Transaction requires review",
          decision: data.finalDecision,
          quantity: s.quantity,
          grandTotalMinor: s.grandTotalMinor,
          perUnitMinor: s.perUnitMinor,
          bargain: hasRealSavings
            ? {
                discountBps: s.discountBps,
                savingsMinor: s.savingsMinor,
                outcome: s.outcome,
              }
            : undefined,
        });

        // Orders are left `payment_pending` for a real Razorpay test checkout —
        // every payment opens the checkout, so surface the order to pay.
        if (s.needsCheckout && s.razorpayOrderId) {
          setPaymentCheckout({
            orderId: s.razorpayOrderId,
            keyId: s.razorpayKeyId || "",
            amountMinor: s.amountMinor ?? s.grandTotalMinor,
            currency: s.currency || "INR",
            grandTotalMinor: s.grandTotalMinor,
            quantity: s.quantity,
          });
          setPaymentError(null);
        }
      }

      if (data.finalDecision === "STEP_UP") {
        const checkoutEvt = data.events.find((e) => e.type === "checkout");
        const checkoutPayload = checkoutEvt?.responsePayload as
          | { cartMandate?: { id?: string } }
          | undefined;
        // Did Surge Pricing cause the STEP_UP? Any event whose payload carries a
        // SURGE_PRICING_ACTIVE reason (either on the policy evaluation or the
        // confirm response) means the in-flight quote was re-priced +15%.
        const surged = data.events.some((e) => {
          const payload = (e.responsePayload || {}) as Record<string, unknown>;
          const r = (payload.policyEvaluation || payload) as Record<
            string,
            unknown
          >;
          return (
            Array.isArray(r?.reasonCodes) &&
            r.reasonCodes.includes("SURGE_PRICING_ACTIVE")
          );
        });
        setStepUpData({
          summary: data.summary,
          cartMandateId: checkoutPayload?.cartMandate?.id,
          surged,
        });
        setIsStepUpModalOpen(true);
      }
    } catch (e) {
      console.error("Simulation error:", e);
    } finally {
      setRunning(false);
    }
  };

  /** Load the Razorpay checkout SDK (test mode) once, then open the modal and
   * verify the resulting payment signature server-side before marking paid. */
  const loadRazorpayCheckout = (): Promise<RazorpayCtor | null> => {
    return new Promise((resolve) => {
      const w = window as unknown as { Razorpay?: RazorpayCtor };
      if (w.Razorpay) return resolve(w.Razorpay);
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.async = true;
      script.onload = () => resolve(w.Razorpay ?? null);
      script.onerror = () => resolve(null);
      document.body.appendChild(script);
    });
  };

  const handleRazorpayCheckout = async () => {
    if (!paymentCheckout || isPaying) return;
    setPaymentError(null);
    setIsPaying(true);
    try {
      const RazorpayCtor = await loadRazorpayCheckout();
      if (!RazorpayCtor) {
        setPaymentError(
          "Razorpay checkout SDK could not be loaded. Set a Razorpay TEST key (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET) and retry.",
        );
        return;
      }

      const orderId = paymentCheckout.orderId;
      const options = {
        key: paymentCheckout.keyId,
        amount: paymentCheckout.amountMinor,
        currency: paymentCheckout.currency,
        name: "AgentPay Merchant — Test Checkout",
        description: `AgentPay order ${orderId}`,
        order_id: orderId,
        handler: async (response: RazorpayPaymentResponse) => {
          // Server-side verification: never trust the client that payment
          // succeeded; re-verify the Razorpay signature here.
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
            setPaymentCheckout(null);
            pushToast({
              title: "Payment successful",
              decision: "ALLOW",
              quantity: paymentCheckout.quantity,
              grandTotalMinor: paymentCheckout.grandTotalMinor,
              perUnitMinor: paymentCheckout.grandTotalMinor,
            });
          } else {
            setPaymentError(
              verifyData?.error || "Payment could not be verified.",
            );
          }
        },
        modal: {
          ondismiss: () => {
            setIsPaying(false);
          },
        },
      };

      const rzp = new RazorpayCtor(options);
      rzp.on("payment.failed", (res: unknown) => {
        const err = res as { error?: { description?: string } } | undefined;
        setPaymentError(
          err?.error?.description || "Payment failed on the Razorpay side.",
        );
      });
      rzp.open();
    } catch (e) {
      console.error("Razorpay checkout error:", e);
      setPaymentError("Could not open Razorpay checkout.");
    } finally {
      setIsPaying(false);
    }
  };

  /** Decline the upsell combo — confirm the ORIGINAL cart and open Razorpay. */
  const handleDeclineUpsell = async () => {
    const pending = result?.pendingConfirmation;
    if (!pending) return;
    setUpsellError(null);
    setUpsellDecision("accepting");
    try {
      const res = await fetch("/v1/agent/checkout/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cartMandateId: pending.cartMandateId,
          decisionId: pending.decisionId,
          paymentMethod: "razorpay_checkout",
        }),
      });      const data = await res.json();
      if (res.ok && data.success) {
        setUpsellDecision("declined");
        const declineSettlement: SettlementInfo = {
          quantity: pending.items[0]?.quantity || 1,
          grandTotalMinor: pending.grandTotalMinor,
          perUnitMinor: pending.grandTotalMinor,
          discounted: Boolean(result?.settlement?.discounted),
          discountBps: result?.settlement?.discountBps ?? 0,
          savingsMinor: result?.settlement?.savingsMinor ?? 0,
          outcome: result?.settlement?.outcome ?? "NOT_ATTEMPTED",
          needsCheckout: true,
          razorpayOrderId: data.razorpayOrderId,
          razorpayKeyId: data.razorpayKeyId || "",
          amountMinor: data.amountMinor ?? pending.grandTotalMinor,
          currency: data.currency || "INR",
          paymentStatus: "pending_payment",
        };
        setResult((r) =>
          r
            ? {
                ...r,
                pendingConfirmation: undefined,
                upsell: undefined,
                settlement: declineSettlement,
              }
            : r,
        );
        setPaymentCheckout({
          orderId: data.razorpayOrderId,
          keyId: data.razorpayKeyId || "",
          amountMinor: data.amountMinor ?? pending.grandTotalMinor,
          currency: data.currency || "INR",
          grandTotalMinor: pending.grandTotalMinor,
          quantity: pending.items[0]?.quantity || 1,
        });
        setPaymentError(null);
      } else {
        setUpsellError(data.error || "Could not confirm the order.");
      }
    } catch (e) {
      setUpsellError(String(e instanceof Error ? e.message : e));
    } finally {
      setUpsellDecision("pending");
    }
  };

  /** Accept the upsell combo — re-checkout WITH the offer, then open Razorpay. */
  const handleAcceptUpsell = async (offerId: string) => {
    const pending = result?.pendingConfirmation;
    if (!pending) return;
    setUpsellError(null);
    setUpsellDecision("accepting_checkout");
    setAcceptingOfferId(offerId);
    try {
      // 1. Re-checkout with the accepted upsell offer id (the merchant
      //    authoritatively re-resolves the offer items and merges them).
      const checkoutRes = await fetch("/v1/agent/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intentMandateId: pending.intentMandateId,
          verificationId: pending.verificationId,
          items: pending.items,
          upsellOfferId: offerId,
          negotiationSessionId: pending.negotiationSessionId,
          delivery: {
            country: "IND",
            postalCode: "560001",
            city: "Bengaluru",
            state: "Karnataka",
            addressLine1: "123 Indiranagar 100ft Rd",
          },
        }),
      });
      const checkoutData = await checkoutRes.json();
      if (
        !checkoutRes.ok ||
        !checkoutData.cartMandate ||
        !checkoutData.policyEvaluation
      ) {
        setUpsellError(
          checkoutData.error ||
            "The combo offer could not be added to the cart (it may have expired).",
        );
        return;
      }

      // The upsold cart re-runs the full policy gate. Only an ALLOW decision
      // produces a payable Razorpay order — a DENY/STEP_UP cart carries no
      // payment intent, so confirming it would fail. Surface the real decision
      // instead of a cryptic 500.
      const upsellDecisionValue = checkoutData.policyEvaluation.decision;
      if (upsellDecisionValue === "DENY") {
        setUpsellError(
          `The upsold cart was declined by policy: ${(checkoutData.policyEvaluation.reasonCodes || []).join(", ") || "not within the buyer's mandate"}. No payment was created.`,
        );
        return;
      }
      if (upsellDecisionValue === "STEP_UP") {
        setUpsellError(
          "The upsold cart requires human merchant approval (STEP_UP). It has been queued — no payment was created.",
        );
        return;
      }

      const newCartMandateId = checkoutData.cartMandate.id;
      const newDecisionId = checkoutData.policyEvaluation.decisionId;
      const newGrandTotal =
        checkoutData.cartMandate.totals?.grandTotalMinor ??
        pending.grandTotalMinor;

      // 2. Confirm the updated cart → creates the Razorpay order.
      const confirmRes = await fetch("/v1/agent/checkout/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cartMandateId: newCartMandateId,
          decisionId: newDecisionId,
          paymentMethod: "razorpay_checkout",
        }),
      });
      const confirmData = await confirmRes.json();
      if (!confirmRes.ok || !confirmData.success) {
        setUpsellError(
          confirmData.error ||
            "The combo order could not be confirmed for payment.",
        );
        return;
      }

      // 3. Present the Razorpay modal for the upsold cart.
      setUpsellDecision("declined");
      const upsellSettlement: SettlementInfo = {
        quantity: pending.items[0]?.quantity || 1,
        grandTotalMinor: newGrandTotal,
        perUnitMinor: newGrandTotal,
        discounted: Boolean(result?.settlement?.discounted),
        discountBps: result?.settlement?.discountBps ?? 0,
        savingsMinor: result?.settlement?.savingsMinor ?? 0,
        outcome: result?.settlement?.outcome ?? "NOT_ATTEMPTED",
        needsCheckout: true,
        razorpayOrderId: confirmData.razorpayOrderId,
        razorpayKeyId: confirmData.razorpayKeyId || "",
        amountMinor: confirmData.amountMinor ?? newGrandTotal,
        currency: confirmData.currency || "INR",
        paymentStatus: "pending_payment",
      };
      setResult((r) =>
        r
          ? {
              ...r,
              pendingConfirmation: undefined,
              upsell: undefined,
              settlement: upsellSettlement,
            }
          : r,
      );
      setPaymentCheckout({
        orderId: confirmData.razorpayOrderId,
        keyId: confirmData.razorpayKeyId || "",
        amountMinor: confirmData.amountMinor ?? newGrandTotal,
        currency: confirmData.currency || "INR",
        grandTotalMinor: newGrandTotal,
        quantity: pending.items[0]?.quantity || 1,
      });
      setPaymentError(null);
    } catch (e) {
      setUpsellError(String(e instanceof Error ? e.message : e));
    } finally {
      setUpsellDecision("pending");
      setAcceptingOfferId(null);
    }
  };

  const buildCustomConfig = (
    m?: Record<string, unknown> | null,
  ): CustomSimulationConfig => ({
    instruction: String(m?.instruction || customInstruction),
    searchQuery: String(m?.searchQuery || customSearchQuery || "").trim(),
    budgetInr: Number(m?.budgetInr || customBudgetInr || 5000),
    budgetTolerancePercent: Number(
      m?.budgetTolerancePercent ?? customTolerancePercent,
    ),
    quantity: Math.max(1, Number(m?.quantity || customQuantity || 1)),
    minRating:
      m?.minRating !== undefined && m?.minRating !== null
        ? Number(m.minRating)
        : customMinRating || undefined,
    category: (m?.category as string) || customCategory || undefined,
    strategy: customStrategy,
    negotiateForBulk: true,
  });

  const handleRunFromParams = () =>
    runSimulation({ customConfig: buildCustomConfig() });

  const handleRunPreset = () =>
    runSimulation({ scenarioId: selectedScenarioKey });

  const handleApproveStepUpOnce = async () => {
    if (!stepUpData?.cartMandateId) {
      setIsStepUpModalOpen(false);
      return;
    }
    try {
      setApprovingStepUp(true);
      const res = await fetch(
        `/api/merchant/requests/${stepUpData.cartMandateId}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "approve" }),
        },
      );
      const data = await res.json().catch(() => null);
      if (res.ok) {
        setIsStepUpModalOpen(false);
        // Approval authorizes a REAL payment — surface the Razorpay test
        // checkout for the approved order so it can be completed here.
        if (data?.razorpayOrderId) {
          const grandTotalMinor = data.grandTotalMinor ?? data.amountMinor ?? 0;
          setPaymentCheckout({
            orderId: data.razorpayOrderId,
            keyId: data.razorpayKeyId || "",
            amountMinor: data.amountMinor ?? grandTotalMinor,
            currency: data.currency || "INR",
            grandTotalMinor,
            quantity: data.quantity || 1,
          });
          setPaymentError(null);
        } else {
          // Defensive fallback: no payment intent, re-run as before.
          handleRunFromParams();
        }
      }
    } catch (err) {
      console.error("Failed to approve step up:", err);
    } finally {
      setApprovingStepUp(false);
    }
  };

  // Buyer test handler
  const handleTestBuyer = async () => {
    setBuyerTesting(true);
    setBuyerTestResult(null);
    try {
      const res = await fetch("/api/merchant/ai-test", {
        // 👈 changed URL
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: buyerLlmProvider,
          model: buyerLlmModel,
          baseUrl: buyerLlmBaseUrl,
          apiKey: openRouterApiKey,
        }),
      });
      const data = await res.json();
      setBuyerTestResult(
        data.message || String(data.error || "Unknown response"),
      );
    } catch (e) {
      setBuyerTestResult(String(e));
    } finally {
      setBuyerTesting(false);
    }
  };

  const conversation: ConversationLine[] = result
    ? extractConversation(result)
    : [];

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Agent Simulation Lab"
        description="Describe a purchase, watch your AI buyer negotiate with the merchant agent, and see every policy decision."
      />

      <div className="p-6 space-y-5">
        {/* ── Configure & Launch ─────────────────────────────────── */}
        <Card>
          <Tabs value={configTab} onValueChange={setConfigTab}>
            <div className="flex items-center justify-between gap-4 px-6 pt-5 pb-0 flex-wrap">
              <TabsList>
                <TabsTrigger
                  value="chat"
                  className="flex items-center gap-1.5 text-xs"
                >
                  <MessageSquare className="w-3.5 h-3.5" />
                  Plan by Chat
                </TabsTrigger>
                <TabsTrigger value="presets" className="text-xs">
                  Quick Scenarios
                </TabsTrigger>
              </TabsList>

              <div className="flex items-center gap-1">
                {/* Merchant-side model — persisted, powers the merchant agent */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={openMerchantDialog}
                  className="gap-1 text-[11px] text-text-muted"
                  title="Configure the model the MERCHANT agent uses (saved server-side)"
                >
                  <Building2 className="w-3 h-3" />
                  {merchantAi?.live
                    ? `Merchant model: ${merchantAi.provider} live`
                    : "Merchant model"}
                  {merchantAi?.live && (
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#00b874]" />
                  )}
                </Button>

                {/* Buyer-side model — session-only, powers your buyer agent */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsKeyDialogOpen(true)}
                  className="gap-1 text-[11px] text-text-muted"
                  title="Configure the model YOUR buyer agent uses (kept in this browser session)"
                >
                  <Key className="w-3 h-3" />
                  {openRouterApiKey ? "Buyer LLM set" : "Connect buyer LLM"}
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-5 p-6 pt-4">
              {/* Left: config mode content */}
              <div className="min-h-[380px]">
                <TabsContent
                  value="chat"
                  className="mt-0 flex flex-col h-[420px] rounded-xl border border-border bg-muted overflow-hidden"
                >
                  <div className="flex-1 overflow-y-auto p-4 space-y-3 text-xs">
                    {messages.map((m) => (
                      <div
                        key={m.id}
                        className={
                          m.role === "user"
                            ? "flex justify-end"
                            : "flex justify-start"
                        }
                      >
                        <div
                          className={`max-w-[85%] rounded-xl px-3.5 py-2.5 leading-relaxed whitespace-pre-line ${
                            m.role === "user"
                              ? "bg-primary text-primary-foreground font-medium"
                              : "bg-card border border-border text-foreground"
                          }`}
                        >
                          {m.content}
                        </div>
                      </div>
                    ))}
                    {isChatSending && (
                      <div className="flex items-center gap-2 text-text-muted">
                        <Bot className="w-4 h-4 animate-spin text-primary" />
                        <span>Parsing your intent...</span>
                      </div>
                    )}
                    <div ref={chatBottomRef} />
                  </div>

                  <div className="border-t border-border bg-background/60 p-3 space-y-2">
                    <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                      <Sparkles className="w-3 h-3 text-primary shrink-0" />
                      {[
                        {
                          label: "Bulk deal",
                          text: "Buy 10 keyboards in bulk for the office, budget ₹30,000",
                        },
                        {
                          label: "Single item",
                          text: "Buy an ANC headphone under ₹7,000 rated above 4.5 stars",
                        },
                        {
                          label: "Missing budget",
                          text: "I want a gaming mouse",
                        },
                        {
                          label: "Over-budget",
                          text: "Buy a gaming laptop under ₹5,000 strict",
                        },
                      ].map((chip) => (
                        <button
                          key={chip.label}
                          type="button"
                          onClick={() => handleSendMessage(chip.text)}
                          disabled={isChatSending}
                          className="shrink-0 text-[11px] px-2.5 py-1 rounded-full border border-border bg-white hover:border-primary/40 hover:text-primary transition-colors text-text-muted"
                        >
                          {chip.label}
                        </button>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <Input
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        onKeyDown={(e) =>
                          e.key === "Enter" && handleSendMessage()
                        }
                        placeholder='e.g. "Order 8 laptop stands in bulk under ₹12,000"'
                        className="h-9 text-xs"
                      />
                      <Button
                        size="sm"
                        onClick={() => handleSendMessage()}
                        disabled={!chatInput.trim() || isChatSending}
                        className="h-9 px-3"
                      >
                        <Send className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="presets" className="mt-0">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {Object.entries(PRESET_SCENARIOS).map(([key, sc]) => {
                      const isSelected = selectedScenarioKey === key;
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setSelectedScenarioKey(key)}
                          className={`text-left rounded-xl border p-4 shadow-sm transition-all ${
                            isSelected
                              ? "border-primary/60 bg-accent"
                              : "border-border bg-white hover:border-primary/40 hover:bg-accent/40"
                          }`}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <Badge
                              variant={
                                sc.expectedDecision === "ALLOW"
                                  ? "success"
                                  : sc.expectedDecision === "STEP_UP"
                                    ? "warning"
                                    : "destructive"
                              }
                              className="font-mono text-[10px]"
                            >
                              {sc.expectedDecision}
                            </Badge>
                            {"autonomousConfig" in sc && sc.autonomousConfig ? (
                              <Badge
                                variant="outline"
                                className="text-[9px] gap-1"
                              >
                                <Handshake className="w-2.5 h-2.5" />{" "}
                                Negotiation
                              </Badge>
                            ) : null}
                          </div>
                          <h4 className="text-xs font-semibold leading-snug mb-1 text-foreground">
                            {sc.name.replace(/^Scenario \d+: /, "")}
                          </h4>
                          <p className="text-[11px] text-text-muted line-clamp-2 leading-relaxed">
                            {sc.description}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </TabsContent>
              </div>

              {/* Right: live mandate panel (always visible) */}
              <div className="rounded-xl border border-border bg-muted p-4 space-y-3.5 text-xs">
                <div className="flex items-center justify-between border-b border-border pb-3">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                    Buyer Mandate
                  </span>
                  {isMandateReady ? (
                    <Badge variant="success" className="gap-1 text-[10px]">
                      <Check className="w-3 h-3" /> Ready
                    </Badge>
                  ) : (
                    <Badge variant="warning" className="gap-1 text-[10px]">
                      Missing fields
                    </Badge>
                  )}
                </div>

                <label
                  htmlFor="custom-search-query"
                  className="block space-y-1"
                >
                  <span className="font-medium text-text-muted text-[11px]">
                    Product
                  </span>
                  <Input
                    id="custom-search-query"
                    value={customSearchQuery}
                    onChange={(e) => setCustomSearchQuery(e.target.value)}
                    placeholder="keyboard, mouse..."
                    className="h-8"
                  />
                </label>

                <label htmlFor="custom-budget-inr" className="block space-y-1">
                  <span className="font-medium text-text-muted text-[11px]">
                    Budget (₹)
                  </span>
                  <Input
                    id="custom-budget-inr"
                    type="number"
                    value={customBudgetInr || ""}
                    onChange={(e) =>
                      setCustomBudgetInr(Number(e.target.value) || null)
                    }
                    className="h-8 font-mono"
                  />
                  <span className="block text-[10px] text-primary font-mono">
                    Cap incl. ±{customTolerancePercent}%: ₹
                    {effectiveMaxCapInr.toLocaleString("en-IN")}
                  </span>
                </label>

                <div className="space-y-1">
                  <span className="font-medium text-text-muted text-[11px]">
                    Quantity
                  </span>
                  <div className="flex items-stretch gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-8 px-0"
                      onClick={() =>
                        setCustomQuantity((q) => Math.max(1, q - 1))
                      }
                    >
                      −
                    </Button>
                    <Input
                      type="number"
                      min={1}
                      value={customQuantity}
                      onChange={(e) =>
                        setCustomQuantity(
                          Math.max(1, Number(e.target.value) || 1),
                        )
                      }
                      className="h-9 flex-1 text-center font-mono"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-8 px-0"
                      onClick={() => setCustomQuantity((q) => q + 1)}
                    >
                      +
                    </Button>
                  </div>
                  <span
                    className={`block text-[10px] ${willNegotiate ? "text-[#00875c]" : "text-text-muted"}`}
                  >
                    {willNegotiate
                      ? "≥2 units → buyer will haggle with the merchant agent"
                      : "Add 2+ units to trigger agent-to-agent negotiation"}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="block space-y-1">
                    <span className="font-medium text-text-muted text-[11px]">
                      Tolerance
                    </span>
                    <select
                      value={customTolerancePercent}
                      onChange={(e) =>
                        setCustomTolerancePercent(Number(e.target.value))
                      }
                      className="w-full h-8 rounded-md bg-white border border-input px-2 text-xs font-mono"
                    >
                      {[0, 5, 10, 15, 20].map((t) => (
                        <option key={t} value={t}>
                          ±{t}%
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block space-y-1">
                    <span className="font-medium text-text-muted text-[11px]">
                      Strategy
                    </span>
                    <select
                      value={customStrategy}
                      onChange={(e) =>
                        setCustomStrategy(
                          e.target.value as typeof customStrategy,
                        )
                      }
                      className="w-full h-8 rounded-md bg-white border border-input px-2 text-[11px]"
                    >
                      <option value="best_match_within_budget">
                        Best match
                      </option>
                      <option value="lowest_price">Lowest price</option>
                      <option value="maximize_quality">Max quality</option>
                    </select>
                  </label>
                </div>

                <Button
                  onClick={
                    configTab === "presets"
                      ? handleRunPreset
                      : handleRunFromParams
                  }
                  disabled={
                    running || (configTab === "chat" && !isMandateReady)
                  }
                  className="w-full gap-2 font-semibold"
                >
                  <Play
                    className={`w-4 h-4 ${running ? "animate-spin" : ""}`}
                  />
                  {running
                    ? `Agent running… ${elapsedSecs}s`
                    : configTab === "presets"
                      ? "Run Scenario"
                      : "Run Buyer Agent"}
                </Button>
                {running && (
                  <p className="text-[11px] text-text-muted text-center">
                    {openRouterApiKey
                      ? "Live agent dialogue in progress — first run with a new key can take a few seconds."
                      : "Executing protocol steps…"}
                  </p>
                )}
              </div>
            </div>
          </Tabs>
        </Card>

        {/* ── Results ────────────────────────────────────────────── */}
        {result && (
          <div className="animate-in fade-in slide-in-from-bottom-3 space-y-4">
            {/* Compact outcome banner */}
            <div
              className={`p-4 rounded-xl border ${
                result.finalDecision === "ALLOW"
                  ? "bg-[#00b874]/[0.08] border-[#00b874]/25 text-[#00875c]"
                  : result.finalDecision === "STEP_UP"
                    ? "bg-[#ffb822]/[0.12] border-[#ffb822]/40 text-[#946400]"
                    : "bg-destructive/[0.06] border-destructive/25 text-destructive"
              }`}
            >
              <div className="flex flex-col lg:flex-row lg:items-center gap-3 justify-between">
                <div className="flex items-start gap-3">
                  {result.finalDecision === "ALLOW" ? (
                    <CheckCircle2 className="w-5 h-5 mt-0.5 shrink-0" />
                  ) : result.finalDecision === "STEP_UP" ? (
                    <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0" />
                  ) : (
                    <XCircle className="w-5 h-5 mt-0.5 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold">{result.finalDecision}</span>
                    </div>
                    <p className="text-xs text-text-secondary mt-1 max-w-3xl">
                      {result.summary}
                    </p>
                    {result.negotiation?.finalDiscountBps ? (
                      <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-[#00b874]/30 bg-white/80 px-3.5 py-2.5 text-[#00875c]">
                        <span className="flex items-center gap-1.5 text-sm font-extrabold tracking-tight">
                          <Handshake className="w-4 h-4" />
                          {(result.negotiation.finalDiscountBps / 100).toFixed(
                            1,
                          )}
                          % off
                        </span>
                        <span className="hidden h-5 w-px bg-[#00b874]/20 sm:block" />
                        <span className="flex items-baseline gap-1.5 text-sm">
                          <span className="text-xs text-text-secondary">
                            You saved
                          </span>
                          <span className="font-mono text-base font-bold text-emerald-700">
                            {formatMinorUnits(result.negotiation.savingsMinor)}
                          </span>
                        </span>
                        <span className="ml-auto text-[11px] font-medium text-text-muted">
                          after {result.negotiation.rounds} round
                          {result.negotiation.rounds === 1 ? "" : "s"} of
                          negotiation
                        </span>
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="text-[10px] font-mono text-right text-text-muted shrink-0">
                  <div>
                    {result.totalDurationMs}ms · {result.events.length} steps
                  </div>
                  <div className="truncate max-w-[180px]">{result.traceId}</div>
                </div>
              </div>
            </div>

            {/* ── Upsell combo-deal decision ────────────────────────────── */}
            {result.pendingConfirmation && result.upsell?.offers?.length ? (
              <Card className="p-5 border-primary/40 bg-gradient-to-br from-primary/[0.06] to-transparent">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15 text-primary">
                      <PackagePlus className="w-5 h-5" />
                    </span>
                    <div>
                      <p className="text-sm font-bold text-text-primary">
                        Combo deal found — add to your cart?
                      </p>
                      <p className="text-xs text-text-secondary">
                        The merchant agent suggested a lucrative bundle. You
                        decide before any payment is created.
                      </p>
                    </div>
                  </div>
                  {upsellDecision === "accepting" ? (
                    <Badge className="bg-[#00b874]/15 text-[#00875c] border border-[#00b874]/25">
                      Confirming order (no upsell)
                    </Badge>
                  ) : upsellDecision === "accepting_checkout" ? (
                    <Badge className="bg-[#00b874]/15 text-[#00875c] border border-[#00b874]/25">
                      Building upsold cart…
                    </Badge>
                  ) : null}
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {result.upsell.offers.map((offer) => (
                    <div
                      key={offer.offerId}
                      className="rounded-xl border border-border bg-white p-4"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-text-primary">
                          {offer.title}
                        </p>
                        {offer.bundleDiscountMinor > 0 ? (
                          <Badge
                            variant="outline"
                            className="text-[10px] gap-1 text-[#00875c] border-[#00b874]/30"
                          >
                            <Tag className="w-3 h-3" />
                            save {formatMinorUnits(offer.bundleDiscountMinor)}
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="text-[10px] gap-1 text-text-muted border-border"
                          >
                            <Tag className="w-3 h-3" />
                            add-on
                          </Badge>
                        )}
                      </div>
                      {offer.description && (
                        <p className="text-[11px] text-text-muted mt-1">
                          {offer.description}
                        </p>
                      )}
                      <ul className="mt-3 space-y-1.5">
                        {offer.items.map((it) => (
                          <li
                            key={it.variantId}
                            className="flex items-center justify-between gap-2 text-xs"
                          >
                            <span className="text-text-secondary">
                              {it.title}
                              <span className="text-text-muted">
                                {" "}
                                ×{it.quantity}
                              </span>
                            </span>
                            <span className="font-mono font-medium text-text-primary">
                              {formatMinorUnits(it.lineAmountMinor)}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <div className="mt-3 flex items-center justify-between border-t border-border pt-2.5">
                        <span className="text-xs text-text-secondary">
                          Adds{" "}
                          <span className="font-semibold text-text-primary">
                            {formatMinorUnits(offer.addedTotalMinor)}
                          </span>{" "}
                          to cart
                        </span>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1"
                          onClick={() => handleDeclineUpsell()}
                          disabled={
                            upsellDecision === "accepting" ||
                            upsellDecision === "accepting_checkout"
                          }
                        >
                          <X className="w-3.5 h-3.5" />
                          Decline
                        </Button>
                        <Button
                          size="sm"
                          className="gap-1 bg-primary hover:bg-primary/90"
                          onClick={() => handleAcceptUpsell(offer.offerId)}
                          disabled={
                            upsellDecision === "accepting" ||
                            (upsellDecision === "accepting_checkout" &&
                              acceptingOfferId !== offer.offerId)
                          }
                        >
                          <Check className="w-3.5 h-3.5" />
                          {upsellDecision === "accepting_checkout" &&
                          acceptingOfferId === offer.offerId
                            ? "Adding…"
                            : "Add & Pay"}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>

                {upsellError && (
                  <p className="mt-3 text-[11px] text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                    {upsellError}
                  </p>
                )}
                <p className="mt-3 text-[11px] text-text-muted">
                  Total in cart:{" "}
                  <span className="font-mono text-text-primary">
                    {formatMinorUnits(result.upsell.cartSubtotalMinor)}
                  </span>
                  {" · "}maximum bundle uplift allowed:{" "}
                  <span className="font-mono text-text-primary">
                    {formatMinorUnits(result.upsell.maxUpliftMinor)}
                  </span>
                </p>
              </Card>
            ) : null}

            {/* Result views */}
            <Card className="p-0 overflow-hidden">
              <Tabs
                value={resultView}
                onValueChange={(v) => setResultView(v as typeof resultView)}
              >
                <div className="px-5 pt-4 border-b border-border">
                  <TabsList className="mb-3">
                    <TabsTrigger
                      value="conversation"
                      className="flex items-center gap-1.5 text-xs"
                    >
                      <MessagesSquare className="w-3.5 h-3.5" />
                      Agent Conversation ({conversation.length})
                    </TabsTrigger>
                    <TabsTrigger
                      value="trace"
                      className="flex items-center gap-1.5 text-xs"
                    >
                      <ListTree className="w-3.5 h-3.5" />
                      Execution Trace ({result.events.length})
                    </TabsTrigger>
                  </TabsList>
                </div>

                {/* Conversation view */}
                <TabsContent value="conversation" className="mt-0">
                  <div className="max-h-[560px] overflow-y-auto p-5 space-y-4">
                    {conversation.map((line, i) => {
                      const prevLine = conversation[i - 1];
                      const showDivider =
                        !prevLine || prevLine.stepLabel !== line.stepLabel;

                      const isBuyer = line.from === "buyer_agent";
                      const isMerchant = line.from === "merchant_agent";

                      return (
                        <div key={line.id}>
                          {showDivider && (
                            <div className="flex items-center gap-3 my-3 first:mt-0">
                              <div className="h-px flex-1 bg-border" />
                              <span className="text-[10px] text-text-muted truncate max-w-[60%]">
                                {line.stepLabel}
                              </span>
                              <div className="h-px flex-1 bg-border" />
                            </div>
                          )}

                          {isBuyer || isMerchant ? (
                            <div
                              className={`flex ${isMerchant ? "justify-end" : "justify-start"}`}
                            >
                              <div
                                className={`max-w-[78%] ${isMerchant ? "items-end" : "items-start"}`}
                              >
                                <div className="flex items-center gap-1.5 mb-1">
                                  <div
                                    className={`w-5 h-5 rounded-md flex items-center justify-center text-[9px] font-bold ${
                                      isBuyer
                                        ? "bg-accent text-primary"
                                        : "bg-[#00b874]/10 text-[#00875c]"
                                    }`}
                                  >
                                    <Bot className="w-3 h-3" />
                                  </div>
                                  <span
                                    className={`text-[10px] font-medium ${isBuyer ? "text-primary" : "text-[#00875c]"}`}
                                  >
                                    {isBuyer
                                      ? "AI Buyer Agent"
                                      : "Merchant Agent"}
                                  </span>
                                </div>
                                <div
                                  className={`rounded-xl px-3.5 py-2.5 text-xs leading-relaxed ${
                                    isBuyer
                                      ? "bg-accent border border-primary/25 text-foreground rounded-tl-sm"
                                      : "bg-[#00b874]/[0.08] border border-[#00b874]/25 text-foreground rounded-tr-sm"
                                  }`}
                                >
                                  {line.message}
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div className="flex justify-center">
                              <div className="max-w-[85%] rounded-lg bg-muted border border-border px-3 py-1.5 text-[11px] text-text-muted text-center">
                                <span className="font-medium text-text-secondary uppercase tracking-wide mr-1.5">
                                  {line.from.replace(/_/g, " ")}:
                                </span>
                                {line.message}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {conversation.length === 0 && (
                      <p className="text-xs text-text-muted text-center py-8">
                        No agent communications recorded.
                      </p>
                    )}
                  </div>
                </TabsContent>

                {/* Trace view */}
                <TabsContent value="trace" className="mt-0">
                  <div className="p-5 space-y-2.5">
                    {result.events.map((evt) => {
                      const isExpanded = !!expandedSteps[evt.stepIndex];
                      return (
                        <div
                          key={evt.stepIndex}
                          className="rounded-xl border border-border overflow-hidden"
                        >
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedSteps((p) => ({
                                ...p,
                                [evt.stepIndex]: !p[evt.stepIndex],
                              }))
                            }
                            className="w-full p-3.5 flex items-center justify-between gap-3 hover:bg-muted transition-colors text-left"
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              <span
                                className={`shrink-0 ${
                                  evt.status === "success"
                                    ? "text-[#00875c]"
                                    : evt.status === "warning"
                                      ? "text-[#946400]"
                                      : "text-destructive"
                                }`}
                              >
                                {evt.status === "success" ? (
                                  <CheckCircle2 className="w-4 h-4" />
                                ) : evt.status === "warning" ? (
                                  <AlertTriangle className="w-4 h-4" />
                                ) : (
                                  <XCircle className="w-4 h-4" />
                                )}
                              </span>
                              <div className="min-w-0">
                                <div className="text-xs font-semibold truncate">
                                  <span className="uppercase text-[10px] font-mono text-text-muted mr-2">
                                    {evt.type}
                                  </span>
                                  {evt.description}
                                </div>
                                <div className="text-[11px] text-text-muted line-clamp-1 mt-0.5">
                                  {evt.summary}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0 text-[10px] font-mono text-text-muted">
                              {evt.durationMs}ms
                              {isExpanded ? (
                                <ChevronDown className="w-4 h-4" />
                              ) : (
                                <ChevronRight className="w-4 h-4" />
                              )}
                            </div>
                          </button>

                          {isExpanded && (
                            <div className="border-t border-border bg-muted/60 p-4 space-y-2 text-[10px]">
                              {evt.communications &&
                                evt.communications.length > 0 && (
                                  <div className="space-y-1.5 mb-3">
                                    {evt.communications.map((c) => (
                                      <div
                                        key={`${evt.stepIndex}-${c.from}-${c.message.slice(0, 24)}`}
                                        className="flex gap-2"
                                      >
                                        <Badge
                                          variant="outline"
                                          className="text-[9px] min-w-[110px] justify-center shrink-0"
                                        >
                                          {c.from.replace(/_/g, " ")}
                                        </Badge>
                                        <span className="text-text-secondary leading-relaxed">
                                          {c.message}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              {evt.requestPayload != null && (
                                <>
                                  <div className="font-mono text-text-muted">
                                    Request
                                  </div>
                                  <pre className="rounded-md bg-[#1a1a2e] border border-white/10 p-2 font-mono overflow-x-auto text-zinc-200">
                                    {JSON.stringify(
                                      evt.requestPayload,
                                      null,
                                      2,
                                    )}
                                  </pre>
                                </>
                              )}
                              {evt.responsePayload != null && (
                                <>
                                  <div className="font-mono text-primary">
                                    Response
                                  </div>
                                  <pre className="rounded-md bg-[#1a1a2e] border border-white/10 p-2 font-mono max-h-56 overflow-y-auto text-zinc-200">
                                    {JSON.stringify(
                                      evt.responsePayload,
                                      null,
                                      2,
                                    )}
                                  </pre>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </TabsContent>
              </Tabs>
            </Card>
          </div>
        )}
      </div>

      {/* LLM key dialog */}
      <Dialog open={isKeyDialogOpen} onOpenChange={setIsKeyDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Buyer Agent Model (optional)</DialogTitle>
            <DialogDescription>
              Your own LLM makes the simulated buyer agent speak and decide
              genuinely — negotiation lines, selection rationale, settlement
              commentary. Without a key, structured heuristic dialogue is used
              and all protocol calls still run for real.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 pt-1 text-xs">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label
                  htmlFor="buyer-llm-provider"
                  className="block font-medium mb-1"
                >
                  Provider
                </label>
                <select
                  id="buyer-llm-provider"
                  value={buyerLlmProvider}
                  onChange={(e) => setBuyerLlmProvider(e.target.value)}
                  className="h-9 w-full px-2 rounded-md bg-white border border-input text-xs focus:outline-none focus:border-primary"
                >
                  <option value="openrouter">OpenRouter</option>
                  <option value="openai">OpenAI</option>
                  <option value="groq">Groq</option>
                  <option value="together">Together AI</option>
                  <option value="custom">Custom base URL</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor="buyer-llm-model"
                  className="block font-medium mb-1"
                >
                  Model
                </label>
                <Input
                  id="buyer-llm-model"
                  value={buyerLlmModel}
                  onChange={(e) => setBuyerLlmModel(e.target.value)}
                  placeholder={
                    buyerLlmProvider === "openrouter"
                      ? "openai/gpt-4o-mini"
                      : "gpt-4o-mini / llama-3.3-70b…"
                  }
                  className="font-mono"
                />
              </div>
            </div>

            {buyerLlmProvider === "custom" && (
              <div>
                <label
                  htmlFor="buyer-llm-base-url"
                  className="block font-medium mb-1"
                >
                  Base URL
                </label>
                <Input
                  id="buyer-llm-base-url"
                  value={buyerLlmBaseUrl}
                  onChange={(e) => setBuyerLlmBaseUrl(e.target.value)}
                  placeholder="https://your-host/v1/chat/completions"
                  className="font-mono"
                />
              </div>
            )}

            <Input
              type="password"
              value={openRouterApiKey}
              onChange={(e) => setOpenRouterApiKey(e.target.value)}
              placeholder="API key (sk-… / sk-or-v1-… / gsk_…)"
              className="font-mono"
              autoComplete="off"
            />

            {/* Buyer test button & result */}
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleTestBuyer}
                disabled={buyerTesting}
                className="gap-1.5"
              >
                <PlugZap className="w-3.5 h-3.5" />
                {buyerTesting ? "Testing…" : "Test"}
              </Button>
              {buyerTestResult && (
                <span className="text-[11px] text-text-secondary truncate">
                  {buyerTestResult}
                </span>
              )}
            </div>

            <p className="text-[11px] text-text-muted">
              The key stays in this browser session and is only used to voice
              your buyer agent. The merchant side uses whatever model the
              merchant configured in Settings.
            </p>
            <div className="flex justify-end">
              <Button size="sm" onClick={() => setIsKeyDialogOpen(false)}>
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Merchant-side model dialog — same UX as the buyer key dialog, but
          persists to merchant Settings so negotiations use it server-side */}
      <Dialog open={merchantDialogOpen} onOpenChange={setMerchantDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Merchant Agent Model</DialogTitle>
            <DialogDescription>
              The model your MERCHANT agent uses to voice negotiation replies.
              Saved to store settings and used for every AI-buyer checkout —
              separate from the buyer LLM, which stays session-only in this
              browser.
              {merchantAi?.apiKeyMasked && (
                <span className="mt-1 block font-mono text-[11px] text-text-muted">
                  Saved key: {merchantAi.apiKeyMasked}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 pt-1 text-xs">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label
                  htmlFor="merchant-llm-provider"
                  className="block font-medium mb-1"
                >
                  Provider
                </label>
                <select
                  id="merchant-llm-provider"
                  value={mProvider}
                  onChange={(e) => setMProvider(e.target.value)}
                  className="h-9 w-full px-2 rounded-md bg-white border border-input text-xs focus:outline-none focus:border-primary"
                >
                  <option value="openrouter">OpenRouter</option>
                  <option value="openai">OpenAI</option>
                  <option value="groq">Groq</option>
                  <option value="together">Together AI</option>
                  <option value="custom">Custom base URL</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor="merchant-llm-model"
                  className="block font-medium mb-1"
                >
                  Model
                </label>
                <Input
                  id="merchant-llm-model"
                  value={mModel}
                  onChange={(e) => setMModel(e.target.value)}
                  placeholder={
                    mProvider === "openrouter"
                      ? "openai/gpt-4o-mini"
                      : "gpt-4o-mini / llama-3.3-70b…"
                  }
                  className="font-mono"
                />
              </div>
            </div>

            {mProvider === "custom" && (
              <div>
                <label
                  htmlFor="merchant-llm-base-url"
                  className="block font-medium mb-1"
                >
                  Base URL
                </label>
                <Input
                  id="merchant-llm-base-url"
                  value={mBaseUrl}
                  onChange={(e) => setMBaseUrl(e.target.value)}
                  placeholder="https://your-host/v1/chat/completions"
                  className="font-mono"
                />
              </div>
            )}

            <Input
              type="password"
              value={mApiKey}
              onChange={(e) => setMApiKey(e.target.value)}
              placeholder={
                merchantAi?.hasApiKey
                  ? "Leave blank to keep the saved key"
                  : "API key (sk-… / sk-or-v1-… / gsk_…)"
              }
              className="font-mono"
              autoComplete="off"
            />

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleTestModel}
                disabled={mTesting}
                className="gap-1.5"
              >
                <PlugZap className="w-3.5 h-3.5" />
                {mTesting ? "Testing…" : "Test"}
              </Button>
              {mTestResult && (
                <span className="text-[11px] text-text-secondary truncate">
                  {mTestResult}
                </span>
              )}
            </div>

            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={handleSaveMerchantModel}
                disabled={mSaving}
              >
                {mSaving ? "Saving…" : "Save merchant model"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* STEP_UP approval dialog */}
      <Dialog open={isStepUpModalOpen} onOpenChange={setIsStepUpModalOpen}>
        <DialogContent className="max-w-md border-[#ffb822]/40">
          <DialogHeader>
            <div className="flex items-center gap-2 text-[#946400]">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <DialogTitle>Policy Step-Up Required</DialogTitle>
            </div>
            {stepUpData?.surged && (
              <div className="mt-2 rounded-lg border border-[#ffb822]/40 bg-[#fff7e0] px-3 py-2 text-xs text-[#946400]">
                <div className="font-semibold">
                  Surge Pricing re-priced this transaction +15%
                </div>
                <p className="mt-0.5 text-[11px] text-[#7a5400]">
                  Surge pricing is active, so this in-flight quote was escalated
                  to STEP_UP (SURGE_PRICING_ACTIVE). Approving authorizes
                  payment at the surged price.
                </p>
              </div>
            )}
            <DialogDescription className="text-text-secondary text-xs mt-2">
              {stepUpData?.summary ||
                "The transaction was paused for human authorization before settlement."}
              <span className="mt-2 block">
                Approve it here, or head to the{" "}
                <span className="font-semibold">Agent Requests</span> tab in the
                merchant console and approve it there — the Razorpay test
                checkout will open automatically in real time so you can
                complete the payment.
              </span>
            </DialogDescription>
          </DialogHeader>

          <div className="flex justify-end gap-2 pt-3 border-t border-border">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsStepUpModalOpen(false)}
              className="text-xs"
            >
              Leave Paused
            </Button>
            <Button
              size="sm"
              onClick={handleApproveStepUpOnce}
              disabled={approvingStepUp}
              className="text-xs gap-1 bg-[#ffb822] hover:bg-[#ffc23d] text-[#4a3500]"
            >
              <Check className="w-3.5 h-3.5" />
              {approvingStepUp
                ? "Authorizing..."
                : "Approve & Open Test Checkout"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Live Razorpay test checkout (payment_pending order awaiting payment) —
          bottom-CENTER so it never collides with the top-right toast stack */}
      {paymentCheckout && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] w-[360px] overflow-hidden rounded-xl border border-primary/40 bg-white shadow-2xl">
          <div className="flex items-center justify-between bg-primary/10 px-4 py-2.5 text-xs font-semibold text-primary">
            <span>Complete test payment required</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setPaymentCheckout(null)}
              className="opacity-60 hover:opacity-100"
            >
              <XCircle className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="px-4 py-3 space-y-3 text-sm">
            <p className="text-xs text-text-secondary">
              This order (
              <span className="font-semibold text-text-primary">
                {paymentCheckout.quantity} unit
                {paymentCheckout.quantity > 1 ? "s" : ""} ·{" "}
                {formatMinorUnits(paymentCheckout.grandTotalMinor)}
              </span>
              ) requires a real Razorpay test checkout to complete the payment.
            </p>
            <p className="text-[11px] text-text-muted font-mono break-all">
              Order: {paymentCheckout.orderId}
            </p>
            {paymentError && (
              <p className="text-[11px] text-red-600 bg-red-50 border border-red-200 rounded-md px-2 py-1.5">
                {paymentError}
              </p>
            )}
            <Button
              size="sm"
              className="w-full gap-1"
              onClick={handleRazorpayCheckout}
              disabled={isPaying}
            >
              {isPaying ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Opening…
                </>
              ) : (
                <>
                  <PlugZap className="w-3.5 h-3.5" />
                  Pay ₹
                  {formatMinorUnits(paymentCheckout.amountMinor).replace(
                    "₹",
                    "",
                  )}{" "}
                  via Razorpay Test
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      {/* Transaction notifications — stacked sequentially (top-right, BELOW the
          fixed h-16 top navbar so they are never hidden behind it; height-bounded
          so many toasts scroll instead of overflowing into the bottom-center
          Razorpay checkout card). */}
      {toasts.length > 0 && (
        <div className="fixed top-[4.5rem] right-4 z-[100] flex max-h-[calc(100vh-6rem)] w-[340px] flex-col gap-2 overflow-y-auto pb-1">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={cn(
                "w-full shrink-0 overflow-hidden rounded-xl border bg-white shadow-2xl animate-in fade-in slide-in-from-top-2 duration-200",
                toast.decision === "ALLOW"
                  ? "border-emerald-300"
                  : toast.decision === "DENY"
                    ? "border-red-300"
                    : "border-[#ffb822]/50",
              )}
            >
              <div
                className={cn(
                  "flex items-center justify-between gap-2 px-4 py-2.5 text-xs font-semibold",
                  toast.decision === "ALLOW"
                    ? "bg-emerald-50 text-emerald-700"
                    : toast.decision === "DENY"
                      ? "bg-red-50 text-red-700"
                      : "bg-[#fff7e0] text-[#946400]",
                )}
              >
                <span className="flex items-center gap-1.5">
                  {toast.decision === "ALLOW" ? (
                    <CheckCircle2 className="w-4 h-4" />
                  ) : toast.decision === "DENY" ? (
                    <XCircle className="w-4 h-4" />
                  ) : (
                    <AlertTriangle className="w-4 h-4" />
                  )}
                  {toast.title}
                </span>
                <button
                  type="button"
                  onClick={() => dismissToast(toast.id)}
                  aria-label="Dismiss notification"
                  className="flex h-6 w-6 items-center justify-center rounded-md opacity-60 transition-colors hover:bg-black/5 hover:opacity-100"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="px-4 py-3 space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-text-secondary text-xs">
                    {toast.quantity} unit{toast.quantity > 1 ? "s" : ""}
                  </span>
                  <span className="font-semibold text-text-primary">
                    {formatMinorUnits(toast.grandTotalMinor)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-text-secondary text-xs">Per unit</span>
                  <span className="text-text-secondary text-xs">
                    {formatMinorUnits(toast.perUnitMinor)}
                  </span>
                </div>

                {toast.bargain && (
                  <div className="mt-1 rounded-lg border border-[#ffb822]/30 bg-[#fffbea] px-3 py-2">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-[#946400]">
                      <Handshake className="w-3.5 h-3.5" />
                      {toast.bargain.outcome === "AGREED"
                        ? "Bargain agreed"
                        : "Bargain applied"}{" "}
                      · {((toast.bargain.discountBps ?? 0) / 100).toFixed(1)}%
                      off
                    </div>
                    <div className="mt-1 flex items-center justify-between text-xs">
                      <span className="text-text-secondary">
                        You saved on this order
                      </span>
                      <span className="font-semibold text-emerald-600">
                        {formatMinorUnits(toast.bargain.savingsMinor)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
