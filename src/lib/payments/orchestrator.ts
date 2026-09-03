import { eq } from "drizzle-orm";
import { cartMandates, db, paymentActions, policyDecisions } from "@/db";
import { generateCartMandateSnapshotHash } from "@/lib/crypto/canonical";
import { createOrder } from "@/lib/payments/razorpay";

export class CartSnapshotMismatchError extends Error {
  constructor(
    public readonly cartMandateId: string,
    public readonly expectedHash: string,
    public readonly recomputedHash: string,
  ) {
    super("CART_SNAPSHOT_MISMATCH");
    this.name = "CartSnapshotMismatchError";
  }
}

export async function preparePayment(params: {
  cartMandateId: string;
  decisionId: string;
  budgetReservationId: string;
  traceId: string;
  /** Allow creating a payment intent for a queued (STEP_UP) over-limit
   * proposal that is pending merchant approval. Without this, preparePayment
   * refuses every non-ALLOW decision. */
  allowQueuedApproval?: boolean;
}) {
  const [cart] = await db
    .select()
    .from(cartMandates)
    .where(eq(cartMandates.id, params.cartMandateId))
    .limit(1);

  if (!cart) {
    throw new Error("CART_MANDATE_NOT_FOUND");
  }

  const [decision] = await db
    .select()
    .from(policyDecisions)
    .where(eq(policyDecisions.id, params.decisionId))
    .limit(1);

  if (!decision) {
    throw new Error("POLICY_DECISION_NOT_FOUND");
  }

  if (decision.decision !== "ALLOW" && !params.allowQueuedApproval) {
    throw new Error("PAYMENT_REQUIRES_ALLOW_DECISION");
  }

  const decisionJson =
    (decision.decision_json as Record<string, unknown>) || {};
  const expectedHash = String(
    decisionJson.cart_snapshot_hash || cart.content_hash || "",
  );
  const recomputedHash = generateCartMandateSnapshotHash(cart);

  if (!expectedHash || recomputedHash !== expectedHash) {
    throw new CartSnapshotMismatchError(
      params.cartMandateId,
      expectedHash,
      recomputedHash,
    );
  }

  const existingPayment = await db
    .select()
    .from(paymentActions)
    .where(eq(paymentActions.cart_mandate_id, params.cartMandateId))
    .limit(1);

  // Only an intent that is still open for payment is reusable. An intent that
  // was expired (e.g. Surge Pricing re-priced the cart mid-flight) or cancelled
  // must NOT be reused — a fresh Razorpay order at the new amount is required.
  if (
    existingPayment[0]?.razorpay_order_id &&
    existingPayment[0].status !== "expired" &&
    existingPayment[0].status !== "cancelled"
  ) {
    return {
      paymentAction: existingPayment[0],
      razorpayOrderId: existingPayment[0].razorpay_order_id,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID || "rzp_test_simulated_key",
      reused: true,
    };
  }

  const order = await createOrder({
    amountMinor: cart.total_minor,
    currency: cart.currency,
    receipt: params.cartMandateId,
    notes: {
      cartMandateId: params.cartMandateId,
      intentMandateId: cart.intent_mandate_id,
      traceId: params.traceId,
    },
  });

  return {
    order,
    cart,
    razorpayOrderId: order.id,
    razorpayKeyId: order.keyId,
    reused: false,
    // Row to refresh when a stale (expired/cancelled) intent already exists
    // for this cart: unique constraints forbid inserting a second one.
    existingPaymentAction: existingPayment[0] || null,
  };
}
