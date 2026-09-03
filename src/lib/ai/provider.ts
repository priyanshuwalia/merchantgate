/**
 * Multi-provider LLM configuration resolution.
 *
 * Supports any OpenAI-compatible chat-completions endpoint:
 * OpenRouter, OpenAI, Groq, Together, or a fully custom base URL.
 *
 * Resolution order (first wins):
 *   1. Explicitly supplied config (e.g. buyer key from simulator UI)
 *   2. Merchant-saved config (merchants.config.ai in DB — passed by caller)
 *   3. Environment variables (OPENROUTER_API_KEY / OPENAI_API_KEY / MODEL_API_KEY)
 */

export type AiProvider =
  | "openrouter"
  | "openai"
  | "groq"
  | "together"
  | "custom";

export interface AiConfigInput {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface ResolvedAiConfig {
  provider: AiProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
}

const PROVIDER_PRESETS: Record<
  Exclude<AiProvider, "custom">,
  { baseUrl: string; defaultModel: string }
> = {
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    defaultModel: "nvidia/nemotron-3.5-lightning:free",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-4o-mini",
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
    defaultModel: "llama-3.3-70b-versatile",
  },
  together: {
    baseUrl: "https://api.together.xyz/v1/chat/completions",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  },
};

function normalizeProvider(provider?: string): AiProvider {
  const p = (provider || "").toLowerCase().trim();
  if (p === "openai") return "openai";
  if (p === "groq") return "groq";
  if (p === "together") return "together";
  if (p === "custom") return "custom";
  return "openrouter";
}

function sanitizeKey(key?: string | null): string | undefined {
  const k = (key || "").trim();
  if (!k) return undefined;
  // Reject placeholder values commonly pasted by mistake
  if (/dummy|your[_-]?key|changeme|example|xxx+/i.test(k)) return undefined;
  return k;
}

/**
 * Resolve a usable AI config. Returns null when no API key can be found so
 * callers can fall back to deterministic behavior.
 */
export function resolveAiConfig(
  userSupplied?: AiConfigInput | null,
  merchantSaved?: AiConfigInput | null,
): ResolvedAiConfig | null {
  const candidates: Array<{ source: AiConfigInput; envFallback?: boolean }> =
    [];

  if (userSupplied && sanitizeKey(userSupplied.apiKey)) {
    candidates.push({ source: userSupplied });
  }
  if (merchantSaved && sanitizeKey(merchantSaved.apiKey)) {
    candidates.push({ source: merchantSaved });
  }

  // Environment fallback (provider inferred from whichever key exists)
  const envOpenRouter = sanitizeKey(process.env.OPENROUTER_API_KEY);
  const envOpenAi = sanitizeKey(process.env.OPENAI_API_KEY);
  const envModel = sanitizeKey(process.env.MODEL_API_KEY);
  const envKey = envOpenRouter || envOpenAi || envModel;
  if (envKey) {
    candidates.push({
      source: {
        provider:
          envOpenAi && !envOpenRouter
            ? "openai"
            : String(process.env.MODEL_PROVIDER || "openrouter"),
        model: process.env.MODEL_NAME,
        apiKey: envKey,
      },
    });
  }

  for (const { source } of candidates) {
    const provider = normalizeProvider(source.provider);
    const apiKey = sanitizeKey(source.apiKey);
    if (!apiKey) continue;

    let model = (source.model || "").trim();
    let baseUrl = (source.baseUrl || "").trim();

    if (provider === "custom") {
      if (!baseUrl) continue; // custom provider requires explicit base URL
      if (!model) model = "default";
    } else {
      const preset = PROVIDER_PRESETS[provider];
      baseUrl = baseUrl || preset.baseUrl;
      model = model || preset.defaultModel;
    }

    return { provider, apiKey, model, baseUrl };
  }

  return null;
}

/** Mask an API key for safe display: sk-proj-abcd...wxyz */
export function maskApiKey(key?: string | null): string | null {
  const k = sanitizeKey(key);
  if (!k) return null;
  if (k.length <= 10) return `${k.slice(0, 2)}${"•".repeat(6)}`;
  return `${k.slice(0, 6)}${"•".repeat(8)}${k.slice(-4)}`;
}
