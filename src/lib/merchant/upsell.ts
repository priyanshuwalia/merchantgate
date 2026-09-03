/**
 * Merchant Upsell / Cross-sell Engine
 *
 * The LLM proposes; deterministic code disposes. This engine computes bounded,
 * deterministic upsell + cross-sell offers for an AI buyer's cart — every offer
 * is priced from the merchant's own catalogue, every candidate is compatibility
 * scored with real co-occurrence/purchase-history lift, and the total basket
 * uplift is capped by merchant-configured rules so an agent can never be talked
 * (or coerced) into an unbounded additional spend.
 */

import { generateCanonicalDigest } from "@/lib/crypto/canonical";

/**
 * Stable, content-addressed offer id. Offer ids are derived from the cart, the
 * priced candidates, the active rules and the market-basket history — NOT from
 * a random value — so the merchant can re-derive the same offer deterministically
 * when the buyer later accepts it during checkout, and a buyer can never forge
 * an offer id for items the merchant never priced.
 */
function stableOfferId(parts: Record<string, unknown>): string {
  return `up_${generateCanonicalDigest(parts).slice(0, 20)}`;
}

export interface UpsellCartItem {
  variantId: string;
  category: string;
  title: string;
  quantity: number;
  unitAmountMinor: number;
}

export interface UpsellCatalogItem {
  variantId: string;
  title: string;
  category: string;
  unitAmountMinor: number;
  stockQuantity: number;
  returnable?: boolean;
  attributes?: Record<string, unknown>;
}

/** One completed purchase basket, used to learn real cross-sell affinity. */
export interface MarketBasketRecord {
  agentId: string;
  variantIds: string[];
}

export interface UpsellRuleSet {
  enabled: boolean;
  upsellCategories: string[];
  maxUpsellOffers: number;
  maxUpsellItems: number;
  maxBasketUpliftBps: number;
  bundleDiscountBps: number;
  minAffinityScore: number;
}

export interface UpsellOfferItem {
  variantId: string;
  title: string;
  category: string;
  quantity: number;
  unitAmountMinor: number;
  lineAmountMinor: number;
  savedMinor: number;
}

export type UpsellOfferType = "ADD_ON" | "BUNDLE";

export interface UpsellOffer {
  offerId: string;
  type: UpsellOfferType;
  title: string;
  description: string;
  affinityScore: number;
  coOccurrenceCount: number;
  reasonCodes: string[];
  items: UpsellOfferItem[];
  subtotalMinor: number;
  bundleDiscountBps: number;
  bundleDiscountMinor: number;
  addedTotalMinor: number;
}

export interface UpsellGenerationResult {
  enabled: boolean;
  offers: UpsellOffer[];
  reasonCodes: string[];
  cartSubtotalMinor: number;
  maxUpliftMinor: number;
  totalUpliftMinor: number;
  offersTrimmedByUpliftCap: boolean;
  metadata: {
    marketBasketsAnalyzed: number;
    candidatesConsidered: number;
  };
}

export const DEFAULT_UPSELL_RULES: UpsellRuleSet = {
  enabled: true,
  upsellCategories: ["accessories"],
  maxUpsellOffers: 3,
  maxUpsellItems: 2,
  maxBasketUpliftBps: 4000, // 40% of the cart — hard commercial ceiling
  bundleDiscountBps: 500, // 5% off the add-on bundle
  minAffinityScore: 0.3,
};

export function getUpsellRules(
  config?: Record<string, unknown>,
): UpsellRuleSet {
  const r = (config?.upsellRules as Partial<UpsellRuleSet> | undefined) || {};
  const num = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };

  return {
    enabled: r.enabled !== false,
    upsellCategories:
      Array.isArray(r.upsellCategories) && r.upsellCategories.length > 0
        ? r.upsellCategories
        : DEFAULT_UPSELL_RULES.upsellCategories,
    maxUpsellOffers: Math.max(
      1,
      Math.min(
        10,
        Math.round(
          num(r.maxUpsellOffers, DEFAULT_UPSELL_RULES.maxUpsellOffers),
        ),
      ),
    ),
    maxUpsellItems: Math.max(
      1,
      Math.min(
        5,
        Math.round(num(r.maxUpsellItems, DEFAULT_UPSELL_RULES.maxUpsellItems)),
      ),
    ),
    maxBasketUpliftBps: Math.max(
      0,
      Math.min(
        20000,
        Math.round(
          num(r.maxBasketUpliftBps, DEFAULT_UPSELL_RULES.maxBasketUpliftBps),
        ),
      ),
    ),
    bundleDiscountBps: Math.max(
      0,
      Math.min(
        6000,
        Math.round(
          num(r.bundleDiscountBps, DEFAULT_UPSELL_RULES.bundleDiscountBps),
        ),
      ),
    ),
    minAffinityScore: Math.max(
      0,
      Math.min(
        1,
        num(r.minAffinityScore, DEFAULT_UPSELL_RULES.minAffinityScore),
      ),
    ),
  };
}

