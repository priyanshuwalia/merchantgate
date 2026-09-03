"use client";

import {
  Clock,
  Code2,
  Eye,
  EyeOff,
  RefreshCw,
  ScrollText,
  Search,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useState } from "react";
import { Header } from "@/components/dashboard/Header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface AuditEvent {
  id: string;
  traceId: string;
  sequenceNo: number;
  timestamp: string;
  actorType: string;
  actorId: string;
  eventType: string;
  intentMandateId?: string;
  cartMandateId?: string;
  decisionId?: string;
  paymentActionId?: string;
  reasonCodes?: string[];
  providerRefs?: Record<string, unknown>;
  snapshotHash?: string;
  explanation: string;
  metadata?: Record<string, unknown>;
}

const EVENT_TYPES = [
  "agent_verification",
  "checkout_quoted",
  "campaign_created",
  "campaign_ended",
  "campaign_discount_applied",
  "negotiation_opened",
  "negotiation_responded",
  "negotiation_agreed",
  "payment_settled",
  "payment_verified_settled",
  "merchant_order_refunded",
  "security_payment_signature_failed",
  "security_toctou_violation",
  "surge_settlement_blocked",
  "upsell_offers_generated",
  "agent_api_key_issued",
  "webhook_refund_confirmed",
  "webhook_refund_failed",
];

function eventTone(eventType: string): string {
  if (eventType.startsWith("security") || eventType === "payment_failed")
    return "bg-red-50 text-red-700 border-red-200";
  if (eventType.includes("refund") || eventType.includes("settled"))
    return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (eventType.includes("surge") || eventType.includes("campaign_ends"))
    return "bg-[#ffb822]/15 text-[#946400] border-[#ffb822]/40";
  return "bg-muted text-text-secondary border-border";
}

export default function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [traceFilter, setTraceFilter] = useState("");
  const [eventTypeFilter, setEventTypeFilter] = useState("all");
  const [actorFilter, setActorFilter] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (traceFilter.trim()) params.set("traceId", traceFilter.trim());
      if (eventTypeFilter !== "all") params.set("eventType", eventTypeFilter);
      if (actorFilter !== "all") params.set("actorType", actorFilter);
      const res = await fetch(`/api/merchant/audit?${params.toString()}`);
      const data = await res.json();
      if (res.ok) {
        setEvents(data.events || []);
        setTotal(data.total || 0);
      }
    } catch (e) {
      console.error("Failed to load audit trail:", e);
    } finally {
      setLoading(false);
    }
  }, [traceFilter, eventTypeFilter, actorFilter]);

  // Debounce trace search, immediate on filter change.
  useEffect(() => {
    const t = setTimeout(() => fetchEvents(), traceFilter.trim() ? 400 : 0);
    return () => clearTimeout(t);
  }, [fetchEvents, traceFilter]);

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Audit Trail Explorer"
        description="Append-only lineage of every agent, merchant and system action — each entry carries its snapshot hash and reason codes."
      />

      <div className="p-6 space-y-6">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
            <Input
              value={traceFilter}
              onChange={(e) => setTraceFilter(e.target.value)}
              placeholder="Filter by trace id…"
              className="pl-8 h-9 text-xs w-64"
            />
          </div>

          <select
            value={eventTypeFilter}
            onChange={(e) => setEventTypeFilter(e.target.value)}
            className="h-9 text-xs rounded-md border border-border bg-card px-2.5 text-text-secondary focus:outline-none focus:ring-1 focus:ring-primary/40"
          >
            <option value="all">All event types</option>
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          <select
            value={actorFilter}
            onChange={(e) => setActorFilter(e.target.value)}
            className="h-9 text-xs rounded-md border border-border bg-card px-2.5 text-text-secondary focus:outline-none focus:ring-1 focus:ring-primary/40"
          >
            <option value="all">All actors</option>
            <option value="agent">Agent</option>
            <option value="merchant">Merchant</option>
            <option value="system">System</option>
          </select>

          <Button
            variant="outline"
            size="sm"
            onClick={fetchEvents}
            className="gap-1.5 text-xs"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </Button>

          <span className="text-[11px] text-text-muted font-mono">
            {total} event{total === 1 ? "" : "s"}
          </span>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <ScrollText className="w-4 h-4 text-primary" />
              Immutable Audit Events
            </CardTitle>
            <CardDescription>
              Newest first. Sequence integrity is chained per trace via snapshot
              hashes.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">When</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Explanation</TableHead>
                  <TableHead className="text-right pr-4">Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && events.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="py-10 text-center text-muted-foreground font-sans"
                    >
                      Loading audit trail…
                    </TableCell>
                  </TableRow>
                ) : events.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="py-10 text-center text-muted-foreground font-sans"
                    >
                      No audit events match these filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  events.map((e) => {
                    const isExpanded = expanded === e.id;
                    return (
                      <Fragment key={e.id}>
                        <TableRow
                          className="cursor-pointer align-top"
                          onClick={() => setExpanded(isExpanded ? null : e.id)}
                        >
                          <TableCell className="pl-4">
                            <div className="font-mono text-[11px] text-text-secondary flex items-center gap-1">
                              <Clock className="w-3 h-3 text-text-muted" />
                              {new Date(e.timestamp).toLocaleTimeString()}
                            </div>
                            <div className="font-mono text-[10px] text-text-muted">
                              {e.traceId}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="text-xs font-medium text-foreground">
                              {e.actorType}
                            </div>
                            <div className="font-mono text-[10px] text-text-muted">
                              {e.actorId}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="secondary"
                              className={eventTone(e.eventType)}
                            >
                              {e.eventType}
                            </Badge>
                            {e.reasonCodes && e.reasonCodes.length > 0 && (
                              <div className="mt-1 flex flex-wrap gap-1">
                                {e.reasonCodes.map((c) => (
                                  <span
                                    key={c}
                                    className="rounded bg-muted border border-border px-1 py-0.5 text-[9px] font-mono text-text-muted"
                                  >
                                    {c}
                                  </span>
                                ))}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="max-w-md">
                            <p className="text-xs text-text-secondary leading-relaxed line-clamp-2">
                              {e.explanation}
                            </p>
                            <p className="text-[10px] text-text-muted font-mono mt-0.5">
                              hash {e.snapshotHash?.slice(0, 16)}…
                            </p>
                          </TableCell>
                          <TableCell className="text-right pr-4">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="gap-1 text-xs"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                setExpanded(isExpanded ? null : e.id);
                              }}
                            >
                              {isExpanded ? (
                                <EyeOff className="w-3.5 h-3.5" />
                              ) : (
                                <Eye className="w-3.5 h-3.5" />
                              )}
                              {isExpanded ? "Hide" : "View"}
                            </Button>
                          </TableCell>
                        </TableRow>
                        {isExpanded && (
                          <TableRow>
                            <TableCell colSpan={5} className="p-0">
                              <pre className="m-3 p-3 rounded-md bg-card border border-border text-text-secondary font-mono text-[10px] max-h-52 overflow-auto">
                                {JSON.stringify(
                                  {
                                    event: e,
                                    providerRefs: e.providerRefs,
                                    metadata: e.metadata,
                                  },
                                  null,
                                  2,
                                )}
                              </pre>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <div className="flex items-center gap-2 text-[11px] text-text-muted">
          <Code2 className="w-3.5 h-3.5" />
          Every record is written append-only to <code>audit_events</code> and
          includes <code>snapshot_hash</code> for tamper-evidence.
        </div>
      </div>
    </div>
  );
}
