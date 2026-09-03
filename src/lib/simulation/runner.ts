import { generateExchange, isPersonaDisabled } from "@/lib/ai/persona";
import type { AiConfigInput } from "@/lib/ai/provider";
import { generateTraceId } from "@/lib/utils";
import type { SimulatedBuyerAgent } from "./buyer-agent";
import type { Scenario } from "./scenarios";

/** Minimal shapes of merchant API responses consumed by the runner. */
interface CatalogItem {
  productId: string;
  variantId: string;
  title: string;
  category: string;
  rating?: { average: number; count: number };
  discoveryPrice?: { amountMinor: number };
  availability?: { status: string };
}

interface ProductDetail {
  variantId?: string;
  title?: string;
  pricing?: { amountMinor: number };
  availability?: { status: string };
}

interface NegotiateResponse {
  success: boolean;
  sessionId?: string;
  outcome?: "AGREED" | "COUNTER_OFFER" | "REJECTED";
  round?: number;
  roundsRemaining?: number;
  discountBps?: number;
  lineSavingsMinor?: number;
  requiresMerchantApproval?: boolean;
  merchantMessage?: string;
  buyerGuidance?: string;
  reasonCodes?: string[];
  status?: string;
  error?: string;
}

interface CheckoutQuoteItem {
  discountBps?: number;
  negotiation?: { merchantMessage?: string };
}

interface CheckoutResponse {
  cartMandate?: {
    id: string;
    items: CheckoutQuoteItem[];
    totals: { grandTotalMinor: number };
  };
  policyEvaluation?: {
    decisionId: string;
    decision: "ALLOW" | "STEP_UP" | "DENY";
  };
  merchantAgentNegotiations?: Array<{ merchantMessage?: string }>;
}

interface VerifyResponse {
  verificationId?: string;
  decision?: "ALLOW" | "STEP_UP" | "DENY";
  explanation?: string;
}

interface ConfirmResponse {
  success?: boolean;
  decision?: "ALLOW" | "STEP_UP" | "DENY";
  explanation?: string;
  reasonCodes?: string[];
  paymentActionId?: string;
  status?: string;
  razorpayOrderId?: string;
  razorpayKeyId?: string;
  amountMinor?: number;
  currency?: string;
}

interface CheckoutItemInput {
  variantId: string;
  quantity: number;
  discoveryPriceMinor?: number;
}

function formatMinor(minor: number): string {
  return `₹${(minor / 100).toFixed(2)}`;
}

export interface SimulationCommunication {
  from:
    | "buyer_agent"
    | "merchant_agent"
    | "policy_gate"
    | "payment_orchestrator";
  message: string;
}

export interface SimulationEvent {
  stepIndex: number;
  type: string;
  description: string;
  timestamp: string;
  durationMs: number;
  requestPayload?: unknown;
  responsePayload?: unknown;
  communications?: SimulationCommunication[];
  status: "success" | "warning" | "error";
  summary: string;
}

export interface NegotiationSummary {
  attempted: boolean;
  outcome: "AGREED" | "COUNTER_OFFER" | "REJECTED" | "NOT_ATTEMPTED";
  rounds: number;
  finalDiscountBps: number;
  savingsMinor: number;
  requiresMerchantApproval: boolean;
}

export interface SettlementInfo {
  quantity: number;
  grandTotalMinor: number;
  perUnitMinor: number;
  discounted: boolean;
  discountBps: number;
  savingsMinor: number;
  outcome: NegotiationSummary["outcome"];
  /** When true the order was created but left `payment_pending` so the client
   * must complete a real Razorpay checkout (amount above the modal threshold).
   * All of the order data needed to open the checkout modal is surfaced here. */
  needsCheckout?: boolean;
  razorpayOrderId?: string;
  razorpayKeyId?: string;
  amountMinor?: number;
  currency?: string;
  paymentStatus?: "pending_payment" | "paid" | "failed";
}

export interface SimulationResult {
  traceId: string;
  scenarioId: string;
  scenarioName: string;
  category: string;
  success: boolean;
  finalDecision: "ALLOW" | "STEP_UP" | "DENY" | "ERROR";
  expectedDecision: "ALLOW" | "STEP_UP" | "DENY";
  totalDurationMs: number;
  events: SimulationEvent[];
  negotiation?: NegotiationSummary;
  settlement?: SettlementInfo;
  summary: string;
  pendingConfirmation?: {
    cartMandateId: string;
    decisionId: string;
    items: Array<{ variantId: string; quantity: number }>;
    verificationId: string;
    negotiationSessionId?: string;
    intentMandateId: string;
    grandTotalMinor: number;
  };
  upsell?: {
    offers: Array<{
      offerId: string;
      title: string;
      description: string;
      items: Array<{
        variantId: string;
        title: string;
        category: string;
        quantity: number;
        unitAmountMinor: number;
        lineAmountMinor: number;
      }>;
      addedTotalMinor: number;
      bundleDiscountMinor: number;
      bundleDiscountBps: number;
    }>;
    cartSubtotalMinor: number;
    maxUpliftMinor: number;
    totalUpliftMinor: number;
  };
}

export interface CustomSimulationConfig {
  instruction: string;
  searchQuery: string;
  budgetInr: number;
  budgetTolerancePercent?: number; // e.g. 0, 5, 10, 15, 20
  quantity?: number;
  minRating?: number;
  category?: string;
  strategy?: "best_match_within_budget" | "lowest_price" | "maximize_quality";
  negotiateForBulk?: boolean;
  agentId?: string;
  agentName?: string;
  userId?: string;
}

interface StepAccumulator {
  events: SimulationEvent[];
  nextStepIndex: number;
}

function createEvent(
  acc: StepAccumulator,
  input: {
    type: string;
    description: string;
    durationMs: number;
    requestPayload?: unknown;
    responsePayload?: unknown;
    communications?: SimulationCommunication[];
    status: "success" | "warning" | "error";
    summary: string;
  },
): void {
  acc.events.push({
    stepIndex: acc.nextStepIndex++,
    description: input.description,
    type: input.type,
    durationMs: input.durationMs,
    requestPayload: input.requestPayload,
    responsePayload: input.responsePayload,
    communications: input.communications,
    status: input.status,
    summary: input.summary,
    timestamp: new Date().toISOString(),
  });
}

export class SimulationRunner {
  private agent: SimulatedBuyerAgent;
  private baseUrl: string;
  private llm?: AiConfigInput | null;
  /** Wall-clock budget for AI dialogue generation per run (ms). */
  private personaDeadline = 0;

  constructor(
    agent: SimulatedBuyerAgent,
    baseUrl = "http://localhost:3000",
    llm?: AiConfigInput | null,
  ) {
    this.agent = agent;
    this.baseUrl = baseUrl;
    this.llm = llm;
    // Keep total LLM dialogue time bounded — protocol steps must stay snappy.
    this.personaDeadline = Date.now() + 20_000;
  }

  /**
   * Produce the buyer↔merchant dialogue for a protocol step. When a buyer
   * LLM key is configured the lines are genuinely generated from live
   * context; otherwise structured heuristic lines keep the run functional.
   * Once the run's persona budget is exhausted, fallback is instant.
   */
  private personaAvailable(): boolean {
    if (!this.llm?.apiKey) return false;
    if (isPersonaDisabled()) return false;
    return Date.now() < this.personaDeadline;
  }

