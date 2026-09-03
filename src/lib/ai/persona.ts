/**
 * Persona-driven agent communication.
 *
 * When an LLM key is available (buyer key from the simulator UI, or the
 * merchant's saved model in Settings), every inter-agent message in a
 * simulation run is genuinely generated from the live protocol context.
 * The commerce terms themselves stay owned by deterministic code — only
 * the words are AI. Without a key, callers fall back to structured
 * heuristic messages so the platform still works offline.
 */

import { callLlm } from "./llm";
import type { AiConfigInput } from "./provider";

export interface PersonaContext {
  step: string;
  instruction?: string;
  searchQuery?: string;
  quantity?: number;
  budgetCapMinor?: number;
  titles?: string[];
  selectedTitle?: string;
  priceMinor?: number;
  decision?: string;
  discountBps?: number;
  savingsMinor?: number;
  roundsRemaining?: number;
  outcome?: string;
  reasonCodes?: string[];
  cartMandateId?: string;
  paymentMethod?: string;
  upsellOffers?: Array<{
    title: string;
    items: Array<{ title: string; priceInr: number }>;
    addedTotalInr: number;
    savingsInr: number;
  }>;
  upsellCartSubtotalMinor?: number;
}

export interface AgentExchange {
  buyer: string;
  merchant: string;
}

