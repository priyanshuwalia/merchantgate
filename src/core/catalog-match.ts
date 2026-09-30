/**
 * Merchant catalogue matching core — pure, deterministic product relevance.
 *
 * This is the "find the right product" boundary. Agent gateways used to hand a
 * buyer agent a bag of `%query%` SQL matches in whatever order Postgres
 * happened to return them, which let an accessory win the race against the
 * thing that was actually asked for — a search for "headphones" could settle on
 * "Aluminum Headphone Stand with USB Hub" because the row came back first.
 *
 * Two rules make substitution impossible rather than merely unlikely:
 *
 *  1. A query's HEAD NOUN is the product being asked for. When that noun only
 *     ever appears in a candidate title as the *modifier* of a known accessory
 *     head noun ("headphone" → "… Headphone **Stand**"), the candidate is a
 *     COMPLEMENT for the request, never the request itself.
 *  2. Only `exact` / `compatible` verdicts are `selectable`. Auto-selection is
 *     fail-closed: when nothing clears the bar the answer is "no match", not
 *     "here is the cheapest thing in the store".
 *
 * No Next.js, no DB, no I/O — unit-testable in isolation.
 */

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type CatalogMatchInput = {
  variantId: string;
  title: string;
  category?: string | null;
  description?: string | null;
  /** Present when the caller has pricing/stock on hand; used for tie-breaks. */
  basePriceMinor?: number | null;
  inStock?: boolean;
};

export type MatchVerdict =
  /** Every query token is in the title and the head noun is the product. */
  | "exact"
  /** Some query tokens are in the title; the head noun is the product. */
  | "compatible"
  /** The query only matches as a modifier of an accessory head noun. */
  | "accessory"
  /** Matched only through description / category / variant id. */
  | "weak"
  /** Nothing meaningful matched. */
  | "unrelated";

export type CatalogMatch<T> = {
  item: T;
  verdict: MatchVerdict;
  /** Higher is more relevant. May be negative (accessories rank last). */
  score: number;
  /** May an autonomous agent pick this for the query? Fail-closed gate. */
  selectable: boolean;
  matchedTokens: string[];
  reason: string;
};

export type RankOptions = {
  /** Hard category constraint from the buyer's mandate. */
  category?: string | null;
};

// ----------------------------------------------------------------------------
// Tokenisation
// ----------------------------------------------------------------------------

/** Words that carry no product identity ("for", "with", "under", "best"…). */
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "for",
  "with",
  "without",
  "to",
  "in",
  "on",
  "at",
  "by",
  "from",
  "is",
  "are",
  "be",
  "me",
  "my",
  "i",
  "we",
  "it",
  "under",
  "below",
  "above",
  "up",
  "to",
  "upto",
  "within",
  "cheap",
  "cheaper",
  "cheapest",
  "best",
  "good",
  "great",
  "nice",
  "new",
  "any",
  "some",
  "all",
  "get",
  "buy",
  "purchase",
  "need",
  "want",
  "please",
  "quality",
  "budget",
  "price",
  "rupees",
  "inr",
  "rs",
]);

/**
 * Head nouns that mark a SKU as a COMPLEMENT for another product rather than
 * the product itself. Deliberately narrow: every entry is a noun that only
 * makes sense as "<requested product> <this>" in a title.
 */
const ACCESSORY_HEAD_NOUNS = new Set([
  "stand",
  "holder",
  "case",
  "cover",
  "sleeve",
  "cable",
  "cord",
  "adapter",
  "mount",
  "arm",
  "charger",
  "dock",
  "hub",
  "mat",
  "rest",
  "bag",
  "pouch",
  "kit",
  "strap",
  "clip",
  "hook",
  "protector",
  "skin",
  "organizer",
  "rack",
  "cleaner",
  "cleaning",
  "wipe",
  "wipes",
  "replacement",
  "tip",
  "tips",
  "earbud",
  "earbud",
  "eartip",
  "cushion",
  "headband",
  "lanyard",
  "plug",
  "socket",
  "extension",
  "converter",
  "tester",
  "film",
  "glass",
  "screen",
  "keycap",
  "keycaps",
  "knob",
  "handle",
  "screw",
  "screws",
  "mounting",
  "replacement",
  "spare",
  "pads",
  "pad",
  "grip",
  "holder",
  "insert",
]);

/** Light, deterministic English stemmer — enough to fold plural SKUs. */
export function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ies"))
    return `${token.slice(0, -3)}y`;
  if (token.length > 4 && /(?:ss|ch|sh|x|z)es$/.test(token)) {
    return token.slice(0, -2);
  }
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

export function normalizeText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Normalised, stop-worded, stemmed tokens. Deterministic and order-stable.
 * Digit-only tokens ("8k", "2024") carry no product identity and are dropped —
 * they are budget hints, not catalogue terms.
 */
export function tokenize(value: unknown): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((t) => t.length > 1 && !STOPWORDS.has(t) && /^[a-z]/.test(t))
    .map(stem);
}

function lastIndexOfToken(tokens: string[], token: string): number {
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i] === token) return i;
  }
  return -1;
}

// ----------------------------------------------------------------------------
// Scoring
// ----------------------------------------------------------------------------

