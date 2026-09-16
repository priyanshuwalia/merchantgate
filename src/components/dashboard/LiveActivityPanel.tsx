"use client";

import { Activity, Link2, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { subscribeMerchantControl } from "@/lib/broadcast/agentpay-bus";

interface LiveEvent {
  id: number;
  traceId: string;
  timestamp: string;
  actorType: string;
  actorId: string;
  eventType: string;
  explanation: string;
}

const POLL_INTERVAL_MS = 5000;

function toneFor(eventType: string): string {
  if (eventType.startsWith("security") || eventType === "payment_failed")
    return "bg-red-50 text-red-700 border-red-200";
  if (
    eventType.includes("refund") ||
    eventType.includes("settled") ||
    eventType.includes("captured")
  )
    return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (
    eventType.includes("surge") ||
    eventType.includes("campaign") ||
    eventType.includes("negotiation")
  )
    return "bg-[#ffb822]/15 text-[#946400] border-[#ffb822]/40";
  return "bg-muted text-text-secondary border-border";
}

/**
 * Live Agent Activity panel for the merchant overview. Polls the audit trail
 * endpoint (throttled) and instantly refreshes when any merchant control
 * changes (e.g. surge toggled, approval published) via the local event bus.
 */
export function LiveActivityPanel() {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/merchant/audit?limit=10");
      const data = await res.json();
      if (res.ok) {
        setEvents(data.events || []);
        setLastRefresh(Date.now());
      }
    } catch (e) {
      console.error("Live activity poll failed:", e);
    } finally {
      setLoading(false);
    }
  };

  // Trigger an immediate load on any merchant control broadcast.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    loadRef.current();
    const unsubscribe = subscribeMerchantControl(() => {
      loadRef.current();
    });
    // Reset the throttle timer so a focus/broadcast refresh isn't instantly
    // stacked with the next poll tick.
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => loadRef.current(), POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      unsubscribe();
    };
  }, []);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="w-4 h-4 text-primary" />
            Live Agent Activity
          </CardTitle>
          <CardDescription>
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[#00b874] animate-pulse" />
              streaming audit events (polls every {POLL_INTERVAL_MS / 1000}s)
            </span>
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => loadRef.current()}
            disabled={loading}
            className="gap-1 text-xs"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Link
            href="/dashboard/audit"
            className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:bg-muted transition-colors"
          >
            <Link2 className="w-3 h-3" />
            Open Explorer
          </Link>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {loading && events.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground font-sans">
            Streaming audit events…
          </div>
        ) : events.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground font-sans">
            No audit events yet. Run a simulated buyer flow to see activity.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {events.map((e) => (
              <li
                key={e.id}
                className="flex items-start gap-3 px-4 py-2.5 hover:bg-muted/40 transition-colors"
              >
                <Badge variant="secondary" className={toneFor(e.eventType)}>
                  {e.eventType}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] text-text-secondary leading-snug line-clamp-1">
                    {e.explanation}
                  </p>
                  <p className="mt-0.5 font-mono text-[9px] text-text-muted">
                    {e.actorType}:{e.actorId} · {e.traceId} ·{" "}
                    {new Date(e.timestamp).toLocaleTimeString()}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center justify-between px-4 py-2 border-t border-border text-[10px] text-text-muted font-mono">
          <span>
            last poll:{" "}
            {lastRefresh
              ? new Date(lastRefresh).toLocaleTimeString()
              : "waiting…"}
          </span>
          <span>append-only · snapshot-hashed</span>
        </div>
      </CardContent>
    </Card>
  );
}
