import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db, merchants } from "@/db";
import { callLlm } from "@/lib/ai/llm";
import { resolveAiConfig } from "@/lib/ai/provider";
import { requireMerchantAuth } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

/** Reject non-http(s) custom base URLs to avoid SSRF against internal hosts. */
function isSafeBaseUrl(baseUrl: unknown): boolean {
  if (baseUrl === undefined || baseUrl === null) return true;
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") return true;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * POST /api/merchant/ai-test
 * Verifies the merchant's configured (or newly-typed, not-yet-saved) AI
 * model settings by issuing a tiny completion. Returns a human-readable
 * diagnostic so merchants know their key/model actually works.
 */
export async function POST(request: NextRequest) {
  const auth = requireMerchantAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json().catch(() => ({}));
    if (!isSafeBaseUrl(body.baseUrl)) {
      return NextResponse.json(
        { success: false, message: "Custom base URL must use http(s)." },
        { status: 400 },
      );
    }
    const supplied = {
      provider: body.provider,
      model: body.model,
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
    };

    let configInput = supplied;
    if (!supplied.apiKey) {
      // Fall back to whatever the merchant has saved
      const [merchant] = await db
        .select()
        .from(merchants)
        .where(eq(merchants.id, "mch_nimbus_gear_001"))
        .limit(1);
      const config = (merchant?.config as Record<string, unknown>) || {};
      configInput = {
        ...supplied,
        ...((config.ai as Record<string, string>) || {}),
      };
    }

    const resolved = resolveAiConfig(configInput);
    if (!resolved) {
      return NextResponse.json({
        success: false,
        message:
          "No API key available. Paste your model provider's API key and try again.",
      });
    }

    const started = Date.now();
    const out = await callLlm(
      [
        {
          role: "system",
          content:
            "You are a connectivity probe. Reply with exactly: AGENTPAY_LINK_OK",
        },
        { role: "user", content: "ping" },
      ],
      { ...resolved, temperature: 0, maxTokens: 20, timeoutMs: 15_000 },
    );

    if (out?.toUpperCase().includes("AGENTPAY_LINK_OK")) {
      return NextResponse.json({
        success: true,
        provider: resolved.provider,
        model: resolved.model,
        latencyMs: Date.now() - started,
        message: `Connected to ${resolved.provider} • ${resolved.model} (${Date.now() - started}ms)`,
      });
    }

    return NextResponse.json({
      success: false,
      provider: resolved.provider,
      model: resolved.model,
      message: out
        ? "Provider responded but with an unexpected reply — check the model name."
        : `Call failed. Verify the API key${resolved.provider === "custom" ? ", base URL" : ""}, model name, and that the key has quota.`,
    });
  } catch (error) {
    console.error("AI test failed:", error);
    return NextResponse.json(
      { success: false, message: "AI connectivity test failed." },
      { status: 500 },
    );
  }
}