const SCORE_EXACT = 600;
const SCORE_COMPATIBLE = 300;
const SCORE_PARTIAL_TOKEN = 10;
const SCORE_SUPPORT_TOKEN = 5;
const SCORE_SUPPORT_ONLY = 40;
const BONUS_EXACT_PHRASE = 200;
const BONUS_PHRASE = 120;
const BONUS_LEAD_TOKEN = 40;
const SCORE_ACCESSORY = -1000;

/**
 * Score one catalogue item against a buyer query. Pure — same inputs always
 * produce the same verdict, score and reason.
 */
export function scoreCatalogMatch<T extends CatalogMatchInput>(
  query: string,
  item: T,
): CatalogMatch<T> {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) {
    return {
      item,
      verdict: "unrelated",
      score: 0,
      selectable: false,
      matchedTokens: [],
      reason: "EMPTY_QUERY_NO_MATCH_SIGNAL",
    };
  }

  const titleTokens = tokenize(item.title);
  const supportTokens = new Set([
    ...tokenize(item.description),
    ...tokenize(item.category),
    ...tokenize(item.variantId),
  ]);

  // The head noun is the last meaningful token of the query: "wireless
  // headphones" → "headphone". Its position in the title decides whether the
  // candidate IS that product or merely a complement FOR it.
  const head = qTokens[qTokens.length - 1];
  const headIdx = lastIndexOfToken(titleTokens, head);
  const isAccessory =
    headIdx >= 0 && ACCESSORY_HEAD_NOUNS.has(titleTokens[headIdx + 1] ?? "");

  const titleHits = qTokens.filter((t) => titleTokens.includes(t));
  const supportHits = qTokens.filter(
    (t) => !titleHits.includes(t) && supportTokens.has(t),
  );

  let verdict: MatchVerdict;
  let score: number;
  let reason: string;

  if (isAccessory) {
    verdict = "accessory";
    score = SCORE_ACCESSORY;
    reason = `COMPLEMENT_FOR_REQUEST (${head} only qualifies the "${titleTokens[headIdx + 1]}")`;
  } else if (titleHits.length === qTokens.length) {
    verdict = "exact";
    score = SCORE_EXACT + titleHits.length * SCORE_PARTIAL_TOKEN;
    reason = "TITLE_MATCHES_FULL_QUERY";
  } else if (titleHits.length > 0) {
    verdict = "compatible";
    score = SCORE_COMPATIBLE + titleHits.length * SCORE_PARTIAL_TOKEN;
    reason = "TITLE_MATCHES_PARTIAL_QUERY";
  } else if (supportHits.length > 0) {
    verdict = "weak";
    score = supportHits.length * SCORE_SUPPORT_ONLY;
    reason = "MATCHED_ONLY_VIA_METADATA";
  } else {
    verdict = "unrelated";
    score = 0;
    reason = "NO_RELEVANT_MATCH";
  }

  if (verdict === "exact" || verdict === "compatible") {
    const phrase = qTokens.join(" ");
    const titlePhrase = titleTokens.join(" ");
    if (titlePhrase === phrase) {
      score += BONUS_EXACT_PHRASE;
    } else if (titlePhrase.includes(phrase)) {
      score += BONUS_PHRASE;
    }
    if (titleTokens[0] === head) {
      score += BONUS_LEAD_TOKEN;
    }
  }

  score += supportHits.length * SCORE_SUPPORT_TOKEN;

  return {
    item,
    verdict,
    score,
    selectable: verdict === "exact" || verdict === "compatible",
    matchedTokens: [...titleHits, ...supportHits],
    reason,
  };
}

// ----------------------------------------------------------------------------
// Ranking + fail-closed selection
// ----------------------------------------------------------------------------

/**
 * Total order over candidates: relevance first, then availability, then price,
 * then variant id. The trailing variant-id key makes the sort deterministic
 * even when two rows are otherwise indistinguishable — no "whatever Postgres
 * returned first" decisions.
 */
export function rankCatalogMatches<T extends CatalogMatchInput>(
  items: T[],
  query: string,
  options: RankOptions = {},
): CatalogMatch<T>[] {
  const wantedCategory = options.category?.trim().toLowerCase();
  const scored = items
    .filter(
      (item) =>
        !wantedCategory ||
        (item.category || "").trim().toLowerCase() === wantedCategory,
    )
    .map((item) => scoreCatalogMatch(query, item));

  return scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aStock = a.item.inStock === false ? 0 : 1;
    const bStock = b.item.inStock === false ? 0 : 1;
    if (aStock !== bStock) return bStock - aStock;
    const aPrice = a.item.basePriceMinor ?? Number.MAX_SAFE_INTEGER;
    const bPrice = b.item.basePriceMinor ?? Number.MAX_SAFE_INTEGER;
    if (aPrice !== bPrice) return aPrice - bPrice;
    return a.item.variantId.localeCompare(b.item.variantId);
  });
}

/** Only `exact` / `compatible` matches may ever be auto-selected. */
export function selectableMatches<T extends CatalogMatchInput>(
  ranked: CatalogMatch<T>[],
): CatalogMatch<T>[] {
  return ranked.filter((m) => m.selectable);
}

/**
 * Pick the single best candidate for a query, or `null`. Returning `null` is a
 * first-class answer: callers must fail closed rather than fall back to an
 * unrelated SKU.
 */
export function selectCatalogMatch<T extends CatalogMatchInput>(
  items: T[],
  query: string,
  options: RankOptions = {},
): CatalogMatch<T> | null {
  return (
    selectableMatches(rankCatalogMatches(items, query, options))[0] ?? null
  );
}
