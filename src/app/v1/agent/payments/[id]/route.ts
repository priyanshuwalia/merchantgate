import { eq, or } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db, paymentActions, refundActions } from "@/db";
import { authenticateAgentRequest } from "@/lib/auth/agent-auth";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateAgentRequest(request);

  try {
    const { id } = await params;

    const [action] = await db
      .select()
      .from(paymentActions)
      .where(
        or(
          eq(paymentActions.id, id),
          eq(paymentActions.razorpay_order_id, id),
          eq(paymentActions.cart_mandate_id, id),
        ),
      )
      .limit(1);

    if (!action) {
      return NextResponse.json(
        { error: "Payment action not found", id },
        { status: 404 },
      );
    }

    const [refund] = await db
      .select()
      .from(refundActions)
      .where(eq(refundActions.payment_action_id, action.id))
      .limit(1);

    return NextResponse.json({
      paymentActionId: action.id,
      status: action.status,
      amountMinor: action.amount_minor,
      currency: action.currency,
      razorpayOrderId: action.razorpay_order_id,
      razorpayPaymentId: action.razorpay_payment_id,
      completedAt:
        action.status === "completed"
          ? action.updated_at.toISOString()
          : undefined,
      refundStatus: refund ? refund.status : undefined,
      refundAmountMinor: refund ? refund.amount_minor : undefined,
      traceId: `trace_${action.id}`,
      agentAuth: {
        mode: auth.mode,
        agentId: auth.agentId,
        rateLimitRemaining: auth.rateLimitInfo.remaining,
      },
    });
  } catch (error) {
    console.error("Error fetching payment status:", error);
    return NextResponse.json(
      {
        error: "Internal server error fetching payment status",
      },
      { status: 500 },
    );
  }
}
