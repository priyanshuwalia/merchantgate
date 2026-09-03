"use client";

import {
  Bot,
  CheckCircle2,
  Copy,
  CreditCard,
  KeyRound,
  PlugZap,
  Save,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Header } from "@/components/dashboard/Header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const PROVIDERS = [
  {
    value: "openrouter",
    label: "OpenRouter",
    hint: "sk-or-v1-… · any model slug",
  },
  { value: "openai", label: "OpenAI", hint: "sk-… · gpt-4o-mini, gpt-4o, …" },
  { value: "groq", label: "Groq", hint: "gsk_… · llama-3.3-70b-versatile" },
  {
    value: "together",
    label: "Together AI",
    hint: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  },
  {
    value: "custom",
    label: "Custom / Self-hosted",
    hint: "Any OpenAI-compatible base URL",
  },
];

export default function SettingsPage() {
  const [_loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [_copied, setCopied] = useState<string | null>(null);

  const [merchantName, setMerchantName] = useState("Nimbus Gear & Electronics");
  const [currency, setCurrency] = useState("INR");
  const [razorpayKeyId, setRazorpayKeyId] = useState("");
  const [webhookUrl, setWebhookUrl] = useState(
    "https://your-domain.com/api/webhooks/razorpay",
  );

  // AI model configuration
  const [aiProvider, setAiProvider] = useState("openrouter");
  const [aiModel, setAiModel] = useState("");
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiBaseUrl, setAiBaseUrl] = useState("");
  const [savedAi, setSavedAi] = useState<{
    hasApiKey?: boolean;
    apiKeyMasked?: string | null;
    model?: string;
    provider?: string;
    live?: boolean;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  useEffect(() => {
    async function loadSettings() {
      try {
        const res = await fetch("/api/merchant/settings");
        const data = await res.json();
        if (data.name) setMerchantName(data.name);
        if (data.config) {
          setCurrency(data.config.currency || "INR");
          setRazorpayKeyId(data.config.razorpayKeyId || "");
          if (data.config.webhookUrl) setWebhookUrl(data.config.webhookUrl);
        }
        if (data.ai) {
          setSavedAi(data.ai);
          setAiProvider(data.ai.provider || "openrouter");
          setAiModel(data.ai.model || "");
          setAiBaseUrl(data.ai.baseUrl || "");
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    loadSettings();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSaved(false);
      const res = await fetch("/api/merchant/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: merchantName,
          currency,
          razorpayKeyId,
          webhookUrl,
          ai: {
            provider: aiProvider,
            model: aiModel,
            baseUrl: aiBaseUrl,
            apiKey: aiApiKey || undefined,
          },
        }),
      });
      const data = await res.json();
      if (res.ok) {
        if (data.ai) setSavedAi(data.ai);
        setAiApiKey("");
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleTestAi = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/merchant/ai-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: aiProvider,
          model: aiModel,
          baseUrl: aiBaseUrl,
          apiKey: aiApiKey || undefined,
        }),
      });
      const data = await res.json();
      setTestResult({
        success: Boolean(data.success),
        message: data.message || String(data.error || "Unknown response"),
      });
    } catch (e) {
      setTestResult({ success: false, message: String(e) });
    } finally {
      setTesting(false);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Merchant & Gateway Settings"
        description="Configure your merchant identity, AI models, Razorpay payment keys, and agent discovery endpoints."
      />

      <div className="p-6 space-y-6 max-w-4xl">
        <form onSubmit={handleSave} className="space-y-6 text-xs">
          {/* Merchant Profile */}
          <Card className="p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div>
                <CardTitle>Merchant Profile</CardTitle>
                <CardDescription>
                  Identity presented to discovering AI buyer agents.
                </CardDescription>
              </div>
              <Badge variant="success" className="font-mono text-[10px]">
                Active Merchant
              </Badge>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="merchant-id"
                  className="block text-foreground font-medium mb-1"
                >
                  Merchant ID (Immutable)
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    id="merchant-id"
                    disabled
                    value="mch_nimbus_gear_001"
                    className="font-mono text-muted-foreground bg-muted"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    onClick={() =>
                      copyToClipboard("mch_nimbus_gear_001", "mch_id")
                    }
                  >
                    <Copy className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              <div>
                <label
                  htmlFor="store-name"
                  className="block text-foreground font-medium mb-1"
                >
                  Store / Business Name
                </label>
                <Input
                  id="store-name"
                  required
                  value={merchantName}
                  onChange={(e) => setMerchantName(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="settlement-currency"
                className="block text-foreground font-medium mb-1"
              >
                Default Settlement Currency
              </label>
              <select
                id="settlement-currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="h-9 w-48 px-3 rounded-lg bg-white border border-input text-xs text-foreground font-mono focus:outline-none focus:border-primary focus:shadow-[0_0_0_3px_rgba(0,102,255,0.1)]"
              >
                <option value="INR">INR (Indian Rupee - ₹)</option>
                <option value="USD">USD (US Dollar - $)</option>
              </select>
            </div>
          </Card>

          {/* AI Model Configuration */}
          <Card className="p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <Bot className="w-4 h-4 text-primary" />
                <div>
                  <CardTitle>AI Model Configuration</CardTitle>
                  <CardDescription>
                    Your own LLM powers the merchant negotiating agent & the
                    inventory assistant.
                  </CardDescription>
                </div>
              </div>
              {savedAi?.live ? (
                <Badge variant="success" className="gap-1">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#00b874]" />
                  Live • {savedAi.provider}
                </Badge>
              ) : (
                <Badge variant="outline">Heuristic mode</Badge>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="ai-provider"
                  className="block text-foreground font-medium mb-1"
                >
                  Provider
                </label>
                <select
                  id="ai-provider"
                  value={aiProvider}
                  onChange={(e) => setAiProvider(e.target.value)}
                  className="h-9 w-full px-3 rounded-md bg-white border border-input text-sm text-foreground focus:outline-none focus:border-primary focus:shadow-[0_0_0_3px_rgba(0,102,255,0.1)]"
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-text-muted">
                  {PROVIDERS.find((p) => p.value === aiProvider)?.hint}
                </p>
              </div>

              <div>
                <label
                  htmlFor="ai-model"
                  className="block text-foreground font-medium mb-1"
                >
                  Model Name / Slug
                </label>
                <Input
                  id="ai-model"
                  placeholder={
                    aiProvider === "openrouter"
                      ? "e.g. openai/gpt-4o-mini"
                      : aiProvider === "groq"
                        ? "e.g. llama-3.3-70b-versatile"
                        : "e.g. gpt-4o-mini"
                  }
                  value={aiModel}
                  onChange={(e) => setAiModel(e.target.value)}
                  className="font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="ai-api-key"
                  className="flex items-center gap-1.5 text-foreground font-medium mb-1"
                >
                  <KeyRound className="w-3.5 h-3.5 text-text-muted" />
                  API Key{" "}
                  {savedAi?.apiKeyMasked && (
                    <span className="font-mono text-[11px] font-normal text-text-muted">
                      (saved: {savedAi.apiKeyMasked})
                    </span>
                  )}
                </label>
                <Input
                  id="ai-api-key"
                  type="password"
                  placeholder={
                    savedAi?.hasApiKey
                      ? "Leave blank to keep the saved key"
                      : "Paste your provider API key"
                  }
                  value={aiApiKey}
                  onChange={(e) => setAiApiKey(e.target.value)}
                  className="font-mono"
                  autoComplete="off"
                />
                <p className="mt-1 text-[11px] text-text-muted">
                  Stored server-side only; never exposed back to the browser.
                </p>
              </div>

              <div>
                <label
                  htmlFor="ai-base-url"
                  className="block text-foreground font-medium mb-1"
                >
                  Custom Base URL{" "}
                  {aiProvider !== "custom" && (
                    <span className="font-normal text-text-muted">
                      (optional)
                    </span>
                  )}
                </label>
                <Input
                  id="ai-base-url"
                  placeholder="https://your-host/v1/chat/completions"
                  value={aiBaseUrl}
                  onChange={(e) => setAiBaseUrl(e.target.value)}
                  className="font-mono"
                />
                <p className="mt-1 text-[11px] text-text-muted">
                  Required for self-hosted/OpenAI-compatible endpoints.
                </p>
              </div>
            </div>

            {/* Test connection */}
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleTestAi}
                disabled={testing}
                className="gap-1.5"
              >
                <PlugZap className="w-3.5 h-3.5" />
                {testing ? "Testing…" : "Test Connection"}
              </Button>

              {testResult && (
                <span
                  className={`text-xs font-medium ${
                    testResult.success ? "text-[#00875c]" : "text-destructive"
                  }`}
                >
                  {testResult.success ? "✓ " : "✕ "}
                  {testResult.message}
                </span>
              )}
            </div>
          </Card>

          {/* Payment Gateway Settings */}
          <Card className="p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <CreditCard className="w-4 h-4 text-primary" />
                <div>
                  <CardTitle>Razorpay Payment Gateway</CardTitle>
                  <CardDescription>
                    Live test mode credentials for processing agent checkouts.
                  </CardDescription>
                </div>
              </div>
              <Badge
                variant="outline"
                className="text-primary font-mono text-[10px]"
              >
                Test Mode
              </Badge>
            </div>

            <div className="space-y-4">
              <div>
                <label
                  htmlFor="razorpay-key-id"
                  className="block text-foreground font-medium mb-1"
                >
                  Razorpay Key ID
                </label>
                <Input
                  id="razorpay-key-id"
                  placeholder="rzp_test_..."
                  value={razorpayKeyId}
                  onChange={(e) => setRazorpayKeyId(e.target.value)}
                  className="font-mono"
                />
              </div>

              <div>
                <label
                  htmlFor="webhook-url"
                  className="block text-foreground font-medium mb-1"
                >
                  Webhook Receiver URL
                </label>
                <Input
                  id="webhook-url"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  className="font-mono"
                />
              </div>
            </div>
          </Card>

          {/* Endpoints Reference */}
          <Card className="p-6 space-y-3">
            <CardTitle>Agent Protocol Endpoints</CardTitle>
            <div className="space-y-2 font-mono text-[11px]">
              <div className="flex items-center justify-between p-2.5 rounded-lg bg-muted border border-border">
                <span className="text-text-muted">Discovery:</span>
                <span className="text-primary">
                  GET /.well-known/agent-commerce.json
                </span>
              </div>
              <div className="flex items-center justify-between p-2.5 rounded-lg bg-muted border border-border">
                <span className="text-text-muted">Catalog Search:</span>
                <span className="text-primary">GET /v1/agent/catalog</span>
              </div>
              <div className="flex items-center justify-between p-2.5 rounded-lg bg-muted border border-border">
                <span className="text-text-muted">Verification:</span>
                <span className="text-primary">POST /v1/agent/verify</span>
              </div>
              <div className="flex items-center justify-between p-2.5 rounded-lg bg-muted border border-border">
                <span className="text-text-muted">Authoritative Checkout:</span>
                <span className="text-[#00875c]">POST /v1/agent/checkout</span>
              </div>
            </div>
          </Card>

          {/* Save Button */}
          <div className="flex items-center justify-between pt-2">
            {saved ? (
              <Badge variant="success" className="gap-1.5 py-1 px-3">
                <CheckCircle2 className="w-4 h-4" /> Settings updated
                successfully!
              </Badge>
            ) : (
              <span />
            )}

            <Button type="submit" className="gap-2 text-xs">
              <Save className="w-4 h-4" />
              <span>Save Configuration</span>
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
