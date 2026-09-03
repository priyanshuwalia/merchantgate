import "./_setup";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_UPSELL_RULES,
  generateUpsellOffers,
  getUpsellRules,
  resolveUpsellOffer,
} from "@/lib/merchant/upsell";

const keyboard = {
  variantId: "kbd_nimbus_75_black_brown",
  title: "Nimbus 75 Keyboard",
  category: "electronics",
  quantity: 1,
  unitAmountMinor: 349900,
};
const mouse = {
  variantId: "mse_nimbus_pro_white",
  title: "Nimbus Pro Mouse",
  category: "electronics",
  quantity: 1,
  unitAmountMinor: 189900,
};

const catalog = [
  {
    variantId: "kbd_nimbus_75_black_brown",
    title: "Nimbus 75 Keyboard",
    category: "electronics",
    unitAmountMinor: 349900,
    stockQuantity: 45,
  },
  {
    variantId: "mse_nimbus_pro_white",
    title: "Nimbus Pro Mouse",
    category: "electronics",
    unitAmountMinor: 189900,
    stockQuantity: 80,
  },
  {
    variantId: "acc_nimbus_deskmat",
    title: "Desk Mat",
    category: "accessories",
    unitAmountMinor: 19900,
    stockQuantity: 250,
  },
  {
    variantId: "acc_nimbus_switch_set",
    title: "Switch Set",
    category: "accessories",
    unitAmountMinor: 12900,
    stockQuantity: 180,
  },
  {
    variantId: "acc_kbd_wristrest",
    title: "Wrist Rest",
    category: "accessories",
    unitAmountMinor: 9900,
    stockQuantity: 320,
  },
  {
    variantId: "acc_nimbus_charger",
    title: "GaN Charger",
    category: "accessories",
    unitAmountMinor: 15900,
    stockQuantity: 150,
  },
  {
    variantId: "acc_headphone_stand",
    title: "Headphone Stand",
    category: "accessories",
    unitAmountMinor: 22900,
    stockQuantity: 120,
  },
  {
    variantId: "acc_oos_item",
    title: "Out of Stock Add-on",
    category: "accessories",
    unitAmountMinor: 5000,
    stockQuantity: 0,
  },
];

describe("upsell engine", () => {
  test("returns disabled immediately when rules.enabled is false", () => {
    const result = generateUpsellOffers({
      cart: [keyboard],
      catalog,
      rules: { ...DEFAULT_UPSELL_RULES, enabled: false },
    });
    assert.equal(result.enabled, false);
    assert.deepEqual(result.reasonCodes, ["UPSELL_DISABLED"]);
    assert.equal(result.offers.length, 0);
  });

  test("only offers in-stock compatible accessory add-ons, never cart items", () => {
    const result = generateUpsellOffers({
      cart: [keyboard],
      catalog,
      rules: getUpsellRules(),
    });
    assert.ok(result.offers.length >= 1, "expected at least one offer");
    for (const offer of result.offers) {
      for (const item of offer.items) {
        assert.notEqual(
          item.variantId,
          keyboard.variantId,
          "cart item offered",
        );
        assert.ok(item.unitAmountMinor > 0);
      }
    }
    // The out-of-stock candidate must never be offered.
    const variants = result.offers
      .flatMap((o) => o.items)
      .map((i) => i.variantId);
    assert.ok(!variants.includes("acc_oos_item"), "out-of-stock item offered");
  });

  test("respects the basket uplift cap (40% of cart by default)", () => {
    const result = generateUpsellOffers({
      cart: [keyboard],
      catalog,
      rules: getUpsellRules(),
    });
    const maxUplift = Math.round((keyboard.unitAmountMinor * 4000) / 10000);
    assert.equal(result.maxUpliftMinor, maxUplift);
    assert.ok(
      result.totalUpliftMinor <= maxUplift,
      `totalUpliftMinor ${result.totalUpliftMinor} > cap ${maxUplift}`,
    );
  });

  test("learns cross-sell affinity from real market baskets (co-occurrence)", () => {
    // acc_headphone_stand is NOT in the mouse's explicit compat list, but a
    // market basket shows mouse+headphone-stand co-purchase, so it must be
    // scored via MARKET_BASKET_AFFINITY and earn a slot in the top offers.
    const result = generateUpsellOffers({
      cart: [mouse],
      catalog,
      rules: getUpsellRules(),
      marketBaskets: [
        {
          agentId: "agt_a",
          variantIds: [mouse.variantId, "acc_headphone_stand"],
        },
        {
          agentId: "agt_b",
          variantIds: [mouse.variantId, "acc_headphone_stand"],
        },
      ],
    });
    const offered = result.offers
      .flatMap((o) => o.items)
      .map((i) => i.variantId);
    assert.ok(
      offered.includes("acc_headphone_stand"),
      "co-occurring item not offered",
    );
    const marked = result.offers.find((o) =>
      o.reasonCodes.some((c) => c.startsWith("MARKET_BASKET_AFFINITY")),
    );
    assert.ok(marked, "no affinity reason code on any offer");
    assert.equal(result.metadata.marketBasketsAnalyzed, 2);
  });

  test("generates a BUNDLE offer when the cart contains a hero item", () => {
    const result = generateUpsellOffers({
      cart: [keyboard],
      catalog,
      rules: getUpsellRules(),
    });
    const bundle = result.offers.find((o) => o.type === "BUNDLE");
    assert.ok(bundle, "expected a bundle offer for a hero cart");
    assert.ok(bundle.bundleDiscountMinor > 0, "bundle should carry a discount");
    assert.ok(bundle.addedTotalMinor < bundle.subtotalMinor);
  });

  test("resolveUpsellOffer re-derives items deterministically; rejects unknown ids", () => {
    const first = generateUpsellOffers({
      cart: [keyboard],
      catalog,
      rules: getUpsellRules(),
    });
    assert.ok(first.offers.length > 0);
    const accepted = resolveUpsellOffer({
      cart: [keyboard],
      catalog,
      rules: getUpsellRules(),
      upsellOfferId: first.offers[0].offerId,
    });
    assert.ok(accepted && accepted.length > 0);
    const rejected = resolveUpsellOffer({
      cart: [keyboard],
      catalog,
      rules: getUpsellRules(),
      upsellOfferId: "up_fake_injected_id",
    });
    assert.equal(
      rejected,
      null,
      "injected unknown offer id must resolve to nothing",
    );
  });

  test("limits offer count and item count via rules", () => {
    const rules = getUpsellRules({
      upsellRules: { maxUpsellOffers: 2, maxUpsellItems: 1 },
    });
    const result = generateUpsellOffers({ cart: [keyboard], catalog, rules });
    const addOns = result.offers.filter((o) => o.type === "ADD_ON");
    assert.ok(addOns.length <= 2);
    for (const offer of result.offers) assert.ok(offer.items.length <= 1);
  });
});
