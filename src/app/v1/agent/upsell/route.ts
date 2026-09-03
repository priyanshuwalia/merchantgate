import { eq, inArray } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { cartMandates, db, merchants, paymentActions, products } from "@/db";
import { logAuditEvent } from "@/lib/audit/logger";
import { authenticateAgentRequest } from "@/lib/auth/agent-auth";
import {
  aiSalesPausedResponse,
  getMerchantGateState,
} from "@/lib/merchant/guard";
import {
  generateUpsellOffers,
  getUpsellRules,
  type MarketBasketRecord,
  type UpsellCartItem,
  type UpsellCatalogItem,
} from "@/lib/merchant/upsell";
import { generateTraceId } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * POST /v1/agent/upsell
 *
 * Bounded upsell / cross-sell offers for an AI buyer's cart. Deterministic,
 * merchant-priced, capped by the configured basket-uplift ceiling. The buyer
 * agent MAY pass an offer's `offerId` back to the checkout endpoint as
 * `upsellOfferId` to accept it — the checkout re-resolves it authoritatively.
 */
export async function POST(request: NextRequest) {
  const traceId = generateTraceId();

  try {
    const merchantId = "mch_nimbus_gear_001";
    const [merchant] = await db
      .select()
      .from(merchants)
      .where(eq(merchants.id, merchantId))
      .limit(1);
    if (!merchant) {
      return NextResponse.json(
        { success: false, error: "Merchant not found" },
        { status: 404 },
      );
    }

    const merchantConfig = (merchant.config as Record<string, unknown>) || {};
    const gate = await getMerchantGateState();
    if (!gate.aiSalesEnabled) {
      return aiSalesPausedResponse({ endpoint: "/v1/agent/upsell" });
    }

    const auth = await authenticateAgentRequest(request, { merchantConfig });
    if (!auth.ok && auth.response) return auth.response;

    const body = await request.json();
    const requestedItems = body.items as Array<{
      variantId: string;
      quantity?: number;
    }>;
    if (!Array.isArray(requestedItems) || requestedItems.length === 0) {
      return NextResponse.json(
        { success: false, error: "items array is required" },
        { status: 400 },
      );
    }

    // Load the whole active catalogue once: used for both cart resolution and
    // as the candidate pool for offers.
    const catalogue = await db.select().from(products);
    const catalogMap = new Map(catalogue.map((p) => [p.variant_id, p]));

    const cartItems: UpsellCartItem[] = [];
    for (const item of requestedItems) {
      const dbProduct = catalogMap.get(item.variantId);
      if (!dbProduct) {
        return NextResponse.json(
          {
            success: false,
            error: `Product variant not found: ${item.variantId}`,
          },
          { status: 404 },
        );
      }
      const quantity = Math.max(1, Math.round(Number(item.quantity) || 1));
      cartItems.push({
        variantId: dbProduct.variant_id,
        category: dbProduct.category,
        title: dbProduct.title,
        quantity,
        unitAmountMinor: dbProduct.base_price_minor,
      });
    }

    const catalog: UpsellCatalogItem[] = catalogue.map((p) => ({
      variantId: p.variant_id,
      title: p.title,
      category: p.category,
      unitAmountMinor: p.base_price_minor,
      stockQuantity: p.stock_quantity,
      returnable: p.returnable,
      attributes: (p.attributes as Record<string, unknown>) || {},
    }));

    // A3: learn real cross-sell affinity from completed purchase history.
    const completedPayments = await db
      .select()
      .from(paymentActions)
      .where(inArray(paymentActions.status, ["completed"]))
      .limit(100);
    const completedCartIds = completedPayments.map((p) => p.cart_mandate_id);
    const completedCarts =
      completedCartIds.length > 0
        ? await db
            .select()
            .from(cartMandates)
            .where(inArray(cartMandates.id, completedCartIds))
        : [];
    const marketBaskets: MarketBasketRecord[] = completedCarts.map((c) => ({
      agentId: String(c.intent_mandate_id),
      variantIds: ((c.items as Array<{ variantId: string }>) || []).map(
        (i) => i.variantId,
      ),
    }));

    const rules = getUpsellRules(merchantConfig);
    const requiresRefundable =
      body.requiresRefundable !== undefined
        ? Boolean(body.requiresRefundable)
        : false;
    const result = generateUpsellOffers({
      cart: cartItems,
      catalog,
      rules,
      marketBaskets,
      requiresRefundable,
    });

    await logAuditEvent({
      traceId,
      actorType: "agent",
      actorId: auth.agentId,
      eventType: "upsell_offers_generated",
      intentMandateId: String(body.intentMandateId || "") || undefined,
      reasonCodes: result.reasonCodes,
      explanation:
        result.offers.length > 0
          ? `Generated ${result.offers.length} bounded upsell offer(s) for a ${cartItems.length}-line cart. Uplift cap ${result.maxUpliftMinor} minor units; offered ${result.totalUpliftMinor}.`
          : "No eligible upsell offers generated for cart.",
      metadata: {
        cartItems: cartItems.length,
        cartSubtotalMinor: result.cartSubtotalMinor,
        offerCount: result.offers.length,
        maxUpliftMinor: result.maxUpliftMinor,
        totalUpliftMinor: result.totalUpliftMinor,
        trimmedByCap: result.offersTrimmedByUpliftCap,
        marketBasketsAnalyzed: marketBaskets.length,
        agentAuthMode: auth.mode,
        rateLimitRemaining: auth.rateLimitInfo.remaining,
      },
    });

    return NextResponse.json({
      success: true,
      offers: result.offers.map((o) => ({
        ...o,
        accept: {
          checkoutField: "upsellOfferId",
          value: o.offerId,
        },
      })),
      cartSubtotalMinor: result.cartSubtotalMinor,
      maxBasketUpliftMinor: result.maxUpliftMinor,
      totalUpliftMinor: result.totalUpliftMinor,
      reasonCodes: result.reasonCodes,
      agentAuthMode: auth.mode,
      rateLimit: {
        remaining: auth.rateLimitInfo.remaining,
        limit: auth.rateLimitInfo.limit,
      },
    });
  } catch (error) {
    console.error("Error generating upsell offers:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error during upsell" },
      { status: 500 },
    );
  }
}
