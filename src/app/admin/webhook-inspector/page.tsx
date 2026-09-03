"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Lock,
  Radio,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Header } from "@/components/dashboard/Header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { WebhookInspectionLog } from "@/lib/webhooks/inspector-store";

export default function WebhookInspectorPage() {
  const [logs, setLogs] = useState<WebhookInspectionLog[]>([]);
  const [connected, setConnected] = useState(false);
  const [triggering, setTriggering] = useState<string | null>(null);

  useEffect(() => {
    // Initial fetch fallback
    fetch("/api/webhooks/inspector/logs")
      .then((res) => res.json())
      .then((data) => {
        if (data.logs) setLogs(data.logs);
      })
      .catch((err) => console.error(err));

    // Connect to SSE stream
    const eventSource = new EventSource("/api/webhooks/inspector/stream");

    eventSource.onopen = () => {
      setConnected(true);
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "init" && Array.isArray(data.logs)) {
          setLogs(data.logs);
        } else if (data.type === "new_log" && data.log) {
          setLogs((prev) => [
            data.log,
            ...prev.filter((l) => l.id !== data.log.id),
          ]);
        }
      } catch (e) {
        console.error("SSE parse error:", e);
      }
    };

    eventSource.onerror = () => {
      setConnected(false);
    };

    return () => {
      eventSource.close();
    };
  }, []);

  const triggerTestWebhook = async (
    mode: "valid" | "malformed" | "duplicate",
  ) => {
    try {
      setTriggering(mode);
      await fetch("/api/webhooks/inspector/logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-merchant-csrf": "1",
        },
        body: JSON.stringify({
          mode,
          event: "payment.captured",
          eventId:
            mode === "duplicate" ? "evt_duplicate_id_demo_fixed" : undefined,
        }),
      });
    } catch (err) {
      console.error("Failed to trigger webhook:", err);
    } finally {
      setTriggering(null);
    }
  };

  const clearLogs = () => {
    setLogs([]);
  };

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-background text-foreground">
      <Header
        title="Live HMAC Webhook Inspector"
        description="Real-time cryptographic signature verification, replay protection, and attack rejection telemetry."
      />

      <div className="p-6 space-y-6">
        {/* Top Controls & Attack Simulator Banner */}
        <Card className="p-5">
          <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-primary" />
                <h2 className="text-sm font-bold text-foreground tracking-tight">
                  Cryptographic Webhook Boundary Verification
                </h2>
                <Badge
                  variant={connected ? "success" : "secondary"}
                  className="font-mono text-[10px] gap-1 ml-1"
                >
                  <Radio
                    className={`w-3 h-3 ${connected ? "animate-pulse text-[#00b874]" : ""}`}
                  />
                  <span>
                    {connected ? "LIVE SSE STREAM ACTIVE" : "CONNECTING..."}
                  </span>
                </Badge>
              </div>
              <p className="text-xs text-text-muted mt-1">
                Every incoming Razorpay webhook must match SHA-256 HMAC
                timing-safe signatures and pass deduplication before mutating
                state.
              </p>
            </div>

            {/* Attack & Demo Buttons */}
            <div className="flex items-center flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => triggerTestWebhook("valid")}
                disabled={Boolean(triggering)}
                className="gap-1.5 text-xs bg-[#00b874]/[0.08] hover:bg-[#00b874]/[0.15] text-[#00875c] border-[#00b874]/25"
              >
                <Zap className="w-3.5 h-3.5" />
                <span>
                  {triggering === "valid" ? "Sending..." : "Send Valid Webhook"}
                </span>
              </Button>

              <Button
                variant="destructive"
                size="sm"
                onClick={() => triggerTestWebhook("malformed")}
                disabled={Boolean(triggering)}
                className="gap-1.5 text-xs"
              >
                <ShieldAlert className="w-3.5 h-3.5" />
                <span>
                  {triggering === "malformed"
                    ? "Attacking..."
                    : "🚨 Send Malformed Webhook"}
                </span>
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={() => triggerTestWebhook("duplicate")}
                disabled={Boolean(triggering)}
                className="gap-1.5 text-xs bg-[#ffb822]/[0.12] hover:bg-[#ffb822]/[0.2] text-[#946400] border-[#ffb822]/40"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>
                  {triggering === "duplicate"
                    ? "Replaying..."
                    : "Send Duplicate Webhook"}
                </span>
              </Button>

              <Button
                variant="ghost"
                size="sm"
                onClick={clearLogs}
                className="gap-1 text-xs text-text-muted hover:text-foreground"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Clear</span>
              </Button>
            </div>
          </div>
        </Card>

        {/* Live Webhook Inspection Tree List */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider flex items-center gap-1.5">
              <Terminal className="w-4 h-4 text-primary" />
              <span>Inspection Stream Logs ({logs.length} events)</span>
            </h3>
            <span className="text-[11px] font-mono text-text-muted">
              Provider:{" "}
              <code className="text-primary">Razorpay HMAC SHA-256</code>
            </span>
          </div>

          {logs.length === 0 ? (
            <Card className="p-12 text-center border-dashed border-border bg-muted/50">
              <div className="w-12 h-12 rounded-full bg-white border border-border text-text-muted flex items-center justify-center mx-auto mb-3">
                <Lock className="w-5 h-5 text-primary" />
              </div>
              <h4 className="text-sm font-semibold text-foreground">
                No Webhooks Recorded in Stream
              </h4>
              <p className="text-xs text-text-muted mt-1 max-w-sm mx-auto">
                Click <strong>"Send Valid Webhook"</strong> or{" "}
                <strong>"🚨 Send Malformed Webhook"</strong> above to inspect
                live HMAC verification!
              </p>
            </Card>
          ) : (
            <div className="space-y-3">
              {logs.map((log) => {
                const isMatch = log.signatureMatch;
                const isProcessed = log.status === "PROCESSED";
                const isRejected = log.status === "REJECTED_SIGNATURE";

                return (
                  <div
                    key={log.id}
                    className={`rounded-xl border p-4 transition-all animate-in fade-in slide-in-from-top-2 ${
                      isProcessed
                        ? "bg-[#00b874]/[0.08] border-[#00b874]/25"
                        : isRejected
                          ? "bg-destructive/[0.06] border-destructive/25"
                          : "bg-[#ffb822]/[0.12] border-[#ffb822]/40"
                    }`}
                  >
                    {/* Event Header */}
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 pb-3 border-b border-black/[0.06]">
                      <div className="flex items-center gap-2">
                        {isProcessed ? (
                          <CheckCircle2 className="w-4 h-4 text-[#00b874] shrink-0" />
                        ) : isRejected ? (
                          <XCircle className="w-4 h-4 text-destructive shrink-0" />
                        ) : (
                          <AlertTriangle className="w-4 h-4 text-[#946400] shrink-0" />
                        )}
                        <span className="font-bold text-xs text-foreground font-mono">
                          📩 Webhook Received ({log.providerEventId})
                        </span>
                        <Badge
                          variant={
                            isProcessed
                              ? "success"
                              : isRejected
                                ? "destructive"
                                : "warning"
                          }
                          className="font-mono text-[9px] uppercase"
                        >
                          {log.eventType}
                        </Badge>
                      </div>

                      <div className="text-[10px] font-mono text-text-muted">
                        {new Date(log.timestamp).toLocaleTimeString()} •{" "}
                        {log.timestamp}
                      </div>
                    </div>

                    {/* Inspection Tree Nodes */}
                    <div className="mt-3 font-mono text-xs space-y-2 text-text-secondary">
                      {/* Node 1: Raw Body */}
                      <div className="flex items-start gap-2">
                        <span className="text-slate-300 select-none">├──</span>
                        <span className="text-text-muted shrink-0">
                          Raw Body:
                        </span>
                        <span className="text-zinc-200 truncate max-w-xl text-[11px] bg-[#1a1a2e] px-1.5 py-0.5 rounded border border-white/10">
                          {log.rawBody}
                        </span>
                      </div>

                      {/* Node 2: Received Signature */}
                      <div className="flex items-start gap-2">
                        <span className="text-slate-300 select-none">├──</span>
                        <span className="text-text-muted shrink-0">
                          Received Signature:
                        </span>
                        <span className="text-primary truncate max-w-md text-[11px]">
                          {log.receivedSignature}
                        </span>
                      </div>

                      {/* Node 3: Computed HMAC & Verification Match */}
                      <div className="flex items-start gap-2">
                        <span className="text-slate-300 select-none">├──</span>
                        <span className="text-text-muted shrink-0">
                          Computed HMAC:
                        </span>
                        <span className="text-primary truncate max-w-md text-[11px]">
                          {log.computedHmac}
                        </span>
                        {isMatch ? (
                          <Badge
                            variant="success"
                            className="text-[9px] font-mono py-0 px-1.5 gap-1 shrink-0"
                          >
                            <CheckCircle2 className="w-2.5 h-2.5" /> MATCH
                          </Badge>
                        ) : (
                          <Badge
                            variant="destructive"
                            className="text-[9px] font-mono py-0 px-1.5 gap-1 shrink-0 animate-pulse"
                          >
                            <XCircle className="w-2.5 h-2.5" /> MISMATCH -
                            REJECTED
                          </Badge>
                        )}
                      </div>

                      {/* Node 4: Event ID & Dedupe Check */}
                      <div className="flex items-start gap-2">
                        <span className="text-slate-300 select-none">├──</span>
                        <span className="text-text-muted shrink-0">
                          Dedupe Check:
                        </span>
                        <span className="text-[11px]">
                          {log.dedupeCheck === "NEW_EVENT" ? (
                            <span className="text-[#00875c]">
                              ✅ First time processing (New Event)
                            </span>
                          ) : (
                            <span className="text-[#946400]">
                              ⏭️ Duplicate Event ID (Replay skipped)
                            </span>
                          )}
                        </span>
                      </div>

                      {/* Node 5: Action */}
                      <div className="flex items-start gap-2">
                        <span className="text-slate-300 select-none">└──</span>
                        <span className="text-text-muted shrink-0">
                          Action:
                        </span>
                        <span
                          className={`text-[11px] font-semibold ${
                            isProcessed
                              ? "text-[#00875c]"
                              : isRejected
                                ? "text-destructive"
                                : "text-[#946400]"
                          }`}
                        >
                          {log.action}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
