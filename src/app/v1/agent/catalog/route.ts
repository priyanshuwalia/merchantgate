import { and, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db, products } from "@/db";
import { logAuditEvent } from "@/lib/audit/logger";
import {
  aiSalesPausedResponse,
  getMerchantGateState,
} from "@/lib/merchant/guard";
import { generateTraceId } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const traceId = generateTraceId();
  try {
    // Global AI Sales kill-switch: paused merchants serve no agent catalog
    const gate = await getMerchantGateState();
    if (!gate.aiSalesEnabled) {
      return aiSalesPausedResponse({ endpoint: "/v1/agent/catalog" });
    }

    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q")?.trim();
    const category = searchParams.get("category")?.trim();
    const minPrice = searchParams.get("minPrice")
      ? Number(searchParams.get("minPrice"))
      : undefined;
    const maxPrice = searchParams.get("maxPrice")
      ? Number(searchParams.get("maxPrice"))
      : undefined;
    const inStock = searchParams.get("inStock") === "true";
    const limit = Math.min(Number(searchParams.get("limit") || 20), 100);
    const offset = Number(searchParams.get("cursor") || 0);

    const conditions = [];

    if (category) {
      conditions.push(eq(products.category, category));
    }
    if (minPrice !== undefined && !isNaN(minPrice)) {
      conditions.push(gte(products.base_price_minor, minPrice));
    }
    if (maxPrice !== undefined && !isNaN(maxPrice)) {
      conditions.push(lte(products.base_price_minor, maxPrice));
    }
    if (inStock) {
      conditions.push(gte(products.stock_quantity, 1));
    }
    if (q) {
      conditions.push(
        or(
          ilike(products.title, `%${q}%`),
          ilike(products.description, `%${q}%`),
          ilike(products.category, `%${q}%`),
          ilike(products.variant_id, `%${q}%`),
        ),
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const items = await db
      .select()
      .from(products)
      .where(whereClause)
      .limit(limit)
      .offset(offset);

    const totalCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(products)
      .where(whereClause);

    const total = Number(totalCount[0]?.count || items.length);

    const formattedItems = items.map((p) => {
      let availabilityStatus: "in_stock" | "limited" | "out_of_stock" =
        "in_stock";
      if (p.stock_quantity <= 0) {
        availabilityStatus = "out_of_stock";
      } else if (p.stock_quantity <= 10) {
        availabilityStatus = "limited";
      }

      const attributes = (p.attributes as Record<string, unknown>) || {};

      return {
        productId: p.id,
        variantId: p.variant_id,
        merchantId: p.merchant_id,
        title: p.title,
        description: p.description || "",
        category: p.category,
        tags: attributes.tags || [p.category],
        attributes,
        rating: {
          average: Number(attributes.ratingAverage ?? 4.6),
          count: Number(attributes.ratingCount ?? 100),
        },
        discoveryPrice: {
          amountMinor: p.base_price_minor,
          currency: p.currency,
        },
        availability: {
          status: availabilityStatus,
          quantityBand: p.stock_quantity > 20 ? "20+" : `${p.stock_quantity}`,
        },
        returnable: p.returnable,
        returnWindowDays: p.return_window_days || 7,
        images: ["/product-placeholder.png"],
        version: String(p.version || "1.0.0"),
        updatedAt: p.updated_at.toISOString(),
      };
    });

    const nextCursor =
      offset + items.length < total ? String(offset + items.length) : undefined;

    // Funnel telemetry: catalog view event (excluded from overview audit feed)
    await logAuditEvent({
      traceId,
      actorType: "agent",
      actorId: searchParams.get("agentId") || "external_buyer_agent",
      eventType: "catalog_view",
      explanation: `Catalog viewed (q='${q || ""}', ${items.length} results).`,
      metadata: { query: q || "", resultCount: items.length },
    });

    return NextResponse.json({
      items: formattedItems,
      nextCursor,
      total,
    });
  } catch (error) {
    console.error("Error fetching agent catalog:", error);
    return NextResponse.json(
      {
        error: "Internal server error fetching catalog",
      },
      { status: 500 },
    );
  }
}
