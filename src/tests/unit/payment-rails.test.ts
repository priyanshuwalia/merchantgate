import "./_setup";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  isStripePaymentAction,
  paymentRailLabel,
  paymentRailOf,
} from "@/lib/payments/rails";

describe("payment rail identification", () => {
  test("explicit provider metadata wins over any id prefix", () => {
    assert.equal(
      paymentRailOf({
        provider_metadata: { provider: "stripe", method: "stripe_card" },
        razorpay_order_id: "pi_123",
      }),
      "stripe",
    );
  });

  test("a Stripe PaymentIntent stored in razorpay_order_id reads as stripe", () => {
    // The settlement record is shared across rails, so a Stripe intent lands in
    // the `razorpay_order_id` column. Misreading it rendered `pi_…` under a
    // column labelled "Razorpay Order ID".
    assert.equal(
      paymentRailOf({
        provider_metadata: {},
        razorpay_order_id: "pi_3Mock_123",
      }),
      "stripe",
    );
    assert.equal(
      isStripePaymentAction({
        razorpay_order_id: "pi_3Mock_123",
        provider_metadata: {},
      }),
      true,
    );
  });

  test("a Razorpay order id reads as razorpay", () => {
    assert.equal(
      paymentRailOf({
        provider_metadata: { method: "razorpay_checkout" },
        razorpay_order_id: "order_QXb1z2",
      }),
      "razorpay",
    );
    assert.equal(
      isStripePaymentAction({
        razorpay_order_id: "order_QXb1z2",
        provider_metadata: { method: "razorpay_checkout" },
      }),
      false,
    );
  });

  test("simulated settlements are distinguished from real rails", () => {
    assert.equal(
      paymentRailOf({
        provider_metadata: { method: "simulated_uap" },
        razorpay_order_id: "order_sim_abc",
      }),
      "simulated",
    );
  });

  test("an unbound action with no provider reference is simulated, not razorpay", () => {
    assert.equal(
      paymentRailOf({ provider_metadata: null, razorpay_order_id: null }),
      "simulated",
    );
  });

  test("labels pair each rail with the reference that identifies it", () => {
    assert.deepEqual(
      paymentRailLabel({
        provider_metadata: { method: "stripe_card" },
        razorpay_order_id: "pi_123",
        razorpay_payment_id: "ch_123",
      }),
      { rail: "stripe", label: "Stripe PaymentIntent", reference: "pi_123" },
    );

    assert.deepEqual(
      paymentRailLabel({
        provider_metadata: { method: "razorpay_checkout" },
        razorpay_order_id: "order_QXb1z2",
      }),
      { rail: "razorpay", label: "Razorpay Order", reference: "order_QXb1z2" },
    );
  });

  test("an action with no reference reports null rather than a placeholder id", () => {
    assert.equal(
      paymentRailLabel({ provider_metadata: null, razorpay_order_id: null })
        .reference,
      null,
    );
  });
});
