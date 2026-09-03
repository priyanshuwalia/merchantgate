import { and, eq, gt, inArray } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import {
  budgetReservations,
  cartMandates,
  db,
  paymentActions,
  policyDecisions,
} from "@/db";
import { logAuditEvent } from "@/lib/audit/logger";
import { requireMerchantAuth } from "@/lib/auth/guard";
import { rateLimitRequest } from "@/lib/auth/rate-limit";
import { generateCartMandateSnapshotHash } from "@/lib/crypto/canonical";
import {
  getSurgeStatus,
  SURGE_PERCENT,
  SURGE_PRICING_REASON,
  setSurgePricing,
} from "@/lib/merchant/surge";
import { generateTraceId } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = requireMerchantAuth(request);
  if (auth instanceof NextResponse) return auth;
  const status = getSurgeStatus();
  return NextResponse.json(status);
}

/**
 * Enabling Surge Pricing does not only price NEW checkouts at +15%: it also
 * re-prices every transaction that is currently in flight. Any quote still
 * awaiting completion (`proposed`, or already `flagged` for slippage) is
 * re-priced +15% in place and escalated to STEP_UP with an explicit
 * SURGE_PRICING_ACTIVE reason. Pre-surge payment intents are expired and their
 * budget reservations released so they can never settle at the old price.
 * The merchant then confirms each surged transaction from the console.
 */
