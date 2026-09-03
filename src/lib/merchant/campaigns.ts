/**
 * Merchant Campaign Orchestrator (SaaS-grade)
 *
 * Campaigns are merchant-owned promotional programs persisted in the merchant's
 * config (DB jsonb) — not in code — so they can be stood up and retired from
 * the Admin API / dashboard without redeploys. The deterministic resolution
 * functions here are pure and unit-testable; the orchestrator adds the DB
 * persistence layer on top.
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

import { eq, inArray } from "drizzle-orm";
import { auditEvents, db, merchants } from "@/db";
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
  /** AGENT_TARGETED: when set, only these agent ids benefit from the promo. */
  targetAgents?: string[];
  /** Budget cap on total discount spend (minor units). Undefined = unlimited. */
  budgetMinor?: number;
  /** Accumulated discount spend (minor units), maintained by the orchestrator. */
  spentMinor?: number;
  /** Higher priority wins when multiple campaigns match a line. Default 0. */
  priority?: number;
  /** FLASH_SALE: absolute floor price (minor) a line can never drop below. */
  flashPriceMinor?: number;
  /** TIERED_DISCOUNT: escalating thresholds (see resolveCampaignForLine). */
  tiers?: CampaignTier[];
  /** When false (default), this campaign claims the whole line over others. */
  stackable?: boolean;
  /** A/B experiment tag for reporting. */
  abGroup?: "A" | "B";
  /** Restrict when the campaign is live to specific UTC weekdays (0=Sun..6). */
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
const MAX_DISCOUNT_BPS = 4000; // Merchant never configures >40% promo off.

/**
 * Pure. Decide whether a campaign is live right now (status active AND within
 * its validity window AND today is an allowed schedule day). Deterministic, no
 * DB/clock side effects other than the supplied `now`.
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
    return campaign.scheduleDays.includes(now.getUTCDay());
  }
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
    if (campaign.type === "BUNDLE_DISCOUNT") continue; // bundle-level only

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

    // AGENT_TARGETED requires the buying agent to be allow-listed.
    if (
      campaign.type === "AGENT_TARGETED" &&
      campaign.targetAgents &&
      campaign.targetAgents.length > 0 &&
      (!agentId || !campaign.targetAgents.includes(agentId))
    ) {
      continue;
    }

    let bps = campaign.discountBps;

    // TIERED_DISCOUNT picks the highest tier the order subtotal clears.
    if (campaign.type === "TIERED_DISCOUNT" && campaign.tiers?.length) {
      const cleared = campaign.tiers.find(
        (t) =>
          orderSubtotalMinor === undefined ||
          orderSubtotalMinor >= t.minOrderMinor,
      );
      if (cleared) bps = cleared.discountBps;
    }

    let discounted = applyBps(basePriceMinor, bps);

    // FLASH_SALE: keep the price at or above the configured floor price (a
    // floor is a lower bound — the promo can't discount below it).
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

    // Stacking: a non-stackable campaign always claims the line outright. A
    // stackable one only applies if the current best is also stackable (or we
    // have no best). Ties resolved by priority, then by higher bps.
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

function readCampaigns(config?: Record<string, unknown> | null): Campaign[] {
  if (!Array.isArray(config?.campaigns)) return [];
  return config.campaigns as Campaign[];
}

const DEFAULT_CAMPAIGNS: Array<
  Omit<Campaign, "id" | "createdAt" | "startsAt" | "endsAt" | "status">
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
  {
    name: "Desk Setup Bundle",
    description:
      "Buy 2+ accessories together and get an extra 7% off the bundle — learnable checkout basket builder.",
    type: "BUNDLE_DISCOUNT",
    variantIds: [
      "acc_nimbus_deskmat",
      "acc_nimbus_switch_set",
      "acc_headphone_stand",
      "acc_nimbus_stand_alu",
      "acc_lap_sleeve",
    ],
    discountBps: 700,
    targetAudience: "AI buyer agents building complete desk setups",
  },
];

function buildCampaignWindow(): { startsAt: string; endsAt: string } {
  const now = new Date();
  const startsAt = new Date(now.getTime() - 60 * 1000);
  const endsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
}

async function getMerchant() {
  const [merchant] = await db
    .select()
    .from(merchants)
    .where(eq(merchants.id, MERCHANT_ID))
    .limit(1);
  return merchant ?? null;
}

async function saveCampaigns(campaigns: Campaign[]): Promise<Campaign[]> {
  const merchant = await getMerchant();
  if (!merchant) throw new Error("Merchant not found");

  const config = (merchant.config as Record<string, unknown>) || {};
  await db
    .update(merchants)
    .set({ config: { ...config, campaigns } })
    .where(eq(merchants.id, MERCHANT_ID));

  return campaigns;
}

/** Lazy-seed the demo campaigns the first time the orchestrator is used. */
export async function ensureDefaultCampaigns(): Promise<Campaign[]> {
  const merchant = await getMerchant();
  if (!merchant) return [];

  const config = (merchant.config as Record<string, unknown>) || {};
  const existing = readCampaigns(config);
  if (existing.length > 0) return existing;

  const nowIso = new Date().toISOString();
  const campaigns: Campaign[] = DEFAULT_CAMPAIGNS.map((c) => {
    const w = buildCampaignWindow();
    return {
      ...c,
      id: generateId("cmp"),
      status: "active",
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      createdAt: nowIso,
    };
  });

  await saveCampaigns(campaigns);
  return campaigns;
}

