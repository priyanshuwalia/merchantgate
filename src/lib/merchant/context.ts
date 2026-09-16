/**
 * Merchant Context Resolution
 *
 * Single seam for resolving the acting merchant. Today the platform ships with
 * one demo tenant (`mch_nimbus_gear_001`), but every request should obtain its
 * merchant context through here — never a hardcoded id scattered through route
 * handlers. When multi-tenancy lands, this is the module that reads the tenant
 * from the agent credential / admin session / host header instead.
 *
 * The context loader merges what several call-sites used to fetch separately
 * (kill-switch gate state + runtime state hydration) into ONE merchant read.
 */

import { eq } from "drizzle-orm";
import { db, merchants } from "@/db";
import { hydrateRuntimeState } from "@/lib/merchant/runtime-state";
import { isSurgePricingActive } from "@/lib/merchant/surge";
import { DEFAULT_MERCHANT_ID } from "@/lib/merchant/tenant";

export { DEFAULT_MERCHANT_ID };

export interface MerchantContext {
  merchantId: string;
  merchantName: string;
  config: Record<string, unknown>;
  aiSalesEnabled: boolean;
  surgeActive: boolean;
}

export async function getMerchantById(
  merchantId: string,
): Promise<typeof merchants.$inferSelect | null> {
  const [merchant] = await db
    .select()
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1);
  return merchant ?? null;
}

/**
 * Resolve the acting merchant, hydrate runtime state (surge toggle, negotiation
 * sessions) from its persisted config, and report the kill-switch gate — all
 * from a single `merchants` read.
 */
export async function getMerchantContext(merchantId?: string): Promise<{
  merchant: typeof merchants.$inferSelect;
  context: MerchantContext;
}> {
  const id = merchantId ?? DEFAULT_MERCHANT_ID;
  const merchant = await getMerchantById(id);
  const config = (merchant?.config as Record<string, unknown>) || {};

  await hydrateRuntimeState();
  const surgeActive = isSurgePricingActive();

  return {
    merchant: merchant ?? ({} as typeof merchants.$inferSelect),
    context: {
      merchantId: id,
      merchantName: merchant?.name ?? "",
      config,
      aiSalesEnabled: config.aiSalesEnabled !== false,
      surgeActive,
    },
  };
}
