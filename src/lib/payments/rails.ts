/**
 * Payment-rail identification — pure, dependency-free so it can be imported from
 * both server routes and client components without pulling the Stripe or
 * Razorpay SDKs into the browser bundle.
 *
 * Both providers are stored in the same `payment_actions` columns
 * (`razorpay_order_id` / `razorpay_payment_id`), because a payment action is
 * the single settlement record regardless of rail. For Stripe those columns hold
 * the PaymentIntent id and the charge id, so the *only* way to tell the rails
 * apart is the prefix / `provider_metadata`. Getting this wrong previously
 * rendered `pi_…` PaymentIntents in a column labelled "Razorpay Order ID".
 */

export type PaymentRail = "razorpay" | "stripe" | "simulated";

/** Synthetic reference prefixes minted by the offline fallbacks. */
const MOCK_REFERENCE_PREFIXES = ["pi_sim_", "ch_sim_", "order_sim_"];

interface PaymentActionLike {
  provider_metadata?: unknown;
  razorpay_order_id?: string | null;
  razorpay_payment_id?: string | null;
}

function metaOf(action: PaymentActionLike): Record<string, unknown> {
  return (action.provider_metadata as Record<string, unknown> | null) || {};
}

/**
 * A reference minted by the offline fallback rather than the provider. A
 * `pi_sim_…` id is shaped exactly like a real PaymentIntent but never existed
 * in Stripe, which is precisely why settlement provenance has to be explicit
 * instead of inferred from the prefix alone.
 */
export function isMockReference(reference: string | null | undefined): boolean {
  if (!reference) return false;
  return MOCK_REFERENCE_PREFIXES.some((prefix) => reference.startsWith(prefix));
}

/**
 * Did this settlement reach the provider, or was it simulated?
 *
 * `provider_metadata.isMock` is the authoritative flag written at settlement
 * time; the synthetic-prefix check is the backstop for rows written before the
 * flag existed (and for records whose metadata was never populated).
 */
export function isSimulatedPayment(action: PaymentActionLike): boolean {
  const meta = metaOf(action);
  if (meta.isMock === true) return true;
  if (meta.isMock === "true") return true;
  return (
    isMockReference(action.razorpay_order_id) ||
    isMockReference(action.razorpay_payment_id)
  );
}

/** The Stripe PaymentIntent this action settled through, if it is a real one. */
export function stripePaymentIntentIdOf(
  action: PaymentActionLike,
): string | null {
  if (paymentRailOf(action) !== "stripe") return null;
  const meta = metaOf(action);
  const recorded =
    typeof meta.paymentIntentId === "string" ? meta.paymentIntentId : null;
  const fromColumn =
    action.razorpay_order_id?.startsWith("pi_") === true
      ? action.razorpay_order_id
      : null;
  const intentId = recorded ?? fromColumn;
  // Simulated ids must never be linked out to the Stripe dashboard: the page
  // would 404, which reads as "the payment vanished" rather than "it was fake".
  if (!intentId || isMockReference(intentId)) return null;
  return intentId;
}

/**
 * Deep link to the settlement in the Stripe dashboard. Test-mode intents live
 * under `/test/`; live-mode under the bare path. The mode is recorded at
 * settlement time (`liveMode`) because a client component cannot read
 * `STRIPE_SECRET_KEY`, and guessing wrong sends the merchant to a 404.
 */
export function stripeDashboardUrl(action: PaymentActionLike): string | null {
  const intentId = stripePaymentIntentIdOf(action);
  if (!intentId) return null;
  const liveMode = metaOf(action).liveMode === true;
  return `https://dashboard.stripe.com/${liveMode ? "" : "test/"}payments/${intentId}`;
}

export function paymentRailOf(action: {
  provider_metadata?: unknown;
  razorpay_order_id?: string | null;
  razorpay_payment_id?: string | null;
}): PaymentRail {
  const meta =
    (action.provider_metadata as Record<string, unknown> | null) || {};

  if (meta.provider === "stripe" || meta.method === "stripe_card") {
    return "stripe";
  }
  if (action.razorpay_order_id?.startsWith("pi_")) {
    return "stripe";
  }
  if (meta.method === "simulated_uap") {
    return "simulated";
  }
  if (action.razorpay_order_id) {
    return "razorpay";
  }
  return "simulated";
}

export function isStripePaymentAction(action: {
  razorpay_order_id: string | null;
  provider_metadata: unknown;
}): boolean {
  return paymentRailOf(action) === "stripe";
}

/** Human label + the provider reference that actually identifies the payment. */
export function paymentRailLabel(action: {
  provider_metadata?: unknown;
  razorpay_order_id?: string | null;
  razorpay_payment_id?: string | null;
}): {
  rail: PaymentRail;
  label: string;
  reference: string | null;
  simulated: boolean;
  dashboardUrl: string | null;
} {
  const rail = paymentRailOf(action);
  const simulated = isSimulatedPayment(action);
  switch (rail) {
    case "stripe":
      return {
        rail,
        label: simulated
          ? "Stripe PaymentIntent (simulated)"
          : "Stripe PaymentIntent",
        reference: action.razorpay_order_id ?? null,
        simulated,
        dashboardUrl: stripeDashboardUrl(action),
      };
    case "simulated":
      return {
        rail,
        label: "Simulated",
        reference: action.razorpay_payment_id ?? null,
        simulated: true,
        dashboardUrl: null,
      };
    default:
      return {
        rail,
        label: simulated ? "Razorpay Order (simulated)" : "Razorpay Order",
        reference: action.razorpay_order_id ?? null,
        simulated,
        dashboardUrl: null,
      };
  }
}
