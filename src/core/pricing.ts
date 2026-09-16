/**
 * Merchant pricing core — pure, deterministic cart math.
 *
 * This is the "LLM proposes, code disposes" boundary for money. It only ever
 * LOWERs a quoted unit price below the merchant's list price (negotiation,
 * campaigns) or re-prices UP the way the merchant configured it (surge). No
 * buyer-supplied value reaches a total without being sanitised and bounded.
 *
 * No Next.js, no DB, no I/O — unit-testable in isolation.
 */

import { evaluateMerchantNegotiation } from "@/lib/merchant/agent";
import { resolveCampaignForLine } from "@/lib/merchant/campaigns";
import type { NegotiationSession } from "@/lib/merchant/negotiation";

// ----------------------------------------------------------------------------
// Types (structural — decoupled from the drizzle row shapes at the boundary)
// ----------------------------------------------------------------------------

export type PriceableProduct = {
  id: string;
  variant_id: string;
  category: string;
  title: string;
  base_price_minor: number;
  stock_quantity: number;
  tax_rate_bps: number;
  returnable: boolean;
  attributes?: Record<string, unknown>;
};

export type RequestedLineItem = {
  variantId: string;
  quantity?: number | string;
  discoveryPriceMinor?: number;
};

export type PriceableLine = {
  productId: string;
  variantId: string;
  category: string;
  title: string;
  quantity: number;
  unitAmountMinor: number;
  originalUnitAmountMinor: number;
  discountBps: number;
  lineDiscountMinor: number;
  lineAmountMinor: number;
  discoveryPriceMinor: number;
  returnable: boolean;
  rating: { average: number; count: number };
  negotiation: {
    agentName: string;
    discountBps: number;
    unitDiscountMinor: number;
    discountedUnitAmountMinor: number;
    lineDiscountMinor: number;
    merchantMessage: string;
    requiresMerchantApproval: boolean;
    reasonCodes: string[];
  };
  campaign?: {
    id: string;
    name: string;
    discountBps: number;
    discountMinor?: number;
  };
};

export type CartTotals = {
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  taxMinor: number;
  grandTotalMinor: number;
};

type AgentRules = Parameters<typeof evaluateMerchantNegotiation>[1];
type Campaign = Parameters<
  typeof resolveCampaignForLine
>[0]["campaigns"][number];

export type PricedCart = {
  lines: PriceableLine[];
  totals: CartTotals;
  preSubtotalMinor: number;
};

export type PricingContext = {
  productMap: Map<string, PriceableProduct>;
  surgeActive: boolean;
  campaigns: Campaign[];
  rules: AgentRules;
  negotiatedTerms?: Map<string, { discountBps: number; quantity: number }>;
  negotiationSession?: Pick<
    NegotiationSession,
    "id" | "requiresMerchantApproval"
  > | null;
};

// ----------------------------------------------------------------------------
// Sanitisation — bound every buyer-supplied number before it drives the policy
// ----------------------------------------------------------------------------

export type MandateConstraints = {
  currency?: string;
  maxTransactionAmountMinor?: number;
  rolling30dAmountMinor?: number;
  quantityMax?: number;
  maxPriceSlippageBps?: number;
  requiresRefundability?: boolean;
  allowedMerchants?: string[];
  allowedCategories?: string[];
  fulfillment?: unknown;
};

export type IntentMandateShape = {
  type?: string;
  id?: string;
  revision?: number;
  principal?: { userId?: string };
  delegate?: { agentId?: string; agentVersion?: string };
  constraints?: MandateConstraints;
  validity?: { notBefore?: string; expiresAt?: string };
};

const MAX_TXN = 1_000_000_000; // ₹10 crore
const MAX_ROLLING = 5_000_000_000;
const MAX_QTY = 1_000_000;

