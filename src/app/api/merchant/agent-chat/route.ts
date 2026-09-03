import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db, merchants } from "@/db";
import {
  callLlm,
  extractFencedJson,
  looksLikeToolLeak,
  sanitizeAssistantReply,
  stripFencedBlock,
} from "@/lib/ai/llm";
import type { AiConfigInput } from "@/lib/ai/provider";
import { requireMerchantAuth } from "@/lib/auth/guard";
import { rateLimitRequest } from "@/lib/auth/rate-limit";
import {
  getMerchantAgentRules,
  type MerchantAgentRuleSet,
  sanitizeMerchantRules,
} from "@/lib/merchant/agent";

export const dynamic = "force-dynamic";

const KNOWN_CATEGORIES = ["electronics", "audio", "accessories", "computers"];

interface RuleExtraction {
  rules: Partial<MerchantAgentRuleSet>;
  appliedFields: string[];
}

const WORD_PERCENTS: Record<string, number> = {
  one: 100,
  two: 200,
  three: 300,
  four: 400,
  five: 500,
  six: 600,
  seven: 700,
  eight: 800,
  nine: 900,
  ten: 1000,
  eleven: 1100,
  twelve: 1200,
  thirteen: 1300,
  fourteen: 1400,
  fifteen: 1500,
  twenty: 2000,
};

interface PercentMention {
  bps: number;
  /** The comma/and-separated clause this percentage appears in */
  clause: string;
}

/**
 * Find every percentage mentioned in the text along with its enclosing clause
 * so multi-part sentences ("7% off from 5 units, never exceed 12%, ask
 * approval above 10%") can be classified correctly.
 */
function parsePercentMentions(text: string): PercentMention[] {
  const clauses = text
    .split(/,|;|\band\b/i)
    .map((c) => c.trim())
    .filter(Boolean);

  const mentions: PercentMention[] = [];
  const pattern =
    /([0-9]+(?:\.[0-9]+)?)(?:\s*(?:%|percent))|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty)\s+percent\b/gi;

  for (const clause of clauses) {
    pattern.lastIndex = 0;
    for (const match of clause.matchAll(pattern)) {
      const raw = match[1] ?? match[2];
      const value = Number(raw);
      const bps = Number.isNaN(value)
        ? (WORD_PERCENTS[raw.toLowerCase()] ?? -1)
        : Math.round(value * 100);
      if (bps >= 0) mentions.push({ bps, clause: clause.toLowerCase() });
    }
  }
  return mentions;
}

function parseQuantity(text: string): number | null {
  // Negative lookahead skips numbers that are percentages (e.g. "more than 15%")
  const match =
    text.match(
      /(?:bulk|min(?:imum)?|at least|more than|over|from|when)\s*(\d+)(?![0-9])\s*(?!%|percent)(?:units?|items?|qty|quantity|pieces?|pcs)?/i,
    ) ||
    text.match(
      /(\d+)\s*(?:units?|items?|qty|quantity|pieces?|pcs)\s*(?:or more|minimum|min)?/i,
    ) ||
    text.match(
      /\b(\d+)\s*\+?\s*(?:keyboards?|mice|mouse|headphones?|stands?|laptops?|monitors?)\b/i,
    );
  return match ? Math.max(1, parseInt(match[1], 10)) : null;
}

function parseCategories(text: string): string[] | null {
  const found = KNOWN_CATEGORIES.filter((c) => text.toLowerCase().includes(c));
  return found.length > 0 ? found : null;
}

/**
 * Deterministic fallback parser for inventory rules.
 */
