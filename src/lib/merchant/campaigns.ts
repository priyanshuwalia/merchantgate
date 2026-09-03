/**
 * Merchant Campaign Orchestrator (SaaS-grade)
 *
 * Campaigns are merchant-owned promotional programs stored in a dedicated
 * `campaigns` database table — not in code or config JSON — so they can be
 * stood up and retired from the Admin API / dashboard without redeploys. The
 * deterministic resolution functions here are pure and unit-testable; the
 * orchestrator adds the DB persistence layer on top.
 *
 * Capabilities:
 *  - Six campaign types: CATEGORY_DISCOUNT, FLAT_DISCOUNT, BUNDLE_DISCOUNT,
 *    FLASH_SALE, TIERED_DISCOUNT, AGENT_TARGETED.
 *  - Budget caps with spend tracking: each campaign tracks the cumulative
 *    discount spend (spentMinor) against an optional cap (budgetMinor); a
 *    campaign whose budget is exhausted stops pricing further lines down.
 *  - Priority & stacking: when multiple live campaigns match a line, the
 *    highest `priority` wins on each line; a non-stackable campaign wins the
 *    whole line over a stackable one.
 *  - Agent targeting: AGENT_TARGETED campaigns only discount for allow-listed
 *    agents.
 *  - Scheduling: optional weekly schedule days; pause/resume/end lifecycle.
 *  - A/B groups: a campaign can be tagged abGroup "A" | "B" for experiment
 *    reporting.
 *
 * Campaign discounts only ever LOWER a quoted unit price below the merchant's
 * list price, so the buyer's price-slippage defense and mandate ceilings still
 * gate every checkout. Surge pricing overrides campaigns (a surge re-prices
 * quotes UP; a campaign discounts; the two never stack).
 */

import { and, eq, gte, lte, or, sql } from "drizzle-orm";
import { auditEvents, campaigns as campaignsTable, db, merchants } from "@/db";
import { generateId } from "@/lib/utils";

export type CampaignType =
  | "CATEGORY_DISCOUNT"
  | "FLAT_DISCOUNT"
  | "BUNDLE_DISCOUNT"
  | "FLASH_SALE"
  | "TIERED_DISCOUNT"
  | "AGENT_TARGETED";

export interface CampaignTier {
  minOrderMinor: number;
  discountBps: number;
}

export interface Campaign {
  id: string;
  name: string;
  description?: string;
  type: CampaignType;
  category?: string;
  variantIds?: string[];
  discountBps: number;
  minOrderMinor?: number;
  startsAt: string;
  endsAt: string;
  status: "draft" | "active" | "paused" | "ended";
  targetAudience?: string;
  targetAgents?: string[];
  budgetMinor?: number;
  spentMinor?: number;
  priority?: number;
  flashPriceMinor?: number;
  tiers?: CampaignTier[];
  stackable?: boolean;
  abGroup?: "A" | "B";
  scheduleDays?: number[];
  createdAt: string;
  updatedAt?: string;
}

export interface CampaignLineMatch {
  campaign: Campaign;
  discountedUnitPriceMinor: number;
  discountMinor: number;
  discountBps: number;
}

const MERCHANT_ID = "mch_nimbus_gear_001";
const MAX_CAMPAIGNS = 50;
const MAX_DISCOUNT_BPS = 4000;

// ---- DB ↔ Domain mapping

