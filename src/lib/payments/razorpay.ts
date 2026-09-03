import crypto from "crypto";
import Razorpay from "razorpay";

export function getRazorpayClient(): {
  client: Razorpay | null;
  keyId: string | null;
} {
  const keyId =
    process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (
    keyId &&
    keySecret &&
    !keyId.includes("xxxxx") &&
    !keySecret.includes("xxxxx")
  ) {
    return {
      client: new Razorpay({
        key_id: keyId,
        key_secret: keySecret,
      }),
      keyId,
    };
  }

  return { client: null, keyId: keyId || null };
}

export interface CreateOrderParams {
  amountMinor: number;
  currency?: string;
  receipt: string;
  notes?: Record<string, string>;
}

export async function createOrder(params: CreateOrderParams) {
  const { amountMinor, currency = "INR", receipt, notes = {} } = params;
  const { client, keyId } = getRazorpayClient();

  if (client) {
    try {
      console.log(
        `[Razorpay] Creating real order for ${currency} ${(amountMinor / 100).toFixed(2)} (receipt: ${receipt})...`,
      );
      const order: any = await (client.orders as any).create({
        amount: amountMinor,
        currency: currency.toUpperCase(),
        receipt: receipt.slice(0, 40), // Razorpay receipt max length is 40 chars
        notes,
        payment_capture: true,
      });

      console.log(
        `[Razorpay] Real Order Created: ${order.id} (Status: ${order.status})`,
      );

      return {
        id: String(order.id),
        amount: Number(order.amount),
        currency: String(order.currency),
        status: String(order.status),
        keyId: keyId!,
        isMock: false,
      };
    } catch (err: any) {
      console.error(
        "[Razorpay] API call failed with error:",
        err?.error || err,
      );
    }
  } else {
    console.log(
      "[Razorpay] No valid keys found in process.env, falling back to simulated order.",
    );
  }

  // Simulated order for sandbox / local development if keys missing
  const mockId = `order_sim_${crypto.randomBytes(8).toString("hex")}`;
  return {
    id: mockId,
    amount: amountMinor,
    currency: currency.toUpperCase(),
    status: "created",
    keyId: keyId || "rzp_test_simulated_key",
    isMock: true,
  };
}

export function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  // Fail closed: a missing secret can never validate a signature.
  if (!signature || !secret) return false;
  try {
    const expected = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    const expectedBuf = Buffer.from(expected, "utf8");
    const providedBuf = Buffer.from(signature, "utf8");
    if (expectedBuf.length !== providedBuf.length) return false;

    return crypto.timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}

/**
 * Verify a Razorpay payment occurring on the merchant dashboard (human-present
 * checkout) using the documented algorithm:
 *   signature = HmacSHA256(order_id + "|" + payment_id, key_secret)
 *
 * This must ALWAYS be checked server-side before a payment action is marked
 * completed — a client-supplied `razorpay_signature` is never trusted directly.
 */
export function verifyPaymentSignature(params: {
  orderId: string;
  paymentId: string;
  signature: string;
  secret: string;
}): boolean {
  const { orderId, paymentId, signature, secret } = params;
  if (!orderId || !paymentId || !signature || !secret) return false;
  try {
    const expected = crypto
      .createHmac("sha256", secret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    const expectedBuf = Buffer.from(expected, "utf8");
    const providedBuf = Buffer.from(signature, "utf8");
    if (expectedBuf.length !== providedBuf.length) return false;

    return crypto.timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}

/**
 * Issue a REAL Razorpay refund for a captured payment. Returns null when the
 * merchant hasn't configured usable keys (the caller decides whether to fall
 * back to simulation for local demo). Test-mode refunds settle instantly and
 * also emit refund.* webhook events which reconcile the refund action
 * idempotently.
 */
export async function refundPayment(params: {
  paymentId: string;
  amountMinor: number;
  notes?: Record<string, string>;
}): Promise<{ id: string; status: string; isMock: boolean } | null> {
  const { client } = getRazorpayClient();
  if (!client) return null;

  try {
    console.log(
      `[Razorpay] Issuing real refund for payment ${params.paymentId} (amount ${params.amountMinor} minor)...`,
    );
    const refund: any = await (client.payments as any).refund(
      params.paymentId,
      {
        amount: params.amountMinor,
        speed: "normal",
        notes: params.notes || {},
      },
    );

    console.log(
      `[Razorpay] Refund created: ${refund.id} (status: ${refund.status})`,
    );
    return {
      id: String(refund.id),
      status: String(refund.status),
      isMock: false,
    };
  } catch (err: any) {
    console.error("[Razorpay] Refund API call failed:", err?.error || err);
    return null;
  }
}
