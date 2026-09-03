/**
 * Merchant Agent Negotiation Engine
 *
 * Implements a deterministic multi-round negotiation protocol between an
 * AI buyer agent and the merchant's negotiating agent. All concessions are
 * bounded by the merchant's configured rules (bulk thresholds, max discount,
 * approval threshold) — the LLM proposes, but this engine disposes.
 */

import { generateId } from "@/lib/utils";
import type { MerchantAgentRuleSet } from "./agent";

export interface NegotiationItem {
  variantId: string;
  title: string;
  category: string;
  quantity: number;
  unitAmountMinor: number;
}

export interface NegotiationTurn {
  actor: "buyer_agent" | "merchant_agent";
  message: string;
  offeredDiscountBps?: number;
  outcome?: string;
  timestamp: string;
}

export interface NegotiationSession {
  id: string;
  merchantId: string;
  agentId: string;
  items: NegotiationItem[];
  round: number;
  maxRounds: number;
  currentDiscountBps: number;
  status: "active" | "agreed" | "rejected" | "expired";
  requiresMerchantApproval: boolean;
  transcript: NegotiationTurn[];
  createdAt: number;
  expiresAt: number;
}

export interface NegotiationEvaluation {
  outcome: "AGREED" | "COUNTER_OFFER" | "REJECTED";
  discountBps: number;
  merchantMessage: string;
  buyerGuidance: string;
  requiresMerchantApproval: boolean;
  reasonCodes: string[];
}

const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ROUNDS = 4;

// In-memory session store (demo parity with surge pricing store)
const globalStore = globalThis as unknown as {
  __negotiationSessions?: Map<string, NegotiationSession>;
};
const sessions: Map<string, NegotiationSession> =
  globalStore.__negotiationSessions || new Map();
globalStore.__negotiationSessions = sessions;

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt < now) {
      session.status = "expired";
      sessions.delete(id);
    }
  }
}

export function getNegotiationSession(
  sessionId: string,
): NegotiationSession | null {
  pruneExpiredSessions();
  const session = sessions.get(sessionId);
  if (!session || session.status === "expired") return null;
  return session;
}

/** Snapshot the live (non-expired) sessions for durable persistence. */
export function getNegotiationSessionsSnapshot(): NegotiationSession[] {
  pruneExpiredSessions();
  return Array.from(sessions.values());
}

/**
 * Rehydrate sessions persisted in the merchant's config into the in-memory
 * store. Never overwrites a session that is already live in this process and
 * drops anything already expired on arrival.
 */
export function hydrateNegotiationSessions(
  persisted: NegotiationSession[] | undefined | null,
): void {
  if (!Array.isArray(persisted)) return;
  const now = Date.now();
  for (const session of persisted) {
    if (!session?.id || !session?.items) continue;
    if (session.status === "expired" || session.expiresAt < now) continue;
    if (sessions.has(session.id)) continue;
    sessions.set(session.id, session);
  }
}

export function getAgreedNegotiationForCheckout(
  sessionId: string | undefined | null,
): NegotiationSession | null {
  if (!sessionId) return null;
  const session = getNegotiationSession(sessionId);
  if (!session) return null;
  if (session.status !== "agreed" && session.status !== "active") return null;
  return session;
}

export function appendTurn(
  session: NegotiationSession,
  turn: Omit<NegotiationTurn, "timestamp">,
): void {
  session.transcript.push({ ...turn, timestamp: new Date().toISOString() });
}

interface EligibilityResult {
  eligible: boolean;
  reasonCodes: string[];
  reasonText: string;
}

function evaluateEligibility(
  item: NegotiationItem,
  rules: MerchantAgentRuleSet,
): EligibilityResult {
  if (!rules.enabled) {
    return {
      eligible: false,
      reasonCodes: ["MERCHANT_AGENT_DISABLED"],
      reasonText: "the merchant agent is currently paused",
    };
  }
  if (!rules.bulkDiscountEnabled) {
    return {
      eligible: false,
      reasonCodes: ["BULK_DISCOUNTS_DISABLED"],
      reasonText: "bulk discounts are disabled storewide",
    };
  }
  if (!rules.negotiableCategories.includes(item.category)) {
    return {
      eligible: false,
      reasonCodes: ["CATEGORY_NOT_NEGOTIABLE"],
      reasonText: `'${item.category}' is not a negotiable category`,
    };
  }
  if (item.quantity < rules.bulkMinQuantity) {
    return {
      eligible: false,
      reasonCodes: ["QUANTITY_BELOW_BULK_THRESHOLD"],
      reasonText: `bulk pricing starts at ${rules.bulkMinQuantity} units`,
    };
  }
  return {
    eligible: true,
    reasonCodes: ["BULK_ELIGIBLE"],
    reasonText: "quantity meets the bulk threshold",
  };
}