function dbRowToCampaign(row: typeof campaignsTable.$inferSelect): Campaign {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    type: row.type as CampaignType,
    category: row.category ?? undefined,
    variantIds: (row.variant_ids as string[]) || [],
    discountBps: row.discount_bps,
    minOrderMinor: row.min_order_minor ?? undefined,
    startsAt: row.starts_at instanceof Date
      ? row.starts_at.toISOString()
      : String(row.starts_at),
    endsAt: row.ends_at instanceof Date
      ? row.ends_at.toISOString()
      : String(row.ends_at),
    status: row.status as Campaign["status"],
    targetAudience: row.target_audience ?? undefined,
    targetAgents: (row.target_agents as string[]) || [],
    budgetMinor: row.budget_minor ?? undefined,
    spentMinor: row.spent_minor ?? 0,
    priority: row.priority ?? 0,
    flashPriceMinor: row.flash_price_minor ?? undefined,
    tiers: (row.tiers as CampaignTier[]) || [],
    stackable: row.stackable ?? false,
    abGroup: row.ab_group as "A" | "B" | undefined,
    scheduleDays: (row.schedule_days as number[]) || [],
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at),
    updatedAt: row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : String(row.updated_at),
  };
}

/**
 * Pure. Decide whether a campaign is live right now (status active AND within
 * its validity window AND today is an allowed schedule day AND budget not
 * exhausted). Deterministic, no DB/clock side effects other than the supplied
 * `now`.
 */
export function isCampaignLive(
  campaign: Campaign,
  now: Date = new Date(),
): boolean {
  if (campaign.status !== "active") return false;
  const start = new Date(campaign.startsAt);
  const end = new Date(campaign.endsAt);
  if (!(now >= start && now <= end)) return false;
  if (campaign.scheduleDays && campaign.scheduleDays.length > 0) {
    if (!campaign.scheduleDays.includes(now.getUTCDay())) return false;
  }
  if (!hasCampaignBudget(campaign)) return false;
  return true;
}

function applyBps(base: number, bps: number): number {
  const clamped = Math.max(0, Math.min(MAX_DISCOUNT_BPS, bps));
  return Math.max(0, Math.round((base * (10000 - clamped)) / 10000));
}

/** Is this campaign's discount budget already exhausted? */
export function hasCampaignBudget(campaign: Campaign): boolean {
  if (campaign.budgetMinor === undefined || campaign.budgetMinor <= 0) {
    return true;
  }
  return (campaign.spentMinor ?? 0) < campaign.budgetMinor;
}

/**
 * Pure. Resolve the discounted merchant unit price for a single line.
 *
 * Matching rules:
 *  - CATEGORY_DISCOUNT  → category match
 *  - FLAT_DISCOUNT      → variantId or category match
 *  - FLASH_SALE         → variantId or category match, price never below floor
 *  - TIERED_DISCOUNT    → variantId/category match; bps from the highest tier
 *                          whose minOrderMinor the order subtotal clears
 *  - AGENT_TARGETED     → variantId/category match AND agent allow-listed
 *  - BUNDLE_DISCOUNT    → resolved at bundle level only (skipped here)
 *
 * When multiple campaigns match, the one with the highest `priority` wins. A
 * non-stackable campaign always wins over a stackable one on that line.
 * Budget-exhausted campaigns are skipped. Returns null when nothing matches.
 */
