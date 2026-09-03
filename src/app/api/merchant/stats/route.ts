import { desc, eq, notInArray, sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import {
  auditEvents,
  cartMandates,
  db,
  merchants,
  paymentActions,
  policyDecisions,
  products,
} from "@/db";
import { requireMerchantAuth } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

/** Event types that are pure funnel telemetry, not business audit records. */
const TELEMETRY_EVENT_TYPES = ["catalog_view", "product_view"];

interface CartItemShape {
  variantId?: string;
  title?: string;
  quantity?: number;
  lineAmountMinor?: number;
}

export async function GET(request: NextRequest) {
  const auth = requireMerchantAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    // 1. Fetch Merchant
    const [merchant] = await db
      .select()
      .from(merchants)
      .where(eq(merchants.id, "mch_nimbus_gear_001"))
      .limit(1);

    // 2. Fetch all cart mandates
    const allCarts = await db
      .select()
      .from(cartMandates)
      .orderBy(desc(cartMandates.created_at))
      .limit(100);

    // 3. Fetch payment actions
    const allPayments = await db
      .select()
      .from(paymentActions)
      .orderBy(desc(paymentActions.created_at));

    // 4. Fetch policy decisions
    const allDecisions = await db
      .select()
      .from(policyDecisions)
      .orderBy(desc(policyDecisions.created_at))
      .limit(100);

    // 5. Fetch recent audit logs (excluding pure telemetry noise)
    const recentAudit = await db
      .select()
      .from(auditEvents)
      .where(notInArray(auditEvents.event_type, TELEMETRY_EVENT_TYPES))
      .orderBy(desc(auditEvents.id))
      .limit(30);

    // Funnel counters (telemetry events)
    const viewRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditEvents)
      .where(
        sql`${auditEvents.event_type} IN ('catalog_view', 'product_view')`,
      );
    const catalogViews = Number(viewRows[0]?.count || 0);

    // 6. Fetch products count & stock
    const allProducts = await db.select().from(products);

    // Calculations
    const completedPayments = allPayments.filter(
      (p) => p.status === "completed",
    );
    const totalGmvMinor = completedPayments.reduce(
      (sum, p) => sum + p.amount_minor,
      0,
    );

    const pendingProposals = allCarts.filter(
      (c) =>
        c.status === "proposed" && new Date() < new Date(c.quote_expires_at),
    );

    const stepUpCount = allDecisions.filter(
      (d) => d.decision === "STEP_UP",
    ).length;
    const allowCount = allDecisions.filter(
      (d) => d.decision === "ALLOW",
    ).length;
    const denyCount = allDecisions.filter((d) => d.decision === "DENY").length;

    const conversionRate =
      allCarts.length > 0
        ? Math.round((completedPayments.length / allCarts.length) * 100)
        : 0;

    // Category breakdown
    const categoryMap: Record<string, number> = {};
    for (const p of allProducts) {
      categoryMap[p.category] = (categoryMap[p.category] || 0) + 1;
    }

    // ---- Revenue Attribution (AI vs Human) ----
    // AI revenue is real settled agent GMV this week. Human POS sales are a
    // deterministic demo baseline (no human channel is wired in this build).
    const weekStart = new Date();
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7)); // Monday

    const aiWeekMinor = completedPayments
      .filter((p) => new Date(p.created_at) >= weekStart)
      .reduce((sum, p) => sum + p.amount_minor, 0);
    const aiAllTimeMinor = totalGmvMinor;

    // Deterministic mock for the human channel so the pie isn't degenerate.
    const weekNumber = Math.floor(Date.now() / (7 * 24 * 3600 * 1000));
    const humanFactor = 2.1 + (weekNumber % 5) * 0.15;
    const humanWeekMinor = Math.round(aiWeekMinor * humanFactor) || 4126600; // ₹41,266 demo floor

    const hasAiRevenue = aiWeekMinor > 0 || aiAllTimeMinor > 0;
    const attribution = {
      aiMinor: aiWeekMinor,
      humanMinor: humanWeekMinor,
      aiAllTimeMinor,
      isDemoHuman: true,
      isDemoData: !hasAiRevenue,
      weekLabel: "this week",
      headline: `₹${((hasAiRevenue ? aiWeekMinor : 12400 * 100) / 100).toLocaleString("en-IN")} in AI-driven sales ${hasAiRevenue ? "this week" : "(demo)"}`,
    };

    // ---- Conversion Funnel ----
    const cartsCreated = allCarts.length;
    const policyApproved = allowCount;
    const paid = completedPayments.length;
    const funnelIsDemo = cartsCreated === 0 && paid === 0;
    const funnel = funnelIsDemo
      ? {
          catalogViews: 150,
          cartsCreated: 22,
          policyApproved: 18,
          paid: 15,
          isDemoData: true,
        }
      : {
          catalogViews: catalogViews || Math.max(cartsCreated * 4, 1),
          cartsCreated,
          policyApproved,
          paid,
          isDemoData: false,
        };

    // ---- Top AI-Purchased SKUs ----
    const skuAgg = new Map<
      string,
      { title: string; units: number; revenueMinor: number }
    >();
    for (const cart of allCarts) {
      if (cart.status !== "completed") continue;
      const items = (cart.items as CartItemShape[]) || [];
      for (const item of items) {
        const key = item.variantId || item.title || "unknown";
        const prev = skuAgg.get(key) || {
          title: item.title || key,
          units: 0,
          revenueMinor: 0,
        };
        prev.units += Number(item.quantity || 1);
        prev.revenueMinor += Number(item.lineAmountMinor || 0);
        if (item.title) prev.title = item.title;
        skuAgg.set(key, prev);
      }
    }
    const topSkus = Array.from(skuAgg.entries())
      .map(([variantId, v]) => ({ variantId, ...v }))
      .sort((a, b) => b.units - a.units || b.revenueMinor - a.revenueMinor)
      .slice(0, 5);

    // Attach each proposal's policy decision + reason codes so the dashboard
    // can distinguish over-limit (queued for approval) from other flags/denies,
    // plus the decision's own metadata (e.g. surge_reason / surge_multiplier /
    // surge_repriced_at) so surge-driven STEP_UPs are visibly labelled.
    const decisionByCart = new Map(
      allDecisions.map((d) => [d.cart_mandate_id, d]),
    );
    const recentProposals = allCarts.slice(0, 10).map((cart) => {
      const dec = decisionByCart.get(cart.id);
      return {
        ...cart,
        policyDecision: dec
          ? {
              decision: dec.decision,
              reasonCodes: dec.reason_codes,
              decisionJSON: dec.decision_json,
            }
          : null,
      };
    });

    return NextResponse.json({
      merchant: {
        id: merchant?.id || "mch_nimbus_gear_001",
        name: merchant?.name || "Nimbus Gear & Electronics",
        config: merchant?.config || {},
      },
      metrics: {
        totalGmvMinor,
        totalGmvFormatted: `₹${(totalGmvMinor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
        totalTransactions: allCarts.length,
        completedOrders: completedPayments.length,
        activeProposals: pendingProposals.length,
        conversionRate,
        stepUpRequests: stepUpCount,
        allowedRequests: allowCount,
        deniedRequests: denyCount,
        productsCount: allProducts.length,
        totalStock: allProducts.reduce((sum, p) => sum + p.stock_quantity, 0),
      },
      attribution,
      funnel,
      topSkus,
      categories: Object.entries(categoryMap).map(([name, count]) => ({
        name,
        count,
      })),
      recentAudit,
      recentProposals,
      recentOrders: allPayments.slice(0, 10),
    });
  } catch (error) {
    console.error("Error fetching merchant stats:", error);
    return NextResponse.json(
      { error: "Internal server error fetching stats" },
      { status: 500 },
    );
  }
}
