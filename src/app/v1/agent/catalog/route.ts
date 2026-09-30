import { and, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { rankCatalogMatches } from "@/core/catalog-match";
import { db, products } from "@/db";
import { logAuditEvent } from "@/lib/audit/logger";
import {
  aiSalesPausedResponse,
  getMerchantGateState,
} from "@/lib/merchant/guard";
import { generateTraceId } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * Relevance ranking is computed in JS (see `src/core/catalog-match.ts`) so a
 * text query has to be scored over a bounded window before pagination. 200 rows
 * is far more than any single merchant catalogue in this protocol.
 */
const RELEVANCE_SCAN_WINDOW = 200;

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
    // Off by default: a text query only ever returns SKUs that actually match
    // the request. Complements ("headphone" → "Headphone Stand") and
    // description-only hits are excluded unless a buyer asks for them.
    const includeNonMatches = searchParams.get("includeNonMatches") === "true";

    const conditions = [];

    if (category) {
      conditions.push(eq(products.category, category));
    }
    if (minPrice !== undefined && !Number.isNaN(minPrice)) {
      conditions.push(gte(products.base_price_minor, minPrice));
    }
    if (maxPrice !== undefined && !Number.isNaN(maxPrice)) {
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

    // With a text query the scan window is widened so relevance has something to
    // rank before the page slice; the cursor then pages inside that window.
    const scanLimit = q
      ? Math.min(Math.max(limit, 20) * 5, RELEVANCE_SCAN_WINDOW)
      : limit;
    const scanOffset = q ? 0 : offset;

    const rows = await db
      .select()
      .from(products)
      .where(whereClause)
      .limit(scanLimit)
      .offset(scanOffset);

    const totalCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(products)
      .where(whereClause);

    const ranked = rankCatalogMatches(
      rows.map((p) => ({
        row: p,
        variantId: p.variant_id,
        title: p.title,
        category: p.category,
        description: p.description,
        basePriceMinor: p.base_price_minor,
        inStock: p.stock_quantity > 0,
      })),
      q || "",
      { category: null },
    ).map((m) => ({ match: m, row: m.item.row }));

    const matching =
      q && !includeNonMatches
        ? ranked.filter((r) => r.match.selectable)
        : ranked;
    const ordered = q ? matching.slice(offset, offset + limit) : matching;

    const total = q
      ? matching.length
      : Number(totalCount[0]?.count || ordered.length);

    const formattedItems = ordered.map(({ row: p, match }) => {
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
        // Relevance verdict, so a buyer agent can see WHY a SKU is (or is not)
        // a legitimate answer to its query. `selectable: false` means "do not
        // buy this for the request" — it is a complement, not the product.
        match: q
          ? {
              verdict: match.verdict,
              score: match.score,
              selectable: match.selectable,
              reason: match.reason,
            }
          : undefined,
      };
    });

    const available = q ? matching.length : total;
    const nextCursor =
      offset + ordered.length < available
        ? String(offset + ordered.length)
        : undefined;

    // Funnel telemetry: catalog view event (excluded from overview audit feed)
    await logAuditEvent({
      traceId,
      actorType: "agent",
      actorId: searchParams.get("agentId") || "external_buyer_agent",
      eventType: "catalog_view",
      explanation: `Catalog viewed (q='${q || ""}', ${formattedItems.length} results).`,
      metadata: { query: q || "", resultCount: formattedItems.length },
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
