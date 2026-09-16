import "./_setup";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Campaign } from "@/lib/merchant/campaigns";
import {
  isCampaignLive,
  resolveCampaignForLine,
} from "@/lib/merchant/campaigns";

const now = new Date("2026-09-02T12:00:00Z");

const liveCategory: Campaign = {
  id: "cmp_test_1",
  name: "Accessory Week",
  type: "CATEGORY_DISCOUNT",
  category: "accessories",
  discountBps: 1000,
  startsAt: "2026-09-01T00:00:00Z",
  endsAt: "2026-09-08T00:00:00Z",
  status: "active",
  createdAt: "2026-08-31T00:00:00Z",
};

describe("campaign engine", () => {
  test("isCampaignLive requires active status and a valid window", () => {
    assert.equal(isCampaignLive(liveCategory, now), true);
    assert.equal(
      isCampaignLive({ ...liveCategory, status: "draft" }, now),
      false,
    );
    assert.equal(
      isCampaignLive({ ...liveCategory, endsAt: "2026-09-01T00:00:00Z" }, now),
      false,
    );
    assert.equal(
      isCampaignLive(
        { ...liveCategory, startsAt: "2026-09-03T00:00:00Z" },
        now,
      ),
      false,
    );
  });

  test("CATEGORY_DISCOUNT applies to matching category only", () => {
    const match = resolveCampaignForLine({
      variantId: "acc_nimbus_deskmat",
      category: "accessories",
      basePriceMinor: 19900,
      campaigns: [liveCategory],
      now,
    });
    assert.ok(match);
    // 10% off ₹199 → ₹179 (rounded down? 19900 * 0.9 = 17910)
    assert.equal(match.discountedUnitPriceMinor, 17910);
    assert.equal(match.discountBps, 1000);

    const noMatch = resolveCampaignForLine({
      variantId: "kbd_nimbus_75_black_brown",
      category: "electronics",
      basePriceMinor: 349900,
      campaigns: [liveCategory],
      now,
    });
    assert.equal(noMatch, null);
  });

  test("FLAT_DISCOUNT matches explicit variant ids", () => {
    const flat: Campaign = {
      id: "cmp_flat",
      name: "Keyboard Week",
      type: "FLAT_DISCOUNT",
      variantIds: ["kbd_nimbus_75_black_brown"],
      discountBps: 500,
      startsAt: "2026-09-01T00:00:00Z",
      endsAt: "2026-09-08T00:00:00Z",
      status: "active",
      createdAt: "2026-08-31T00:00:00Z",
    };
    const hit = resolveCampaignForLine({
      variantId: "kbd_nimbus_75_black_brown",
      category: "electronics",
      basePriceMinor: 349900,
      campaigns: [flat],
      now,
    });
    assert.ok(hit);
    assert.equal(hit.discountBps, 500);
    const miss = resolveCampaignForLine({
      variantId: "mse_nimbus_pro_white",
      category: "electronics",
      basePriceMinor: 189900,
      campaigns: [flat],
      now,
    });
    assert.equal(miss, null);
  });

  test("minOrderMinor gates the discount on order subtotal", () => {
    const gated: Campaign = {
      ...liveCategory,
      minOrderMinor: 50000,
    };
    const above = resolveCampaignForLine({
      variantId: "acc_nimbus_deskmat",
      category: "accessories",
      basePriceMinor: 19900,
      campaigns: [gated],
      orderSubtotalMinor: 60000,
      now,
    });
    assert.ok(above);
    const below = resolveCampaignForLine({
      variantId: "acc_nimbus_deskmat",
      category: "accessories",
      basePriceMinor: 19900,
      campaigns: [gated],
      orderSubtotalMinor: 30000,
      now,
    });
    assert.equal(below, null);
  });

  test("discount is hard-capped at 4000 bps regardless of config", () => {
    const absurd: Campaign = { ...liveCategory, discountBps: 9000 };
    const match = resolveCampaignForLine({
      variantId: "acc_nimbus_deskmat",
      category: "accessories",
      basePriceMinor: 10000,
      campaigns: [absurd],
      now,
    });
    assert.ok(match);
    assert.equal(match.discountBps, 4000);
    assert.equal(match.discountedUnitPriceMinor, 6000);
  });

  test("BUNDLE_DISCOUNT is never applied at line level", () => {
    const bundle: Campaign = {
      ...liveCategory,
      type: "BUNDLE_DISCOUNT",
      category: undefined,
      discountBps: 700,
    };
    assert.equal(
      resolveCampaignForLine({
        variantId: "acc_nimbus_deskmat",
        category: "accessories",
        basePriceMinor: 19900,
        campaigns: [bundle],
        now,
      }),
      null,
    );
  });

  test("budget-exhausted campaign is skipped entirely", () => {
    const exhausted: Campaign = {
      ...liveCategory,
      budgetMinor: 1000,
      spentMinor: 1000,
    };
    assert.equal(
      resolveCampaignForLine({
        variantId: "acc_nimbus_deskmat",
        category: "accessories",
        basePriceMinor: 19900,
        campaigns: [exhausted],
        now,
      }),
      null,
    );
    // With headroom it still applies.
    const ok = resolveCampaignForLine({
      variantId: "acc_nimbus_deskmat",
      category: "accessories",
      basePriceMinor: 19900,
      campaigns: [{ ...exhausted, spentMinor: 500 }],
      now,
    });
    assert.ok(ok);
  });

  test("higher priority campaign wins when multiple match", () => {
    const low: Campaign = { ...liveCategory, priority: 0, discountBps: 1000 };
    const high: Campaign = { ...liveCategory, priority: 5, discountBps: 500 };
    const match = resolveCampaignForLine({
      variantId: "acc_nimbus_deskmat",
      category: "accessories",
      basePriceMinor: 19900,
      campaigns: [low, high],
      now,
    });
    assert.ok(match);
    assert.equal(match.campaign.id, high.id);
    assert.equal(match.discountBps, 500);
  });

  test("non-stackable campaign beats a stackable one on a line", () => {
    const stackable: Campaign = {
      ...liveCategory,
      stackable: true,
      priority: 9,
      discountBps: 1000,
    };
    const nonStack: Campaign = {
      ...liveCategory,
      stackable: false,
      priority: 0,
      discountBps: 500,
    };
    const match = resolveCampaignForLine({
      variantId: "acc_nimbus_deskmat",
      category: "accessories",
      basePriceMinor: 19900,
      campaigns: [stackable, nonStack],
      now,
    });
    assert.ok(match);
    assert.equal(match.campaign.id, nonStack.id);
  });

  test("AGENT_TARGETED only applies for allow-listed agents", () => {
    const targeted: Campaign = {
      ...liveCategory,
      type: "AGENT_TARGETED",
      category: "accessories",
      targetAgents: ["agt_apollo_buyer_v1"],
    };
    const allowed = resolveCampaignForLine({
      variantId: "acc_nimbus_deskmat",
      category: "accessories",
      basePriceMinor: 19900,
      campaigns: [targeted],
      agentId: "agt_apollo_buyer_v1",
      now,
    });
    assert.ok(allowed);
    const denied = resolveCampaignForLine({
      variantId: "acc_nimbus_deskmat",
      category: "accessories",
      basePriceMinor: 19900,
      campaigns: [targeted],
      agentId: "agt_other_buyer",
      now,
    });
    assert.equal(denied, null);
  });

  test("FLASH_SALE never drops below the configured floor price", () => {
    const flash: Campaign = {
      ...liveCategory,
      type: "FLASH_SALE",
      category: "accessories",
      discountBps: 4000,
      flashPriceMinor: 15000,
    };
    const match = resolveCampaignForLine({
      variantId: "acc_nimbus_deskmat",
      category: "accessories",
      basePriceMinor: 19900,
      campaigns: [flash],
      now,
    });
    assert.ok(match);
    // 19900 - 40% = 11940, but floor is 15000 → price floors at 15000.
    assert.equal(match.discountedUnitPriceMinor, 15000);
  });

  test("TIERED_DISCOUNT escalates bps as order subtotal clears tiers", () => {
    const tiered: Campaign = {
      ...liveCategory,
      type: "TIERED_DISCOUNT",
      category: "accessories",
      discountBps: 0,
      tiers: [
        { minOrderMinor: 100000, discountBps: 1500 },
        { minOrderMinor: 50000, discountBps: 1000 },
      ],
    };
    const low = resolveCampaignForLine({
      variantId: "acc_nimbus_deskmat",
      category: "accessories",
      basePriceMinor: 19900,
      campaigns: [tiered],
      orderSubtotalMinor: 60000,
      now,
    });
    assert.ok(low);
    assert.equal(low.discountBps, 1000); // clears 50k tier
    const high = resolveCampaignForLine({
      variantId: "acc_nimbus_deskmat",
      category: "accessories",
      basePriceMinor: 19900,
      campaigns: [tiered],
      orderSubtotalMinor: 120000,
      now,
    });
    assert.ok(high);
    assert.equal(high.discountBps, 1500); // clears 100k tier
  });

  test("scheduleDays gates the campaign by weekday", () => {
    const scheduled: Campaign = {
      ...liveCategory,
      scheduleDays: [0, 6], // weekends only (2026-09-02 is a Wednesday)
    };
    assert.equal(isCampaignLive(scheduled, now), false);
    assert.equal(
      isCampaignLive(scheduled, new Date("2026-09-05T12:00:00Z")),
      true,
    );
  });
});