export async function POST(request: NextRequest) {
  const auth = requireMerchantAuth(request);
  if (auth instanceof NextResponse) return auth;

  // Toggling surge re-prices every in-flight quote (a loop over the DB). Cap
  // per-client so this cannot be spammed into a write storm.
  const limited = rateLimitRequest(request, {
    namespace: "merchant-surge",
    limit: Number(process.env.RATE_LIMIT_SURGE) || 20,
  });
  if (limited) return limited;

  try {
    const body = await request.json().catch(() => ({}));
    const active = body.active !== undefined ? Boolean(body.active) : true;
    const durationSeconds = Number(body.durationSeconds) || 60;

    setSurgePricing(active, durationSeconds);

    const traceId = generateTraceId();
    let affectedCarts = 0;

    if (active) {
      // Every non-terminal quote issued before the toggle is "mid-flight".
      const inFlightCarts = await db
        .select()
        .from(cartMandates)
        .where(
          and(
            inArray(cartMandates.status, ["proposed", "flagged"]),
            gt(cartMandates.quote_expires_at, new Date()),
          ),
        );

      for (const cart of inFlightCarts) {
        const [decision] = await db
          .select()
          .from(policyDecisions)
          .where(eq(policyDecisions.cart_mandate_id, cart.id))
          .limit(1);

        // A hard-DENY (buyer's mandate ceiling) cannot be re-approved by the
        // merchant, so leave it untouched.
        if (decision && decision.decision === "DENY") continue;

        // Re-price the frozen quote +15% in place. Scaling the surviving line
        // fields keeps every total internally consistent and the trace tells
        // the buyer exactly what the pre-surge price was.
        const surgeMultiplier = 1 + SURGE_PERCENT / 100; // 1.15
        const rows = (cart.items as Array<Record<string, unknown>>) || [];
        const surgedItems = rows.map((item) => {
          const unit = Math.round(
            (Number(item.unitAmountMinor) || 0) * surgeMultiplier,
          );
          const line = Math.round(
            (Number(item.lineAmountMinor) || 0) * surgeMultiplier,
          );
          const lineDiscount = Math.round(
            (Number(item.lineDiscountMinor) || 0) * surgeMultiplier,
          );
          return {
            ...item,
            unitAmountMinor: unit,
            lineDiscountMinor: lineDiscount,
            lineAmountMinor: line,
            surgeApplied: {
              percent: SURGE_PERCENT,
              preSurgeUnitAmountMinor: Number(item.unitAmountMinor) || 0,
              reason: SURGE_PRICING_REASON,
              appliedAt: new Date().toISOString(),
            },
          };
        });
        // Re-price the authoritative quote total +15%. The frozen line items
        // carry no per-line tax rate, so scaling the line amounts alone would
        // silently drop the tax component (e.g. base 1899.00 + 18% tax =
        // 2240.82 becomes 2183.85 — less than the pre-surge total!). Surge
        // applies to the whole quote, so scale the grand total the same way
        // the quote itself was built: subtotal and tax rise together.
        const surgedTotalMinor = Math.round(
          (Number(cart.total_minor) || 0) * surgeMultiplier,
        );

        // Recompute the authoritative cart snapshot hash over the re-priced
        // payload so the approval/settlement TOCTOU guards still pass.
        const surgedSnapshotHash = generateCartMandateSnapshotHash({
          id: cart.id,
          intent_mandate_id: cart.intent_mandate_id,
          merchant_id: cart.merchant_id,
          quote_expires_at: cart.quote_expires_at,
          total_minor: surgedTotalMinor,
          currency: cart.currency,
          items: surgedItems,
          fulfillment: cart.fulfillment,
          terms: cart.terms,
        });

        const reasonCodes = decision
          ? Array.from(
              new Set([
                ...((decision.reason_codes as string[] | null) || []),
                SURGE_PRICING_REASON,
              ]),
            )
          : [SURGE_PRICING_REASON];

        if (decision) {
          const decisionJson =
            (decision.decision_json as Record<string, unknown>) || {};
          await db
            .update(policyDecisions)
            .set({
              decision: "STEP_UP",
              reason_codes: reasonCodes,
              decision_json: {
                ...decisionJson,
                decision: "STEP_UP",
                cart_snapshot_hash: surgedSnapshotHash,
                surge_repriced_at: new Date().toISOString(),
                surge_reason: SURGE_PRICING_REASON,
                surge_multiplier: surgeMultiplier,
              },
            })
            .where(eq(policyDecisions.id, decision.id));
        }

        await db
          .update(cartMandates)
          .set({
            status: "flagged",
            total_minor: surgedTotalMinor,
            items: surgedItems,
            content_hash: surgedSnapshotHash,
          })
          .where(eq(cartMandates.id, cart.id));

        // Expire any pre-surge payment intent still awaiting payment and
        // release its budget reservation so the stale, pre-surge Razorpay
        // order can never settle. The merchant's approval creates a fresh
        // order at the surged total.
        const [openPayment] = await db
          .select()
          .from(paymentActions)
          .where(
            and(
              eq(paymentActions.cart_mandate_id, cart.id),
              eq(paymentActions.status, "pending_payment"),
            ),
          )
          .limit(1);
        if (openPayment) {
          const meta =
            (openPayment.provider_metadata as Record<string, unknown> | null) ||
            {};
          await db
            .update(paymentActions)
            .set({
              status: "expired",
              provider_metadata: {
                ...meta,
                expiredBySurge: true,
                surgeActiveFrom: new Date().toISOString(),
              },
              updated_at: new Date(),
            })
            .where(eq(paymentActions.id, openPayment.id));

          if (openPayment.budget_reservation_id) {
            await db
              .update(budgetReservations)
              .set({ status: "released" })
              .where(
                eq(budgetReservations.id, openPayment.budget_reservation_id),
              );
          }
        }

        await logAuditEvent({
          traceId,
          actorType: "system",
          actorId: "surge_pricing_guard",
          eventType: "surge_repriced_proposal",
          cartMandateId: cart.id,
          decisionId: decision?.id,
          paymentActionId: openPayment?.id,
          reasonCodes: [SURGE_PRICING_REASON],
          explanation: `Surge pricing enabled (+${SURGE_PERCENT}%): in-flight quote ${cart.id} re-priced from ${cart.currency} ${(cart.total_minor / 100).toFixed(2)} to ${cart.currency} ${(surgedTotalMinor / 100).toFixed(2)} and escalated to STEP_UP (${SURGE_PRICING_REASON}). Requires merchant approval before the surged price can be paid.${openPayment ? ` Pre-surge payment intent ${openPayment.id} expired.` : ""}`,
          metadata: {
            surgePercent: SURGE_PERCENT,
            surgeReason: SURGE_PRICING_REASON,
            cartStatusBefore: cart.status,
            preSurgeTotalMinor: cart.total_minor,
            surgedTotalMinor,
            expiredPaymentIntentId: openPayment?.id || null,
            releasedBudgetReservationId:
              openPayment?.budget_reservation_id || null,
          },
        });

        affectedCarts += 1;
      }

      await logAuditEvent({
        traceId,
        actorType: "merchant",
        actorId: "merchant_admin",
        eventType: "surge_pricing_enabled",
        explanation: `Merchant enabled +15% Surge Pricing simulation for ${durationSeconds} seconds. ${affectedCarts} in-flight transaction(s) re-priced and escalated to STEP_UP (${SURGE_PRICING_REASON}).`,
        metadata: {
          durationSeconds,
          active,
          affectedCarts,
          surgePercent: SURGE_PERCENT,
        },
      });
    } else {
      await logAuditEvent({
        traceId,
        actorType: "merchant",
        actorId: "merchant_admin",
        eventType: "surge_pricing_disabled",
        explanation: `Merchant disabled Surge Pricing simulation. ${affectedCarts} transaction(s) remain in the STEP_UP approval queue.`,
        metadata: { active, durationSeconds },
      });
    }

    const status = getSurgeStatus();
    return NextResponse.json({
      success: true,
      ...status,
      affectedCarts,
    });
  } catch (error) {
    console.error("Error toggling surge:", error);
    return NextResponse.json(
      { error: "Failed to toggle surge" },
      { status: 500 },
    );
  }
}