export function parseInventoryRulesLocally(
  message: string,
  _existing: MerchantAgentRuleSet,
): RuleExtraction {
  const next: Partial<MerchantAgentRuleSet> = {};
  const lower = message.toLowerCase();

  if (/(disable|turn off|pause)(?!.*bulk)/i.test(lower)) next.enabled = false;
  if (/(enable|activate|turn on|resume)/i.test(lower)) next.enabled = true;
  if (/(no bulk|disable bulk|turn off bulk|stop bulk)/i.test(lower))
    next.bulkDiscountEnabled = false;
  if (/(enable bulk|allow bulk|bulk discounts? on)/i.test(lower))
    next.bulkDiscountEnabled = true;

  const mentions = parsePercentMentions(message);
  const wantsDiscountChange =
    /(discount|off|%|percent|cheaper|deal|negotiat)/i.test(lower);

  for (const mention of mentions) {
    const clause = mention.clause;
    const isApprovalContext = /(approv|ask me|human sign|check with me)/.test(
      clause,
    );
    const isMaxContext =
      /(exceed|max|ceiling|cap\b|hard limit|no more than|more than|highest)/.test(
        clause,
      );

    if (isApprovalContext && !isMaxContext) {
      next.requireApprovalAboveDiscountBps = mention.bps;
    } else if (isMaxContext) {
      next.maxDiscountBps = mention.bps;
    } else if (
      !next.bulkDiscountBps &&
      (wantsDiscountChange || /off|discount/.test(clause))
    ) {
      next.bulkDiscountBps = mention.bps;
    }
  }

  const qty = parseQuantity(message);
  if (qty !== null) next.bulkMinQuantity = qty;

  const categories = parseCategories(message);
  if (categories) next.negotiableCategories = categories;

  if (message.trim().length > 10) next.inventoryInstruction = message.trim();

  const appliedFields = Object.keys(next).filter(
    (k) => k !== "inventoryInstruction",
  );
  return { rules: next, appliedFields };
}

const MERCHANT_AGENT_SYSTEM_PROMPT = `You are the Inventory & Negotiation Agent configuration assistant for an e-commerce merchant ("Nimbus Gear"). The merchant talks to you in plain English and you convert their instructions into a structured rule set used by the autonomous merchant negotiating agent during AI-buyer checkouts.

The rule schema:
{
  "enabled": boolean (merchant agent active),
  "bulkDiscountEnabled": boolean,
  "bulkMinQuantity": integer (units before bulk pricing kicks in),
  "bulkDiscountBps": integer (basis points; 700 = 7%),
  "maxDiscountBps": integer (absolute ceiling),
  "minimumMarginBps": integer,
  "requireApprovalAboveDiscountBps": integer (discounts above this need human approval),
  "negotiableCategories": ["electronics","audio","accessories","computers"],
  "inventoryInstruction": free-text standing instruction
}

Always respond with:
1. A short friendly confirmation of what you understood/changed.
2. A fenced block tagged json_rules containing ONLY the fields explicitly mentioned or clearly implied by the merchant's latest message (omit untouched fields):

\`\`\`json_rules
{ ...only changed fields... }
\`\`\`

If the merchant expresses intent but misses a critical number (e.g. "give a discount" with no percentage, or "bulk orders" with no quantity), ask ONE concise clarifying question instead of guessing.
100 basis points = 1%. Never invent percentages.`;

