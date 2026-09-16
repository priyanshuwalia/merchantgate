import { eq, or } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db, products } from "@/db";
import { logAuditEvent } from "@/lib/audit/logger";
import {
  aiSalesPausedResponse,
  getMerchantGateState,
} from "@/lib/merchant/guard";
import { generateTraceId } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const traceId = generateTraceId();
  try {
    // Global AI Sales kill-switch
    const gate = await getMerchantGateState();
    if (!gate.aiSalesEnabled) {
      return aiSalesPausedResponse({ endpoint: "/v1/agent/products" });
    }

    const { id } = await params;

    const [product] = await db
      .select()
      .from(products)
      .where(or(eq(products.variant_id, id), eq(products.id, id)))
      .limit(1);

    if (!product) {
      return NextResponse.json(
        { error: "Product variant not found", variantId: id },
        { status: 404 },
      );
    }

    let availabilityStatus: "in_stock" | "limited" | "out_of_stock" =
      "in_stock";
    if (product.stock_quantity <= 0) {
      availabilityStatus = "out_of_stock";
    } else if (product.stock_quantity <= 10) {
      availabilityStatus = "limited";
    }

    const attributes = (product.attributes as Record<string, unknown>) || {};

    const response = {
      productId: product.id,
      variantId: product.variant_id,
      merchantId: product.merchant_id,
      title: product.title,
      description: product.description || "",
      category: product.category,
      tags: attributes.tags || [product.category],
      attributes,
      rating: {
        average: Number(attributes.ratingAverage ?? 4.6),
        count: Number(attributes.ratingCount ?? 100),
      },
      pricing: {
        amountMinor: product.base_price_minor,
        currency: product.currency,
        taxRateBps: product.tax_rate_bps,
        isPromotional: false,
      },
      availability: {
        status: availabilityStatus,
        quantityBand:
          product.stock_quantity > 20 ? "20+" : `${product.stock_quantity}`,
        stock: product.stock_quantity,
      },
      returnable: product.returnable,
      returnWindowDays: product.return_window_days || 7,
      images: ["/product-placeholder.png"],
      version: String(product.version || "1.0.0"),
      updatedAt: product.updated_at.toISOString(),
    };

    // Funnel telemetry: product detail view
    await logAuditEvent({
      traceId,
      actorType: "agent",
      actorId: "external_buyer_agent",
      eventType: "product_view",
      cartMandateId: undefined,
      explanation: `Product detail viewed: ${product.title} (${product.variant_id}).`,
      metadata: { variantId: product.variant_id, title: product.title },
    });

    return NextResponse.json(response);
  } catch (error) {
    console.error("Error fetching product details:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
