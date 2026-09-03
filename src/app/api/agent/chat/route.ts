import { type NextRequest, NextResponse } from "next/server";
import { SHOPPING_PLANNER_SYSTEM_PROMPT } from "@/lib/agent/prompts";
import { AGENT_ALLOWED_TOOLS } from "@/lib/agent/tools";
import {
  callLlm,
  extractFencedJson,
  looksLikeToolLeak,
  sanitizeAssistantReply,
  stripFencedBlock,
} from "@/lib/ai/llm";
import { rateLimitRequest } from "@/lib/auth/rate-limit";

export const dynamic = "force-dynamic";

interface ExtractedMandateState {
  instruction: string;
  searchQuery: string;
  budgetInr: number | null;
  budgetTolerancePercent: number;
  category: string | null;
  quantity: number;
  minRating: number | null;
  isMandateComplete: boolean;
  missingRequired: string[];
}

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  keyboard: ["electronics"],
  mouse: ["electronics"],
  headphone: ["audio"],
  earphone: ["audio"],
  audio: ["audio"],
  anc: ["audio"],
  stand: ["accessories"],
  riser: ["accessories"],
  holder: ["accessories"],
  laptop: ["computers"],
  monitor: ["electronics"],
};

/**
 * Affirmative/confirmation replies that continue an open mandate conversation
 * without introducing a new shopping request — e.g. "go ahead", "yes", "buy
 * it". These must be treated as purchase intent (not as a greeting) so a
 * ready mandate can be acknowledged and executed rather than reset.
 */