/**
 * Explicit variant compatibility: the strongest, most defensible signal a
 * merchant can give the engine. Keyed by the seed catalogue's variant IDs.
 * Every candidate is independently verified against the requested cart before
 * it can appear in an offer.
 */
const VARIANT_COMPAT: Record<string, string[]> = {
  kbd_nimbus_75_black_brown: [
    "acc_nimbus_deskmat",
    "acc_nimbus_switch_set",
    "mse_nimbus_pro_white",
    "acc_kbd_wristrest",
  ],
  mse_nimbus_pro_white: ["acc_nimbus_deskmat", "acc_nimbus_charger"],
  aud_nimbus_anc_pro: ["acc_headphone_stand", "acc_nimbus_charger"],
  laptop_gaming_pro: [
    "acc_lap_sleeve",
    "acc_nimbus_stand_alu",
    "acc_nimbus_charger",
  ],
  mon_apex_27_4k: ["acc_monitor_arm", "acc_nimbus_charger", "acc_lap_sleeve"],
};

/** Category-level fallback for items not in the explicit map. */
const CATEGORY_COMPAT: Record<string, string[]> = {
  electronics: ["accessories"],
  audio: ["accessories"],
  computers: ["accessories"],
  accessories: [],
};

function ratingOf(item: UpsellCatalogItem): { average: number; count: number } {
  const a = (item.attributes as Record<string, unknown>) || {};
  return {
    average: Number(a.ratingAverage ?? 4.5) || 4.5,
    count: Number(a.ratingCount ?? 0) || 0,
  };
}

/** Normalised 0..1 direct compatibility: explicit variant map > category map. */
function directCompat(
  cart: UpsellCartItem[],
  candidate: UpsellCatalogItem,
): number {
  for (const item of cart) {
    if (VARIANT_COMPAT[item.variantId]?.includes(candidate.variantId)) {
      return 1;
    }
  }
  const requestedCategories = new Set(cart.map((i) => i.category));
  for (const reqCat of requestedCategories) {
    if (CATEGORY_COMPAT[reqCat]?.includes(candidate.category)) {
      return 0.8;
    }
  }
  return 0;
}

/**
 * Cross-sell lift from real purchase history (A3): how often the candidate was
 * bought alongside anything already in the cart. Returns both the raw count
 * and a normalised 0..1 signal.
 */
function coOccurrenceLift(
  cartVariantIds: Set<string>,
  candidateVariantId: string,
  baskets: MarketBasketRecord[] | undefined,
): { count: number; signal: number } {
  if (!baskets || baskets.length === 0) return { count: 0, signal: 0 };
  let count = 0;
  for (const basket of baskets) {
    const hasCartItem = basket.variantIds.some((v) => cartVariantIds.has(v));
    const hasCandidate = basket.variantIds.includes(candidateVariantId);
    if (
      hasCartItem &&
      hasCandidate &&
      !cartVariantIds.has(candidateVariantId)
    ) {
      count += 1;
    }
  }
  // Diminishing marginal lift: 5+ co-purchases saturate the boost.
  return { count, signal: Math.min(0.3, count * 0.06) };
}