export function sanitizeMandate<T extends IntentMandateShape>(mandate: T): T {
  const c = mandate.constraints || {};
  const num = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };

  return {
    ...mandate,
    constraints: {
      ...c,
      currency:
        typeof c.currency === "string" ? c.currency.toUpperCase() : "INR",
      maxTransactionAmountMinor: Math.min(
        MAX_TXN,
        num(c.maxTransactionAmountMinor, 500000),
      ),
      rolling30dAmountMinor: Math.min(
        MAX_ROLLING,
        num(c.rolling30dAmountMinor, MAX_ROLLING),
      ),
      quantityMax: Math.min(MAX_QTY, num(c.quantityMax, 1_000_000)),
      maxPriceSlippageBps: Math.min(
        10000,
        Math.max(0, num(c.maxPriceSlippageBps, 200)),
      ),
      requiresRefundability: Boolean(c.requiresRefundability),
      allowedMerchants: Array.isArray(c.allowedMerchants)
        ? c.allowedMerchants.filter((m: unknown) => typeof m === "string")
        : [],
      allowedCategories: Array.isArray(c.allowedCategories)
        ? c.allowedCategories.filter((m: unknown) => typeof m === "string")
        : [],
      fulfillment: c.fulfillment,
    },
  } as T;
}

// ----------------------------------------------------------------------------
// Pricing
// ----------------------------------------------------------------------------

const DEFAULT_TAX_BPS = 1800;

function clampQuantity(raw: unknown): number {
  const q = raw === undefined || raw === null ? 1 : Number(raw);
  return Number.isSafeInteger(q) && q >= 1 && q <= MAX_QTY ? q : 0;
}

/**
 * Price a cart line-by-line and return the full break-down. Pure and
 * deterministic; throws nothing for pricing decisions (a caller-level early
 * return handles missing/invalid lines via the `rejectedLines` shape).
 */