export function resolveCampaignForLine(options: {
  variantId: string;
  category: string;
  basePriceMinor: number;
  campaigns: Campaign[];
  orderSubtotalMinor?: number;
  agentId?: string;
  now?: Date;
}): CampaignLineMatch | null {
  const {
    variantId,
    category,
    basePriceMinor,
    campaigns,
    orderSubtotalMinor,
    agentId,
    now,
  } = options;

  let best: CampaignLineMatch | null = null;

  for (const campaign of campaigns) {
    if (!isCampaignLive(campaign, now)) continue;
    if (!hasCampaignBudget(campaign)) continue;
    if (campaign.type === "BUNDLE_DISCOUNT") continue;

    if (
      campaign.minOrderMinor !== undefined &&
      campaign.minOrderMinor > 0 &&
      (orderSubtotalMinor === undefined ||
        orderSubtotalMinor < campaign.minOrderMinor)
    ) {
      continue;
    }

    const baseMatch =
      campaign.type === "CATEGORY_DISCOUNT"
        ? category === campaign.category
        : campaign.type === "FLAT_DISCOUNT" ||
            campaign.type === "FLASH_SALE" ||
            campaign.type === "TIERED_DISCOUNT" ||
            campaign.type === "AGENT_TARGETED"
          ? Boolean(
              campaign.variantIds?.includes(variantId) ||
                (campaign.category && campaign.category === category),
            )
          : false;

    if (!baseMatch) continue;

    if (
      campaign.type === "AGENT_TARGETED" &&
      campaign.targetAgents &&
      campaign.targetAgents.length > 0 &&
      (!agentId || !campaign.targetAgents.includes(agentId))
    ) {
      continue;
    }

    let bps = campaign.discountBps;

    if (campaign.type === "TIERED_DISCOUNT" && campaign.tiers?.length) {
      const cleared = campaign.tiers.find(
        (t) =>
          orderSubtotalMinor === undefined ||
          orderSubtotalMinor >= t.minOrderMinor,
      );
      if (cleared) bps = cleared.discountBps;
    }

    let discounted = applyBps(basePriceMinor, bps);

    if (
      campaign.type === "FLASH_SALE" &&
      campaign.flashPriceMinor !== undefined
    ) {
      discounted = Math.max(discounted, Math.max(0, campaign.flashPriceMinor));
      discounted = Math.max(0, Math.min(discounted, basePriceMinor));
    }

    if (discounted >= basePriceMinor) continue;

    const match: CampaignLineMatch = {
      campaign,
      discountedUnitPriceMinor: discounted,
      discountMinor: basePriceMinor - discounted,
      discountBps: Math.max(0, Math.min(MAX_DISCOUNT_BPS, bps)),
    };

    if (!best) {
      best = match;
      continue;
    }
    const bestWins = best.campaign.priority ?? 0;
    const candidateWins = campaign.priority ?? 0;
    const bestNonStack = best.campaign.stackable === false;
    const candNonStack = campaign.stackable === false;

    if (candNonStack && !bestNonStack) {
      best = match;
    } else if (!candNonStack && bestNonStack) {
    } else if (candidateWins > bestWins) {
      best = match;
    } else if (
      candidateWins === bestWins &&
      match.discountBps > best.discountBps
    ) {
      best = match;
    }
  }

  return best;
}

// ---------------------------------------------------------------- persistence

function clampDiscount(bps: number): number {
  return Math.max(0, Math.min(MAX_DISCOUNT_BPS, Math.round(Number(bps) || 0)));
}

function resolveCampaignDefaults(input: {
  type: CampaignType;
  discountBps?: number;
  tiers?: CampaignTier[];
}): { discountBps: number; tiers?: CampaignTier[] } {
  if (input.type === "TIERED_DISCOUNT" && input.tiers?.length) {
    const sorted = [...input.tiers].sort(
      (a, b) => a.minOrderMinor - b.minOrderMinor,
    );
    const tiers = sorted
      .map((t) => ({
        minOrderMinor: Math.round(Number(t.minOrderMinor) || 0),
        discountBps: clampDiscount(Number(t.discountBps) || 0),
      }))
      .filter((t) => t.minOrderMinor > 0);
    const fallback = tiers.reduce((m, t) => Math.max(m, t.discountBps), 0);
    return { discountBps: fallback, tiers };
  }
  return { discountBps: clampDiscount(Number(input.discountBps) || 0) };
}

function buildCampaignWindow(): { startsAt: Date; endsAt: Date } {
  const now = new Date();
  const startsAt = new Date(now.getTime() - 60 * 1000);
  const endsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { startsAt, endsAt };
}

const DEFAULT_CAMPAIGNS: Array<
  Omit<
    Campaign,
    "id" | "createdAt" | "startsAt" | "endsAt" | "status" | "spentMinor"
  >