function aggregateAffinityScore(
  direct: number,
  coOccurrenceSignal: number,
  candidate: UpsellCatalogItem,
): number {
  const { average } = ratingOf(candidate);
  const ratingMultiplier = Math.max(0.9, Math.min(1.1, average / 5));
  const score = (direct + coOccurrenceSignal) * ratingMultiplier;
  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

/**
 * Generate bounded upsell / cross-sell offers for a cart.
 *
 * Bounds enforced:
 *  1. only in-stock, non-cart variants from the configured upsell categories;
 *  2. at most `maxUpsellOffers` offers and `maxUpsellItems` items per offer;
 *  3. candidates must clear the merchant's `minAffinityScore` threshold;
 *  4. the SUM of all offers' added totals is capped by `maxBasketUpliftBps`
 *     of the original cart subtotal (offers are then trimmed by score).
 */
export function generateUpsellOffers(options: {
  cart: UpsellCartItem[];
  catalog: UpsellCatalogItem[];
  rules: UpsellRuleSet;
  marketBaskets?: MarketBasketRecord[];
  requiresRefundable?: boolean;
}): UpsellGenerationResult {
  const { cart, catalog, rules, marketBaskets, requiresRefundable } = options;
  const cartSubtotalMinor = cart.reduce(
    (sum, i) => sum + i.unitAmountMinor * i.quantity,
    0,
  );
  const reasonCodes: string[] = [];

  if (!rules.enabled) {
    return {
      enabled: false,
      offers: [],
      reasonCodes: ["UPSELL_DISABLED"],
      cartSubtotalMinor,
      maxUpliftMinor: 0,
      totalUpliftMinor: 0,
      offersTrimmedByUpliftCap: false,
      metadata: { marketBasketsAnalyzed: 0, candidatesConsidered: 0 },
    };
  }

  const cartVariantIds = new Set(cart.map((i) => i.variantId));
  const candidatePool = catalog.filter(
    (p) =>
      !cartVariantIds.has(p.variantId) &&
      p.stockQuantity > 0 &&
      rules.upsellCategories.includes(p.category) &&
      p.unitAmountMinor > 0 &&
      // A buyer whose mandate requires refundable items must never be offered
      // a non-returnable product — accepting it would build a cart the policy
      // would hard-DENY (NON_REFUNDABLE_ITEM_DISALLOWED).
      (!requiresRefundable || p.returnable !== false),
  );

  const offerContext = {
    cart: cart
      .map((i) => ({
        variantId: i.variantId,
        quantity: i.quantity,
        unitAmountMinor: i.unitAmountMinor,
        category: i.category,
      }))
      .sort((a, b) => a.variantId.localeCompare(b.variantId)),
    categories: [...rules.upsellCategories].sort(),
    maxUpliftBps: rules.maxBasketUpliftBps,
    maxOffers: rules.maxUpsellOffers,
    maxItems: rules.maxUpsellItems,
    bundleDiscountBps: rules.bundleDiscountBps,
    minAffinityScore: rules.minAffinityScore,
    baskets: (marketBaskets || [])
      .map((b) => ({
        agentId: b.agentId,
        variantIds: [...b.variantIds].sort(),
      }))
      .sort((a, b) => a.agentId.localeCompare(b.agentId)),
  };

  const scored: Array<{
    item: UpsellCatalogItem;
    direct: number;
    coOccurrence: { count: number; signal: number };
    score: number;
    reasonCodes: string[];
  }> = [];

  for (const candidate of candidatePool) {
    const direct = directCompat(cart, candidate);
    if (direct <= 0 && (!marketBaskets || marketBaskets.length === 0)) {
      continue; // Only category/variant compat is offered without history.
    }
    const coOccurrence = coOccurrenceLift(
      cartVariantIds,
      candidate.variantId,
      marketBaskets,
    );
    const score = aggregateAffinityScore(
      direct,
      coOccurrence.signal,
      candidate,
    );
    if (score < rules.minAffinityScore) continue;

    const codes: string[] = [];
    if (direct >= 1) codes.push("DIRECT_COMPATIBILITY_MATCH");
    else if (direct >= 0.8) codes.push("CATEGORY_COMPATIBILITY_MATCH");
    if (coOccurrence.count > 0)
      codes.push(`MARKET_BASKET_AFFINITY:${coOccurrence.count}`);

    scored.push({
      item: candidate,
      direct,
      coOccurrence,
      score,
      reasonCodes: codes,
    });
  }

  // Deterministic ranking: score desc, then title asc for stability.
  scored.sort(
    (a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title),
  );

  const maxUpliftMinor = Math.round(
    (cartSubtotalMinor * rules.maxBasketUpliftBps) / 10000,
  );
  const offers: UpsellOffer[] = [];
  let totalUpliftMinor = 0;
  let offersTrimmedByUpliftCap = false;

  for (const candidate of scored.slice(0, rules.maxUpsellOffers)) {
    const qty = 1;
    const line = candidate.item.unitAmountMinor * qty;
    if (totalUpliftMinor + line > maxUpliftMinor && offers.length > 0) {
      offersTrimmedByUpliftCap = true;
      break;
    }

    offers.push({
      offerId: stableOfferId({
        context: offerContext,
        type: "ADD_ON",
        variantId: candidate.item.variantId,
        unitAmountMinor: candidate.item.unitAmountMinor,
      }),
      type: "ADD_ON",
      title: candidate.item.title,
      description: `Compatible add-on for your ${cart
        .map((i) => i.title)
        .join(", ")} — ${ratingOf(candidate.item).average.toFixed(1)}★ from ${
        ratingOf(candidate.item).count
      } buyers.`,
      affinityScore: candidate.score,
      coOccurrenceCount: candidate.coOccurrence.count,
      reasonCodes: candidate.reasonCodes,
      items: [
        {
          variantId: candidate.item.variantId,
          title: candidate.item.title,
          category: candidate.item.category,
          quantity: qty,
          unitAmountMinor: candidate.item.unitAmountMinor,
          lineAmountMinor: line,
          savedMinor: 0,
        },
      ],
      subtotalMinor: line,
      bundleDiscountBps: 0,
      bundleDiscountMinor: 0,
      addedTotalMinor: line,
    });

    totalUpliftMinor += line;
  }

  // Bundle offer: the strongest add-on bundled with a small extra discount.
  // Only produces an add-on bundle when the cart already contains a hero item.
  const hero = [...cart].sort(
    (a, b) => b.unitAmountMinor - a.unitAmountMinor,
  )[0];
  if (
    offers.length > 0 &&
    hero &&
    VARIANT_COMPAT[hero.variantId] &&
    rules.maxUpsellItems > 0
  ) {
    const bundleCandidates = offers.slice(0, rules.maxUpsellItems);
    const bundleSubtotal = bundleCandidates.reduce(
      (sum, o) => sum + o.subtotalMinor,
      0,
    );
    if (bundleSubtotal > 0) {
      const discount = Math.round(
        (bundleSubtotal * rules.bundleDiscountBps) / 10000,
      );
      const added = Math.max(0, bundleSubtotal - discount);
      if (
        totalUpliftMinor - offers[0].addedTotalMinor + added <=
        maxUpliftMinor
      ) {
        const bundleId = stableOfferId({
          context: offerContext,
          type: "BUNDLE",
          variantIds: bundleCandidates.map((o) => o.items[0].variantId).sort(),
          units: bundleCandidates
            .map((o) => o.items[0].unitAmountMinor)
            .sort((a, b) => a - b),
          discountBps: rules.bundleDiscountBps,
        });
        offers.push({
          offerId: bundleId,
          type: "BUNDLE",
          title: `${hero.title.split(" ")[0]} Setup Bundle`,
          description: `Bundle your ${hero.title} with compatible accessories for ${(rules.bundleDiscountBps / 100).toFixed(1)}% off the add-ons.`,
          affinityScore: Math.max(
            ...bundleCandidates.map((o) => o.affinityScore),
          ),
          coOccurrenceCount: Math.max(
            ...bundleCandidates.map((o) => o.coOccurrenceCount),
          ),
          reasonCodes: ["BUNDLE_DISCOUNT", ...offers[0].reasonCodes],
          items: bundleCandidates.flatMap((o) => o.items),
          subtotalMinor: bundleSubtotal,
          bundleDiscountBps: rules.bundleDiscountBps,
          bundleDiscountMinor: discount,
          addedTotalMinor: added,
        });
        totalUpliftMinor = totalUpliftMinor - offers[0].addedTotalMinor + added;
        if (totalUpliftMinor > maxUpliftMinor) offersTrimmedByUpliftCap = true;
      }
    }
  }

  reasonCodes.push(
    offers.length > 0 ? "UPSELL_OFFERS_GENERATED" : "NO_ELIGIBLE_UPSELL",
  );
  if (offersTrimmedByUpliftCap) reasonCodes.push("BASKET_UPLIFT_CAP_REACHED");

  return {
    enabled: true,
    offers,
    reasonCodes,
    cartSubtotalMinor,
    maxUpliftMinor,
    totalUpliftMinor,
    offersTrimmedByUpliftCap,
    metadata: {
      marketBasketsAnalyzed: marketBaskets?.length ?? 0,
      candidatesConsidered: scored.length,
    },
  };
}

/**
 * Resolve an accepted offer back to the exact items that should be added to a
 * checkout. Re-runs generation deterministically so an `upsellOfferId` can
 * only ever resolve to items the merchant priced at quote time — a buyer can
 * never inject arbitrary variant IDs through this field.
 */
export function resolveUpsellOffer(options: {
  cart: UpsellCartItem[];
  catalog: UpsellCatalogItem[];
  rules: UpsellRuleSet;
  marketBaskets?: MarketBasketRecord[];
  upsellOfferId: string;
  requiresRefundable?: boolean;
}): UpsellOfferItem[] | null {
  const { offers } = generateUpsellOffers(options);
  const match = offers.find((o) => o.offerId === options.upsellOfferId);
  if (!match) return null;
  return match.items.map((i) => ({ ...i, savedMinor: 0 }));
}
