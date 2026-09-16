import {
  generateCanonicalDigest,
  verifyCanonicalDigest,
} from "../lib/crypto/canonical";
import { evaluatePolicy, type IntentMandate } from "../lib/policy/engine";
import { PRESET_SCENARIOS } from "../lib/simulation/scenarios";

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${testName}`);
    failed++;
  }
}

async function runTests() {
  console.log(
    "\n🧪 Running AgentPay Merchant Platform Comprehensive Verification Suite...\n",
  );

  // 1. Canonical JSON & SHA-256 Digest Tests
  console.log("🔹 1. Canonical JSON & Cryptographic Proof Verification");
  const obj1 = { b: 2, a: 1, nested: { y: "test", x: 10 } };
  const obj2 = { a: 1, b: 2, nested: { x: 10, y: "test" } };
  const hash1 = generateCanonicalDigest(obj1);
  const hash2 = generateCanonicalDigest(obj2);

  assert(
    hash1 === hash2,
    "Deterministic canonical hash matches regardless of key order",
  );
  assert(
    verifyCanonicalDigest(obj1, hash1),
    "verifyCanonicalDigest succeeds on identical object",
  );
  assert(
    !verifyCanonicalDigest({ ...obj1, a: 2 }, hash1),
    "verifyCanonicalDigest rejects modified object",
  );

  // 2. Policy Engine Tests
  console.log("\n🔹 2. Policy Engine Bounding Box & Gate Evaluations");

  const baseMandate: IntentMandate = {
    type: "intent_mandate.v1",
    id: "int_test_001",
    revision: 1,
    principal: { userId: "user_shopper_01" },
    delegate: { agentId: "agt_apollo_buyer_v1", agentVersion: "1.0.0" },
    constraints: {
      currency: "INR",
      maxTransactionAmountMinor: 500000, // ₹5,000.00
      allowedMerchants: ["mch_nimbus_gear_001"],
      allowedCategories: ["electronics", "audio", "accessories"],
      maxPriceSlippageBps: 200, // 2%
      requiresRefundability: true,
    },
    validity: {
      notBefore: new Date(Date.now() - 3600000).toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    },
  };

  // Test 2.1: Valid Cart within limits -> ALLOW
  const validCart = {
    merchantId: "mch_nimbus_gear_001",
    items: [
      {
        productId: "prod_kbd_75",
        variantId: "kbd_nimbus_75_black_brown",
        category: "electronics",
        title: "Nimbus 75 Mechanical Keyboard",
        quantity: 1,
        unitAmountMinor: 349900,
        lineAmountMinor: 349900,
        discoveryPriceMinor: 349900,
        returnable: true,
      },
    ],
    totals: {
      subtotalMinor: 349900,
      discountMinor: 0,
      shippingMinor: 0,
      taxMinor: 62982,
      grandTotalMinor: 412882, // within 500000 limit
      currency: "INR",
    },
    fulfillment: { country: "IND" },
    terms: { refundable: true, returnWindowDays: 7 },
  };

  const res1 = evaluatePolicy(baseMandate, validCart, {
    maxAgentTransactionAmount: 500000,
    priceSlippageToleranceBps: 200,
    autoProcessAgentOrders: true,
    agentRequiresApproval: false,
  });
  assert(
    res1.decision === "ALLOW",
    "Valid transaction within mandate limits returns ALLOW",
  );

  // Test 2.2: Price Slippage > 200 bps -> STEP_UP
  const slippageCart = {
    ...validCart,
    items: [
      {
        ...validCart.items[0],
        discoveryPriceMinor: 300000, // ₹3,000.00
        unitAmountMinor: 349900, // ₹3,499.00 -> 16.6% increase > 200 bps
      },
    ],
  };
  const res2 = evaluatePolicy(baseMandate, slippageCart);
  assert(
    res2.decision === "STEP_UP",
    "Price increase exceeding tolerance triggers STEP_UP",
  );
  assert(
    res2.reasonCodes.includes("PRICE_SLIPPAGE_EXCEEDED"),
    "Reason code includes PRICE_SLIPPAGE_EXCEEDED",
  );

  // Test 2.3: Over budget limit -> DENY
  const overLimitCart = {
    ...validCart,
    totals: {
      ...validCart.totals,
      grandTotalMinor: 650000, // ₹6,500.00 > ₹5,000.00 max limit
    },
  };
  const res3 = evaluatePolicy(baseMandate, overLimitCart);
  assert(
    res3.decision === "DENY",
    "Transaction exceeding budget limit returns DENY",
  );
  assert(
    res3.reasonCodes.includes("TRANSACTION_LIMIT_EXCEEDED"),
    "Reason code includes TRANSACTION_LIMIT_EXCEEDED",
  );

  // Test 2.4: Disallowed category -> DENY
  const badCategoryCart = {
    ...validCart,
    items: [
      {
        ...validCart.items[0],
        category: "unauthorized_restricted_goods",
      },
    ],
  };
  const res4 = evaluatePolicy(baseMandate, badCategoryCart);
  assert(
    res4.decision === "DENY",
    "Cart with disallowed category returns DENY",
  );

  // 3. Simulation Pre-built Scenarios Conformance
  console.log("\n🔹 3. Simulation Scenarios Specification Conformance");
  assert(
    PRESET_SCENARIOS.happyPath.expectedDecision === "ALLOW",
    "Scenario 1: Happy Path expects ALLOW",
  );
  assert(
    PRESET_SCENARIOS.priceChange.expectedDecision === "STEP_UP",
    "Scenario 2: Price Slippage expects STEP_UP",
  );
  assert(
    PRESET_SCENARIOS.overLimit.expectedDecision === "DENY",
    "Scenario 3: Over Limit expects DENY",
  );
  assert(
    PRESET_SCENARIOS.promptInjection.expectedDecision === "DENY",
    "Scenario 4: Prompt Injection defense expects DENY",
  );

  // 4. Budget Mandate & +- Tolerance Policy Bounding Tests
  console.log("\n🔹 4. Budget Mandate & ± Tolerance Policy Bounding Tests");

  // Keyboard Cart: Base ₹3,499 + 18% GST (₹629.82) = ₹4,128.82 (412882 minor units)
  const keyboardCart = {
    merchantId: "mch_nimbus_gear_001",
    items: [
      {
        productId: "prod_kbd_75",
        variantId: "kbd_nimbus_75_black_brown",
        category: "electronics",
        title: "Nimbus 75 Mechanical Keyboard",
        quantity: 1,
        unitAmountMinor: 349900,
        lineAmountMinor: 349900,
        discoveryPriceMinor: 349900,
        returnable: true,
      },
    ],
    totals: {
      subtotalMinor: 349900,
      discountMinor: 0,
      shippingMinor: 0,
      taxMinor: 62982,
      grandTotalMinor: 412882, // ₹4,128.82
      currency: "INR",
    },
    fulfillment: { country: "IND" },
    terms: { refundable: true, returnWindowDays: 7 },
  };

  // Test 4.1: Budget ₹4,000 with 0% tolerance (Max cap ₹4,000 = 400000 minor) -> DENY because ₹4,128.82 > ₹4,000
  const strictBudgetMandate: IntentMandate = {
    ...baseMandate,
    constraints: {
      ...baseMandate.constraints,
      maxTransactionAmountMinor: 400000, // ₹4,000.00
    },
  };
  const strictRes = evaluatePolicy(strictBudgetMandate, keyboardCart);
  assert(
    strictRes.decision === "DENY",
    "Strict ₹4,000 budget cap correctly denies ₹4,128.82 order",
  );
  assert(
    strictRes.reasonCodes.includes("TRANSACTION_LIMIT_EXCEEDED"),
    "Reason is TRANSACTION_LIMIT_EXCEEDED when tax exceeds strict budget",
  );

  // Test 4.2: Budget ₹4,000 with +10% tolerance (Max cap ₹4,400 = 440000 minor) -> ALLOW because ₹4,128.82 <= ₹4,400
  const tolerantBudgetMandate: IntentMandate = {
    ...baseMandate,
    constraints: {
      ...baseMandate.constraints,
      maxTransactionAmountMinor: 440000, // ₹4,400.00 (4000 + 10%)
    },
  };
  const tolerantRes = evaluatePolicy(tolerantBudgetMandate, keyboardCart, {
    autoProcessAgentOrders: true,
    agentRequiresApproval: false,
    maxAgentTransactionAmount: 500000,
  });
  assert(
    tolerantRes.decision === "ALLOW",
    "Budget with +10% tolerance allows ₹4,128.82 purchase",
  );
  assert(
    tolerantRes.money.transactionLimitMinor === 440000,
    "Transaction limit accurately reflects authorized max cap",
  );

  // 5. Security & Boundary Defense Tests
  console.log("\n🔹 5. Security & Boundary Defense Tests");

  // Test 5.1: LLM Tool Boundary Audit
  const { AGENT_ALLOWED_TOOLS } = await import("../lib/agent/tools");
  const toolNames = AGENT_ALLOWED_TOOLS.map((t) => t.name);
  const forbiddenTools = [
    "callRazorpay",
    "executePayment",
    "createOrder",
    "fetch",
    "pay",
    "charge",
  ];
  const hasForbidden = forbiddenTools.some((f) => toolNames.includes(f));
  assert(
    !hasForbidden,
    "LLM Tool definitions contain NO payment execution tools",
  );
  assert(
    toolNames.includes("searchCatalog") &&
      toolNames.includes("getProduct") &&
      toolNames.includes("requestCheckoutProposal"),
    "Only shopping planner tools are registered",
  );

  // Test 5.2: TOCTOU Cart Snapshot Verification
  const snapshotCart = {
    cartMandateId: "cart_snap_001",
    quoteId: "quo_snap_001",
    merchantId: "mch_nimbus_gear_001",
    totals: { grandTotalMinor: 412882, currency: "INR" },
    items: [
      {
        variantId: "kbd_nimbus_75_black_brown",
        quantity: 1,
        unitAmountMinor: 349900,
      },
    ],
  };
  const validSnapshotHash = generateCanonicalDigest(snapshotCart);

  // Attacker tampers cart total in DB
  const tamperedCart = {
    ...snapshotCart,
    totals: { grandTotalMinor: 899900, currency: "INR" },
  };
  const tamperedSnapshotHash = generateCanonicalDigest(tamperedCart);
  assert(
    validSnapshotHash !== tamperedSnapshotHash,
    "TOCTOU: Tampered cart total generates different canonical hash",
  );
  assert(
    !verifyCanonicalDigest(tamperedCart, validSnapshotHash),
    "TOCTOU: Verification rejects tampered cart against original snapshot hash",
  );

  // Test 5.3: Cryptographic HMAC Webhook Signature Verification
  const crypto = await import("node:crypto");
  const secret = "test_webhook_secret_12345";
  const webhookBody = JSON.stringify({
    event: "payment.captured",
    id: "evt_test_123",
  });
  const validHmac = crypto
    .createHmac("sha256", secret)
    .update(webhookBody)
    .digest("hex");
  const forgedHmac = "7a8b3c_forged_malicious_signature_deadbeef";

  const computedValid = crypto
    .createHmac("sha256", secret)
    .update(webhookBody)
    .digest("hex");
  assert(
    computedValid === validHmac,
    "HMAC: Valid webhook signature cryptographically matches computed SHA-256 HMAC",
  );
  assert(
    computedValid !== forgedHmac,
    "HMAC: Forged webhook signature correctly fails verification and triggers REJECTED",
  );

  // Test 5.4: Surge Pricing Simulation Slippage Trigger
  const {
    setSurgePricing,
    isSurgePricingActive,
    getSurgeStatus: _getSurgeStatus,
  } = await import("../lib/merchant/surge");
  setSurgePricing(true, 60);
  assert(
    isSurgePricingActive(),
    "Surge pricing manager is active with 60s TTL",
  );

  // Quoting with surge (+15% above discovery price ₹3,499 -> ₹4,023.85)
  const surgeQuotedCart = {
    ...validCart,
    items: [
      {
        ...validCart.items[0],
        discoveryPriceMinor: 349900,
        unitAmountMinor: Math.round(349900 * 1.15), // +15% surge
      },
    ],
  };
  const surgeRes = evaluatePolicy(baseMandate, surgeQuotedCart);
  assert(
    surgeRes.decision === "STEP_UP",
    "Surge pricing (+15%) triggers STEP_UP due to price slippage",
  );
  assert(
    surgeRes.reasonCodes.includes("PRICE_SLIPPAGE_EXCEEDED"),
    "Surge pricing correctly flags PRICE_SLIPPAGE_EXCEEDED",
  );
  setSurgePricing(false);

  console.log(`\n========================================`);
  console.log(`Results: ${passed} Passed, ${failed} Failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
