export interface MerchantAgentRuleSet {
  enabled: boolean;
  agentName: string;
  bulkDiscountEnabled: boolean;
  bulkMinQuantity: number;
  bulkDiscountBps: number;
  maxDiscountBps: number;
  minimumMarginBps: number;
  negotiableCategories: string[];
  requireApprovalAboveDiscountBps: number;
  inventoryInstruction: string;
  upsellEnabled: boolean;
  upsellCategories: string[];
  maxUpsellOffers: number;
  maxUpsellItems: number;
  maxBasketUpliftBps: number;
  minAffinityScore: number;
}

export interface MerchantNegotiationInput {
  title: string;
  category: string;
  quantity: number;
  unitAmountMinor: number;
  stockQuantity?: number;
  rating?: {
    average: number;
    count: number;
  };
}

export interface MerchantNegotiationDecision {
  agentName: string;
  discountBps: number;
  unitDiscountMinor: number;
  discountedUnitAmountMinor: number;
  lineDiscountMinor: number;
  merchantMessage: string;
  requiresMerchantApproval: boolean;
  reasonCodes: string[];
}

const DEFAULT_RULES: MerchantAgentRuleSet = {
  enabled: true,
  agentName: "Nimbus Merchant Agent",
  bulkDiscountEnabled: true,
  bulkMinQuantity: 3,
  bulkDiscountBps: 700,
  maxDiscountBps: 1200,
  minimumMarginBps: 1800,
  negotiableCategories: ["electronics", "audio", "accessories", "computers"],
  requireApprovalAboveDiscountBps: 1000,
  inventoryInstruction:
    "Offer automatic bulk discounts when quantity is high, preserve margin, and ask for approval when a discount exceeds the configured threshold.",
  upsellEnabled: true,
  upsellCategories: ["accessories"],
  maxUpsellOffers: 3,
  maxUpsellItems: 2,
  maxBasketUpliftBps: 4000,
  minAffinityScore: 0.3,
};

export function getMerchantAgentRules(
  config?: Record<string, unknown>,
): MerchantAgentRuleSet {
  const rules =
    (config?.merchantAgentRules as Partial<MerchantAgentRuleSet> | undefined) ||
    {};

  return {
    ...DEFAULT_RULES,
    ...rules,
    bulkMinQuantity: Number(
      rules.bulkMinQuantity ?? DEFAULT_RULES.bulkMinQuantity,
    ),
    bulkDiscountBps: Number(
      rules.bulkDiscountBps ?? DEFAULT_RULES.bulkDiscountBps,
    ),
    maxDiscountBps: Number(
      rules.maxDiscountBps ?? DEFAULT_RULES.maxDiscountBps,
    ),
    minimumMarginBps: Number(
      rules.minimumMarginBps ?? DEFAULT_RULES.minimumMarginBps,
    ),
    requireApprovalAboveDiscountBps: Number(
      rules.requireApprovalAboveDiscountBps ??
        DEFAULT_RULES.requireApprovalAboveDiscountBps,
    ),
    negotiableCategories:
      Array.isArray(rules.negotiableCategories) &&
      rules.negotiableCategories.length > 0
        ? rules.negotiableCategories
        : DEFAULT_RULES.negotiableCategories,
    upsellEnabled: rules.upsellEnabled !== false,
    upsellCategories:
      Array.isArray(rules.upsellCategories) && rules.upsellCategories.length > 0
        ? rules.upsellCategories
        : DEFAULT_RULES.upsellCategories,
    maxUpsellOffers: Number(
      rules.maxUpsellOffers ?? DEFAULT_RULES.maxUpsellOffers,
    ),
    maxUpsellItems: Number(
      rules.maxUpsellItems ?? DEFAULT_RULES.maxUpsellItems,
    ),
    maxBasketUpliftBps: Number(
      rules.maxBasketUpliftBps ?? DEFAULT_RULES.maxBasketUpliftBps,
    ),
    minAffinityScore: Number(
      rules.minAffinityScore ?? DEFAULT_RULES.minAffinityScore,
    ),
  };
}

/**
 * Clamp rule-set numeric values to safe production ranges and enforce internal
 * consistency (bulk discount can never exceed the max ceiling; approval
 * threshold can never exceed the ceiling). This is the final defence against a
 * chat model that tries to save an absurd or contradictory rule set.
 */
