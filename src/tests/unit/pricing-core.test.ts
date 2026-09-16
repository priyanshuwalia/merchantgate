import "./_setup";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  LineItemError,
  type PriceableProduct,
  type PricingContext,
  priceCart,
  type RequestedLineItem,
  sanitizeMandate,
  validateCart,
} from "@/core/pricing";
import { getMerchantAgentRules } from "@/lib/merchant/agent";
import type { Campaign } from "@/lib/merchant/campaigns";

const noopCampaigns: Campaign[] = [];

function product(overrides: Partial<PriceableProduct> = {}): PriceableProduct {
  return {
    id: "prod_1",
    variant_id: "var_headphones_x1",
    category: "audio",
    title: "Aurora Wireless Headphones",
    base_price_minor: 899900,
    stock_quantity: 50,
    tax_rate_bps: 1800,
    returnable: true,
    ...overrides,
  };
}

function ctx(overrides?: Partial<PricingContext>): PricingContext {
  return {
    productMap: new Map([
      [product().variant_id, product()],
      [
        "var_mouse_m1",
        product({
          id: "prod_2",
          variant_id: "var_mouse_m1",
          category: "accessories",
          title: "Ergo Mouse",
          base_price_minor: 149900,
          stock_quantity: 100,
          tax_rate_bps: 1800,
        }),
      ],
      [
        "var_unlucky_u1",
        product({
          id: "prod_3",
          variant_id: "var_unlucky_u1",
          category: "audio",
          title: "Unlucky One",
          base_price_minor: 99900,
          stock_quantity: 2,
        }),
      ],
    ]),
    surgeActive: false,
    campaigns: noopCampaigns,
    rules: getMerchantAgentRules({}),
    ...overrides,
  };
}

