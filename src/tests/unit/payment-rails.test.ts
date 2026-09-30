import "./_setup";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  isMockReference,
  isSimulatedPayment,
  isStripePaymentAction,
  paymentRailLabel,
  paymentRailOf,
  stripeDashboardUrl,
  stripePaymentIntentIdOf,
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
      {
        rail: "stripe",
        label: "Stripe PaymentIntent",
        reference: "pi_123",
        simulated: false,
        dashboardUrl: "https://dashboard.stripe.com/test/payments/pi_123",
      },
    );

    assert.deepEqual(
      paymentRailLabel({
        provider_metadata: { method: "razorpay_checkout" },
        razorpay_order_id: "order_QXb1z2",
      }),
      {
        rail: "razorpay",
        label: "Razorpay Order",
        reference: "order_QXb1z2",
        simulated: false,
        dashboardUrl: null,
      },
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

describe("settlement provenance (real vs simulated)", () => {
  test("isMock: true marks a settlement as simulated even with a pi_ id", () => {
    // The offline fallback mints ids shaped exactly like real ones, so the
    // prefix is not evidence. The explicit flag is.
    const action = {
      provider_metadata: {
        provider: "stripe",
        method: "stripe_card",
        isMock: true,
      },
      razorpay_order_id: "pi_sim_149ae932518ed1ce",
      razorpay_payment_id: "ch_sim_88ab",
    };
    assert.equal(isSimulatedPayment(action), true);
    assert.equal(
      paymentRailLabel(action).label,
      "Stripe PaymentIntent (simulated)",
    );
    // A simulated intent must never be linked out — the dashboard page 404s.
    assert.equal(stripeDashboardUrl(action), null);
  });

  test("a synthetic prefix is the backstop when isMock was never written", () => {
    assert.equal(isMockReference("pi_sim_abc"), true);
    assert.equal(isMockReference("ch_sim_abc"), true);
    assert.equal(isMockReference("order_sim_abc"), true);
    assert.equal(isMockReference("pi_3UL16OFHKLEAj0tS0QLDesR7"), false);
    assert.equal(isMockReference("order_QXb1z2"), false);
    assert.equal(isMockReference(null), false);

    assert.equal(
      isSimulatedPayment({
        razorpay_order_id: "pi_sim_abc",
        provider_metadata: {},
      }),
      true,
    );
    assert.equal(
      isSimulatedPayment({
        razorpay_order_id: "ch_sim_abc",
        provider_metadata: {},
      }),
      true,
    );
    assert.equal(
      isSimulatedPayment({
        razorpay_order_id: "order_sim_abc",
        provider_metadata: {},
      }),
      true,
    );
  });

  test("a real test-mode PaymentIntent is not simulated", () => {
    const action = {
      provider_metadata: {
        provider: "stripe",
        method: "stripe_card",
        isMock: false,
        liveMode: false,
        paymentIntentId: "pi_3UL16OFHKLEAj0tS0QLDesR7",
      },
      razorpay_order_id: "pi_3UL16OFHKLEAj0tS0QLDesR7",
    };
    assert.equal(isSimulatedPayment(action), false);
    assert.equal(
      stripeDashboardUrl(action),
      "https://dashboard.stripe.com/test/payments/pi_3UL16OFHKLEAj0tS0QLDesR7",
    );
  });

  test("liveMode selects the live dashboard path", () => {
    const action = {
      provider_metadata: {
        provider: "stripe",
        isMock: false,
        liveMode: true,
        paymentIntentId: "pi_3RealLive0001",
      },
      razorpay_order_id: "pi_3RealLive0001",
    };
    assert.equal(
      stripeDashboardUrl(action),
      "https://dashboard.stripe.com/payments/pi_3RealLive0001",
    );
  });

  test("defaults to the test path when liveMode is absent", () => {
    // Older rows predate the flag; test mode is the safe default because a
    // wrong test-mode link shows "not found" while a wrong live-mode link is
    // indistinguishable from a vanished payment.
    assert.equal(
      stripeDashboardUrl({
        provider_metadata: { provider: "stripe" },
        razorpay_order_id: "pi_3Legacy01",
      }),
      "https://dashboard.stripe.com/test/payments/pi_3Legacy01",
    );
  });

  test("the intent id is read from metadata first, then the shared column", () => {
    assert.equal(
      stripePaymentIntentIdOf({
        provider_metadata: {
          provider: "stripe",
          paymentIntentId: "pi_fromMeta",
        },
        razorpay_order_id: "pi_fromColumn",
      }),
      "pi_fromMeta",
    );
    assert.equal(
      stripePaymentIntentIdOf({
        provider_metadata: { provider: "stripe" },
        razorpay_order_id: "pi_fromColumn",
      }),
      "pi_fromColumn",
    );
    // A razorpay rail never yields a Stripe link.
    assert.equal(
      stripePaymentIntentIdOf({
        provider_metadata: { method: "razorpay_checkout" },
        razorpay_order_id: "order_QXb1z2",
      }),
      null,
    );
  });

  test("isMock persisted as the string 'true' is still treated as simulated", () => {
    assert.equal(
      isSimulatedPayment({
        provider_metadata: { provider: "stripe", isMock: "true" },
        razorpay_order_id: "pi_3StrFlag01",
      }),
      true,
    );
  });
});
