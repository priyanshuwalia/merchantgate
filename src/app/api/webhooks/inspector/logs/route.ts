import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db, paymentActions } from "@/db";
import { requireMerchantAuth } from "@/lib/auth/guard";
import { webhookInspectorStore } from "@/lib/webhooks/inspector-store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = requireMerchantAuth(request);
  if (auth instanceof NextResponse) return auth;
  const logs = webhookInspectorStore.getLogs(50);
  return NextResponse.json({ logs });
}

/**
 * POST /api/webhooks/inspector/logs
 *
 * Lets an authenticated merchant self-test the webhook handler by replaying a
 * payment-captured event against an order that ALREADY exists in the database.
 *
 * Security: this endpoint must not become a vector to fabricate a valid
 * payment capture for an arbitrary (possibly non-existent) order. Therefore it
 * (a) requires the merchant session + CSRF header, (b) refuses a client-supplied
 * orderId unless it matches a real payment action row, and (c) signs the exact
 * order/amount actually stored for that order — never values chosen by the
 * caller. Only a "malformed"/"duplicate" simulation can use a fake signature.
 */
export async function POST(request: NextRequest) {
  const auth = requireMerchantAuth(request, { requireCsrf: true });
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json().catch(() => ({}));
    const mode = body.mode || "valid"; // 'valid' | 'malformed' | 'duplicate'
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const requestedOrderId = body.orderId ? String(body.orderId) : "";

    // Resolve a real payment action to replay against.
    const [action] = requestedOrderId
      ? await db
          .select()
          .from(paymentActions)
          .where(eq(paymentActions.razorpay_order_id, requestedOrderId))
          .limit(1)
      : await db
          .select()
          .from(paymentActions)
          .where(eq(paymentActions.status, "completed"))
          .limit(1);

    if (!webhookSecret) {
      return NextResponse.json(
        { success: false, error: "Webhook secret not configured." },
        { status: 503 },
      );
    }

    if (!action?.razorpay_order_id) {
      return NextResponse.json(
        {
          success: false,
          error:
            mode === "valid" || mode === "duplicate"
              ? "No existing Razorpay order found to replay. Create/pay an order first."
              : "No order available for a malformed-signature test.",
        },
        { status: 404 },
      );
    }

    const orderId = action.razorpay_order_id;
    const amount = action.amount_minor;
    const eventId = body.eventId || `evt_demo_${Date.now()}`;

    const payload = {
      id: eventId,
      entity: "event",
      event: body.event || "payment.captured",
      contains: ["payment"],
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: `pay_${Date.now()}`,
            entity: "payment",
            amount,
            currency: action.currency || "INR",
            status: "captured",
            order_id: orderId,
            method: "upi",
            description: "Autonomous agent checkout settlement",
          },
        },
      },
    };

    const rawBody = JSON.stringify(payload);
    let signature = "";

    if (mode === "valid" || mode === "duplicate") {
      signature = crypto
        .createHmac("sha256", webhookSecret)
        .update(rawBody)
        .digest("hex");
    } else {
      // Malformed / fake signature attack simulation
      signature = "7a8b3c_forged_signature_attempt_invalid_hmac_deadbeef";
    }

    const url = new URL(request.url);
    const webhookUrl = `${url.protocol}//${url.host}/api/webhooks/razorpay`;

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-razorpay-signature": signature,
        "x-razorpay-event-id": eventId,
      },
      body: rawBody,
    });

    const data = await res.json().catch(() => ({}));

    return NextResponse.json({
      success: true,
      mode,
      orderId,
      sentEventId: eventId,
      status: res.status,
      response: data,
    });
  } catch (error) {
    console.error("Error triggering test webhook:", error);
    return NextResponse.json(
      { error: "Failed to trigger test webhook" },
      { status: 500 },
    );
  }
}