function money(minor: number): string {
  return `₹${(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

/**
 * Opening offer for a fresh negotiation. Round 1 of the ladder.
 */
export function openNegotiation(
  items: NegotiationItem[],
  agentId: string,
  buyerMessage: string | undefined,
  rules: MerchantAgentRuleSet,
): { session: NegotiationSession; evaluation: NegotiationEvaluation } {
  pruneExpiredSessions();

  const now = Date.now();
  const primaryItem = [...items].sort((a, b) => b.quantity - a.quantity)[0];
  const eligibility = evaluateEligibility(primaryItem, rules);

  let discountBps = 0;
  if (eligibility.eligible) {
    discountBps = Math.min(rules.bulkDiscountBps, rules.maxDiscountBps);
  }

  const session: NegotiationSession = {
    id: generateId("neg"),
    merchantId: "mch_nimbus_gear_001",
    agentId,
    items,
    round: 1,
    maxRounds: MAX_ROUNDS,
    currentDiscountBps: discountBps,
    status: discountBps > 0 ? "active" : "rejected",
    requiresMerchantApproval: false,
    transcript: [],
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };

  appendTurn(session, {
    actor: "buyer_agent",
    message:
      buyerMessage ||
      `Requesting bulk pricing for ${items.map((i) => `${i.quantity} x ${i.title}`).join(", ")}.`,
  });

  const unitAfter = Math.round(
    primaryItem.unitAmountMinor * (1 - discountBps / 10000),
  );
  const savings =
    (primaryItem.unitAmountMinor - unitAfter) * primaryItem.quantity;

  let evaluation: NegotiationEvaluation;
  if (discountBps > 0) {
    evaluation = {
      outcome: "COUNTER_OFFER",
      discountBps,
      merchantMessage: `${rules.agentName}: For ${primaryItem.quantity} units of ${primaryItem.title} I can offer ${(discountBps / 100).toFixed(1)}% off — ${money(unitAfter)} per unit instead of ${money(primaryItem.unitAmountMinor)} (saves ${money(savings)} across the line). Counter-offer if this doesn't work for your mandate.`,
      buyerGuidance: `Merchant offered ${(discountBps / 100).toFixed(1)}%. You may counter once more or accept.`,
      requiresMerchantApproval: false,
      reasonCodes: eligibility.reasonCodes,
    };
  } else {
    evaluation = {
      outcome: "REJECTED",
      discountBps: 0,
      merchantMessage: `${rules.agentName}: I can't open negotiations on this order — ${eligibility.reasonText}. List price ${money(primaryItem.unitAmountMinor)} per unit stands.`,
      buyerGuidance: eligibility.reasonCodes.includes(
        "QUANTITY_BELOW_BULK_THRESHOLD",
      )
        ? `Increase quantity to at least ${rules.bulkMinQuantity} units to unlock bulk pricing.`
        : "This item/order is not eligible for negotiated pricing.",
      requiresMerchantApproval: false,
      reasonCodes: eligibility.reasonCodes,
    };
    session.status = "rejected";
  }

  appendTurn(session, {
    actor: "merchant_agent",
    message: evaluation.merchantMessage,
    offeredDiscountBps: evaluation.discountBps,
    outcome: evaluation.outcome,
  });

  sessions.set(session.id, session);
  return { session, evaluation };
}

/**
 * Respond to a buyer counter-proposal using a concession ladder.
 * The merchant concedes toward maxDiscountBps but never beyond it, and
 * never below the minimum margin floor implied by the rules.
 */
