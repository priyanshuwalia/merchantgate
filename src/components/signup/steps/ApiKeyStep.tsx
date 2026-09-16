"use client";

import { ArrowRight, Check, Copy, Lightbulb } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

interface ApiKeyStepProps {
  apiKey: string;
  onComplete: () => void;
  onSkip: () => void;
}

export function ApiKeyStep({ apiKey, onComplete, onSkip }: ApiKeyStepProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Your API key
        </h2>
        <p className="mt-1 text-sm text-text-muted">
          This key lets AI buyer agents authenticate against your store in{" "}
          <code className="rounded bg-secondary px-1.5 py-0.5 text-xs font-mono">
            strict
          </code>{" "}
          mode. You can generate more later from Settings.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-secondary/50 p-4">
        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-text-muted">
          Merchant API Key
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 break-all rounded bg-white border border-border p-3 text-sm font-mono text-foreground">
            {apiKey}
          </code>
          <Button
            variant="outline"
            size="icon"
            onClick={handleCopy}
            className="shrink-0"
          >
            {copied ? (
              <Check className="h-4 w-4 text-success" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </Button>
        </div>
        <p className="mt-2 text-xs text-warning font-medium">
          Copy this now — it won&apos;t be shown again.
        </p>
      </div>

      <div className="flex items-start gap-2.5 rounded-lg border border-info/20 bg-info/5 p-3">
        <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-info" />
        <div className="text-xs leading-relaxed text-text-secondary">
          <p className="mb-1 font-medium text-foreground">How it works</p>
          <ul className="list-inside list-disc space-y-0.5">
            <li>
              Agents pass this key via{" "}
              <code className="rounded bg-white px-1 font-mono">
                x-agent-key
              </code>{" "}
              header
            </li>
            <li>
              Switch to{" "}
              <code className="rounded bg-white px-1 font-mono">strict</code>{" "}
              mode in Policies to enforce key validation
            </li>
            <li>
              In <code className="rounded bg-white px-1 font-mono">demo</code>{" "}
              mode, all agents are admitted without a key
            </li>
          </ul>
        </div>
      </div>

      <div className="flex gap-3 pt-2">
        <Button variant="outline" className="flex-1" onClick={onSkip}>
          Skip for now
        </Button>
        <Button className="flex-1" onClick={onComplete} data-icon="inline-end">
          I&apos;ve saved it
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
