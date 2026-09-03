import "./_setup";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CartMandateQuote, IntentMandate } from "@/lib/policy/engine";
import { evaluatePolicy } from "@/lib/policy/engine";

function buildMandate(
  overrides: Partial<IntentMandate> = {},
  constraints: IntentMandate["constraints"] = {
    maxTransactionAmountMinor: 500000,
    rolling30dAmountMinor: 2000000,
    currency: "INR",
  },
): IntentMandate {
  return {
    type: "intent_mandate.v1",
    id: "int_test_001",
    revision: 1,
    principal: { userId: "user_demo_01" },
    delegate: { agentId: "agt_apollo_buyer_v1", agentVersion: "1.0.0" },
    mode: "delegated",
    constraints,
    validity: {
      notBefore: "2026-01-01T00:00:00Z",
      expiresAt: "2027-01-01T00:00:00Z",
    },
    status: "active",
    approval: {
      method: "uaap_2fa",
      approvedBy: "user_demo_01",
      approvedAt: "2026-01-01T00:00:00Z",
    },
    ...overrides,
  };
}

function buildCart(
  grandTotalMinor: number,
  overrides: Partial<CartMandateQuote> = {},
): CartMandateQuote {
  return {
    merchantId: "mch_nimbus_gear_001",
    items: [
      {
        productId: "prod_kbd_nimbus_75",
        variantId: "kbd_nimbus_75_black_brown",
        category: "electronics",
        title: "Nimbus 75 Keyboard",
        quantity: 1,
        unitAmountMinor: grandTotalMinor,
        lineAmountMinor: grandTotalMinor,
      },
    ],
    totals: {
      subtotalMinor: grandTotalMinor,
      discountMinor: 0,
      shippingMinor: 0,
      taxMinor: 0,
      grandTotalMinor,
      currency: "INR",
    },
    fulfillment: { country: "IN" },
    terms: { refundable: true, returnWindowDays: 7 },
    ...overrides,
  };
}

describe("policy engine", () => {
  test("ALLOWs an in-budget transaction with no step-up config", () => {
    const result = evaluatePolicy(buildMandate(), buildCart(350000), {
      autoProcessAgentOrders: true,
    });
    assert.equal(result.decision, "ALLOW");
    assert.ok(result.reasonCodes.includes("MANDATE_CONSTRAINTS_SATISFIED"));
  });

  test("DENYs a transaction over the mandate limit", () => {
    const result = evaluatePolicy(buildMandate(), buildCart(900000), {
      autoProcessAgentOrders: true,
    });
    assert.equal(result.decision, "DENY");
    assert.ok(result.reasonCodes.includes("TRANSACTION_LIMIT_EXCEEDED"));
  });

  test("DENYs when rolling 30-day budget is exhausted (B5)", () => {
    const result = evaluatePolicy(
      buildMandate(
        {},
        { maxTransactionAmountMinor: 500000, rolling30dAmountMinor: 2000000 },
      ),
      buildCart(350000),
      { autoProcessAgentOrders: true, rollingBudgetUsageMinor: 1800000 },
    );
    assert.equal(result.decision, "DENY");
    assert.ok(result.reasonCodes.includes("ROLLING_BUDGET_EXHAUSTED"));
    assert.ok(
      result.reasonCodes.some((c) => c.startsWith("ROLLING_BUDGET_REMAINING_")),
    );
    // remaining = 2_000_000 - 1_800_000 = 200_000 < 350_000 requested
    assert.equal(result.money.rollingBudgetRemainingMinor, 0);
  });

  test("ALLOWs when rolling budget has headroom and reflects true remaining", () => {
    const result = evaluatePolicy(
      buildMandate(
        {},
        { maxTransactionAmountMinor: 500000, rolling30dAmountMinor: 2000000 },
      ),
      buildCart(200000),
      { autoProcessAgentOrders: true, rollingBudgetUsageMinor: 500000 },
    );
    assert.equal(result.decision, "ALLOW");
    assert.equal(result.money.rollingBudgetRemainingMinor, 1300000);
    // effective transaction ceiling reflects rolling headroom
    assert.ok(result.money.transactionLimitMinor <= 500000);
  });

  test("STEP_UPs on price slippage beyond tolerance", () => {
    const result = evaluatePolicy(
      buildMandate(),
      buildCart(350000, {
        items: [
          {
            productId: "p",
            variantId: "v",
            category: "electronics",
            title: "T",
            quantity: 1,
            unitAmountMinor: 350000,
            lineAmountMinor: 350000,
            discoveryPriceMinor: 300000,
          },
        ],
      }),
      { autoProcessAgentOrders: true, priceSlippageToleranceBps: 200 },
    );
    assert.equal(result.decision, "STEP_UP");
    assert.ok(result.reasonCodes.includes("PRICE_SLIPPAGE_EXCEEDED"));
  });

  test("DENYs a tampered devProof digest", () => {
    const result = evaluatePolicy(
      buildMandate({
        devProof: { type: "sha256-canonical-json", digest: "corrupted" },
      }),
      buildCart(100000),
      { autoProcessAgentOrders: true },
    );
    assert.equal(result.decision, "DENY");
    assert.ok(result.reasonCodes.includes("TAMPERED_PROOF_SIGNATURE"));
  });

  test("DEClared currency mismatch denies", () => {
    const result = evaluatePolicy(
      buildMandate({}, { maxTransactionAmountMinor: 500000, currency: "USD" }),
      buildCart(100000),
      { autoProcessAgentOrders: true },
    );
    assert.equal(result.decision, "DENY");
    assert.ok(result.reasonCodes.includes("CURRENCY_MISMATCH"));
  });
});