export function priceCart(
  requestedItems: RequestedLineItem[],
  ctx: PricingContext,
): PricedCart {
  const lines: PriceableLine[] = [];
  let subtotalMinor = 0;
  let taxMinor = 0;
  let discountMinor = 0;

  let preSubtotalMinor = 0;
  for (const item of requestedItems) {
    const p = ctx.productMap.get(item.variantId);
    if (!p) continue;
    const qty = clampQuantity(item.quantity);
    if (qty === 0) continue;
    preSubtotalMinor += p.base_price_minor * qty;
  }

  for (const item of requestedItems) {
    const dbProduct = ctx.productMap.get(item.variantId);
    if (!dbProduct) continue;
    const quantity = clampQuantity(item.quantity);
    if (quantity === 0) continue;

    const baseUnitPrice = dbProduct.base_price_minor;
    const discoveryPriceMinor = item.discoveryPriceMinor || baseUnitPrice;

    // Surge re-prices UP (+15% vs discovery) to trigger slippage defence.
    // Otherwise a live campaign may discount the line off list price.
    let unitAmountMinor = ctx.surgeActive
      ? Math.round(baseUnitPrice * 1.15)
      : baseUnitPrice;

    let appliedCampaign: PriceableLine["campaign"];
    if (!ctx.surgeActive && !ctx.negotiationSession) {
      const match = resolveCampaignForLine({
        variantId: dbProduct.variant_id,
        category: dbProduct.category,
        basePriceMinor: unitAmountMinor,
        campaigns: ctx.campaigns,
        orderSubtotalMinor: preSubtotalMinor,
      });
      if (match) {
        unitAmountMinor = match.discountedUnitPriceMinor;
        appliedCampaign = {
          id: match.campaign.id,
          name: match.campaign.name,
          discountBps: match.discountBps,
          discountMinor: match.discountMinor,
        };
      }
    }

    const productAttributes = dbProduct.attributes || {};
    const rating = {
      average: Number(productAttributes.ratingAverage ?? 4.6),
      count: Number(productAttributes.ratingCount ?? 100),
    };

    const negotiatedTerm =
      ctx.negotiationSession && ctx.negotiatedTerms
        ? ctx.negotiatedTerms.get(dbProduct.variant_id)
        : undefined;

    let negotiation = evaluateMerchantNegotiation(
      {
        title: dbProduct.title,
        category: dbProduct.category,
        quantity,
        unitAmountMinor,
        stockQuantity: dbProduct.stock_quantity,
        rating,
      },
      ctx.rules,
    );

    if (
      negotiatedTerm &&
      negotiatedTerm.discountBps > negotiation.discountBps &&
      negotiatedTerm.quantity === quantity
    ) {
      const unitDiscountMinor = Math.round(
        (unitAmountMinor * negotiatedTerm.discountBps) / 10000,
      );
      const discountedUnitAmountMinor = Math.max(
        0,
        unitAmountMinor - unitDiscountMinor,
      );
      negotiation = {
        agentName: `${negotiation.agentName} (Negotiated)`,
        discountBps: negotiatedTerm.discountBps,
        unitDiscountMinor,
        discountedUnitAmountMinor,
        lineDiscountMinor: unitDiscountMinor * quantity,
        merchantMessage: `Negotiation session ${ctx.negotiationSession?.id}: agreed ${(negotiatedTerm.discountBps / 100).toFixed(1)}% off for ${quantity} x ${dbProduct.title}.`,
        requiresMerchantApproval: Boolean(
          ctx.negotiationSession?.requiresMerchantApproval,
        ),
        reasonCodes: ["NEGOTIATED_AGREEMENT"],
      };
    }

    const discountedUnitAmountMinor = negotiation.discountedUnitAmountMinor;
    const lineAmountMinor = discountedUnitAmountMinor * quantity;
    const itemTaxMinor = Math.round(
      (lineAmountMinor * (dbProduct.tax_rate_bps || DEFAULT_TAX_BPS)) / 10000,
    );

    subtotalMinor += lineAmountMinor;
    taxMinor += itemTaxMinor;
    discountMinor += negotiation.lineDiscountMinor;

    lines.push({
      productId: dbProduct.id,
      variantId: dbProduct.variant_id,
      category: dbProduct.category,
      title: dbProduct.title,
      quantity,
      unitAmountMinor: discountedUnitAmountMinor,
      originalUnitAmountMinor: unitAmountMinor,
      discountBps: negotiation.discountBps,
      lineDiscountMinor: negotiation.lineDiscountMinor,
      lineAmountMinor,
      discoveryPriceMinor,
      returnable: dbProduct.returnable,
      rating,
      negotiation,
      campaign: appliedCampaign,
    });
  }

  const shippingMinor = 0; // Free standard shipping
  return {
    lines,
    totals: {
      subtotalMinor,
      discountMinor,
      shippingMinor,
      taxMinor,
      grandTotalMinor: subtotalMinor + taxMinor + shippingMinor,
    },
    preSubtotalMinor,
  };
}

/** Reject a line item with user-facing error semantics (mirrors the API contract). */
export class LineItemError extends Error {
  constructor(
    public readonly code:
      | "PRODUCT_VARIANT_NOT_FOUND"
      | "INVALID_QUANTITY"
      | "INSUFFICIENT_INVENTORY",
    public readonly title?: string,
    public readonly available?: number,
  ) {
    super(
      title
        ? `${code}: ${title}${available !== undefined ? ` (available: ${available})` : ""}`
        : code,
    );
    this.name = "LineItemError";
  }
}

/** Validate availability & quantity BEFORE pricing runs, so a bad cart fails fast. */
export function validateCart(
  requestedItems: RequestedLineItem[],
  productMap: Map<string, PriceableProduct>,
): void {
  for (const item of requestedItems) {
    const product = productMap.get(item.variantId);
    if (!product) {
      throw new LineItemError("PRODUCT_VARIANT_NOT_FOUND", item.variantId);
    }
    const quantity = clampQuantity(item.quantity);
    if (quantity === 0) {
      throw new LineItemError("INVALID_QUANTITY", product.title);
    }
    if (product.stock_quantity < quantity) {
      throw new LineItemError(
        "INSUFFICIENT_INVENTORY",
        product.title,
        product.stock_quantity,
      );
    }
  }
}
