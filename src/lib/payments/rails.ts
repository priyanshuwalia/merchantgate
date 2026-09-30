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
}): { rail: PaymentRail; label: string; reference: string | null } {
  const rail = paymentRailOf(action);
  switch (rail) {
    case "stripe":
      return {
        rail,
        label: "Stripe PaymentIntent",
        reference: action.razorpay_order_id ?? null,
      };
    case "simulated":
      return {
        rail,
        label: "Simulated",
        reference: action.razorpay_payment_id ?? null,
      };
    default:
      return {
        rail,
        label: "Razorpay Order",
        reference: action.razorpay_order_id ?? null,
      };
  }
}