> = [
  {
    name: "Accessory Week",
    description:
      "10% off all accessories for AI-agent purchases — pairs with keyboards, mice, laptops and monitors.",
    type: "CATEGORY_DISCOUNT",
    category: "accessories",
    discountBps: 1000,
    targetAudience: "AI buyer agents",
  },
];

/** Lazy-seed the demo campaigns the first time the orchestrator is used. */
export async function ensureDefaultCampaigns(): Promise<Campaign[]> {
  const existing = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.merchant_id, MERCHANT_ID));

  if (existing.length > 0) {
    return existing.map(dbRowToCampaign);
  }

  const w = buildCampaignWindow();
  const nowIso = new Date().toISOString();

  for (const c of DEFAULT_CAMPAIGNS) {
    await db.insert(campaignsTable).values({
      id: generateId("cmp"),
      merchant_id: MERCHANT_ID,
      name: c.name,
      description: c.description,
      type: c.type,
      category: c.category,
      variant_ids: c.variantIds ?? [],
      discount_bps: c.discountBps,
      min_order_minor: c.minOrderMinor,
      starts_at: w.startsAt,
      ends_at: w.endsAt,
      status: "active",
      target_audience: c.targetAudience,
      target_agents: c.targetAgents ?? [],
      budget_minor: c.budgetMinor,
      spent_minor: 0,
      priority: c.priority ?? 0,
      flash_price_minor: c.flashPriceMinor,
      tiers: c.tiers ?? [],
      stackable: c.stackable ?? false,
      ab_group: c.abGroup,
      schedule_days: c.scheduleDays ?? [],
    });
  }

  const seeded = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.merchant_id, MERCHANT_ID));

  return seeded.map(dbRowToCampaign);
}

export async function listCampaigns(): Promise<Campaign[]> {
  const all = await ensureDefaultCampaigns();
  return all.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

export async function getActiveCampaigns(
  now: Date = new Date(),
): Promise<Campaign[]> {
  const all = await ensureDefaultCampaigns();
  return all.filter((c) => isCampaignLive(c, now));
}

export async function standUpCampaign(input: {
  name: string;
  type: CampaignType;
  category?: string;
  variantIds?: string[];
  discountBps?: number;
  tiers?: CampaignTier[];
  minOrderMinor?: number;
  durationDays?: number;
  startsAt?: string;
  endsAt?: string;
  targetAudience?: string;
  description?: string;
  targetAgents?: string[];
  budgetMinor?: number;
  priority?: number;
  stackable?: boolean;
  flashPriceMinor?: number;
  scheduleDays?: number[];
  abGroup?: "A" | "B";
}): Promise<Campaign> {
  const existing = await listCampaigns();
  if (existing.length >= MAX_CAMPAIGNS) {
    throw new Error(`Campaign limit of ${MAX_CAMPAIGNS} reached.`);
  }

  const { discountBps, tiers } = resolveCampaignDefaults(input);

  let startsAt = input.startsAt ? new Date(input.startsAt) : new Date();
  let endsAt = input.endsAt
    ? new Date(input.endsAt)
    : new Date(
        startsAt.getTime() + (Number(input.durationDays) || 7) * 86400000,
      );

  if (Number.isNaN(startsAt.getTime())) startsAt = new Date();
  if (Number.isNaN(endsAt.getTime())) {
    endsAt = new Date(startsAt.getTime() + 7 * 86400000);
  }
  if (endsAt <= startsAt) {
    endsAt = new Date(startsAt.getTime() + 7 * 86400000);
  }

  const id = generateId("cmp");
  const nowIso = new Date().toISOString();

  await db.insert(campaignsTable).values({
    id,
    merchant_id: MERCHANT_ID,
    name: input.name,
    description: input.description,
    type: input.type,
    category: input.category,
    variant_ids: Array.isArray(input.variantIds)
      ? input.variantIds.map(String)
      : [],
    discount_bps: discountBps,
    tiers: tiers ?? [],
    min_order_minor:
      Number(input.minOrderMinor) > 0
        ? Math.round(Number(input.minOrderMinor))
        : undefined,
    starts_at: startsAt,
    ends_at: endsAt,
    status: "active",
    target_audience: input.targetAudience,
    target_agents: Array.isArray(input.targetAgents)
      ? input.targetAgents.map(String)
      : [],
    budget_minor:
      Number(input.budgetMinor) > 0
        ? Math.round(Number(input.budgetMinor))
        : undefined,
    spent_minor: 0,
    priority: Number.isFinite(Number(input.priority))
      ? Math.round(Number(input.priority))
      : 0,
    stackable: input.stackable === true,
    flash_price_minor:
      Number(input.flashPriceMinor) > 0
        ? Math.round(Number(input.flashPriceMinor))
        : undefined,
    schedule_days: Array.isArray(input.scheduleDays)
      ? input.scheduleDays.map(Number).filter((d) => d >= 0 && d <= 6)
      : [],
    ab_group:
      input.abGroup === "A" || input.abGroup === "B"
        ? input.abGroup
        : undefined,
  });

  const [row] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, id))
    .limit(1);

  return dbRowToCampaign(row);
}