function money(minor: number): string {
  return `₹${(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

const BUYER_SYSTEM = `You ARE an autonomous AI buyer agent (delegated by a human principal via a signed Intent Mandate) negotiating over a structured merchant-commerce protocol.

Rules:
- Speak in first person as the buyer agent. Max 2 sentences. Pragmatic, concise, slightly transactional.
- You MUST respect and reference the mandate facts given to you (budget cap, quantity, product) exactly — never invent different numbers or products.
- No emoji, no markdown, no role prefixes.`;

const MERCHANT_SYSTEM = `You ARE "Nimbus Merchant Agent", the automated sales desk of an electronics storefront, replying to an AI buyer agent over a structured commerce protocol.

Rules:
- First person as the merchant agent. Max 2 sentences. Professional, helpful, commercially precise.
- Reference ONLY the facts given to you (products, prices, ratings, stock). Never invent SKUs, discounts, or prices not provided.
- No emoji, no markdown, no role prefixes.`;

/**
 * Generate one buyer↔merchant exchange for a simulation step using the
 * buyer-side LLM (falls back to null on any failure).
 */
/**
 * Circuit breaker: if the configured model keeps failing/timing out, stop
 * calling it for a cooldown window so simulation runs fall back to the
 * deterministic dialogue instantly instead of hanging on every step.
 */
const BREAKER_THRESHOLD = 2;
const BREAKER_COOLDOWN_MS = 60_000;

const breakerState = globalThis as unknown as {
  __personaBreaker?: { failures: number; disabledUntil: number };
};
const breaker =
  breakerState.__personaBreaker ||
  (breakerState.__personaBreaker = { failures: 0, disabledUntil: 0 });

export function isPersonaDisabled(): boolean {
  return Date.now() < breaker.disabledUntil;
}

export async function generateExchange(
  ctx: PersonaContext,
  llm?: AiConfigInput | null,
): Promise<AgentExchange | null> {
  if (!llm?.apiKey) return null;
  if (isPersonaDisabled()) return null;

  const facts: string[] = [];
  if (ctx.instruction) facts.push(`Shopper instruction: "${ctx.instruction}"`);
  if (ctx.searchQuery)
    facts.push(`Searching catalogue for: ${ctx.searchQuery}`);
  if (ctx.quantity) facts.push(`Quantity needed: ${ctx.quantity}`);
  if (ctx.budgetCapMinor)
    facts.push(`Hard mandate ceiling: ${money(ctx.budgetCapMinor)}`);
  if (ctx.titles?.length)
    facts.push(`Catalogue candidates returned: ${ctx.titles.join("; ")}`);
  if (ctx.selectedTitle)
    facts.push(`Variant being considered: ${ctx.selectedTitle}`);
  if (ctx.priceMinor) facts.push(`List unit price: ${money(ctx.priceMinor)}`);
  if (ctx.decision) facts.push(`Policy gate decision: ${ctx.decision}`);
  if (typeof ctx.discountBps === "number" && ctx.discountBps > 0)
    facts.push(
      `Agreed/countered discount: ${(ctx.discountBps / 100).toFixed(1)}%`,
    );
  if (ctx.savingsMinor && ctx.savingsMinor > 0)
    facts.push(`Line savings: ${money(ctx.savingsMinor)}`);
  if (ctx.roundsRemaining !== undefined)
    facts.push(`Rounds remaining: ${ctx.roundsRemaining}`);
  if (ctx.outcome) facts.push(`Round outcome: ${ctx.outcome}`);
  if (ctx.reasonCodes?.length)
    facts.push(`Reason codes: ${ctx.reasonCodes.join(", ")}`);
  if (ctx.cartMandateId)
    facts.push(`Cart mandate issued: ${ctx.cartMandateId}`);
  if (ctx.paymentMethod) facts.push(`Settlement method: ${ctx.paymentMethod}`);
  if (ctx.upsellOffers && ctx.upsellOffers.length > 0) {
    const best = ctx.upsellOffers[0];
    facts.push(
      `Merchant offers upsell combo: "${best.title}" — items: ${best.items.map((i) => `${i.title} ₹${i.priceInr.toFixed(2)}`).join(", ")} — add-on total ₹${best.addedTotalInr.toFixed(2)}${best.savingsInr > 0 ? `, saves ₹${best.savingsInr.toFixed(2)}` : ""}`,
    );
    if (ctx.upsellCartSubtotalMinor)
      facts.push(`Current cart subtotal: ${money(ctx.upsellCartSubtotalMinor)}`);
  }

  const prompt = ctx.step === "upsell_suggestion"
    ? `Protocol step: ${ctx.step}
${facts.join("\n")}

Write ONE short line the merchant agent says to suggest the combo deal (mention specific products and savings), then ONE short line the buyer agent says to present it to the human user and ask if they want to add the items. Output exactly this fenced format:

\`\`\`exchange
MERCHANT: <merchant line suggesting the combo>
BUYER: <buyer line asking the user>
\`\`\``
    : `Protocol step: ${ctx.step}
${facts.join("\n")}

Write ONE short line the buyer agent says at this step, then ONE short line the merchant agent replies with. Output exactly this fenced format:

\`\`\`exchange
BUYER: <buyer line>
MERCHANT: <merchant line>
\`\`\``;

  const out = await callLlm(
    [
      { role: "system", content: BUYER_SYSTEM },
      {
        role: "system",
        content: MERCHANT_SYSTEM,
      },
      { role: "user", content: prompt },
    ],
    { ...llm, temperature: 0.6, timeoutMs: 8_000 },
  );

  if (!out) {
    breaker.failures += 1;
    if (breaker.failures >= BREAKER_THRESHOLD) {
      breaker.disabledUntil = Date.now() + BREAKER_COOLDOWN_MS;
      breaker.failures = 0;
    }
    return null;
  }

  breaker.failures = 0;

  const buyerMatch = out.match(/BUYER:\s*([\s\S]*?)(?:\n|MERCHANT:)/i);
  const merchantMatch = out.match(/MERCHANT:\s*([\s\S]*?)(?:\n|$)/i);
  const buyer = buyerMatch?.[1]?.trim();
  const merchant = merchantMatch?.[1]?.trim();
  if (!buyer || !merchant) return null;

  return {
    buyer: buyer.replace(/^["']|["']$/g, "").slice(0, 320),
    merchant: merchant.replace(/^["']|["']$/g, "").slice(0, 320),
  };
}