export async function POST(request: NextRequest) {
  const auth = requireMerchantAuth(request);
  if (auth instanceof NextResponse) return auth;

  // Guard the LLM (merchant API key) surface: cap per-IP calls so an attacker
  // cannot burn the merchant's model quota by hammering this endpoint.
  const limited = rateLimitRequest(request, {
    namespace: "merchant-agent-chat",
    limit: Number(process.env.RATE_LIMIT_AGENT_CHAT) || 30,
  });
  if (limited) return limited;

  try {
    const body = await request.json();
    const message = String(body.message || "").trim();
    const history: Array<{ role: "user" | "assistant"; content: string }> =
      Array.isArray(body.history) ? body.history : [];

    if (!message) {
      return NextResponse.json(
        { error: "Message is required" },
        { status: 400 },
      );
    }

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
    const existingRules = getMerchantAgentRules(config);

    let aiReply = "";
    let llmRules: Partial<MerchantAgentRuleSet> = {};

    // Merchant's own configured model (Settings → AI Model Configuration),
    // with an optional per-request override from the client.
    const merchantAi = (config.ai as AiConfigInput | undefined) || undefined;
    // Reject non-http(s) custom base URLs to avoid SSRF against internal hosts.
    if (body.baseUrl !== undefined && body.baseUrl !== null) {
      if (typeof body.baseUrl !== "string") {
        return NextResponse.json(
          { error: "Invalid baseUrl." },
          { status: 400 },
        );
      }
      try {
        const parsed = new URL(body.baseUrl.trim());
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return NextResponse.json(
            { error: "Custom base URL must use http(s)." },
            { status: 400 },
          );
        }
      } catch {
        return NextResponse.json(
          { error: "Custom base URL must use http(s)." },
          { status: 400 },
        );
      }
    }

    const requestOverrideAi =
      body.apiKey || body.model || body.provider || body.baseUrl
        ? {
            provider: body.provider,
            model: body.model,
            apiKey: body.apiKey,
            baseUrl: body.baseUrl,
          }
        : undefined;
    const llmOptions = requestOverrideAi?.apiKey
      ? requestOverrideAi
      : merchantAi || requestOverrideAi;

    const llmOutput = await callLlm(
      [
        { role: "system", content: MERCHANT_AGENT_SYSTEM_PROMPT },
        ...history.slice(-6).map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: message },
      ],
      llmOptions,
    );

    if (llmOutput) {
      const parsed = extractFencedJson(llmOutput, "json_rules");
      aiReply = sanitizeAssistantReply(
        stripFencedBlock(llmOutput, "json_rules"),
      );
      if (looksLikeToolLeak(aiReply)) aiReply = "";
      if (parsed) {
        const numOrNull = (v: unknown) =>
          typeof v === "number" && !Number.isNaN(v) ? v : undefined;
        llmRules = {
          ...(typeof parsed.enabled === "boolean"
            ? { enabled: parsed.enabled }
            : {}),
          ...(typeof parsed.bulkDiscountEnabled === "boolean"
            ? { bulkDiscountEnabled: parsed.bulkDiscountEnabled }
            : {}),
          ...(numOrNull(parsed.bulkMinQuantity) !== undefined
            ? {
                bulkMinQuantity: Math.max(
                  1,
                  Math.round(parsed.bulkMinQuantity as number),
                ),
              }
            : {}),
          ...(numOrNull(parsed.bulkDiscountBps) !== undefined
            ? {
                bulkDiscountBps: Math.max(
                  0,
                  Math.round(parsed.bulkDiscountBps as number),
                ),
              }
            : {}),
          ...(numOrNull(parsed.maxDiscountBps) !== undefined
            ? {
                maxDiscountBps: Math.max(
                  0,
                  Math.round(parsed.maxDiscountBps as number),
                ),
              }
            : {}),
          ...(numOrNull(parsed.minimumMarginBps) !== undefined
            ? {
                minimumMarginBps: Math.max(
                  0,
                  Math.round(parsed.minimumMarginBps as number),
                ),
              }
            : {}),
          ...(numOrNull(parsed.requireApprovalAboveDiscountBps) !== undefined
            ? {
                requireApprovalAboveDiscountBps: Math.max(
                  0,
                  Math.round(parsed.requireApprovalAboveDiscountBps as number),
                ),
              }
            : {}),
          ...(Array.isArray(parsed.negotiableCategories) &&
          (parsed.negotiableCategories as unknown[]).every(
            (c) => typeof c === "string",
          )
            ? { negotiableCategories: parsed.negotiableCategories as string[] }
            : {}),
          ...(typeof parsed.inventoryInstruction === "string"
            ? { inventoryInstruction: parsed.inventoryInstruction }
            : {}),
        };
      }
    }

    const localParsed = parseInventoryRulesLocally(message, existingRules);

    // Union both extractions — deterministic parser wins on conflicts it detected
    const mergedRules: Partial<MerchantAgentRuleSet> = sanitizeMerchantRules({
      ...llmRules,
      ...localParsed.rules,
    });
    const appliedFields = Array.from(
      new Set([
        ...Object.keys(llmRules).filter((k) => k !== "inventoryInstruction"),
        ...localParsed.appliedFields,
      ]),
    );

    // Cross-questioning: detect intent without the numbers needed to act on it
    const missingFields: string[] = [];
    const wantsDiscountChange =
      /(discount|%|percent|off|cheaper|deal|negotiat)/i.test(message);
    const extractedAnyPercent =
      mergedRules.bulkDiscountBps !== undefined ||
      mergedRules.maxDiscountBps !== undefined ||
      mergedRules.requireApprovalAboveDiscountBps !== undefined;
    if (
      wantsDiscountChange &&
      !extractedAnyPercent &&
      !/approval|approve|margin/i.test(message)
    ) {
      missingFields.push("bulk discount percentage (e.g. '7% off')");
    }
    const mentionsBulk = /bulk|wholesale|volume/i.test(message);
    const extractedQty = mergedRules.bulkMinQuantity !== undefined;
    if (
      mentionsBulk &&
      !extractedQty &&
      !/\d/.test(message.replace(/[.,]/g, ""))
    ) {
      missingFields.push("minimum bulk quantity (e.g. 'from 5 units')");
    }

    const needsMoreInfo = missingFields.length > 0;

    let reply: string;
    if (needsMoreInfo) {
      reply =
        aiReply ||
        `I understood you want to adjust negotiation terms, but I need one more detail: ${missingFields.join(" and ")}.`;
    } else if (appliedFields.length === 0) {
      reply =
        aiReply ||
        `I couldn't map that to any rule yet. Try something like "give 7% off when buyers order at least 5 units", "never exceed 12% discount", "ask for my approval above 10%", or "only negotiate on electronics and audio". Current settings are unchanged.`;
    } else {
      const nextRules: MerchantAgentRuleSet = {
        ...existingRules,
        ...mergedRules,
      };

      await db
        .update(merchants)
        .set({
          config: { ...config, merchantAgentRules: nextRules },
          updated_at: new Date(),
        })
        .where(eq(merchants.id, merchant.id));

      const changes = appliedFields
        .map((field) => {
          switch (field) {
            case "enabled":
              return `agent ${nextRules.enabled ? "activated" : "paused"}`;
            case "bulkDiscountEnabled":
              return `bulk discounts ${nextRules.bulkDiscountEnabled ? "on" : "off"}`;
            case "bulkDiscountBps":
              return `bulk discount → ${(nextRules.bulkDiscountBps / 100).toFixed(1)}%`;
            case "maxDiscountBps":
              return `max discount ceiling → ${(nextRules.maxDiscountBps / 100).toFixed(1)}%`;
            case "requireApprovalAboveDiscountBps":
              return `human approval above ${(nextRules.requireApprovalAboveDiscountBps / 100).toFixed(1)}%`;
            case "bulkMinQuantity":
              return `bulk threshold → ${nextRules.bulkMinQuantity}+ units`;
            case "negotiableCategories":
              return `categories → ${nextRules.negotiableCategories.join(", ")}`;
            default:
              return field;
          }
        })
        .join(", ");

      reply = aiReply
        ? `${aiReply}\n\nSaved: ${changes}.`
        : `Saved: ${changes}. The merchant agent will apply these terms during buyer negotiations.`;
    }

    const freshConfig =
      needsMoreInfo || appliedFields.length === 0
        ? config
        : {
            ...config,
            merchantAgentRules: {
              ...existingRules,
              ...sanitizeMerchantRules(mergedRules),
            },
          };

    return NextResponse.json({
      success: true,
      reply,
      rules: getMerchantAgentRules(freshConfig),
      appliedFields,
      missingFields,
      needsMoreInfo,
    });
  } catch (error) {
    console.error("Error in merchant agent chat:", error);
    return NextResponse.json(
      { error: "Internal error in agent chat." },
      { status: 500 },
    );
  }
}
