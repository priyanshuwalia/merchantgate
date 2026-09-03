/**
 * Merchant Runtime State Coordinator
 *
 * Several merchant behaviors in this project (surge pricing toggle, agent-to-
 * agent negotiation sessions) live in per-instance in-memory stores for demo
 * speed. This coordinator makes them durable by snapshotting them into the
 * merchant's config row (Postgres jsonb) so they survive process restarts and
 * span serverless instances:
 *
 *   hydrateRuntimeState()  → load persisted runtime state into memory
 *   persistRuntimeState()  → write the current in-memory runtime state to db
 *
 * Callers:
 *   checkout / confirm / negotiate  → hydrate before reading session/surge
 *   negotiate / surge admin routes  → persist after mutating the stores
 */

import { eq } from "drizzle-orm";
import { db, merchants } from "@/db";
import {
  getNegotiationSessionsSnapshot,
  hydrateNegotiationSessions,
  type NegotiationSession,
} from "@/lib/merchant/negotiation";
import {
  getSurgeActiveUntilEpoch,
  hydrateSurgeState,
} from "@/lib/merchant/surge";

const MERCHANT_ID = "mch_nimbus_gear_001";

async function getMerchant() {
  const [merchant] = await db
    .select()
    .from(merchants)
    .where(eq(merchants.id, MERCHANT_ID))
    .limit(1);
  return merchant ?? null;
}

interface PersistedRuntimeState {
  negotiationSessions?: unknown[];
  surge?: { activeUntil: number } | null;
}

export async function hydrateRuntimeState(): Promise<void> {
  const merchant = await getMerchant();
  if (!merchant) return;

  const config = (merchant.config as Record<string, unknown>) || {};
  const runtime =
    (config.runtimeState as PersistedRuntimeState | undefined) || {};

  hydrateNegotiationSessions(
    runtime.negotiationSessions as NegotiationSession[] | undefined,
  );
  const activeUntil =
    typeof runtime.surge?.activeUntil === "number"
      ? runtime.surge.activeUntil
      : null;
  hydrateSurgeState(activeUntil);
}

export async function persistRuntimeState(): Promise<void> {
  const merchant = await getMerchant();
  if (!merchant) return;

  const config = (merchant.config as Record<string, unknown>) || {};
  const runtimeState: PersistedRuntimeState = {
    negotiationSessions: getNegotiationSessionsSnapshot().filter(
      (s) => s.status === "active" || s.status === "agreed",
    ),
    surge: (() => {
      const until = getSurgeActiveUntilEpoch();
      return until && until > Date.now() ? { activeUntil: until } : null;
    })(),
  };

  await db
    .update(merchants)
    .set({ config: { ...config, runtimeState } })
    .where(eq(merchants.id, MERCHANT_ID));
}
