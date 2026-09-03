import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db, merchants } from "@/db";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const [merchant] = await db
      .select()
      .from(merchants)
      .where(eq(merchants.id, "mch_nimbus_gear_001"))
      .limit(1);

    const config = (merchant?.config as Record<string, unknown>) || {};
    const aiSalesEnabled = config.aiSalesEnabled !== false; // default true

    // Kill-Switch Check
    if (!aiSalesEnabled) {
      return NextResponse.json(
        {
          error: "MERCHANT_NOT_AVAILABLE",
          status: "paused",
          message:
            "AI Sales Channel is currently paused by merchant administrator.",
        },
        { status: 403 },
      );
    }

    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.host}`;

    const manifest = {
      protocol: "agentpay-commerce.v1",
      merchantId: merchant?.id || "mch_nimbus_gear_001",
      merchantName: merchant?.name || "Nimbus Gear & Electronics",
      description:
        "AI-native merchant offering high-performance computer peripherals and electronics with authoritative time-bound quotes.",
      status: "active",
      capabilities: {
        catalogSearch: true,
        authoritativeCheckout: true,
        agentNegotiation: true,
        bulkPricing: true,
        productRatings: true,
        returns: true,
        agentVerification: true,
        priceFreezingMinutes: 15,
        streamingLineage: true,
      },
      endpoints: {
        manifest: `${baseUrl}/.well-known/agent-commerce.json`,
        catalog: `${baseUrl}/v1/agent/catalog`,
        product: `${baseUrl}/v1/agent/products/{variant_id}`,
        verify: `${baseUrl}/v1/agent/verify`,
        negotiate: `${baseUrl}/v1/agent/negotiate`,
        checkout: `${baseUrl}/v1/agent/checkout`,
        confirm: `${baseUrl}/v1/agent/checkout/confirm`,
      },
      money: {
        currencies: ["INR"],
        minorUnits: true,
      },
      paymentHandlers: [
        {
          type: "razorpay_test",
          mode: "human_present",
        },
      ],
      security: {
        proofType: "sha256-canonical-json",
        mandateSchema: "intent_mandate.v1",
        quoteSchema: "cart_mandate.v1",
      },
    };

    return NextResponse.json(manifest);
  } catch (error) {
    console.error("Error generating agent manifest:", error);
    return NextResponse.json(
      { error: "Internal server error fetching merchant manifest" },
      { status: 500 },
    );
  }
}
