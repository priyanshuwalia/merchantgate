import "./_setup";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type CatalogMatchInput,
  rankCatalogMatches,
  scoreCatalogMatch,
  selectableMatches,
  selectCatalogMatch,
  stem,
  tokenize,
} from "@/core/catalog-match";

function item(
  overrides: Partial<CatalogMatchInput> & { variantId: string },
): CatalogMatchInput {
  return {
    title: "Untitled SKU",
    category: "accessories",
    description: "",
    basePriceMinor: 100000,
    inStock: true,
    ...overrides,
  };
}

/** The exact two rows from the demo catalogue that caused the substitution. */
const HEADPHONES = item({
  variantId: "aud_nimbus_anc_pro",
  title: "Nimbus Studio ANC Wireless Headphones",
  category: "audio",
  description: "Over-ear ANC wireless headphones with 40h battery.",
  basePriceMinor: 649900,
});
const HEADPHONE_STAND = item({
  variantId: "acc_headphone_stand",
  title: "Aluminum Headphone Stand with USB Hub",
  category: "accessories",
  description: "A stand for your headphones with a built-in USB hub.",
  basePriceMinor: 22900,
});
const LAPTOP_STAND = item({
  variantId: "acc_nimbus_stand_alu",
  title: "Ergonomic Aluminum Foldable Laptop Stand",
  category: "accessories",
  basePriceMinor: 279900,
});

describe("tokenize", () => {
  test("folds plurals and drops stop words", () => {
    assert.deepEqual(tokenize("Best headphones under 8K"), ["headphone"]);
    assert.deepEqual(tokenize("Mechanical Keyboards"), [
      "mechanical",
      "keyboard",
    ]);
  });

  test("stem keeps irregular plurals sane", () => {
    assert.equal(stem("headphones"), "headphone");
    assert.equal(stem("batteries"), "battery");
    assert.equal(stem("cases"), "case");
    assert.equal(stem("cables"), "cable");
    assert.equal(stem("glasses"), "glass");
    assert.equal(stem("keyboard"), "keyboard");
  });
});

describe("scoreCatalogMatch", () => {
  test("a headphone query matches the headphones, not the stand", () => {
    const match = scoreCatalogMatch("headphone", HEADPHONES);
    assert.equal(match.verdict, "exact");
    assert.equal(match.selectable, true);
  });

  test("a headphone query is rejected by the headphone stand", () => {
    const match = scoreCatalogMatch("headphone", HEADPHONE_STAND);
    assert.equal(match.verdict, "accessory");
    assert.equal(match.selectable, false);
    assert.match(match.reason, /COMPLEMENT_FOR_REQUEST/);
  });

  test("accessory candidates still score for their OWN query", () => {
    const stand = scoreCatalogMatch("headphone stand", HEADPHONE_STAND);
    const hub = scoreCatalogMatch("usb hub", HEADPHONE_STAND);
    const laptopStand = scoreCatalogMatch("laptop stand", LAPTOP_STAND);
    assert.equal(stand.verdict, "exact");
    assert.equal(stand.selectable, true);
    assert.equal(hub.verdict, "exact");
    assert.equal(hub.selectable, true);
    assert.equal(laptopStand.verdict, "exact");
    assert.equal(laptopStand.selectable, true);
  });

  test("an empty query is never selectable (fail closed)", () => {
    for (const query of ["", "   ", "for me"]) {
      const match = scoreCatalogMatch(query, HEADPHONES);
      assert.equal(match.selectable, false, `query=${JSON.stringify(query)}`);
    }
  });

  test("description-only matches are weak, not selectable", () => {
    const mentionsOnly = item({
      variantId: "mse_nimbus_pro_white",
      title: "Nimbus Pro Wireless Ultralight Gaming Mouse",
      category: "electronics",
      description: "Pairs well with any gaming headset.",
    });
    const match = scoreCatalogMatch("headset", mentionsOnly);
    assert.equal(match.verdict, "weak");
    assert.equal(match.selectable, false);
  });

  test("multi-word queries need the head noun to be the product", () => {
    const query = "wireless headphones";
    assert.equal(scoreCatalogMatch(query, HEADPHONES).verdict, "exact");
    assert.equal(
      scoreCatalogMatch(query, HEADPHONE_STAND).verdict,
      "accessory",
    );
  });
});

describe("rankCatalogMatches", () => {
  test("ranks the requested product above its accessories", () => {
    const ranked = rankCatalogMatches(
      [HEADPHONE_STAND, HEADPHONES, LAPTOP_STAND],
      "headphone",
    );
    assert.equal(ranked[0].item.variantId, "aud_nimbus_anc_pro");
    assert.deepEqual(
      selectableMatches(ranked).map((m) => m.item.variantId),
      ["aud_nimbus_anc_pro"],
    );
  });

  test("a category constraint is a hard filter", () => {
    const ranked = rankCatalogMatches(
      [HEADPHONES, HEADPHONE_STAND],
      "headphone",
      { category: "accessories" },
    );
    assert.deepEqual(
      ranked.map((m) => m.item.variantId),
      ["acc_headphone_stand"],
    );
  });

  test("tie-breaks are deterministic (stock, then price, then variant id)", () => {
    const a = item({
      variantId: "b_sku",
      title: "Studio Stand",
      basePriceMinor: 50000,
      inStock: false,
    });
    const b = item({
      variantId: "a_sku",
      title: "Studio Stand",
      basePriceMinor: 90000,
      inStock: true,
    });
    const c = item({
      variantId: "c_sku",
      title: "Studio Stand",
      basePriceMinor: 50000,
      inStock: true,
    });
    const ranked = rankCatalogMatches([a, b, c], "studio stand");
    assert.deepEqual(
      ranked.map((m) => m.item.variantId),
      ["c_sku", "a_sku", "b_sku"],
    );
  });
});

describe("selectCatalogMatch", () => {
  test("returns the requested product", () => {
    const best = selectCatalogMatch(
      [HEADPHONE_STAND, HEADPHONES],
      "headphone",
      { category: "audio" },
    );
    assert.equal(best?.item.variantId, "aud_nimbus_anc_pro");
  });

  test("returns null instead of substituting an unrelated SKU", () => {
    assert.equal(
      selectCatalogMatch([HEADPHONE_STAND, LAPTOP_STAND], "headphone"),
      null,
    );
    assert.equal(selectCatalogMatch([], "headphone"), null);
    assert.equal(selectCatalogMatch([HEADPHONES], "telescope"), null);
  });
});