export const PROCEED_AFFIRMATION_RE =
  /^\s*(?:yes|yeah|yep|yup|ya|sure|ok|okay|k|go|go ahead|go for it|proceed|confirmed?|confirm|buy (?:it|now)|do it|run it|execute|make it happen|sounds good|looks good|affirmative|please (?:do|proceed|go ahead)|let'?s (?:do it|go)|fine)\b/i;

/**
 * A shopping-intent detector used to gate whether a user message should drive
 * the mandate/order flow at all. Casual greetings ("hello", "hi", "thanks"),
 * chit-chat or empty small-talk must NOT be treated as a purchase intent — we
 * must never derive a product name or money values from an unrelated message.
 *
 * Let through messages that reference buying language, a budget, a quantity,
 * or a recognisable product noun. A short affirmative reply to our own
 * clarifying question ("5000", "keyboard") is also treated as intent because
 * it continues an already-open mandate conversation.
 */
export function isShoppingIntent(text: string): boolean {
  const t = text.trim();
  if (!t) return false;

  // A standalone greeting / pleasantry is never a purchase intent.
  if (
    /^(?:hi+|he(?:y+|llo)|yo+|howdy|namaste?|hola|good\s*(?:morning|afternoon|evening|day)|thanks?(?:\s+you)?|thank you|ty|bye+|goodbye|hello there)\b/i.test(
      t,
    )
  ) {
    return false;
  }

  const productNoun =
    Object.keys(CATEGORY_KEYWORDS).some((kw) => t.toLowerCase().includes(kw)) ||
    /\b(earbuds?|airpods?|headphones?|speakers?|chargers?|cables?|keycaps?|switch(?:es)?|monitor|webcam|mic(?:rophone)?|router|ssd|hdd|ram|gpu|cpu|motherboard|laptops?|tablets?|phone|smartphone|adapter|dock|hub|bag|case|cover)\b/i.test(
      t,
    );

  const shoppingVerbs =
    /(buy|purchase|order|get|grab|procure|need|want|find|search|look(?:ing)?\s*(?:for|to)?|add(?: to (?:cart|basket))?|shop(?:ping)?|quote|procure)/i;

  const moneyOrQty =
    /(budget|spend|under|below|max(?:imum)?|up to|within|cap|₹|rs\.?|rupees|inr|lakhs?|lacs?|crores?|crs?|\bbulk\b|wholesale|qty|quantity|units?|pieces?|pcs|\d+\s*x\b|stars?|rating)/i;

  // A bare short reply (number, possibly with an Indian money unit — "5000",
  // "₹12,000", "7 lakh") or single keyword answers our clarifying question and
  // continues an active mandate conversation.
  const isClarifyingReply =
    /^\s*(?:₹?\s*\d[\d,.]*\s*(?:k|thousand|lakhs?|lacs?|crores?|crs?)?|\b[a-z][a-z-]{2,}\b)\s*$/i.test(
      t,
    );

  return Boolean(
    productNoun ||
      shoppingVerbs.test(t) ||
      moneyOrQty.test(t) ||
      isClarifyingReply ||
      PROCEED_AFFIRMATION_RE.test(t),
  );
}

/**
 * Convert a parsed "number + unit" pair into rupees as the user wrote them.
 * Handles Indian units (lakh/crore) plus k/thousand. A missing unit is a plain
 * number already in rupees. Commas in Indian grouping ("7,00,000") are ignored.
 */
export function applyIndianUnit(value: string, unit: string): number {
  const base = Number(value.replace(/,/g, ""));
  if (Number.isNaN(base)) return NaN;
  if (/^(?:lakhs?|lacs?)$/i.test(unit)) return base * 100_000;
  if (/^(?:crores?|crs?)$/i.test(unit)) return base * 10_000_000;
  if (/^(?:k|thousand)$/i.test(unit)) return base * 1_000;
  return base;
}

/**
 * Deterministic parameter extractor used as fallback when no LLM key is
 * configured (or the provider fails). Parses budget, product, quantity,
 * rating, and category out of free-form text.
 */
export function parseShoppingParams(
  text: string,
  current: ExtractedMandateState,
): ExtractedMandateState {
  const lower = text.toLowerCase();

  // A short numeric-only reply is an answer to our clarifying question.
  // Decide what it answers based on what's currently missing.
  const bareNumberMatch = text.match(
    /^\s*₹?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:k|thousand|lakhs?|lacs?|crores?|crs?)?\s*$/i,
  );
  const mentionsProduct =
    Object.keys(CATEGORY_KEYWORDS).some((kw) => lower.includes(kw)) ||
    /(sku|variant|keyboard|mouse|laptop|monitor|stand)/i.test(lower);

  let searchQuery = current.searchQuery || "";
  let category = current.category || null;
  let budgetInr = current.budgetInr;

  if (!mentionsProduct && bareNumberMatch && !current.searchQuery) {
    // They answered the product question with a number → treat as product-less; can't infer.
    searchQuery = "";
  }

  // --- Budget ---
  // Indian number words are matched FIRST and win over the bare "under N" /
  // "within N" captures. Without this, "under 7 lakhs" would parse as ₹7
  // (the "lakhs"/"crore" multiplier would be silently dropped).
  const indianUnitMatch = text.match(
    /₹?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(lakhs?|lacs?|crores?|crs?)\b/i,
  );
  const kSuffix = text.match(/₹?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*k\b/i);
  const thousandSuffix = text.match(
    /₹?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*thousand\b/i,
  );
  const explicitBudget =
    text.match(
      /(?:under|below|max|budget|within|cap|upto|up to)\s*[:=]?\s*₹?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i,
    ) ||
    text.match(/₹\s*([0-9][0-9,]*(?:\.[0-9]+)?)/) ||
    text.match(/([0-9][0-9,]*)\s*(?:rs\.?|inr|rupees|bucks)/i);

  if (indianUnitMatch) {
    budgetInr = applyIndianUnit(indianUnitMatch[1], indianUnitMatch[2]);
  } else if (kSuffix) {
    budgetInr = applyIndianUnit(kSuffix[1], "k");
  } else if (thousandSuffix) {
    budgetInr = applyIndianUnit(thousandSuffix[1], "thousand");
  } else if (explicitBudget) {
    budgetInr = Number(explicitBudget[1].replace(/,/g, ""));
  } else if (
    !mentionsProduct &&
    bareNumberMatch &&
    current.searchQuery &&
    !current.budgetInr
  ) {
    // Answering the budget question with "5000", "₹12,000", or "7 lakh"
    budgetInr = applyIndianUnit(bareNumberMatch[1], bareNumberMatch[2] || "");
  }
  if (budgetInr !== null && (Number.isNaN(budgetInr) || budgetInr <= 0))
    budgetInr = null;

  // --- Product / search query ---
  if (mentionsProduct || !bareNumberMatch) {
    for (const [keyword, categories] of Object.entries(CATEGORY_KEYWORDS)) {
      if (lower.includes(keyword)) {
        searchQuery = keyword === "anc" ? "audio" : keyword;
        category = category || categories[0];
        break;
      }
    }
  }

  if (!searchQuery && text.trim().length > 2 && !bareNumberMatch) {
    const cleaned = text
      .replace(
        /(?:buy|purchase|order|get|find|me|please|i\s+(?:want|need)|a|an|the|some|new|under|below|for|with|around|about|budget|max|of|and|at\s+least|minimum|bulk|wholesale|quantity|qty|units?|pieces?|pcs|x\b)/gi,
        " ",
      )
      .replace(/[₹0-9,.]+/g, "")
      .replace(/\s+/g, " ")
      .trim();

    // A message that only contained intent verbs ("I want to buy", "please
    // order") carries no product noun — do NOT explode it into a fake product.
    if (/\b[a-z]{2,}\b/i.test(cleaned)) {
      searchQuery = cleaned.slice(0, 40);
    }
  }

  // --- Quantity (incl. bulk phrasing) ---
  const qtyMatch =
    text.match(/\b(\d+)\s*(?:x|×)\b/i) ||
    text.match(/\b(?:quantity|qty|count)\s*[:=]?\s*(\d+)/i) ||
    text.match(/\bbulk\s*(?:order\s*)?(?:of\s*)?(\d+)/i) ||
    text.match(/\b(\d+)\s*(?:units?|pieces?|pcs|nos)\b/i) ||
    // Number + up to three adjective words + product noun ("5 mechanical keyboards")
    text.match(
      /\b(\d+)\s+(?:[a-z][a-z-]*\s+){0,3}?(?:keyboards?|mice|mouse|headphones?|earphones?|stands?|risers?|holders?|laptops?|monitors?)\b/i,
    ) ||
    text.match(
      /\b(\d+)\s*(?:keyboards?|mice|mouse|headphones?|earphones?|stands?|risers?|holders?|laptops?|monitors?)\b/i,
    );

  let quantity = qtyMatch
    ? Math.max(1, parseInt(qtyMatch[1], 10))
    : current.quantity;
  const saysBulkButNoQty = /\b(bulk|wholesale|in volume|lots of|many)\b/i.test(
    lower,
  );
  if (saysBulkButNoQty && !qtyMatch && current.quantity <= 1) {
    quantity = 1; // flagged below via missingQuantity
  }

  // --- Rating filter ---
  const ratingMatch =
    lower.match(
      /(?:rated?|rating|stars?)\s*(?:above|over|at least|>=|of)?\s*([0-5](?:\.[0-9])?)/,
    ) ||
    lower.match(/([0-5](?:\.[0-9])?)\s*\+\s*(?:stars?|rating)?/) ||
    lower.match(/([0-5](?:\.[0-9])?)\s*(?:and above|or better)\s*(?:stars?)?/);
  const minRating = ratingMatch
    ? Math.min(5, Math.max(0, Number(ratingMatch[1])))
    : current.minRating;

  const instruction =
    text.trim().length > 5 && !bareNumberMatch
      ? text.trim()
      : current.instruction;

  return {
    instruction: instruction || `Purchase ${searchQuery}`,
    searchQuery,
    budgetInr,
    budgetTolerancePercent: current.budgetTolerancePercent || 10,
    category,
    quantity,
    minRating,
    isMandateComplete: false,
    missingRequired: [],
  };
}