export async function listCampaigns(): Promise<Campaign[]> {
  const campaigns = await ensureDefaultCampaigns();
  return campaigns.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

export async function getActiveCampaigns(
  now: Date = new Date(),
): Promise<Campaign[]> {
  const all = await ensureDefaultCampaigns();
  return all.filter((c) => isCampaignLive(c, now));
}

function clampDiscount(bps: number): number {
  return Math.max(0, Math.min(MAX_DISCOUNT_BPS, Math.round(Number(bps) || 0)));
}

/** Validate the new-type specific payloads and derive a default bps. */
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
  const existing = await ensureDefaultCampaigns();
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

  const campaign: Campaign = {
    id: generateId("cmp"),
    name: input.name,
    description: input.description,
    type: input.type,
    category: input.category,
    variantIds: Array.isArray(input.variantIds)
      ? input.variantIds.map(String)
      : undefined,
    discountBps,
    tiers,
    minOrderMinor:
      Number(input.minOrderMinor) > 0
        ? Math.round(Number(input.minOrderMinor))
        : undefined,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    status: "active",
    targetAudience: input.targetAudience,
    targetAgents: Array.isArray(input.targetAgents)
      ? input.targetAgents.map(String)
      : undefined,
    budgetMinor:
      Number(input.budgetMinor) > 0
        ? Math.round(Number(input.budgetMinor))
        : undefined,
    spentMinor: 0,
    priority: Number.isFinite(Number(input.priority))
      ? Math.round(Number(input.priority))
      : 0,
    stackable: input.stackable === true,
    flashPriceMinor:
      Number(input.flashPriceMinor) > 0
        ? Math.round(Number(input.flashPriceMinor))
        : undefined,
    scheduleDays: Array.isArray(input.scheduleDays)
      ? input.scheduleDays.map(Number).filter((d) => d >= 0 && d <= 6)
      : undefined,
    abGroup:
      input.abGroup === "A" || input.abGroup === "B"
        ? input.abGroup
        : undefined,
    createdAt: new Date().toISOString(),
  };

  await saveCampaigns([campaign, ...existing].slice(0, MAX_CAMPAIGNS));
  return campaign;
}

export async function updateCampaign(
  campaignId: string,
  patch: Partial<Omit<Campaign, "id" | "createdAt">>,
): Promise<Campaign | null> {
  const existing = await ensureDefaultCampaigns();
  const target = existing.find((c) => c.id === campaignId);
  if (!target) return null;

  const updated = existing.map((c) => {
    if (c.id !== campaignId) return c;
    const next: Campaign = {
      ...c,
      ...patch,
      id: c.id,
      createdAt: c.createdAt,
      updatedAt: new Date().toISOString(),
      discountBps: clampDiscount(
        patch.discountBps !== undefined ? patch.discountBps : c.discountBps,
      ),
    };
    return next;
  });

  await saveCampaigns(updated);
  return updated.find((c) => c.id === campaignId) ?? null;
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
  const existing = await ensureDefaultCampaigns();
  const target = existing.find((c) => c.id === campaignId);
  if (!target) return null;

  const updated = existing.map((c) =>
    c.id === campaignId
      ? {
          ...c,
          status: "ended" as const,
          endsAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
      : c,
  );
  await saveCampaigns(updated);
  return updated.find((c) => c.id === campaignId) ?? null;
}

export async function deleteCampaign(campaignId: string): Promise<boolean> {
  const existing = await ensureDefaultCampaigns();
  const target = existing.find((c) => c.id === campaignId);
  if (!target) return false;
  await saveCampaigns(existing.filter((c) => c.id !== campaignId));
  return true;
}

/**
 * Persist discount spend for one or more campaigns (called once per payment
 * intent so budgets are consumed authoritatively when an order becomes
 * payable). Idempotent-per-call: simply adds `discountMinor` to spentMinor.
 */
export async function recordCampaignSpend(
  spends: Array<{ campaignId: string; discountMinor: number }>,
): Promise<void> {
  const clean = spends.filter(
    (s) => s.campaignId && Number(s.discountMinor) > 0,
  );
  if (clean.length === 0) return;

  const existing = await ensureDefaultCampaigns();
  const byId = new Map(clean.map((s) => [s.campaignId, s.discountMinor]));
  const updated = existing.map((c) => {
    if (!byId.has(c.id)) return c;
    return { ...c, spentMinor: (c.spentMinor ?? 0) + byId.get(c.id)! };
  });

  await saveCampaigns(updated);
}

// ---------------------------------------------------------------- analytics

export interface CampaignPerformance {
  campaign: Campaign;
  orders: number;
  unitsSold: number;
  revenueMinor: number;
  discountSpendMinor: number;
  roiBps: number; // discount spend as a share of revenue (per-10000)
  liveNow: boolean;
  budgetRemainingMinor: number | null;
  budgetPercentUsed: number | null;
}

/**
 * Compute per-campaign performance from the audit trail. Order-scoped audit
 * events carry a `campaignsApplied` list (id + name + discountBps) in their
 * metadata, captured when the quote was generated. Aggregates across the
 * supplied event window.
 */
export async function getCampaignPerformance(
  campaignId?: string,
): Promise<CampaignPerformance[]> {
  const campaigns = await listCampaigns();
  const now = new Date();

  const events = await db
    .select()
    .from(auditEvents)
    .where(
      inArray(auditEvents.event_type, [
        "checkout_quote_generated",
        "payment_succeeded",
      ]),
    );

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
      if (event.event_type === "checkout_quote_generated") {
        perf.orders += 1;
        perf.revenueMinor += grandTotal;
        perf.unitsSold += Number(entry.quantity) || 1;
        perf.discountSpendMinor += Number(entry.discountMinor) || 0;
      } else if (event.event_type === "payment_succeeded") {
        perf.orders += 1;
        perf.revenueMinor += grandTotal;
        perf.unitsSold += Number(entry.quantity) || 1;
        perf.discountSpendMinor += Number(entry.discountMinor) || 0;
      }
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