export async function updateCampaign(
  campaignId: string,
  patch: Partial<Omit<Campaign, "id" | "createdAt">>,
): Promise<Campaign | null> {
  const [existing] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, campaignId))
    .limit(1);

  if (!existing) return null;

  const updates: Record<string, unknown> = {
    updated_at: new Date(),
  };

  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.type !== undefined) updates.type = patch.type;
  if (patch.category !== undefined) updates.category = patch.category;
  if (patch.discountBps !== undefined)
    updates.discount_bps = clampDiscount(patch.discountBps);
  if (patch.minOrderMinor !== undefined)
    updates.min_order_minor = patch.minOrderMinor;
  if (patch.startsAt !== undefined) updates.starts_at = new Date(patch.startsAt);
  if (patch.endsAt !== undefined) updates.ends_at = new Date(patch.endsAt);
  if (patch.status !== undefined) updates.status = patch.status;
  if (patch.targetAudience !== undefined)
    updates.target_audience = patch.targetAudience;
  if (patch.targetAgents !== undefined)
    updates.target_agents = patch.targetAgents;
  if (patch.budgetMinor !== undefined) updates.budget_minor = patch.budgetMinor;
  if (patch.spentMinor !== undefined) updates.spent_minor = patch.spentMinor;
  if (patch.priority !== undefined) updates.priority = patch.priority;
  if (patch.flashPriceMinor !== undefined)
    updates.flash_price_minor = patch.flashPriceMinor;
  if (patch.tiers !== undefined) updates.tiers = patch.tiers;
  if (patch.stackable !== undefined) updates.stackable = patch.stackable;
  if (patch.abGroup !== undefined) updates.ab_group = patch.abGroup;
  if (patch.scheduleDays !== undefined)
    updates.schedule_days = patch.scheduleDays;

  await db
    .update(campaignsTable)
    .set(updates)
    .where(eq(campaignsTable.id, campaignId));

  const [updated] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, campaignId))
    .limit(1);

  return updated ? dbRowToCampaign(updated) : null;
}

export async function setCampaignStatus(
  campaignId: string,
  status: Campaign["status"],
): Promise<Campaign | null> {
  return updateCampaign(campaignId, {
    status,
    updatedAt: new Date().toISOString(),
  });
}

export async function pauseCampaign(
  campaignId: string,
): Promise<Campaign | null> {
  return setCampaignStatus(campaignId, "paused");
}

export async function resumeCampaign(
  campaignId: string,
): Promise<Campaign | null> {
  return setCampaignStatus(campaignId, "active");
}

