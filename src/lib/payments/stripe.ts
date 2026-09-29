import crypto from "node:crypto";
import Stripe from "stripe";

/**
 * Stripe payment provider.
 *
 * The provider is used for AUTONOMOUS agent settlement: the merchant's quote is
 * frozen in `cart_mandates`, and at `/v1/agent/checkout/confirm` the server
 * creates AND confirms a PaymentIntent in one call (`confirm: true`) with a
 * payment-method token presented by the buyer agent. In test mode the standard
 * card tokens (`pm_card_visa`, `tok_visa`) confirm without 3DS, so the whole
 * purchase settles server-to-server with no human in the loop.
 *
 * Like the Razorpay module, when the merchant has no usable keys the module
 * degrades to a clearly-marked simulation so the full flow stays demonstrable
 * offline. A simulated intent is only ever "succeeded" — never silently real.
 */

// Stripe amounts are in the currency's smallest unit. `*_minor` columns are in
// paise (2 decimals) which map 1:1 onto Stripe's INR smallest unit.
function minorToStripeAmount(minor: number): number {
  return Math.round(minor);
}

export function getStripeClient(): Stripe | null {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (
    secretKey &&
    secretKey.startsWith("sk_") &&
    !secretKey.includes("xxxxx")
  ) {
    return new Stripe(secretKey);
  }
  return null;
}

export type StripePaymentResult = {
  id: string;
  status: string; // succeeded | requires_action | requires_payment_method | processing | ...
  clientSecret?: string;
  chargeId?: string;
  amountMinor: number;
  currency: string;
  isMock: boolean;
};

export interface ConfirmStripeIntentParams {
  amountMinor: number;
  currency: string;
  paymentMethodId: string;
  description?: string;
  refundIdHint?: string;
  metadata?: Record<string, string>;
}

/**
 * Create AND detach-less confirm a PaymentIntent server-side. `confirm: true`
 * means Stripe immediately attempts the charge against the presented payment
 * method. With a non-3DS test card this returns synchronously with
 * `status: "succeeded"` — the autonomous settlement path needs no webhook and
 * no browser. `requires_action` (3DS mandates) and `processing` returns come
 * back to the caller to be settled later via the webhook.
 */
export async function confirmStripePaymentIntent(
  params: ConfirmStripeIntentParams,
): Promise<StripePaymentResult> {
  const { amountMinor, currency, paymentMethodId, description, metadata } =
    params;
  const client = getStripeClient();

  if (client) {
    try {
      const intent = await client.paymentIntents.create({
        amount: minorToStripeAmount(amountMinor),
        currency: currency.toLowerCase(),
        payment_method: paymentMethodId,
        confirm: true,
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        description,
        metadata,
      });

      return {
        id: intent.id,
        status: intent.status,
        clientSecret:
          intent.status === "requires_action"
            ? intent.client_secret || undefined
            : undefined,
        chargeId: intent.latest_charge
          ? String(intent.latest_charge)
          : undefined,
        amountMinor,
        currency: currency.toUpperCase(),
        isMock: false,
      };
    } catch (error) {
      console.error(
        "[Stripe] PaymentIntent confirm failed:",
        error instanceof Stripe.errors.StripeError ? error.message : error,
      );
      throw error;
    }
  }

  // No keys configured → simulated autonomous payment (offline demo).
  const mockId = `pi_sim_${crypto.randomBytes(8).toString("hex")}`;
  return {
    id: mockId,
    status: "succeeded",
    chargeId: `ch_sim_${crypto.randomBytes(8).toString("hex")}`,
    amountMinor,
    currency: currency.toUpperCase(),
    isMock: true,
  };
}

export interface StripeRefundParams {
  paymentIntentId: string;
  amountMinor: number;
  reason?: string;
  metadata?: Record<string, string>;
}

/**
 * Issue a real Stripe refund against a captured PaymentIntent. Returns null
 * when the merchant has no usable keys (the caller decides the fallback), or
 * when the Stripe call fails. Test-mode refunds settle synchronously.
 */
export async function refundStripePayment(
  params: StripeRefundParams,
): Promise<{ id: string; status: string; isMock: boolean } | null> {
  const { paymentIntentId, amountMinor, reason, metadata } = params;
  const client = getStripeClient();
  if (!client) return null;
  if (!paymentIntentId.startsWith("pi_") || paymentIntentId.includes("sim")) {
    return null;
  }

  try {
    const refund = await client.refunds.create({
      payment_intent: paymentIntentId,
      amount: minorToStripeAmount(amountMinor),
      reason:
        reason === "requested_by_customer"
          ? "requested_by_customer"
          : "duplicate",
      metadata,
    });

    return {
      id: refund.id,
      status: refund.status || "succeeded",
      isMock: false,
    };
  } catch (error) {
    console.error(
      "[Stripe] Refund failed:",
      error instanceof Stripe.errors.StripeError ? error.message : error,
    );
    return null;
  }
}

/**
 * Verify a Stripe webhook payload with the provider's signing secret
 * (`whsec_…` from `stripe listen` or the dashboard). Fail closed: a missing
 * secret or bad signature rejects. Returns the parsed Event (which also
 * validates the payload shape) or throws.
 */
export function verifyStripeWebhook(
  rawBody: string,
  signature: string,
  secret: string,
): Stripe.Event {
  if (!signature || !secret) {
    throw new Error("STRIPE_WEBHOOK_SIGNATURE_MISSING");
  }
  const client = getStripeClient();
  const key = process.env.STRIPE_SECRET_KEY;
  return (
    client || new Stripe(key || "sk_test_replace_me")
  ).webhooks.constructEvent(rawBody, signature, secret);
}

export function isStripePaymentAction(action: {
  razorpay_order_id: string | null;
  provider_metadata: unknown;
}): boolean {
  const meta =
    (action.provider_metadata as Record<string, unknown> | null) || {};
  return (
    meta.provider === "stripe" ||
    Boolean(action.razorpay_order_id?.startsWith("pi_"))
  );
}