  private async comms(
    _step: string,
    ctx: Parameters<typeof generateExchange>[0],
    fallback: SimulationCommunication[],
  ): Promise<SimulationCommunication[]> {
    if (!this.personaAvailable()) return fallback;
    try {
      const exchange = await generateExchange(ctx, this.llm);
      if (exchange) {
        return [
          { from: "buyer_agent", message: exchange.buyer },
          { from: "merchant_agent", message: exchange.merchant },
        ];
      }
    } catch {
      // fall through to deterministic dialogue
    }
    return fallback;
  }

  /**
   * Voice ONLY the buyer line — used on negotiation steps where the real
   * merchant reply arrives from the live /v1/agent/negotiate protocol call.
   */
  private async buyerLine(
    _step: string,
    ctx: Parameters<typeof generateExchange>[0],
    fallback: string,
  ): Promise<SimulationCommunication[]> {
    if (!this.personaAvailable()) {
      return [{ from: "buyer_agent", message: fallback }];
    }
    try {
      const exchange = await generateExchange(ctx, this.llm);
      if (exchange?.buyer) {
        return [{ from: "buyer_agent", message: exchange.buyer }];
      }
    } catch {
      // fall through
    }
    return [{ from: "buyer_agent", message: fallback }];
  }

  /**
   * Run a pre-built static or template scenario
   */
  async run(scenario: Scenario): Promise<SimulationResult> {
    const traceId = generateTraceId();
    const events: SimulationEvent[] = [];
    const startTime = Date.now();

    let lastVerificationId = "";
    let lastCartMandateId = "";
    let lastDecisionId = "";
    let lastCheckoutTotalMinor: number | undefined;
    let lastCheckoutQuantity = 1;
    let resultSettlement: SettlementInfo | undefined;
    let finalDecision: "ALLOW" | "STEP_UP" | "DENY" | "ERROR" = "ALLOW";

    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      const stepStart = Date.now();
      let stepStatus: "success" | "warning" | "error" = "success";
      let summary = "";
      let responsePayload: unknown = null;
      const requestPayload: unknown = step.payload;

      try {
        if (step.type === "discover") {
          const res = await this.agent.discoverMerchant(this.baseUrl);
          responsePayload = res;
          summary = `Discovered merchant '${res.merchantName}' (${res.protocol}) with endpoints: [${Object.keys(res.endpoints || {}).join(", ")}]`;
        } else if (step.type === "search") {
          const query = (step.payload?.q as string) || "";
          const res = await this.agent.searchCatalog(this.baseUrl, query);
          responsePayload = res;
          summary = `Catalog search '${query}' returned ${res.items?.length || 0} matching items.`;
        } else if (step.type === "select") {
          const variantId =
            (step.payload?.variantId as string) || "kbd_nimbus_75_black_brown";
          const res = await this.agent.getProduct(this.baseUrl, variantId);
          responsePayload = res;
          summary = `Retrieved product '${res.title}' - Base price: ₹${((res.pricing?.amountMinor || 0) / 100).toFixed(2)} (${res.availability?.status})`;
        } else if (step.type === "verify") {
          const constraints = step.payload as
            | Record<string, unknown>
            | undefined;
          const override = constraints
            ? ({ constraints } as unknown as Parameters<
                SimulatedBuyerAgent["verify"]
              >[1])
            : undefined;
          const res: VerifyResponse = await this.agent.verify(
            this.baseUrl,
            override,
          );
          responsePayload = res;
          lastVerificationId = res.verificationId || "";
          finalDecision = res.decision || "ALLOW";
          summary = `Agent mandate verification: [${res.decision}] - ${res.explanation}`;
          if (res.decision === "DENY") stepStatus = "error";
          if (res.decision === "STEP_UP") stepStatus = "warning";
        } else if (step.type === "changePrice") {
          summary = `Simulated discovery vs quoted price change: Discovery was ₹${((step.payload?.discoveryPriceMinor as number) / 100).toFixed(2)}, Quoting at ₹${((step.payload?.unitAmountMinor as number) / 100).toFixed(2)}`;
          responsePayload = {
            priceDifferenceNotice: "Slippage exceeds 200 bps threshold",
          };
          stepStatus = "warning";
        } else if (step.type === "injectMalicious") {
          summary = `Intercepted adversarial injection attempt: "${step.payload?.adversarialPrompt}"`;
          responsePayload = {
            defenseTriggered: true,
            action: "Sanitize & Enforce Deterministic Schema",
          };
          stepStatus = "warning";
        } else if (step.type === "checkout") {
          const items = (step.payload?.items as
            | CheckoutItemInput[]
            | undefined) ?? [
            {
              variantId: "kbd_nimbus_75_black_brown",
              quantity: 1,
              discoveryPriceMinor: 349900,
            },
          ];
          const res = await this.agent.checkout(
            this.baseUrl,
            items,
            lastVerificationId,
          );
          responsePayload = res;

          if (res.cartMandate) {
            lastCartMandateId = res.cartMandate.id;
            lastCheckoutTotalMinor = res.cartMandate.totals?.grandTotalMinor;
            lastCheckoutQuantity = Math.max(
              1,
              (res.cartMandate.items || []).reduce(
                (n: number, item: { quantity?: number }) =>
                  n + (item.quantity || 0),
                0,
              ),
            );
          }
          if (res.policyEvaluation) {
            lastDecisionId = res.policyEvaluation.decisionId;
            finalDecision = res.policyEvaluation.decision;
            if (res.policyEvaluation.decision === "DENY") stepStatus = "error";
            if (res.policyEvaluation.decision === "STEP_UP")
              stepStatus = "warning";
          }

          const grandTotal = res.cartMandate?.totals?.grandTotalMinor
            ? `₹${(res.cartMandate.totals.grandTotalMinor / 100).toFixed(2)}`
            : "N/A";

          summary = `Authoritative Quote: ${res.cartMandate?.id || "None"} Total: ${grandTotal}. Policy Decision: [${res.policyEvaluation?.decision || "DENY"}]`;
        } else if (step.type === "confirm") {
          const paymentMethod =
            (step.payload?.paymentMethod as string) || "simulated_uap";
          const res = await this.agent.confirm(
            this.baseUrl,
            lastCartMandateId,
            lastDecisionId,
            paymentMethod,
          );
          responsePayload = res;
          // A non-settling confirm: the merchant's Surge Pricing re-priced the
          // in-flight transaction to STEP_UP (or another gate blocked it). The
          // confirm payload carries the decision + reason codes — surface them
          // instead of fabricating a pending order.
          if (
            res.success === false ||
            res.decision === "STEP_UP" ||
            (Array.isArray(res.reasonCodes) && res.reasonCodes.length > 0)
          ) {
            stepStatus = "warning";
            const surgeBlocked =
              Array.isArray(res.reasonCodes) &&
              res.reasonCodes.includes("SURGE_PRICING_ACTIVE");
            summary = surgeBlocked
              ? `Surge pricing active — this in-flight transaction was re-priced +15% and escalated to STEP_UP (SURGE_PRICING_ACTIVE). Settlement blocked: the merchant must approve the surged price before a refreshed test checkout.`
              : `Policy escalated settlement: ${res.reasonCodes?.join(", ") || res.decision || "STEP_UP"}. ${res.explanation || ""}`.trim();
          } else if (res.status === "payment_pending" && res.razorpayOrderId) {
            const grandTotalMinor =
              lastCheckoutTotalMinor ?? res.amountMinor ?? 0;
            resultSettlement = {
              quantity: lastCheckoutQuantity,
              grandTotalMinor,
              perUnitMinor: grandTotalMinor / lastCheckoutQuantity,
              discounted: false,
              discountBps: 0,
              savingsMinor: 0,
              outcome: "AGREED",
              needsCheckout: true,
              razorpayOrderId: res.razorpayOrderId,
              razorpayKeyId: res.razorpayKeyId || "",
              amountMinor: res.amountMinor,
              currency: res.currency,
              paymentStatus: "pending_payment",
            };
            summary = `Created Razorpay order ${res.razorpayOrderId} via ${paymentMethod} (${res.status}) — real test checkout required.`;
          } else {
            summary = `Settled payment action ${res.paymentActionId} via ${paymentMethod} (${res.status}).`;
          }
        }
      } catch (err) {
        stepStatus = "error";
        summary = `Step failed with error: ${String(err)}`;
        responsePayload = { error: String(err) };
        finalDecision = "ERROR";
      }

      const durationMs = Date.now() - stepStart;
      events.push({
        stepIndex: i + 1,
        type: step.type,
        description: step.description,
        timestamp: new Date().toISOString(),
        durationMs,
        requestPayload,
        responsePayload,
        status: stepStatus,
        summary,
      });

      if (
        stepStatus === "error" &&
        step.type !== "verify" &&
        scenario.category === "happy_path"
      ) {
        break;
      }
    }

