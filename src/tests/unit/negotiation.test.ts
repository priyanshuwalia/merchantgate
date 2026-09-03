import "./_setup";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getMerchantAgentRules } from "@/lib/merchant/agent";
import {
  getNegotiationSession,
  openNegotiation,
  respondToCounter,
} from "@/lib/merchant/negotiation";

const rules = getMerchantAgentRules();

/** Narrow the `respondToCounter` union to a successful response. */
function expectOk<T extends object>(result: T | { error: string }): T {
  assert.ok(
    !("error" in result),
    `expected success, got: ${("error" in result ? result.error : "")}`,
  );
  return result as T;
}

const bulkKeyboard = {
  variantId: "kbd_nimbus_75_black_brown",
  title: "Nimbus 75 Keyboard",
  category: "electronics",
  quantity: 5,
  unitAmountMinor: 349900,
};

describe("negotiation engine", () => {
  test("rejects below the bulk threshold with an actionable reason code", () => {
    const { session, evaluation } = openNegotiation(
      [{ ...bulkKeyboard, quantity: 1 }],
      "agt_apollo_buyer_v1",
      undefined,
      rules,
    );
    assert.equal(evaluation.outcome, "REJECTED");
    assert.ok(evaluation.reasonCodes.includes("QUANTITY_BELOW_BULK_THRESHOLD"));
    assert.equal(session.status, "rejected");
  });

  test("opens with a counter-offer at the bulk discount for eligible carts", () => {
    const { session, evaluation } = openNegotiation(
      [bulkKeyboard],
      "agt_apollo_buyer_v1",
      undefined,
      rules,
    );
    assert.equal(evaluation.outcome, "COUNTER_OFFER");
    assert.equal(session.status, "active");
    assert.equal(session.currentDiscountBps, rules.bulkDiscountBps);
    assert.ok(session.currentDiscountBps <= rules.maxDiscountBps);
    assert.equal(session.round, 1);
  });

  test("accepting the standing offer locks AGREED terms", () => {
    const { session } = openNegotiation(
      [bulkKeyboard],
      "agt_apollo_buyer_v1",
      undefined,
      rules,
    );
    const agreed = expectOk(
      respondToCounter(session.id, 0, true, "Accepting.", rules),
    );
    assert.equal(agreed.evaluation.outcome, "AGREED");
    assert.equal(agreed.session.status, "agreed");
    assert.equal(agreed.session.currentDiscountBps, rules.bulkDiscountBps);
  });

  test("concedes toward the ceiling but never breaches maxDiscountBps", () => {
    const { session } = openNegotiation(
      [bulkKeyboard],
      "agt_apollo_buyer_v1",
      undefined,
      rules,
    );
    const initialOffer = session.currentDiscountBps;
    const s2 = expectOk(
      respondToCounter(
        session.id,
        rules.maxDiscountBps,
        false,
        "I need max.",
        rules,
      ),
    );
    assert.equal(s2.evaluation.outcome, "COUNTER_OFFER");
    assert.ok(
      s2.session.currentDiscountBps > initialOffer,
      "must concede upward",
    );
    assert.ok(s2.session.currentDiscountBps <= rules.maxDiscountBps);

    const s2Offer = s2.session.currentDiscountBps;
    const s3 = expectOk(
      respondToCounter(
        s2.session.id,
        rules.maxDiscountBps,
        false,
        "Still need max.",
        rules,
      ),
    );
    assert.ok(
      s3.evaluation.outcome === "AGREED" ||
        s3.evaluation.outcome === "COUNTER_OFFER",
    );
    assert.ok(s3.session.currentDiscountBps <= rules.maxDiscountBps);
    assert.ok(s3.session.currentDiscountBps >= s2Offer);
  });

  test("rejects a counter above the merchant ceiling", () => {
    const { session } = openNegotiation(
      [bulkKeyboard],
      "agt_apollo_buyer_v1",
      undefined,
      rules,
    );
    const result = respondToCounter(
      session.id,
      rules.maxDiscountBps + 5000,
      false,
      "Unreasonable demand.",
      rules,
    );
    assert.ok("evaluation" in result);
    if ("evaluation" in result) {
      assert.equal(result.evaluation.outcome, "REJECTED");
      assert.ok(result.evaluation.reasonCodes.includes("MAX_DISCOUNT_CEILING"));
    }
  });

  test("flags merchant approval when the agreed discount crosses the threshold", () => {
    const custom = getMerchantAgentRules({
      merchantAgentRules: {
        requireApprovalAboveDiscountBps: 100,
        maxDiscountBps: 1200,
      },
    });
    const { session } = openNegotiation(
      [bulkKeyboard],
      "agt_apollo",
      undefined,
      custom,
    );
    const s2 = expectOk(respondToCounter(session.id, 0, true, "Deal.", custom));
    assert.equal(s2.evaluation.outcome, "AGREED");
    assert.equal(s2.session.requiresMerchantApproval, true);
  });

  test("unknown/expired sessions are rejected", () => {
    const result = respondToCounter(
      "neg_nonexistent",
      0,
      true,
      undefined,
      rules,
    );
    assert.ok("error" in result);
    if ("error" in result) {
      assert.equal(result.error, "NEGOTIATION_SESSION_NOT_FOUND_OR_EXPIRED");
    }
  });

  test("getNegotiationSession returns live sessions only", () => {
    const { session } = openNegotiation(
      [bulkKeyboard],
      "agt_apollo_buyer_v1",
      undefined,
      rules,
    );
    const found = getNegotiationSession(session.id);
    assert.ok(found);
    assert.equal(found.id, session.id);
    assert.equal(getNegotiationSession("neg_missing"), null);
  });
});
