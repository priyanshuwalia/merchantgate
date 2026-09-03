/**
 * Global AI Sales Channel guard.
 *
 * The merchant kill-switch (config.aiSalesEnabled) must gate EVERY
 * agent-facing surface: discovery, catalog, product detail, verification,
 * negotiation, quoting, and — critically — settlement/confirmation, so that
 * quotes issued before the switch was flipped can never complete afterwards.
 */

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, merchants } from "@/db";

export interface MerchantGateState {
  aiSalesEnabled: boolean;
  config: Record<string, unknown>;
}

const MERCHANT_ID = "mch_nimbus_gear_001";

export async function getMerchantGateState(): Promise<MerchantGateState> {
  const [merchant] = await db
    .select()
    .from(merchants)
    .where(eq(merchants.id, MERCHANT_ID))
    .limit(1);

  const config = (merchant?.config as Record<string, unknown>) || {};
  return {
    aiSalesEnabled: config.aiSalesEnabled !== false,
    config,
  };
}

/**
 * Standard JSON response for a paused AI sales channel.
 */
export function aiSalesPausedResponse(extra?: Record<string, unknown>) {
  return NextResponse.json(
    {
      success: false,
      error: "MERCHANT_NOT_AVAILABLE",
      decision: "DENY",
      message:
        "Merchant AI Sales channel is currently paused by the merchant administrator. No catalog access, quotes, or settlements are possible while paused.",
      ...extra,
    },
    { status: 403 },
  );
}