export async function endCampaign(
  campaignId: string,
): Promise<Campaign | null> {
  return updateCampaign(campaignId, {
    status: "ended",
    endsAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

export async function deleteCampaign(campaignId: string): Promise<boolean> {
  const deleted = await db
    .delete(campaignsTable)
    .where(eq(campaignsTable.id, campaignId))
    .returning();
  return deleted.length > 0;
}

/**
 * Persist discount spend for one or more campaigns (called once per payment
 * intent so budgets are consumed authoritatively when an order becomes
 * payable). Uses atomic SQL increment to avoid read-modify-write races.
 */
export async function recordCampaignSpend(
  spends: Array<{ campaignId: string; discountMinor: number }>,
): Promise<void> {
  const clean = spends.filter(
    (s) => s.campaignId && Number(s.discountMinor) > 0,
  );
  if (clean.length === 0) return;

  for (const spend of clean) {
    await db
      .update(campaignsTable)
      .set({
        spent_minor: sql`${campaignsTable.spent_minor} + ${spend.discountMinor}`,
        updated_at: new Date(),
      })
      .where(eq(campaignsTable.id, spend.campaignId));
  }
}

// ---------------------------------------------------------------- analytics

export interface CampaignPerformance {
  campaign: Campaign;
  orders: number;
  unitsSold: number;
  revenueMinor: number;
  discountSpendMinor: number;
  roiBps: number;
  liveNow: boolean;
  budgetRemainingMinor: number | null;
  budgetPercentUsed: number | null;
}

/**
 * Compute per-campaign performance from the audit trail. Order-scoped audit
 * events carry a `campaignsApplied` list (id + name + discountBps) in their
 * metadata, captured when the quote was generated.
 *
 * Uses only `checkout_quote_generated` events to avoid double-counting (each
 * order emits both a quote_generated and payment_succeeded event).
 */
export async function getCampaignPerformance(
  campaignId?: string,
): Promise<CampaignPerformance[]> {
  const campaigns = await listCampaigns();
  const now = new Date();

  const events = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.event_type, "checkout_quote_generated"));

  const byId = new Map<string, CampaignPerformance>(
    campaigns.map((c) => [
      c.id,
      {
        campaign: c,
        orders: 0,
        unitsSold: 0,
        revenueMinor: 0,
        discountSpendMinor: 0,
        roiBps: 0,
        liveNow: isCampaignLive(c, now),
        budgetRemainingMinor:
          c.budgetMinor !== undefined && c.budgetMinor > 0
            ? Math.max(0, c.budgetMinor - (c.spentMinor ?? 0))
            : null,
        budgetPercentUsed:
          c.budgetMinor !== undefined && c.budgetMinor > 0
            ? Math.min(
                100,
                Math.round(((c.spentMinor ?? 0) / c.budgetMinor) * 1000) / 10,
              )
            : null,
      },
    ]),
  );

  for (const event of events) {
    const meta = (event.metadata as Record<string, unknown>) || {};
    const applied = Array.isArray(meta.campaignsApplied)
      ? meta.campaignsApplied
      : [];
    const grandTotal =
      typeof meta.totalMinor === "number" ? meta.totalMinor : 0;

    for (const entry of applied as Array<{
      campaignId?: string;
      discountBps?: number;
      quantity?: number;
      lineAmountMinor?: number;
      discountMinor?: number;
    }>) {
      const id = entry.campaignId;
      if (!id) continue;
      const perf = byId.get(id);
      if (!perf) continue;
      perf.orders += 1;
      perf.revenueMinor += grandTotal;
      perf.unitsSold += Number(entry.quantity) || 1;
      perf.discountSpendMinor += Number(entry.discountMinor) || 0;
    }
  }

  for (const perf of byId.values()) {
    if (perf.revenueMinor > 0) {
      perf.roiBps = Math.round(
        (perf.discountSpendMinor / perf.revenueMinor) * 10000,
      );
    }
  }

  const all = [...byId.values()].sort((a, b) => b.orders - a.orders);
  return campaignId ? all.filter((p) => p.campaign.id === campaignId) : all;
}