function computeMissing(state: ExtractedMandateState): string[] {
  const missing: string[] = [];
  if (!state.searchQuery) missing.push("searchQuery");
  if (!state.budgetInr || state.budgetInr <= 0) missing.push("budgetInr");
  return missing;
}

/**
 * Clamp every consumer-controlled number to a safe production range so an LLM
 * can never inject an absurd budget/quantity that would auto-settle an order or
 * trivially pass policy. These hard bounds are a final line of defence on top
 * of the deterministic parser.
 */
function clampMandate(state: ExtractedMandateState): ExtractedMandateState {
  const MAX_BUDGET_INR = 100_000_000; // ₹10 crore hard cap
  const MIN_BUDGET_INR = 1;
  const MAX_QUANTITY = 100_000;
  const MAX_TOLERANCE_PERCENT = 100;
  const MAX_RATING = 5;

  const budgetInr =
    state.budgetInr === null
      ? null
      : Math.min(MAX_BUDGET_INR, Math.max(MIN_BUDGET_INR, state.budgetInr));

  return {
    ...state,
    searchQuery: (state.searchQuery || "").trim().slice(0, 80),
    budgetInr,
    budgetTolerancePercent: Math.min(
      MAX_TOLERANCE_PERCENT,
      Math.max(0, Number(state.budgetTolerancePercent) || 10),
    ),
    category: state.category || null,
    quantity: Math.min(
      MAX_QUANTITY,
      Math.max(1, Math.round(Number(state.quantity) || 1)),
    ),
    minRating:
      state.minRating === null
        ? null
        : Math.min(MAX_RATING, Math.max(0, Number(state.minRating))),
  };
}