export function sanitizeMerchantRules(
  rules: Partial<MerchantAgentRuleSet>,
): Partial<MerchantAgentRuleSet> {
  const out: Partial<MerchantAgentRuleSet> = { ...rules };

  // Percentages (bps). 0..10,000 bps (0%..100%) is the hard bound; in practice
  // a merchant discount ceiling beyond 60% is unrealistic so we cap at 6,000.
  const MAX_BPS = 6000;
  // 1..1,000,000 units bulk threshold
  const MAX_QTY = 1_000_000;

  const clampBps = (v: unknown, fallback?: number): number | undefined => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(MAX_BPS, Math.round(n)));
  };
  const clampQty = (v: unknown, fallback?: number): number | undefined => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.min(MAX_QTY, Math.round(n)));
  };

  if (out.bulkDiscountBps !== undefined) {
    const clamped = clampBps(out.bulkDiscountBps);
    if (clamped !== undefined) out.bulkDiscountBps = clamped;
  }
  if (out.maxDiscountBps !== undefined) {
    const clamped = clampBps(out.maxDiscountBps);
    if (clamped !== undefined) out.maxDiscountBps = clamped;
  }
  if (out.minimumMarginBps !== undefined) {
    const clamped = clampBps(out.minimumMarginBps);
    if (clamped !== undefined) out.minimumMarginBps = clamped;
  }
  if (out.requireApprovalAboveDiscountBps !== undefined) {
    const clamped = clampBps(out.requireApprovalAboveDiscountBps);
    if (clamped !== undefined) out.requireApprovalAboveDiscountBps = clamped;
  }
  if (out.bulkMinQuantity !== undefined) {
    const clamped = clampQty(out.bulkMinQuantity);
    if (clamped !== undefined) out.bulkMinQuantity = clamped;
  }

  // Internal consistency: bulk discount must respect the max ceiling; the
  // human-approval threshold must sit at or below the max ceiling.
  if (
    out.maxDiscountBps !== undefined &&
    out.bulkDiscountBps !== undefined &&
    out.bulkDiscountBps > out.maxDiscountBps
  ) {
    out.bulkDiscountBps = out.maxDiscountBps;
  }
  if (
    out.maxDiscountBps !== undefined &&
    out.requireApprovalAboveDiscountBps !== undefined &&
    out.requireApprovalAboveDiscountBps > out.maxDiscountBps
  ) {
    out.requireApprovalAboveDiscountBps = out.maxDiscountBps;
  }

  return out;
}

export function evaluateMerchantNegotiation(
  item: MerchantNegotiationInput,
  rules: MerchantAgentRuleSet,
): MerchantNegotiationDecision {
  const reasonCodes: string[] = [];
  const categoryAllowed = rules.negotiableCategories.includes(item.category);
  const eligibleForBulk =
    rules.enabled &&
    rules.bulkDiscountEnabled &&
    categoryAllowed &&
    item.quantity >= rules.bulkMinQuantity;

  let discountBps = 0;
  if (eligibleForBulk) {
    discountBps = Math.min(rules.bulkDiscountBps, rules.maxDiscountBps);
    reasonCodes.push("BULK_DISCOUNT_APPLIED");
  } else if (!categoryAllowed) {
    reasonCodes.push("CATEGORY_NOT_NEGOTIABLE");
  } else if (item.quantity < rules.bulkMinQuantity) {
    reasonCodes.push("QUANTITY_BELOW_BULK_THRESHOLD");
  } else {
    reasonCodes.push("MERCHANT_AGENT_DISABLED");
  }

  const unitDiscountMinor = Math.round(
    (item.unitAmountMinor * discountBps) / 10000,
  );
  const discountedUnitAmountMinor = Math.max(
    0,
    item.unitAmountMinor - unitDiscountMinor,
  );
  const lineDiscountMinor = unitDiscountMinor * item.quantity;
  const requiresMerchantApproval =
    discountBps > rules.requireApprovalAboveDiscountBps;

  const ratingText = item.rating
    ? ` Product rating is ${item.rating.average.toFixed(1)}/5 from ${item.rating.count} buyers.`
    : "";
  const merchantMessage =
    discountBps > 0
      ? `${rules.agentName}: Quantity ${item.quantity} qualifies for ${(discountBps / 100).toFixed(1)}% bulk discount on ${item.title}.${ratingText}`
      : `${rules.agentName}: No automatic discount offered for quantity ${item.quantity}. ${reasonCodes[0]?.replace(/_/g, " ").toLowerCase()}.`;

  return {
    agentName: rules.agentName,
    discountBps,
    unitDiscountMinor,
    discountedUnitAmountMinor,
    lineDiscountMinor,
    merchantMessage,
    requiresMerchantApproval,
    reasonCodes,
  };
}