describe("pricing core", () => {
  test("prices a single line with tax and no discount", () => {
    const cart = priceCart(
      [{ variantId: "var_headphones_x1", quantity: 2 }],
      ctx(),
    );
    assert.equal(cart.lines.length, 1);
    assert.equal(cart.lines[0].unitAmountMinor, 899900);
    assert.equal(cart.lines[0].lineAmountMinor, 1_799_800);
    assert.equal(cart.totals.subtotalMinor, 1_799_800);
    assert.equal(cart.totals.taxMinor, Math.round((1_799_800 * 1800) / 10000));
    assert.equal(
      cart.totals.grandTotalMinor,
      cart.totals.subtotalMinor + cart.totals.taxMinor,
    );
    assert.equal(cart.lines[0].discountBps, 0);
  });

  test("agrees a bulk discount once quantity crosses the merchant threshold", () => {
    const cart = priceCart(
      [{ variantId: "var_headphones_x1", quantity: 4 }],
      ctx(),
    );
    const line = cart.lines[0];
    assert.ok(line.discountBps > 0, "expected a bulk discount on qty 4");
    assert.equal(
      line.unitAmountMinor,
      Math.round((899900 * (10000 - line.discountBps)) / 10000),
    );
  });

  test("applies a live category campaign discount when not surging", () => {
    const campaign: Campaign = {
      id: "cmp_accessory_week",
      name: "Accessory Week",
      type: "CATEGORY_DISCOUNT",
      category: "accessories",
      discountBps: 1000,
      startsAt: "2026-09-01T00:00:00Z",
      endsAt: "2026-09-30T00:00:00Z",
      status: "active",
      createdAt: "2026-08-30T00:00:00Z",
    };
    const cart = priceCart(
      [{ variantId: "var_mouse_m1", quantity: 1 }],
      ctx({
        campaigns: [campaign],
      }),
    );
    const line = cart.lines[0];
    assert.equal(line.unitAmountMinor, Math.round(149900 * 0.9));
    assert.equal(line.campaign?.id, campaign.id);
    assert.equal(line.campaign?.discountBps, 1000);
  });

  test("surge re-prices UP +15% and suppresses campaigns", () => {
    const campaign: Campaign = {
      id: "cmp_accessory_week",
      name: "Accessory Week",
      type: "CATEGORY_DISCOUNT",
      category: "accessories",
      discountBps: 1000,
      startsAt: "2026-09-01T00:00:00Z",
      endsAt: "2026-09-30T00:00:00Z",
      status: "active",
      createdAt: "2026-08-30T00:00:00Z",
    };
    const cart = priceCart(
      [{ variantId: "var_mouse_m1", quantity: 1 }],
      ctx({
        surgeActive: true,
        campaigns: [campaign],
      }),
    );
    const line = cart.lines[0];
    assert.equal(line.originalUnitAmountMinor, Math.round(149900 * 1.15));
    assert.equal(line.campaign, undefined);
    assert.ok(
      cart.totals.subtotalMinor > 149900,
      "surge must re-price above the base",
    );
  });

  test("negotiated discount overrides static bulk when it beats it", () => {
    const negotiatedTerms = new Map([
      ["var_headphones_x1", { discountBps: 1100, quantity: 2 }],
    ]);
    const cart = priceCart(
      [{ variantId: "var_headphones_x1", quantity: 2 }],
      ctx({
        negotiatedTerms,
        negotiationSession: {
          id: "neg_1",
          requiresMerchantApproval: false,
        },
      }),
    );
    const line = cart.lines[0];
    assert.equal(line.discountBps, 1100);
    assert.equal(
      line.negotiation.agentName,
      "Nimbus Merchant Agent (Negotiated)",
    );
    assert.ok(line.negotiation.reasonCodes.includes("NEGOTIATED_AGREEMENT"));
  });

  test("negotiated discount is ignored when the buy quantity differs", () => {
    const negotiatedTerms = new Map([
      ["var_headphones_x1", { discountBps: 1100, quantity: 5 }],
    ]);
    const cart = priceCart(
      [{ variantId: "var_headphones_x1", quantity: 2 }],
      ctx({
        negotiatedTerms,
        negotiationSession: { id: "neg_1", requiresMerchantApproval: false },
      }),
    );
    assert.notEqual(cart.lines[0].discountBps, 1100);
  });

  test("missing variant, bad quantity and low stock all fail validateCart", () => {
    const map = ctx().productMap;
    assert.throws(
      () => validateCart([{ variantId: "nope", quantity: 1 }], map),
      (e) =>
        e instanceof LineItemError && e.code === "PRODUCT_VARIANT_NOT_FOUND",
    );
    assert.throws(
      () =>
        validateCart([{ variantId: "var_headphones_x1", quantity: -2 }], map),
      (e) => e instanceof LineItemError && e.code === "INVALID_QUANTITY",
    );
    assert.throws(
      () => validateCart([{ variantId: "var_unlucky_u1", quantity: 9 }], map),
      (e) =>
        e instanceof LineItemError &&
        e.code === "INSUFFICIENT_INVENTORY" &&
        e.available === 2,
    );
  });

  test("sanitizeMandate bounds oversize budgets and fills defaults", () => {
    const out = sanitizeMandate({
      type: "intent_mandate.v1",
      id: "int_1",
      constraints: {
        currency: "inr",
        maxTransactionAmountMinor: 1e18,
        rolling30dAmountMinor: 9e15,
        quantityMax: -1,
      } as { maxTransactionAmountMinor: number },
    } as { type: string; id: string; constraints: Record<string, unknown> });
    const c = out.constraints as {
      currency: string;
      maxTransactionAmountMinor: number;
      rolling30dAmountMinor: number;
      quantityMax: number;
    };
    assert.equal(c.currency, "INR");
    assert.equal(c.maxTransactionAmountMinor, 1_000_000_000);
    assert.equal(c.rolling30dAmountMinor, 5_000_000_000);
    assert.equal(c.quantityMax, 1_000_000);
  });

  test("line items accumulate totals across a multi-line cart", () => {
    const cart = priceCart(
      [
        { variantId: "var_headphones_x1", quantity: 1 },
        { variantId: "var_mouse_m1", quantity: 2 },
      ] as RequestedLineItem[],
      ctx(),
    );
    assert.equal(cart.lines.length, 2);
    const expectedSubtotal = 899900 + 149900 * 2;
    assert.equal(cart.totals.subtotalMinor, expectedSubtotal);
    assert.ok(cart.totals.grandTotalMinor > expectedSubtotal);
  });
});