interface CatalogProduct {
  variantId: string;
  title: string;
  category: string;
  rating?: { average?: number; count?: number };
  discoveryPrice?: { amountMinor: number; currency: string };
  availability?: { status: string };
  returnable?: boolean;
}

/**
 * Pre-fetch the merchant's own catalogue for the query + budget so the planner
 * can reply with a concrete, up-to-date list of available products instead of
 * an empty/abstract mandate. Called server-to-server against the same host.
 * Never throws: a failed lookup degrades gracefully to an empty list.
 */
async function fetchCatalogProducts(
  origin: string,
  query: string,
  opts: { maxAmountMinor?: number; quantity?: number; category?: string } = {},
): Promise<CatalogProduct[]> {
  try {
    const params = new URLSearchParams({ q: query, limit: "20" });
    if (opts.category) params.set("category", opts.category);
    if (opts.maxAmountMinor)
      params.set("maxPrice", String(opts.maxAmountMinor));
    const res = await fetch(`${origin}/v1/agent/catalog?${params.toString()}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: CatalogProduct[] };
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}

function formatProductList(
  products: CatalogProduct[],
  budgetMinor: number,
): string {
  if (products.length === 0) return "";
  const lines = products.map((p, i) => {
    const price = (p.discoveryPrice?.amountMinor ?? 0) / 100;
    const inBudget = p.discoveryPrice
      ? p.discoveryPrice.amountMinor <= budgetMinor
      : true;
    const rating = p.rating?.average
      ? ` · ${p.rating.average}/5 (${p.rating.count ?? 0} reviews)`
      : "";
    const avail =
      p.availability?.status === "out_of_stock"
        ? ` · out of stock`
        : p.availability?.status === "limited"
          ? " · low stock"
          : "";
    return `${i + 1}. ${p.title} — ₹${price.toLocaleString("en-IN")}${inBudget ? "" : " (over budget)"}${rating}${avail}`;
  });
  return `Available products matching your request:\n${lines.join("\n")}`;
}

export async function POST(request: NextRequest) {
  // This endpoint is unauthenticated yet drives the LLM (falling back to the
  // merchant's stored/env model key when the client sends none). Rate-limit per
  // IP so an attacker cannot exhaust the merchant's AI quota or spend unbounded
  // tokens.
  const limited = rateLimitRequest(request, {
    namespace: "agent-chat",
    limit: Number(process.env.RATE_LIMIT_AGENT_CHAT) || 30,
  });
  if (limited) return limited;

  try {
    const body = await request.json();
    const {
      messages = [],
      apiKey,
      openRouterApiKey,
      model,
      provider,
      baseUrl,
      currentMandate,
    } = body;
    // Accept both the new generic field and the legacy openRouterApiKey name
    const buyerApiKey = apiKey || openRouterApiKey;

    const lastUserMessage = String(
      messages[messages.length - 1]?.content || "",
    );

    // Same-host origin used for the merchant catalogue pre-fetch.
    const requestOrigin = (() => {
      try {
        return new URL(request.url).origin;
      } catch {
        return "http://localhost:3000";
      }
    })();

    let extractedState: ExtractedMandateState = currentMandate || {
      instruction: "",
      searchQuery: "",
      budgetInr: null,
      budgetTolerancePercent: 10,
      category: null,
      quantity: 1,
      minRating: null,
      isMandateComplete: false,
      missingRequired: ["budgetInr", "searchQuery"],
    };

    // Normalise + clamp whatever the client forwarded so subsequent logic
    // always operates on well-typed, bounded values.
    extractedState = clampMandate({
      ...extractedState,
      quantity: Number(extractedState.quantity) || 1,
      budgetInr:
        extractedState.budgetInr != null
          ? Number(extractedState.budgetInr)
          : null,
    });

    // --- Purchase-intent gate ---
    // Casual greetings, chit-chat, or unrelated messages must never build,
    // mutate, or complete a mandate, and must never be interpreted as a
    // product name or a money value. Only real purchase intent (buying
    // language, a product noun, a budget/quantity, or a reply to our open
    // clarifying question) moves the conversation toward an order. We also
    // deliberately do NOT treat a client-prefilled form as "already known"
    // for a greeting: the returned mandate is built from the actual
    // conversation, not from an unrelated message or a pre-filled form.

    // Confirmation short-circuit: when the user affirms an already-ready
    // mandate ("go ahead", "yes", "buy it"), return the mandate UNCHANGED so
    // the caller can execute the run immediately. We must never re-parse the
    // affirmation as a fresh shopping request (that would wipe the mandate and
    // fall through to the greeting reply: "Hi! I'm your shopping planner…").
    const isConfirmation = PROCEED_AFFIRMATION_RE.test(lastUserMessage);
    const mandateReady =
      Boolean(extractedState.searchQuery?.trim()) &&
      (extractedState.budgetInr ?? 0) > 0 &&
      extractedState.isMandateComplete === true;

    if (isConfirmation && mandateReady) {
      return NextResponse.json({
        reply:
          "Confirmed — executing your mandate now. I'll run the buyer agent to discover the merchant, negotiate terms, and settle within policy.",
        mandate: {
          ...extractedState,
          isMandateComplete: true,
          missingRequired: [],
          instruction: extractedState.instruction || lastUserMessage,
        },
        tools: AGENT_ALLOWED_TOOLS.map((t) => t.name),
      });
    }

    const hasPurchaseIntent = isShoppingIntent(lastUserMessage);

    if (!hasPurchaseIntent) {
      const cleanBaseline: ExtractedMandateState = {
        instruction: "",
        searchQuery: "",
        budgetInr: null,
        budgetTolerancePercent: extractedState.budgetTolerancePercent || 10,
        category: null,
        quantity: 1,
        minRating: null,
        isMandateComplete: false,
        missingRequired: ["searchQuery", "budgetInr"],
      };
      return NextResponse.json({
        reply:
          "Hi! I'm your shopping planner. I can build a verifiable purchase order for you.\n\nTo get started, tell me what you'd like to buy and your budget — for example: \"Buy 5 mechanical keyboards for the office under ₹20,000\". I won't create anything until you've told me a product and a budget.",
        mandate: cleanBaseline,
        tools: AGENT_ALLOWED_TOOLS.map((t) => t.name),
      });
    }

    // --- Deterministic parse first (source of truth for money/quantity) ---
    // We parse against the *previous* state (NOT the LLM-extracted one) so any
    // explicit number the user just typed always wins over anything the model
    // might have hallucinated in this same turn.
    const heuristicParsed = parseShoppingParams(lastUserMessage, {
      ...extractedState,
    });
    const heuristicExplicit = {
      budget: heuristicParsed.budgetInr !== extractedState.budgetInr,
      quantity: heuristicParsed.quantity !== extractedState.quantity,
      search: heuristicParsed.searchQuery !== extractedState.searchQuery,
      rating: heuristicParsed.minRating !== extractedState.minRating,
    };

    let aiReplyText = "";

    const systemPrompt = `${SHOPPING_PLANNER_SYSTEM_PROMPT}

You MUST analyze the conversation and do two things:
1. Reply helpfully. If any REQUIRED parameter is still unknown, ask ONE concise clarifying question covering everything missing.
2. Output the currently-known mandate parameters in a fenced block tagged json_mandate:

\`\`\`json_mandate
{
  "instruction": "natural language purchase instruction",
  "searchQuery": "concise product keywords or empty string",
  "budgetInr": number or null,
  "budgetTolerancePercent": number (default 10),
  "category": "electronics" | "audio" | "accessories" | "computers" | null,
  "quantity": integer (default 1),
  "minRating": number or null
}
\`\`\`

REQUIRED parameters you must obtain before a mandate can be built: product (searchQuery), maximum budget in INR (budgetInr).
If the user says they want to buy "in bulk" without a count, ask how many units.
Carry forward previously extracted values unless the user changes them.
STRICT RULE: Only echo back numbers (budget, quantity, rating, tolerance) that the USER explicitly stated. Never invent or round budget, quantity, rating, or price figures. If the user did not specify a number, use null (for optional) or exactly the carried-forward value.
STRICT RULE: You must NOT emit any tool/function call JSON (no tool_calls, no {"name":...} / {"function":...} / {"arguments":...}), and the ONLY fenced block allowed is the \`\`\`json_mandate\`\`\` above. Reply in plain prose plus exactly that one fence. Tool JSON leaking into the chat is a hard failure.`;

    const llmOutput = await callLlm(
      [
        { role: "system", content: systemPrompt },
        ...messages.map((m: { role: string; content: string }) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      ],
      { apiKey: buyerApiKey, model, provider, baseUrl, timeoutMs: 12_000 },
    );

    if (llmOutput) {
      const parsed = extractFencedJson(llmOutput, "json_mandate");
      // Sanitize the model's prose before showing it: drop stray code fences
      // and any tool-call JSON the model leaked into the chat text. If nothing
      // usable remains we fall back to the deterministic reply below.
      aiReplyText = sanitizeAssistantReply(
        stripFencedBlock(llmOutput, "json_mandate"),
      );
      if (looksLikeToolLeak(aiReplyText)) aiReplyText = "";

      if (parsed) {
        const num = (v: unknown): number | null =>
          typeof v === "number" && !Number.isNaN(v) ? v : null;
        const llmBudget = num(parsed.budgetInr);
        const priorBudget = extractedState.budgetInr;

        // Anti-hallucination guard for budget: a model-invented figure is only
        // trusted when it matches a previously-confirmed value (carry-forward)
        // or the deterministic parser confirmed an explicit budget this turn.
        // Otherwise treat it as "still unknown" so the flow asks for it.
        const budgetAccepted =
          heuristicExplicit.budget ||
          (llmBudget !== null && llmBudget === priorBudget);

        // LLM only supplies values the deterministic parser did NOT explicitly
        // extract this turn. Deterministic wins on every conflict.
        const llmState = clampMandate({
          instruction:
            (typeof parsed.instruction === "string" && parsed.instruction) ||
            extractedState.instruction ||
            lastUserMessage,
          searchQuery: heuristicExplicit.search
            ? heuristicParsed.searchQuery
            : (typeof parsed.searchQuery === "string" &&
                parsed.searchQuery.trim()) ||
              extractedState.searchQuery ||
              "",
          budgetInr: budgetAccepted ? (llmBudget ?? priorBudget) : priorBudget,
          budgetTolerancePercent: heuristicExplicit.budget
            ? heuristicParsed.budgetTolerancePercent
            : (num(parsed.budgetTolerancePercent) ??
              extractedState.budgetTolerancePercent ??
              10),
          category:
            (typeof parsed.category === "string" && parsed.category) ||
            extractedState.category ||
            null,
          quantity: heuristicExplicit.quantity
            ? heuristicParsed.quantity
            : Math.max(1, num(parsed.quantity) ?? extractedState.quantity ?? 1),
          minRating: heuristicExplicit.rating
            ? heuristicParsed.minRating
            : (num(parsed.minRating) ?? extractedState.minRating ?? null),
          isMandateComplete: false,
          missingRequired: [],
        });

        extractedState = clampMandate(llmState);
      }
    }

    // Deterministic parser still fills any remaining gaps and is authoritative
    // on this turn's explicit numbers.
    extractedState = clampMandate({
      ...extractedState,
      ...heuristicParsed,
      searchQuery: heuristicParsed.searchQuery || extractedState.searchQuery,
      budgetInr: heuristicParsed.budgetInr ?? extractedState.budgetInr,
      category: heuristicParsed.category || extractedState.category,
      quantity: heuristicParsed.quantity,
      minRating: heuristicParsed.minRating,
      instruction: heuristicParsed.instruction || extractedState.instruction,
    });

    // Guaranteed cross-questioning: never let a missing required field slide
    const missing = computeMissing(extractedState);
    const bulkNoQty =
      /\b(bulk|wholesale)\b/i.test(lastUserMessage) &&
      extractedState.quantity <= 1 &&
      !/\d/.test(lastUserMessage.replace(/[₹0-9,]*\s*(?:rs|inr)/gi, ""));

    if (missing.length > 0 || bulkNoQty) {
      const questions: string[] = [];
      if (missing.includes("searchQuery"))
        questions.push(
          'which product should I search for (e.g. "mechanical keyboard")',
        );
      if (missing.includes("budgetInr"))
        questions.push("your maximum budget in ₹ INR");
      if (bulkNoQty)
        questions.push("how many units you need for the bulk order");

      const clarifier = `To build your verifiable Intent Mandate I still need ${questions.join(" and ")}.`;
      aiReplyText = aiReplyText ? `${aiReplyText}\n\n${clarifier}` : clarifier;
    } else {
      const budget = extractedState.budgetInr || 0;
      const cap = budget * (1 + extractedState.budgetTolerancePercent / 100);
      const mandateSummary = `Mandate ready: ${extractedState.quantity} x "${extractedState.searchQuery}" with a ₹${budget.toLocaleString("en-IN")} budget (±${extractedState.budgetTolerancePercent}% cap ≈ ₹${cap.toLocaleString("en-IN")})${extractedState.minRating ? `, minimum rating ${extractedState.minRating}/5` : ""}.`;

      // Pre-call the merchant catalogue so the buyer is shown the concrete,
      // currently-available options (not an empty/abstract reply).
      const catalogProducts = await fetchCatalogProducts(
        requestOrigin,
        String(extractedState.searchQuery || ""),
        {
          maxAmountMinor: Math.round(cap * 100),
          category: extractedState.category || undefined,
        },
      );
      const productList = formatProductList(
        catalogProducts,
        Math.round(cap * 100),
      );

      aiReplyText = aiReplyText
        ? `${aiReplyText}\n\n${mandateSummary}${productList ? `\n\n${productList}` : ""}\nSay "go ahead" and I'll execute the run automatically.`
        : `${mandateSummary}${productList ? `\n\n${productList}` : ""}\nSay "go ahead" and I'll execute the run automatically.`;
    }

    extractedState.missingRequired = missing;
    extractedState.isMandateComplete = missing.length === 0 && !bulkNoQty;

    return NextResponse.json({
      reply: aiReplyText,
      mandate: extractedState,
      tools: AGENT_ALLOWED_TOOLS.map((t) => t.name),
    });
  } catch (error) {
    console.error("Error in agent chat planner:", error);
    return NextResponse.json(
      { error: "Failed to process chat message" },
      { status: 500 },
    );
  }
}