export function respondToCounter(
  sessionId: string,
  requestedDiscountBps: number,
  acceptCurrentOffer: boolean,
  buyerMessage: string | undefined,
  rules: MerchantAgentRuleSet,
):
  | { session: NegotiationSession; evaluation: NegotiationEvaluation }
  | { error: string } {
  pruneExpiredSessions();
  const session = sessions.get(sessionId);

  if (!session) {
    return { error: "NEGOTIATION_SESSION_NOT_FOUND_OR_EXPIRED" };
  }
  if (session.status === "agreed") {
    return { error: "NEGOTIATION_ALREADY_AGREED" };
  }
  if (session.status === "rejected") {
    return { error: "NEGOTIATION_ALREADY_REJECTED" };
  }

  const primaryItem = [...session.items].sort(
    (a, b) => b.quantity - a.quantity,
  )[0];
  const eligibility = evaluateEligibility(primaryItem, rules);
  const maxAllowed = eligibility.eligible ? rules.maxDiscountBps : 0;

  appendTurn(session, {
    actor: "buyer_agent",
    message:
      buyerMessage ||
      (acceptCurrentOffer
        ? `Accepting your current offer of ${(session.currentDiscountBps / 100).toFixed(1)}%.`
        : `Asking for ${(requestedDiscountBps / 100).toFixed(1)}% off to make this work within my mandate.`),
    offeredDiscountBps: acceptCurrentOffer
      ? undefined
      : Math.max(0, requestedDiscountBps),
  });

  session.round += 1;

  // Buyer accepts the standing offer
  if (
    acceptCurrentOffer ||
    requestedDiscountBps <= session.currentDiscountBps
  ) {
    const agreed = session.currentDiscountBps;
    session.status = "agreed";
    session.requiresMerchantApproval =
      agreed > rules.requireApprovalAboveDiscountBps;

    const unitAfter = Math.round(
      primaryItem.unitAmountMinor * (1 - agreed / 10000),
    );
    const savings =
      (primaryItem.unitAmountMinor - unitAfter) * primaryItem.quantity;

    const evaluation: NegotiationEvaluation = {
      outcome: "AGREED",
      discountBps: agreed,
      merchantMessage: `${rules.agentName}: Deal — ${(agreed / 100).toFixed(1)}% off confirmed (${money(unitAfter)}/unit, total saving ${money(savings)}). Quote the checkout with session ${session.id}.`,
      buyerGuidance:
        "Terms agreed. Proceed to authoritative checkout quoting with this session.",
      requiresMerchantApproval: session.requiresMerchantApproval,
      reasonCodes: ["NEGOTIATION_AGREED"],
    };

    appendTurn(session, {
      actor: "merchant_agent",
      message: evaluation.merchantMessage,
      offeredDiscountBps: agreed,
      outcome: "AGREED",
    });

    return { session, evaluation };
  }

  // Buyer asks for more than we can ever give
  if (!eligibility.eligible || requestedDiscountBps > maxAllowed) {
    session.status = "rejected";
    const bestFinal = Math.min(session.currentDiscountBps, maxAllowed);

    const evaluation: NegotiationEvaluation = {
      outcome: "REJECTED",
      discountBps: bestFinal,
      merchantMessage: `${rules.agentName}: I can't go to ${(requestedDiscountBps / 100).toFixed(1)}% — that breaches my margin floor. My final position stands at ${(bestFinal / 100).toFixed(1)}% or list price.`,
      buyerGuidance: `Maximum permissible discount is ${(maxAllowed / 100).toFixed(1)}%. Accept the standing offer or proceed without a discount.`,
      requiresMerchantApproval: false,
      reasonCodes: eligibility.eligible
        ? ["MAX_DISCOUNT_CEILING"]
        : eligibility.reasonCodes,
    };

    appendTurn(session, {
      actor: "merchant_agent",
      message: evaluation.merchantMessage,
      offeredDiscountBps: bestFinal,
      outcome: "REJECTED",
    });

    return { session, evaluation };
  }

  // Concede halfway toward the ceiling, capped
  const concessionGap = maxAllowed - session.currentDiscountBps;
  const conceded = Math.max(
    session.currentDiscountBps + Math.ceil(concessionGap / 2),
    Math.min(requestedDiscountBps, maxAllowed),
  );
  const nextOffer = Math.min(conceded, maxAllowed);
  session.currentDiscountBps = nextOffer;
  session.requiresMerchantApproval =
    nextOffer > rules.requireApprovalAboveDiscountBps;

  const unitAfter = Math.round(
    primaryItem.unitAmountMinor * (1 - nextOffer / 10000),
  );

  const evaluation: NegotiationEvaluation = {
    outcome: "COUNTER_OFFER",
    discountBps: nextOffer,
    merchantMessage: `${rules.agentName}: I can stretch to ${(nextOffer / 100).toFixed(1)}% — ${money(unitAfter)} per unit for ${primaryItem.quantity} units. That's my ceiling on this SKU; do we have a deal?`,
    buyerGuidance:
      nextOffer >= requestedDiscountBps
        ? "Merchant met your target. Accept to lock terms."
        : `Merchant countered at ${(nextOffer / 100).toFixed(1)}%. Accept, or push again within ${session.maxRounds - session.round} round(s).`,
    requiresMerchantApproval: session.requiresMerchantApproval,
    reasonCodes: ["MERCHANT_CONCESSION"],
  };

  appendTurn(session, {
    actor: "merchant_agent",
    message: evaluation.merchantMessage,
    offeredDiscountBps: nextOffer,
    outcome: "COUNTER_OFFER",
  });

  if (
    session.round >= session.maxRounds &&
    evaluation.outcome === "COUNTER_OFFER"
  ) {
    // Force resolution on the final round: hold at current offer as final
    evaluation.buyerGuidance =
      "Final round reached. Accept the standing offer or the negotiation closes without a deal.";
  }

  return { session, evaluation };
}
