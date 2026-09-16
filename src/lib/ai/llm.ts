/**
 * Shared LLM helper for agent parsing (buyer planner + merchant inventory agent).
 *
 * Uses any OpenAI-compatible chat completions API (see provider.ts).
 * Returns null on any failure so callers can fall back to deterministic parsers.
 */

import {
  type AiConfigInput,
  type ResolvedAiConfig,
  resolveAiConfig,
} from "./provider";

const REQUEST_TIMEOUT_MS = 12_000;

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type { AiConfigInput, ResolvedAiConfig };
export { maskApiKey, resolveAiConfig } from "./provider";

export function resolveLlmApiKey(userSupplied?: string): string | undefined {
  const resolved = resolveAiConfig({ apiKey: userSupplied || undefined });
  return resolved?.apiKey;
}

export async function callLlm(
  messages: LlmMessage[],
  options?: AiConfigInput & {
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
  },
): Promise<string | null> {
  const config = resolveAiConfig(options);
  if (!config) return null;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options?.timeoutMs ?? REQUEST_TIMEOUT_MS,
  );

  try {
    const res = await fetch(config.baseUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        ...(config.provider === "openrouter"
          ? {
              "HTTP-Referer": "https://agentpay-merchant.local",
              "X-Title": "AgentPay Merchant Agents",
            }
          : {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: options?.temperature ?? 0.2,
        ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.warn(
        `LLM provider (${config.provider}/${config.model}) returned ${res.status}: ${errBody.slice(0, 300)}`,
      );
      return null;
    }

    const completion = await res.json();
    const content =
      completion.choices?.[0]?.message?.content ??
      // Some providers return an error payload with 200 — guard against it
      (completion.error ? null : null);
    if (!content && completion.error) {
      console.warn("LLM provider error:", completion.error);
    }
    return content || null;
  } catch (err) {
    console.warn(
      "LLM call failed, falling back to deterministic parser:",
      String(err),
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Extract the first fenced JSON block of a given language tag from LLM output.
 *
 * Deliberately tolerant of common small-model quirks (trailing commas, single
 * quotes, markdown fences, leading/trailing prose) so structured extraction
 * degrades gracefully instead of failing silently.
 */
export function extractFencedJson(
  raw: string,
  tag: string,
): Record<string, unknown> | null {
  if (typeof raw !== "string" || !raw) return null;

  const fenceRe = new RegExp(`\`\`\`${tag}\\s*([\\s\\S]*?)\\s*\`\`\``, "i");
  let block = raw.match(fenceRe)?.[1];

  // If no fenced block, try to locate a lone JSON object as a last resort so a
  // model that skipped the fence still yields its structure.
  if (!block) {
    const lone = raw.match(/\{[\s\S]*\}/);
    if (lone) block = lone[0];
  }
  if (!block) return null;

  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(s);
      return typeof parsed === "object" && parsed !== null ? parsed : null;
    } catch {
      return null;
    }
  };

  const direct = tryParse(block);
  if (direct) return direct;

  // Tolerate trailing commas / unquoted single-quoted keys / single-quoted
  // strings common in small-model output.
  const cleaned = block
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/([{,]\s*)'([^']+)'\s*:/g, '$1"$2":')
    .replace(/:\s*'([^']*)'/g, ': "$1"');
  const fallback = tryParse(cleaned);
  if (fallback) return fallback;

  // Very defensive: strip any code fences graffiti and whitespace, then retry.
  const stripped = block.replace(/^```[a-zA-Z_-]*|```$/g, "").trim();
  return tryParse(stripped);
}

export function stripFencedBlock(raw: string, tag: string): string {
  return raw
    .replace(new RegExp(`\`\`\`${tag}[\\s\\S]*?\`\`\``, "g"), "")
    .trim();
}

/**
 * Detect whether a raw LLM chunk still smells like an echoed tool/function
 * call (OpenAI-style `tool_calls`, `{"function":{"name":...,"arguments":...}}`,
 * or a `call_...` id). Used to avoid leaking JSON into the chat transcript.
 */
export function looksLikeToolLeak(text: string): boolean {
  return /("tool_calls?"|"function"\s*:|"arguments"\s*:|call_[a-z0-9_]{6,})/i.test(
    text,
  );
}

/**
 * Remove balanced JSON objects/arrays from `raw` whose contents look like a
 * tool/function invocation. String literals are respected so accidental `{}`
 * in prose is never mis-matched, and only spans that reference the buyer
 * tool names or tool-call keys are removed.
 */
export function stripToolCallJson(raw: string): string {
  const isToolish = (slice: string): boolean =>
    /"tool_calls?"|\b(?:searchCatalog|getProduct|requestCheckoutProposal)\b|"function"\s*:|"arguments"\s*:/.test(
      slice,
    );

  let out = "";
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === "{" || c === "[") {
      let depth = 0;
      let inStr = false;
      let end = -1;
      for (let j = i; j < raw.length; j++) {
        const ch = raw[j];
        if (inStr) {
          if (ch === "\\") {
            j += 1;
            continue;
          }
          if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') {
          inStr = true;
          continue;
        }
        if (ch === "{" || ch === "[") depth += 1;
        else if (ch === "}" || ch === "]") {
          depth -= 1;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
      if (end !== -1) {
        const slice = raw.slice(i, end + 1);
        if (isToolish(slice)) {
          out += " ";
          i = end + 1;
          continue;
        }
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Sanitize an assistant reply before it is shown in a chat transcript:
 * drop every markdown/code fence (including stray `json_mandate`/`json`/`
 * `tool_calls` blocks) and any tool-call JSON the model echoed back inline.
 * Returns clean prose, or "" when nothing usable remains so callers can fall
 * back to their deterministic reply.
 */
export function sanitizeAssistantReply(raw: string): string {
  let s = String(raw || "");
  s = s.replace(/```[\s\S]*?(?:```|$)/g, " ");
  s = stripToolCallJson(s);
  s = s
    .replace(/```|```\w*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s;
}
