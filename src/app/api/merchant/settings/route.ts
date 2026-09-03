import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db, merchants } from "@/db";
import {
  type AiConfigInput,
  maskApiKey,
  resolveAiConfig,
} from "@/lib/ai/provider";
import { requireMerchantAuth } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

function publicAiConfig(config: Record<string, unknown>) {
  const ai = (config.ai as AiConfigInput | undefined) || {};
  return {
    provider: ai.provider || "openrouter",
    model: ai.model || "",
    baseUrl: ai.baseUrl || "",
    hasApiKey: Boolean(ai.apiKey),
    apiKeyMasked: maskApiKey(ai.apiKey),
    live: Boolean(resolveAiConfig(null, ai)),
  };
}

/**
 * Strip secrets (e.g. the stored AI model API key) from the merchant config
 * before it is returned to the browser, so the raw key is never exposed.
 */
function publicConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const { ai: _ai, ...rest } = config;
  if (_ai && typeof _ai === "object") {
    const ai = { ...(_ai as Record<string, unknown>) };
    if ("apiKey" in ai && typeof ai.apiKey === "string" && ai.apiKey) {
      ai.apiKey = `•••• ${ai.apiKey.slice(-4)}`;
    }
    return { ...rest, ai };
  }
  return rest;
}

function validateSettings(body: Record<string, unknown>): string | null {
  if (body.maxAgentTransactionAmount !== undefined) {
    const n = Number(body.maxAgentTransactionAmount);
    if (!Number.isFinite(n) || n < 0 || n > 100_000_000_000) {
      return "maxAgentTransactionAmount must be a non-negative number.";
    }
  }
  if (body.priceSlippageToleranceBps !== undefined) {
    const n = Number(body.priceSlippageToleranceBps);
    if (!Number.isFinite(n) || n < 0 || n > 10000) {
      return "priceSlippageToleranceBps must be between 0 and 10000.";
    }
  }
  return null;
}

export async function GET(request: NextRequest) {
  const auth = requireMerchantAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const [merchant] = await db
      .select()
      .from(merchants)
      .where(eq(merchants.id, "mch_nimbus_gear_001"))
      .limit(1);

    if (!merchant) {
      return NextResponse.json(
        { error: "Merchant not found" },
        { status: 404 },
      );
    }

    const config = (merchant.config as Record<string, unknown>) || {};

    return NextResponse.json({
      id: merchant.id,
      name: merchant.name,
      status: merchant.status,
      // Never return the raw API key (or any secret) to the browser
      config: publicConfig(config),
      ai: publicAiConfig(config),
    });
  } catch (error) {
    console.error("Error fetching settings:", error);
    return NextResponse.json(
      { error: "Internal error fetching settings." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = requireMerchantAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json();
    const validationError = validateSettings(body);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }
    const {
      name,
      currency,
      aiSalesEnabled,
      autoProcessAgentOrders,
      agentRequiresApproval,
      maxAgentTransactionAmount,
      priceSlippageToleranceBps,
      razorpayKeyId,
      webhookUrl,
      merchantAgentRules,
      ai,
      clearAiKey,
    } = body;

    const [merchant] = await db
      .select()
      .from(merchants)
      .where(eq(merchants.id, "mch_nimbus_gear_001"))
      .limit(1);

    const existingConfig = (merchant?.config as Record<string, unknown>) || {};
    const existingAi = (existingConfig.ai as AiConfigInput | undefined) || {};

    // Merge AI model config: empty/absent key preserves the stored secret.
    let nextAi: AiConfigInput | undefined;
    if (ai && typeof ai === "object") {
      nextAi = {
        provider: String(ai.provider || existingAi.provider || "openrouter"),
        model: String(ai.model ?? existingAi.model ?? "").trim(),
        baseUrl: String(ai.baseUrl ?? existingAi.baseUrl ?? "").trim(),
        apiKey:
          typeof ai.apiKey === "string" && ai.apiKey.trim().length > 0
            ? ai.apiKey.trim()
            : existingAi.apiKey,
      };
      if (clearAiKey) nextAi.apiKey = undefined;
    } else if (!clearAiKey) {
      nextAi = existingAi.apiKey ? existingAi : undefined;
    }

    const updatedConfig = {
      ...existingConfig,
      // Absent fields preserve their stored values — partial saves (e.g. the
      // kill-switch toggle) must never clobber other merchant settings.
      currency: currency || existingConfig.currency || "INR",
      aiSalesEnabled:
        aiSalesEnabled !== undefined
          ? Boolean(aiSalesEnabled)
          : existingConfig.aiSalesEnabled !== false,
      autoProcessAgentOrders:
        autoProcessAgentOrders !== undefined
          ? Boolean(autoProcessAgentOrders)
          : Boolean(existingConfig.autoProcessAgentOrders ?? false),
      agentRequiresApproval:
        agentRequiresApproval !== undefined
          ? Boolean(agentRequiresApproval)
          : Boolean(existingConfig.agentRequiresApproval ?? true),
      maxAgentTransactionAmount: Number.isFinite(
        Number(maxAgentTransactionAmount),
      )
        ? Number(maxAgentTransactionAmount)
        : Number(existingConfig.maxAgentTransactionAmount ?? 5000000),
      priceSlippageToleranceBps: Number.isFinite(
        Number(priceSlippageToleranceBps),
      )
        ? Number(priceSlippageToleranceBps)
        : Number(existingConfig.priceSlippageToleranceBps ?? 200),
      razorpayKeyId:
        razorpayKeyId ||
        (existingConfig.razorpayKeyId as string) ||
        process.env.RAZORPAY_KEY_ID,
      webhookUrl,
      merchantAgentRules: merchantAgentRules
        ? {
            ...(existingConfig.merchantAgentRules as object),
            ...merchantAgentRules,
          }
        : existingConfig.merchantAgentRules,
      ...(nextAi ? { ai: nextAi } : clearAiKey ? { ai: {} } : {}),
    };

    const [updated] = await db
      .update(merchants)
      .set({
        name: name || merchant?.name || "Nimbus Gear & Electronics",
        config: updatedConfig,
        updated_at: new Date(),
      })
      .where(eq(merchants.id, "mch_nimbus_gear_001"))
      .returning();

    return NextResponse.json({
      success: true,
      merchant: { ...updated, config: publicConfig(updatedConfig) },
      ai: publicAiConfig(updatedConfig),
    });
  } catch (error) {
    console.error("Error updating settings:", error);
    return NextResponse.json(
      { error: "Internal error updating settings." },
      { status: 500 },
    );
  }
}