    const totalDurationMs = Date.now() - startTime;
    const isSuccess = finalDecision === scenario.expectedDecision;

    return {
      traceId,
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      category: scenario.category,
      success: isSuccess,
      finalDecision,
      expectedDecision: scenario.expectedDecision,
      totalDurationMs,
      events,
      summary: isSuccess
        ? resultSettlement
          ? `Scenario '${scenario.name}' completed as expected with decision [${finalDecision}]. Order ${resultSettlement.razorpayOrderId} is pending a real Razorpay test checkout.`
          : `Scenario '${scenario.name}' completed as expected with decision [${finalDecision}].`
        : `Scenario outcome was [${finalDecision}], expected [${scenario.expectedDecision}].`,
      settlement: resultSettlement,
    };
  }

  /**
   * Run a truly autonomous, parameter-driven AI agent simulation that:
   * discovers the merchant, evaluates candidates against its mandate,
   * NEGOTIATES bulk pricing with the merchant agent (real protocol calls),
   * verifies proofs, obtains an authoritative quote honoring negotiated
   * terms, and settles — with every inter-agent message captured.
   */
  async runAutonomous(
    config: CustomSimulationConfig,
  ): Promise<SimulationResult> {
    const traceId = generateTraceId();
    const acc: StepAccumulator = { events: [], nextStepIndex: 1 };
    const startTime = Date.now();

    const budgetInr = Math.max(0, Number(config.budgetInr) || 0);
    const tolerancePercent = Math.max(
      0,
      Number(config.budgetTolerancePercent) || 0,
    );
    const maxBudgetCapMinor = Math.round(
      budgetInr * (1 + tolerancePercent / 100) * 100,
    );
    const toleranceBps = Math.round(tolerancePercent * 100);
    const requestedQuantity = Math.max(1, Number(config.quantity) || 1);
    const minRating = config.minRating
      ? Math.max(0, Math.min(5, Number(config.minRating)))
      : 0;
    const searchQuery = (config.searchQuery || "").trim();
    const instruction =
      config.instruction ||
      `Purchase items matching '${searchQuery}' under ₹${budgetInr.toLocaleString("en-IN")}`;
    const strategy = config.strategy || "best_match_within_budget";
    // Negotiate whenever buying more than one unit unless explicitly disabled
    const shouldNegotiate =
      config.negotiateForBulk !== false && requestedQuantity >= 2;

    let lastVerificationId = "";
    let lastCartMandateId = "";
    let lastDecisionId = "";
    let finalDecision: "ALLOW" | "STEP_UP" | "DENY" | "ERROR" = "ALLOW";
    let lastGrandTotalMinor: number | undefined;
    let lastLineCount = 0;
    let lastSettlement: SettlementInfo | null = null;
    let lastConfirmBlockedBySurge = false;

    let catalogItems: CatalogItem[] = [];
    let selectedVariant: ProductDetail | null = null;
    let selectedBasePriceMinor = 0;
    let isItemAffordable = false;

    const negotiationSummary: NegotiationSummary = {
      attempted: false,
      outcome: "NOT_ATTEMPTED",
      rounds: 0,
      finalDiscountBps: 0,
      savingsMinor: 0,
      requiresMerchantApproval: false,
    };

    // STEP: Discovery
    {
      const stepStart = Date.now();
      let stepStatus: "success" | "warning" | "error" = "success";
      let summary = "";
      let responsePayload: unknown = null;

      try {
        const manifest = await this.agent.discoverMerchant(this.baseUrl);
        responsePayload = manifest;
        summary = `Discovered merchant '${manifest.merchantName}' (${manifest.protocol}). Capabilities: [${Object.entries(
          manifest.capabilities || {},
        )
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(", ")}].`;
      } catch (err) {
        stepStatus = "error";
        summary = `Merchant discovery failed: ${String(err)}`;
        responsePayload = { error: String(err) };
      }

      createEvent(acc, {
        type: "discover",
        description:
          "Fetch merchant discovery manifest & protocol capabilities",
        durationMs: Date.now() - stepStart,
        requestPayload: {
          url: `${this.baseUrl}/.well-known/agent-commerce.json`,
        },
        responsePayload,
        communications: await this.comms(
          "capability_handshake",
          { step: "capability_handshake", instruction },
          [
            {
              from: "buyer_agent",
              message: "Sending capability handshake — what can your store do?",
            },
            {
              from: "merchant_agent",
              message:
                "Manifest served. Catalog search, authoritative checkout, agent-to-agent negotiation, and ratings are available.",
            },
          ],
        ),
        status: stepStatus,
        summary,
      });
    }

    // STEP: Catalog Search
    {
      const stepStart = Date.now();
      let stepStatus: "success" | "warning" | "error" = "success";
      let summary = "";
      let responsePayload: unknown = null;

      try {
        const catalogRes = await this.agent.searchCatalog(
          this.baseUrl,
          searchQuery,
        );
        catalogItems = catalogRes.items || [];
        responsePayload = {
          total: catalogRes.total,
          itemsCount: catalogItems.length,
          items: catalogItems,
        };

        if (catalogItems.length === 0 && searchQuery) {
          const fallbackRes = await this.agent.searchCatalog(this.baseUrl, "");
          if (fallbackRes.items && fallbackRes.items.length > 0) {
            catalogItems = fallbackRes.items;
            summary = `Search for '${searchQuery}' yielded 0 direct SKUs. Retrieved ${catalogItems.length} store catalogue items as alternatives.`;
          } else {
            summary = `Catalog search for '${searchQuery}' returned 0 items in merchant store.`;
          }
        } else {
          summary = `Catalog query '${searchQuery}' returned ${catalogItems.length} matching product variants.`;
        }
      } catch (err) {
        stepStatus = "error";
        summary = `Catalog search failed: ${String(err)}`;
        responsePayload = { error: String(err) };
      }

      createEvent(acc, {
        type: "search",
        description: `Search catalogue for '${searchQuery || "all products"}'`,
        durationMs: Date.now() - stepStart,
        requestPayload: {
          q: searchQuery,
          category: config.category || undefined,
        },
        responsePayload,
        communications: await this.comms(
          "catalog_search",
          {
            step: "catalog_search",
            instruction,
            searchQuery,
            quantity: requestedQuantity,
            titles: catalogItems.slice(0, 5).map((i) => i.title),
          },
          [
            {
              from: "buyer_agent",
              message: `Looking for ${requestedQuantity} unit(s) of '${searchQuery}'. Send candidates with ratings and stock bands.`,
            },
            {
              from: "merchant_agent",
              message: `${catalogItems.length} candidate SKU(s) returned with discovery pricing, ratings, and availability.`,
            },
          ],
        ),
        status: stepStatus,
        summary,
      });
    }

    // STEP: Autonomous Evaluation & Variant Selection
    {
      const stepStart = Date.now();
      let stepStatus: "success" | "warning" | "error" = "success";
      let summary = "";
      let responsePayload: unknown = null;

      const evaluationDetails: Array<{
        productId: string;
        variantId: string;
        title: string;
        category: string;
        rating?: { average: number; count: number };
        meetsRating: boolean;
        basePriceInr: number;
        estimatedTaxInr: number;
        estimatedLandedUnitInr: number;
        totalEstimatedLandedInr: number;
        fitsWithinAuthorizedCap: boolean;
        inStock: boolean;
      }> = [];

      for (const item of catalogItems) {
        const basePriceMinor = item.discoveryPrice?.amountMinor || 0;
        const estimatedTaxMinor = Math.round(basePriceMinor * 0.18);
        const estimatedUnitLandedMinor = basePriceMinor + estimatedTaxMinor;
        const totalEstimatedLandedMinor =
          estimatedUnitLandedMinor * requestedQuantity;
        const fitsInCap = totalEstimatedLandedMinor <= maxBudgetCapMinor;
        const ratingAverage = Number(item.rating?.average || 0);

        evaluationDetails.push({
          productId: item.productId,
          variantId: item.variantId,
          title: item.title,
          category: item.category,
          rating: item.rating,
          meetsRating: minRating === 0 || ratingAverage >= minRating,
          basePriceInr: basePriceMinor / 100,
          estimatedTaxInr: estimatedTaxMinor / 100,
          estimatedLandedUnitInr: estimatedUnitLandedMinor / 100,
          totalEstimatedLandedInr: totalEstimatedLandedMinor / 100,
          fitsWithinAuthorizedCap: fitsInCap,
          inStock: item.availability?.status !== "out_of_stock",
        });
      }

      const affordableCandidates = evaluationDetails.filter(
        (c) => c.fitsWithinAuthorizedCap && c.inStock && c.meetsRating,
      );

      let chosenCandidate = null;
      if (affordableCandidates.length > 0) {
        if (strategy === "lowest_price") {
          affordableCandidates.sort(
            (a, b) => a.totalEstimatedLandedInr - b.totalEstimatedLandedInr,
          );
          chosenCandidate = affordableCandidates[0];
        } else if (strategy === "maximize_quality") {
          affordableCandidates.sort(
            (a, b) => b.totalEstimatedLandedInr - a.totalEstimatedLandedInr,
          );
          chosenCandidate = affordableCandidates[0];
        } else {
          chosenCandidate = affordableCandidates[0];
        }
        isItemAffordable = true;
      } else if (evaluationDetails.length > 0) {
        evaluationDetails.sort(
          (a, b) => a.totalEstimatedLandedInr - b.totalEstimatedLandedInr,
        );
        chosenCandidate = evaluationDetails[0];
        isItemAffordable = false;
      }

      if (chosenCandidate) {
        try {
          const productDetail: ProductDetail = await this.agent.getProduct(
            this.baseUrl,
            chosenCandidate.variantId,
          );
          selectedVariant = productDetail;
          selectedBasePriceMinor =
            productDetail.pricing?.amountMinor ||
            Math.round(chosenCandidate.basePriceInr * 100);

          if (isItemAffordable) {
            summary = `Selected '${chosenCandidate.title}' (${chosenCandidate.variantId}) — rated ${chosenCandidate.rating?.average ?? "N/A"}/5 by ${chosenCandidate.rating?.count ?? 0} buyers — within the ₹${budgetInr.toLocaleString("en-IN")} ±${tolerancePercent}% mandate cap.`;
          } else {
            stepStatus = "warning";
            summary = `⚠️ No candidate SKU fit within ₹${(maxBudgetCapMinor / 100).toFixed(2)} cap. Selected closest item '${chosenCandidate.title}' to test policy bounds.`;
          }

          responsePayload = {
            selectedVariantId: chosenCandidate.variantId,
            title: chosenCandidate.title,
            basePriceMinor: selectedBasePriceMinor,
            withinBudgetCap: isItemAffordable,
            candidateEvaluations: evaluationDetails,
            productDetail,
          };
        } catch (err) {
          stepStatus = "error";
          summary = `Failed to fetch variant details: ${String(err)}`;
          responsePayload = { error: String(err) };
        }
      } else {
        stepStatus = "error";
        summary = "No products found in catalogue to evaluate.";
        responsePayload = { evaluationDetails };
      }

      createEvent(acc, {
        type: "select",
        description: `Evaluate items against ₹${budgetInr.toLocaleString("en-IN")} (±${tolerancePercent}%) mandate & select best variant`,
        durationMs: Date.now() - stepStart,
        requestPayload: {
          budgetInr,
          budgetTolerancePercent: tolerancePercent,
          maxBudgetCapMinor,
          minRating: minRating || undefined,
          strategy,
          requestedQuantity,
        },
        responsePayload,
        communications: await this.comms(
          "variant_selection",
          {
            step: "variant_selection",
            instruction,
            searchQuery,
            quantity: requestedQuantity,
            budgetCapMinor: maxBudgetCapMinor,
            selectedTitle: chosenCandidate?.title,
            priceMinor: selectedBasePriceMinor || undefined,
            outcome: isItemAffordable ? "WITHIN_BUDGET" : "OVER_BUDGET",
          },
          [
            {
              from: "buyer_agent",
              message: `My preference is ${strategy.replace(/_/g, " ")}, ${requestedQuantity} unit(s), hard ceiling ₹${(maxBudgetCapMinor / 100).toFixed(2)}.`,
            },
            {
              from: "merchant_agent",
              message: chosenCandidate
                ? `'${chosenCandidate.title}' matches best — rating ${chosenCandidate.rating?.average ?? "N/A"}/5 from ${chosenCandidate.rating?.count ?? 0} buyers.`
                : "No candidate available for this mandate.",
            },
          ],
        ),
        status: stepStatus,
        summary,
      });
    }

    // STEP: Mandate Proof Submission & Verification
    {
      const stepStart = Date.now();
      let stepStatus: "success" | "warning" | "error" = "success";
      let summary = "";
      let responsePayload: unknown = null;

      const mandateOverride = {
        instruction,
        constraints: {
          currency: "INR",
          maxTransactionAmountMinor: maxBudgetCapMinor,
          maxPriceSlippageBps: Math.max(toleranceBps, 200),
          requiresRefundability: true,
          quantityMax: Math.max(10, requestedQuantity * 2),
        },
      };

      try {
        const verifyRes: VerifyResponse = await this.agent.verify(
          this.baseUrl,
          mandateOverride,
        );
        responsePayload = verifyRes;
        lastVerificationId = verifyRes.verificationId || "";
        finalDecision = verifyRes.decision || "ALLOW";

        summary = `Intent Mandate verified: [${verifyRes.decision}] — cap authorized at ₹${(maxBudgetCapMinor / 100).toFixed(2)} (±${tolerancePercent}%). ${verifyRes.explanation}`;
        if (verifyRes.decision === "DENY") stepStatus = "error";
        if (verifyRes.decision === "STEP_UP") stepStatus = "warning";
      } catch (err) {
        stepStatus = "error";
        summary = `Mandate verification failed: ${String(err)}`;
        responsePayload = { error: String(err) };
        finalDecision = "ERROR";
      }

      createEvent(acc, {
        type: "verify",
        description: `Submit Intent Mandate proof with ₹${(maxBudgetCapMinor / 100).toLocaleString("en-IN")} cap`,
        durationMs: Date.now() - stepStart,
        requestPayload: mandateOverride,
        responsePayload,
        communications: await this.comms(
          "mandate_verification",
          {
            step: "mandate_verification",
            instruction,
            budgetCapMinor: maxBudgetCapMinor,
            decision: finalDecision,
          },
          [
            {
              from: "buyer_agent",
              message: `Presenting signed mandate: max spend ₹${(maxBudgetCapMinor / 100).toFixed(2)}, quantity up to ${Math.max(10, requestedQuantity * 2)}, refundability required.`,
            },
            {
              from: "policy_gate",
              message: `Proof accepted. Verification decision: ${finalDecision}. Verification ID issued.`,
            },
          ],
        ),
        status: stepStatus,
        summary,
      });
    }

    // STEPS: Agent-to-Agent Bulk Negotiation (real protocol calls)
    let negotiationSessionId: string | undefined;
    const captureNegotiation = (res: NegotiateResponse) => {
      negotiationSummary.attempted = true;
      negotiationSummary.rounds += 1;
      if (res.sessionId && !negotiationSessionId)
        negotiationSessionId = res.sessionId;
      if (res.outcome) negotiationSummary.outcome = res.outcome;
      negotiationSummary.finalDiscountBps = res.discountBps ?? 0;
      if (res.lineSavingsMinor !== undefined)
        negotiationSummary.savingsMinor = res.lineSavingsMinor;
      negotiationSummary.requiresMerchantApproval = Boolean(
        res.requiresMerchantApproval,
      );
    };

    if (shouldNegotiate && selectedVariant?.variantId) {
      const variantId = selectedVariant.variantId;
      const title = selectedVariant.title || variantId;
      const listPriceStr = `₹${(selectedBasePriceMinor / 100).toFixed(2)}`;

      // Round 1: open
      {
        const stepStart = Date.now();
        let stepStatus: "success" | "warning" | "error" = "success";
        let summary = "";
        let openRes: NegotiateResponse | null = null;
        const buyerOpenMsg = `I want ${requestedQuantity} units of '${title}' at list ${listPriceStr}. What's your best bulk price?`;

        try {
          const res: NegotiateResponse = await this.agent.negotiate(
            this.baseUrl,
            {
              action: "open",
              items: [{ variantId, quantity: requestedQuantity }],
              buyerMessage: buyerOpenMsg,
            },
          );
          openRes = res;
          captureNegotiation(res);

          if (!res.success) {
            stepStatus = "warning";
            summary = `Negotiation could not be opened: ${res.error}`;
          } else {
            summary = `Merchant agent opened at ${((res.discountBps ?? 0) / 100).toFixed(1)}% off (${(res.outcome || "").replace(/_/g, " ").toLowerCase()}).`;
            if (res.outcome === "REJECTED") stepStatus = "warning";
          }
        } catch (err) {
          stepStatus = "error";
          summary = `Negotiation open failed: ${String(err)}`;
        }

        createEvent(acc, {
          type: "negotiate_open",
          description: `Open price negotiation for ${requestedQuantity} x ${variantId}`,
          durationMs: Date.now() - stepStart,
          requestPayload: {
            action: "open",
            items: [{ variantId, quantity: requestedQuantity }],
          },
          responsePayload: openRes,
          communications: [
            ...(await this.buyerLine(
              "negotiation_open",
              {
                step: "negotiation_open",
                instruction,
                searchQuery,
                quantity: requestedQuantity,
                selectedTitle: title,
                priceMinor: selectedBasePriceMinor,
                outcome: openRes?.outcome,
                discountBps: openRes?.discountBps,
                roundsRemaining: openRes?.roundsRemaining,
              },
              buyerOpenMsg,
            )),
            ...(openRes?.merchantMessage
              ? [
                  {
                    from: "merchant_agent" as const,
                    message: openRes.merchantMessage,
                  },
                ]
              : []),
          ],
          status: stepStatus,
          summary,
        });
      }

      // Round 2: haggle (+2.5% over current offer)
      if (
        negotiationSessionId &&
        negotiationSummary.outcome === "COUNTER_OFFER"
      ) {
        const stepStart = Date.now();
        let stepStatus: "success" | "warning" | "error" = "success";
        let summary = "";
        let haggleRes: NegotiateResponse | null = null;

        const targetBps = Math.min(
          9900,
          negotiationSummary.finalDiscountBps + 250,
        );
        const buyerHaggleMsg = `Push to ${(targetBps / 100).toFixed(1)}% and my mandate clears today.`;

        try {
          const res: NegotiateResponse = await this.agent.negotiate(
            this.baseUrl,
            {
              action: "respond",
              sessionId: negotiationSessionId,
              targetDiscountBps: targetBps,
              buyerMessage: buyerHaggleMsg,
            },
          );
          haggleRes = res;
          captureNegotiation(res);

          if (res.success) {
            summary =
              res.outcome === "AGREED"
                ? `Merchant met the target: ${((res.discountBps ?? 0) / 100).toFixed(1)}% agreed.`
                : `Merchant countered at ${((res.discountBps ?? 0) / 100).toFixed(1)}% — ${res.roundsRemaining ?? 0} round(s) left.`;
          } else {
            stepStatus = "warning";
            summary = `Counter-round rejected: ${res.error}`;
          }
        } catch (err) {
          stepStatus = "error";
          summary = `Negotiation counter failed: ${String(err)}`;
        }

        createEvent(acc, {
          type: "negotiate_counter",
          description: `Counter-proposal: buyer asks ${(targetBps / 100).toFixed(1)}% off`,
          durationMs: Date.now() - stepStart,
          requestPayload: {
            sessionId: negotiationSessionId,
            targetDiscountBps: targetBps,
          },
          responsePayload: haggleRes,
          communications: [
            ...(await this.buyerLine(
              "negotiation_counter",
              {
                step: "negotiation_counter",
                instruction,
                quantity: requestedQuantity,
                selectedTitle: title,
                priceMinor: selectedBasePriceMinor,
                discountBps: targetBps,
                outcome: haggleRes?.outcome,
                roundsRemaining: haggleRes?.roundsRemaining,
              },
              buyerHaggleMsg,
            )),
            ...(haggleRes?.merchantMessage
              ? [
                  {
                    from: "merchant_agent" as const,
                    message: haggleRes.merchantMessage,
                  },
                ]
              : []),
          ],
          status: stepStatus,
          summary,
        });
      }

      // Round 3: accept standing offer (locks terms) — only if not already agreed
      if (
        negotiationSessionId &&
        negotiationSummary.outcome === "COUNTER_OFFER"
      ) {
        const stepStart = Date.now();
        let stepStatus: "success" | "warning" | "error" = "success";
        let summary = "";
        let acceptRes: NegotiateResponse | null = null;
        const buyerAcceptMsg = `Your latest offer works. Locking ${(negotiationSummary.finalDiscountBps / 100).toFixed(1)}%.`;

        try {
          const res: NegotiateResponse = await this.agent.negotiate(
            this.baseUrl,
            {
              action: "respond",
              sessionId: negotiationSessionId,
              acceptCurrentOffer: true,
              buyerMessage: buyerAcceptMsg,
            },
          );
          acceptRes = res;

          if (res.success && res.outcome === "AGREED") {
            captureNegotiation(res);
            summary = `Terms locked: ${((res.discountBps ?? 0) / 100).toFixed(1)}% off, saving ${formatMinor(res.lineSavingsMinor ?? 0)}.${res.requiresMerchantApproval ? " Requires human STEP_UP approval." : ""}`;
          } else {
            captureNegotiation(res);
            stepStatus = "warning";
            summary = `Could not lock terms: ${res.error || res.outcome}`;
            negotiationSessionId = undefined;
          }
        } catch (err) {
          stepStatus = "error";
          summary = `Negotiation accept failed: ${String(err)}`;
        }

        createEvent(acc, {
          type: "negotiate_accept",
          description: "Buyer accepts standing merchant offer — terms locked",
          durationMs: Date.now() - stepStart,
          requestPayload: {
            sessionId: negotiationSessionId,
            acceptCurrentOffer: true,
          },
          responsePayload: acceptRes,
          communications: [
            ...(await this.buyerLine(
              "negotiation_accept",
              {
                step: "negotiation_accept",
                instruction,
                quantity: requestedQuantity,
                selectedTitle: title,
                priceMinor: selectedBasePriceMinor,
                discountBps:
                  acceptRes?.discountBps ?? negotiationSummary.finalDiscountBps,
                savingsMinor: acceptRes?.lineSavingsMinor,
                outcome: acceptRes?.outcome ?? "AGREED",
              },
              buyerAcceptMsg,
            )),
            ...(acceptRes?.merchantMessage
              ? [
                  {
                    from: "merchant_agent" as const,
                    message: acceptRes.merchantMessage,
                  },
                ]
              : []),
          ],
          status: stepStatus,
          summary,
        });
      }
    }

    // STEP: Authoritative Cart Mandate Checkout Quote
    let checkoutSuccess = false;
    {
      const stepStart = Date.now();
      let stepStatus: "success" | "warning" | "error" = "success";
      let summary = "";
      let responsePayload: unknown = null;

      const variantIdToCheckout =
        selectedVariant?.variantId || "kbd_nimbus_75_black_brown";
      const itemsToCheckout = [
        {
          variantId: variantIdToCheckout,
          quantity: requestedQuantity,
          discoveryPriceMinor: selectedBasePriceMinor || 349900,
        },
      ];

      const checkoutPayload = {
        items: itemsToCheckout,
        verificationId: lastVerificationId,
        negotiationSessionId,
      };

      try {
        const checkoutRes: CheckoutResponse = await this.agent.checkout(
          this.baseUrl,
          itemsToCheckout,
          lastVerificationId,
          {
            instruction,
            constraints: {
              currency: "INR",
              maxTransactionAmountMinor: maxBudgetCapMinor,
              maxPriceSlippageBps: Math.max(toleranceBps, 200),
            },
          },
          negotiationSessionId,
        );

        responsePayload = checkoutRes;

        if (checkoutRes.cartMandate) {
          lastCartMandateId = checkoutRes.cartMandate.id;
          lastGrandTotalMinor = checkoutRes.cartMandate.totals?.grandTotalMinor;
          lastLineCount = checkoutRes.cartMandate.items?.length ?? 0;
        }
        if (checkoutRes.policyEvaluation) {
          lastDecisionId = checkoutRes.policyEvaluation.decisionId;
          finalDecision = checkoutRes.policyEvaluation.decision;
          if (checkoutRes.policyEvaluation.decision === "DENY")
            stepStatus = "error";
          if (checkoutRes.policyEvaluation.decision === "STEP_UP")
            stepStatus = "warning";
          if (checkoutRes.policyEvaluation.decision === "ALLOW")
            checkoutSuccess = true;
        }

        const appliedDiscountBps = Number(
          checkoutRes.cartMandate?.items?.[0]?.discountBps || 0,
        );
        const discountLine =
          appliedDiscountBps > 0
            ? `Includes ${(appliedDiscountBps / 100).toFixed(1)}% negotiated discount${negotiationSessionId ? " (agent-to-agent agreement honored)" : ""}.`
            : "No discount applied.";

        const grandTotalStr = checkoutRes.cartMandate?.totals?.grandTotalMinor
          ? formatMinor(checkoutRes.cartMandate.totals.grandTotalMinor)
          : "N/A";

        summary = `Authoritative Quote: ${checkoutRes.cartMandate?.id || "None"} — Grand Total: ${grandTotalStr}. Policy Decision: [${checkoutRes.policyEvaluation?.decision || "DENY"}]. ${discountLine}`;
      } catch (err) {
        stepStatus = "error";
        summary = `Checkout quote generation failed: ${String(err)}`;
        responsePayload = { error: String(err) };
        finalDecision = "ERROR";
      }

      const quoteResponse = responsePayload as
        | CheckoutResponse
        | { error: string };
      const quoteCheckout = (quoteResponse as CheckoutResponse).cartMandate
        ? (quoteResponse as CheckoutResponse)
        : undefined;
      const quoteCartId = quoteCheckout?.cartMandate?.id;
      const quoteDiscountBps = Number(
        quoteCheckout?.cartMandate?.items?.[0]?.discountBps || 0,
      );
      createEvent(acc, {
        type: "checkout",
        description:
          "Request authoritative Cart Mandate quote (with negotiated terms)",
        durationMs: Date.now() - stepStart,
        requestPayload: checkoutPayload,
        responsePayload,
        communications: [
          ...(await this.comms(
            "authoritative_quote_request",
            {
              step: "authoritative_quote_request",
              instruction,
              quantity: requestedQuantity,
              selectedTitle: selectedVariant?.title,
              priceMinor: selectedBasePriceMinor,
              discountBps: quoteDiscountBps || undefined,
              cartMandateId: quoteCartId,
              decision: finalDecision,
              savingsMinor: negotiationSummary.savingsMinor || undefined,
            },
            [
              {
                from: "buyer_agent",
                message: `Requesting authoritative quote for ${requestedQuantity} x ${variantIdToCheckout}${negotiationSessionId ? `, honoring negotiation ${negotiationSessionId}` : ""}.`,
              },
            ],
          )),
          ...("merchantAgentNegotiations" in quoteResponse &&
          quoteResponse.merchantAgentNegotiations?.[0]?.merchantMessage
            ? [
                {
                  from: "merchant_agent" as const,
                  message: quoteResponse.merchantAgentNegotiations[0]
                    .merchantMessage as string,
                },
              ]
            : []),
          {
            from: "policy_gate",
            message: `Decision ${finalDecision}. Quote snapshot hashed; expiry 15 minutes.`,
          },
        ],
        status: stepStatus,
        summary,
      });
    }

    // STEP: Upsell / Cross-sell — merchant agent suggests compatible add-ons
    let upsellOffers: SimulationResult["upsell"];
    if (
      checkoutSuccess &&
      selectedVariant?.variantId &&
      finalDecision === "ALLOW"
    ) {
      const stepStart = Date.now();
      let stepStatus: "success" | "warning" | "error" = "success";
      let summary = "";
      let responsePayload: unknown = null;

      try {
        const upsellRes = await this.agent.upsell(this.baseUrl, [
          {
            variantId: selectedVariant.variantId,
            quantity: requestedQuantity,
          },
        ]);

        responsePayload = upsellRes;
        if (upsellRes.success && upsellRes.offers?.length > 0) {
          upsellOffers = {
            offers: upsellRes.offers.map(
              (o: {
                offerId: string;
                title: string;
                description: string;
                items: Array<{
                  variantId: string;
                  title: string;
                  category: string;
                  quantity: number;
                  unitAmountMinor: number;
                  lineAmountMinor: number;
                }>;
                addedTotalMinor: number;
                bundleDiscountMinor: number;
                bundleDiscountBps: number;
              }) => ({
                offerId: o.offerId,
                title: o.title,
                description: o.description,
                items: o.items,
                addedTotalMinor: o.addedTotalMinor,
                bundleDiscountMinor: o.bundleDiscountMinor,
                bundleDiscountBps: o.bundleDiscountBps,
              }),
            ),
            cartSubtotalMinor: upsellRes.cartSubtotalMinor,
            maxUpliftMinor: upsellRes.maxBasketUpliftMinor,
            totalUpliftMinor: upsellRes.totalUpliftMinor,
          };
          const bestOffer = upsellRes.offers[0];
          summary = `Merchant agent offered ${upsellRes.offers.length} upsell combo(s): ${bestOffer.title} (₹${((bestOffer.addedTotalMinor || 0) / 100).toFixed(2)} add-on). ${upsellRes.reasonCodes?.join(", ") || ""}`;
        } else {
          summary = "No eligible upsell offers for this cart.";
        }
      } catch (err) {
        stepStatus = "warning";
        summary = `Upsell offer generation failed: ${String(err)}`;
        responsePayload = { error: String(err) };
      }

      const merchantSuggestion =
        upsellOffers && upsellOffers.offers.length > 0
          ? `Your ${selectedVariant.title || selectedVariant?.variantId || "kbd_nimbus_75_black_brown"} pairs beautifully with our accessories. I'd recommend the ${upsellOffers.offers[0].title} — adds ${upsellOffers.offers[0].items.map((i) => i.title).join(" & ")} for ₹${((upsellOffers.offers[0].addedTotalMinor || 0) / 100).toFixed(2)}${upsellOffers.offers[0].bundleDiscountMinor > 0 ? ` (saves ₹${((upsellOffers.offers[0].bundleDiscountMinor || 0) / 100).toFixed(2)} with bundle pricing)` : ""}. Want to add it?`
          : "";

      createEvent(acc, {
        type: "upsell",
        description: "Merchant agent suggests compatible add-on combo",
        durationMs: Date.now() - stepStart,
        requestPayload: {
          cartItems: [
            {
              variantId: selectedVariant.variantId,
              quantity: requestedQuantity,
            },
          ],
        },
        responsePayload,
        communications: merchantSuggestion
          ? [
              {
                from: "merchant_agent" as const,
                message: merchantSuggestion,
              },
              {
                from: "buyer_agent" as const,
                message: upsellOffers
                  ? `The merchant is offering ${upsellOffers.offers.length} combo deal(s). Would you like me to add ${upsellOffers.offers[0].items.map((i) => i.title).join(" & ")} to your cart?`
                  : "No combo deals available right now.",
              },
            ]
          : [
              {
                from: "merchant_agent" as const,
                message:
                  "No additional accessories to recommend for this item right now.",
              },
            ],
        status: stepStatus,
        summary,
      });
    }

    // STEP: Settlement or Policy Bounding Enforcement
    // When upsell offers exist, we pause here — the Razorpay modal should only
    // open after the user accepts or declines the combo deal in the chat.
    const upsellHasOffers = Boolean(
      upsellOffers && upsellOffers.offers.length > 0,
    );
    {
      const stepStart = Date.now();
      let stepStatus: "success" | "warning" | "error" = "success";
      let summary = "";
      let responsePayload: unknown = null;

      if (upsellHasOffers) {
        // Pause: store pending confirmation state for the client to resume
        summary = `Upsell combo deal presented to user. Payment paused — Razorpay modal will open after user accepts or declines the add-on.`;
        responsePayload = {
          action: "PENDING_USER_DECISION",
          reason: "UPSELL_COMBO_OFFERED",
          cartMandateId: lastCartMandateId,
          decisionId: lastDecisionId,
        };
        lastSettlement = {
          quantity: requestedQuantity,
          grandTotalMinor: lastGrandTotalMinor ?? 0,
          perUnitMinor: lastGrandTotalMinor
            ? lastGrandTotalMinor / Math.max(1, lastLineCount)
            : 0,
          discounted:
            (negotiationSummary.finalDiscountBps ?? 0) > 0 ||
            (negotiationSummary.savingsMinor ?? 0) > 0,
          discountBps: negotiationSummary.finalDiscountBps ?? 0,
          savingsMinor: negotiationSummary.savingsMinor ?? 0,
          outcome: negotiationSummary.outcome,
          needsCheckout: false,
          paymentStatus: "pending_payment",
        };
      } else if (checkoutSuccess && lastCartMandateId) {
        const paymentMethod = "razorpay_checkout";
        try {
          const confirmRes: ConfirmResponse = await this.agent.confirm(
            this.baseUrl,
            lastCartMandateId,
            lastDecisionId,
            paymentMethod,
          );
          responsePayload = confirmRes;
          if (
            confirmRes?.success === false ||
            confirmRes?.decision === "STEP_UP" ||
            (Array.isArray(confirmRes?.reasonCodes) &&
              confirmRes.reasonCodes.length > 0)
          ) {
            stepStatus = "warning";
            const surgeBlocked =
              Array.isArray(confirmRes?.reasonCodes) &&
              confirmRes.reasonCodes.includes("SURGE_PRICING_ACTIVE");
            if (surgeBlocked) lastConfirmBlockedBySurge = true;
            summary = surgeBlocked
              ? `Surge pricing active — this in-flight transaction was re-priced +15% and escalated to STEP_UP (SURGE_PRICING_ACTIVE). Settlement blocked: the merchant must approve the surged price before a refreshed test checkout.`
              : `Settlement escalated by policy: ${confirmRes.reasonCodes?.join(", ") || confirmRes?.decision || "STEP_UP"}. ${confirmRes?.explanation || ""}`.trim();
          } else if (lastGrandTotalMinor != null) {
            const totalMinor = lastGrandTotalMinor;
            lastSettlement = {
              ...(lastSettlement || {}),
              quantity: requestedQuantity,
              grandTotalMinor: totalMinor,
              perUnitMinor: totalMinor / Math.max(1, lastLineCount),
              discounted:
                (negotiationSummary.finalDiscountBps ?? 0) > 0 ||
                (negotiationSummary.savingsMinor ?? 0) > 0,
              discountBps: negotiationSummary.finalDiscountBps ?? 0,
              savingsMinor: negotiationSummary.savingsMinor ?? 0,
              outcome: negotiationSummary.outcome,
              needsCheckout: true,
              razorpayOrderId: confirmRes.razorpayOrderId,
              razorpayKeyId: confirmRes.razorpayKeyId,
              amountMinor: confirmRes.amountMinor ?? totalMinor,
              currency: confirmRes.currency ?? "INR",
              paymentStatus:
                confirmRes.status === "completed" ? "paid" : "pending_payment",
            };
            summary = `Order created for ₹${(totalMinor / 100).toFixed(2)}. Payment pending — completing a real Razorpay test checkout (order ${confirmRes.razorpayOrderId}).`;
          } else {
            summary = `Order ${confirmRes.razorpayOrderId} created. Payment pending a real Razorpay test checkout.`;
          }
        } catch (err) {
          stepStatus = "error";
          summary = `Payment confirmation failed: ${String(err)}`;
          responsePayload = { error: String(err) };
        }
      } else {
        if (finalDecision === "DENY") {
          stepStatus = "warning";
          summary = `Spend strictly bounded by merchant policy engine. Payment halted because order total exceeds the authorized mandate limit.`;
          responsePayload = {
            action: "HALT_PAYMENT",
            reason: "TRANSACTION_LIMIT_EXCEEDED",
            boundedAtGateway: true,
          };
        } else if (finalDecision === "STEP_UP") {
          stepStatus = "warning";
          summary = negotiationSummary.requiresMerchantApproval
            ? `Negotiated discount exceeds human-approval threshold. Transaction queued for merchant review before settlement.`
            : `Step-up approval required by merchant. Transaction queued for human review before funds settlement.`;
          responsePayload = {
            action: "QUEUE_APPROVAL",
            reason: "MERCHANT_STEP_UP_REQUIRED",
          };
        } else {
          stepStatus = "error";
          summary = `Checkout could not be confirmed due to prior errors.`;
          responsePayload = { error: "Previous step failed" };
        }
      }

      createEvent(acc, {
        type: "confirm",
        description: checkoutSuccess
          ? "Create real Razorpay order (payment_pending) for browser checkout"
          : "Merchant Policy Gateway spending bounding enforcement",
        durationMs: Date.now() - stepStart,
        requestPayload: {
          cartMandateId: lastCartMandateId,
          decision: finalDecision,
        },
        responsePayload,
        communications: await this.comms(
          checkoutSuccess ? "settlement" : "settlement_blocked",
          {
            step: checkoutSuccess ? "settlement" : "settlement_blocked",
            instruction,
            selectedTitle: selectedVariant?.title,
            quantity: requestedQuantity,
            decision: finalDecision,
            savingsMinor: negotiationSummary.savingsMinor || undefined,
            paymentMethod: checkoutSuccess ? "razorpay_checkout" : undefined,
            reasonCodes:
              finalDecision === "DENY"
                ? ["TRANSACTION_LIMIT_EXCEEDED"]
                : undefined,
          },
          [
            {
              from: "buyer_agent",
              message: checkoutSuccess
                ? lastGrandTotalMinor
                  ? `Quote verified against mandate — ${requestedQuantity} unit(s) at ${formatMinor(lastGrandTotalMinor)} total (post-tax). Settling through the permitted handler now.`
                  : "Quote verified against mandate. Settling through the permitted handler now."
                : "I cannot settle without an ALLOW decision.",
            },
            {
              from: "payment_orchestrator",
              message: checkoutSuccess
                ? `Cart snapshot hash re-verified for ${requestedQuantity} unit(s). Total payable ${lastGrandTotalMinor ? formatMinor(lastGrandTotalMinor) : "—"} (incl. taxes)${lastGrandTotalMinor && lastLineCount > 0 ? `, ≈${formatMinor(lastGrandTotalMinor / lastLineCount)}/unit` : ""}${negotiationSummary.savingsMinor > 0 ? `, with ₹${(negotiationSummary.savingsMinor / 100).toFixed(2)} negotiated savings` : ""}. Payment action created.`
                : "No settlement while decision is not ALLOW.",
            },
          ],
        ),
        status: stepStatus,
        summary,
      });
    }

    const totalDurationMs = Date.now() - startTime;
    const expectedDecision = isItemAffordable ? "ALLOW" : "DENY";
    const isSuccess =
      finalDecision === expectedDecision ||
      (expectedDecision === "DENY" && finalDecision === "DENY");

    return {
      traceId,
      scenarioId: "custom_run",
      scenarioName: `Custom Agent: ${instruction}`,
      category: isItemAffordable ? "happy_path" : "policy_deny",
      success: isSuccess,
      finalDecision,
      expectedDecision,
      totalDurationMs,
      events: acc.events,
      negotiation: negotiationSummary,
      settlement:
        lastSettlement ??
        (lastGrandTotalMinor != null && lastLineCount > 0
          ? {
              quantity: requestedQuantity,
              grandTotalMinor: lastGrandTotalMinor,
              perUnitMinor: lastGrandTotalMinor / lastLineCount,
              discounted: (negotiationSummary.finalDiscountBps ?? 0) > 0,
              discountBps: negotiationSummary.finalDiscountBps ?? 0,
              savingsMinor: negotiationSummary.savingsMinor ?? 0,
              outcome: negotiationSummary.outcome,
              // Every ALLOW payment now completes via a real Razorpay test
              // checkout, so it starts payment_pending (never pre-paid).
              paymentStatus:
                finalDecision === "ALLOW" ? "pending_payment" : "failed",
            }
          : undefined),
      summary: lastConfirmBlockedBySurge
        ? `Surge Pricing blocked settlement: the in-flight transaction was re-priced +15% (SURGE_PRICING_ACTIVE) and escalated to STEP_UP. The merchant must approve the surged price before a refreshed Razorpay test checkout can be paid.`
        : upsellHasOffers
          ? `Combo deal offered. Payment paused — waiting for user to accept or decline the upsell offer before creating the Razorpay order.`
          : isSuccess
            ? `Custom AI Agent executed: [${finalDecision}] within budget parameters (Target ₹${budgetInr}, Max Cap ₹${(maxBudgetCapMinor / 100).toFixed(2)})${negotiationSummary.finalDiscountBps > 0 ? `, negotiated ${(negotiationSummary.finalDiscountBps / 100).toFixed(1)}% off` : ""}.`
            : `Custom AI Agent concluded with [${finalDecision}], budget cap was ₹${(maxBudgetCapMinor / 100).toFixed(2)}.`,
      pendingConfirmation:
        upsellHasOffers && checkoutSuccess && lastCartMandateId
          ? {
              cartMandateId: lastCartMandateId,
              decisionId: lastDecisionId,
              items: [
                {
                  variantId:
                    selectedVariant?.variantId || "kbd_nimbus_75_black_brown",
                  quantity: requestedQuantity,
                },
              ],
              verificationId: lastVerificationId,
              negotiationSessionId,
              intentMandateId: this.agent.intentMandate.id,
              grandTotalMinor: lastGrandTotalMinor ?? 0,
            }
          : undefined,
      upsell: upsellOffers,
    };
  }
}
