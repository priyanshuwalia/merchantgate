import { type NextRequest, NextResponse } from "next/server";
import { logAuditEvent } from "@/lib/audit/logger";
import { requireMerchantAuth } from "@/lib/auth/guard";
import {
  type Campaign,
  type CampaignType,
  deleteCampaign,
  endCampaign,
  getCampaignPerformance,
  listCampaigns,
  pauseCampaign,
  resumeCampaign,
  standUpCampaign,
  updateCampaign,
} from "@/lib/merchant/campaigns";
import { generateTraceId } from "@/lib/utils";

export const dynamic = "force-dynamic";

const CAMPAIGN_TYPES: CampaignType[] = [
  "CATEGORY_DISCOUNT",
  "FLAT_DISCOUNT",
  "BUNDLE_DISCOUNT",
  "FLASH_SALE",
  "TIERED_DISCOUNT",
  "AGENT_TARGETED",
];

const CAMPAIGN_STATUSES: Campaign["status"][] = [
  "draft",
  "active",
  "paused",
  "ended",
];

/**
 * GET /api/merchant/campaigns — list campaigns (optionally + analytics).
 *   ?analytics=1 → include per-campaign performance computed from audit_events.
 *   ?id=…        → performance for a single campaign.
 * POST           → stand up a new campaign.
 * PATCH          → update a campaign (editable fields & pause/resume status).
 * DELETE         → end a campaign (or hard-delete with ?delete=true).
 */
export async function GET(request: NextRequest) {
  const auth = requireMerchantAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const wantAnalytics = searchParams.get("analytics") === "1";
    const id = searchParams.get("id") || undefined;

    const campaigns = await listCampaigns();
    if (wantAnalytics) {
      const performance = await getCampaignPerformance(id);
      return NextResponse.json({
        success: true,
        total: performance.length,
        active: performance.filter((p) => p.liveNow).length,
        performance,
      });
    }

    return NextResponse.json({
      success: true,
      total: campaigns.length,
      active: campaigns.filter((c) => c.status === "active").length,
      campaigns: campaigns.map((c) => ({
        ...c,
        liveNow: c.status === "active",
      })),
    });
  } catch (error) {
    console.error("Error listing campaigns:", error);
    return NextResponse.json(
      { error: "Failed to list campaigns" },
      { status: 500 },
    );
  }
}

function parseTiers(body: Record<string, unknown>) {
  if (!Array.isArray(body.tiers)) return undefined;
  return body.tiers
    .map((t) => ({
      minOrderMinor: Number((t as Record<string, unknown>).minOrderMinor) || 0,
      discountBps: Number((t as Record<string, unknown>).discountBps) || 0,
    }))
    .filter((t) => t.minOrderMinor > 0);
}

export async function POST(request: NextRequest) {
  const auth = requireMerchantAuth(request);
  if (auth instanceof NextResponse) return auth;

  const traceId = generateTraceId();

  try {
    const body = await request.json().catch(() => ({}));

    const type = String(body.type || "").toUpperCase() as CampaignType;
    if (!CAMPAIGN_TYPES.includes(type)) {
      return NextResponse.json(
        { error: `type must be one of: ${CAMPAIGN_TYPES.join(", ")}` },
        { status: 400 },
      );
    }
    const name = String(body.name || "").trim();
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const discountBps = Number(body.discountBps);
    if (type !== "TIERED_DISCOUNT") {
      if (
        !Number.isFinite(discountBps) ||
        discountBps < 0 ||
        discountBps > 4000
      ) {
        return NextResponse.json(
          { error: "discountBps must be between 0 and 4000" },
          { status: 400 },
        );
      }
    }

    const campaign = await standUpCampaign({
      name,
      type,
      category: body.category ? String(body.category) : undefined,
      variantIds: Array.isArray(body.variantIds)
        ? body.variantIds.map(String)
        : undefined,
      discountBps: type === "TIERED_DISCOUNT" ? undefined : discountBps,
      tiers: parseTiers(body),
      minOrderMinor: body.minOrderMinor
        ? Number(body.minOrderMinor)
        : undefined,
      durationDays: body.durationDays ? Number(body.durationDays) : undefined,
      startsAt: body.startsAt ? String(body.startsAt) : undefined,
      endsAt: body.endsAt ? String(body.endsAt) : undefined,
      targetAudience: body.targetAudience
        ? String(body.targetAudience)
        : undefined,
      description: body.description ? String(body.description) : undefined,
      targetAgents: Array.isArray(body.targetAgents)
        ? body.targetAgents.map(String)
        : undefined,
      budgetMinor: body.budgetMinor ? Number(body.budgetMinor) : undefined,
      priority: body.priority !== undefined ? Number(body.priority) : undefined,
      stackable: body.stackable === true,
      flashPriceMinor: body.flashPriceMinor
        ? Number(body.flashPriceMinor)
        : undefined,
      scheduleDays: Array.isArray(body.scheduleDays)
        ? body.scheduleDays.map(Number)
        : undefined,
      abGroup:
        body.abGroup === "A" || body.abGroup === "B" ? body.abGroup : undefined,
    });

    await logAuditEvent({
      traceId,
      actorType: "merchant",
      actorId: "merchant_admin",
      eventType: "campaign_created",
      explanation: `Merchant stood up campaign "${campaign.name}" (${campaign.type}, ${campaign.discountBps} bps) valid until ${campaign.endsAt}.`,
      metadata: {
        campaignId: campaign.id,
        type: campaign.type,
        discountBps: campaign.discountBps,
        category: campaign.category || null,
        variantIds: campaign.variantIds || [],
        startsAt: campaign.startsAt,
        endsAt: campaign.endsAt,
        budgetMinor: campaign.budgetMinor ?? null,
        priority: campaign.priority ?? 0,
      },
    });

    return NextResponse.json({ success: true, campaign }, { status: 201 });
  } catch (error) {
    console.error("Error creating campaign:", error);
    return NextResponse.json(
      { error: "Failed to create campaign" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  const auth = requireMerchantAuth(request);
  if (auth instanceof NextResponse) return auth;

  const traceId = generateTraceId();

  try {
    const body = await request.json().catch(() => ({}));
    const campaignId = String(body.campaignId || "");
    if (!campaignId) {
      return NextResponse.json(
        { error: "campaignId is required" },
        { status: 400 },
      );
    }

    // Quick lifecycle transitions.
    if (body.action === "pause") {
      const updated = await pauseCampaign(campaignId);
      if (!updated) {
        return NextResponse.json(
          { error: "Campaign not found" },
          { status: 404 },
        );
      }
      await logAuditEvent({
        traceId,
        actorType: "merchant",
        actorId: "merchant_admin",
        eventType: "campaign_paused",
        explanation: `Merchant paused campaign "${updated.name}".`,
        metadata: { campaignId: updated.id },
      });
      return NextResponse.json({ success: true, campaign: updated });
    }
    if (body.action === "resume") {
      const updated = await resumeCampaign(campaignId);
      if (!updated) {
        return NextResponse.json(
          { error: "Campaign not found" },
          { status: 404 },
        );
      }
      await logAuditEvent({
        traceId,
        actorType: "merchant",
        actorId: "merchant_admin",
        eventType: "campaign_resumed",
        explanation: `Merchant resumed campaign "${updated.name}".`,
        metadata: { campaignId: updated.id },
      });
      return NextResponse.json({ success: true, campaign: updated });
    }

    const patch: Partial<Omit<Campaign, "id" | "createdAt">> = {};
    if (
      body.status &&
      CAMPAIGN_STATUSES.includes(body.status as Campaign["status"])
    ) {
      patch.status = body.status as Campaign["status"];
    }
    if (body.name !== undefined) patch.name = String(body.name);
    if (body.description !== undefined)
      patch.description = String(body.description);
    if (body.category !== undefined) patch.category = String(body.category);
    if (body.discountBps !== undefined)
      patch.discountBps = Number(body.discountBps);
    if (body.minOrderMinor !== undefined)
      patch.minOrderMinor = Number(body.minOrderMinor);
    if (body.budgetMinor !== undefined)
      patch.budgetMinor = Number(body.budgetMinor);
    if (body.priority !== undefined) patch.priority = Number(body.priority);
    if (body.flashPriceMinor !== undefined)
      patch.flashPriceMinor = Number(body.flashPriceMinor);
    if (body.targetAudience !== undefined)
      patch.targetAudience = String(body.targetAudience);
    if (Array.isArray(body.targetAgents))
      patch.targetAgents = body.targetAgents.map(String);
    if (Array.isArray(body.variantIds))
      patch.variantIds = body.variantIds.map(String);
    if (body.startsAt !== undefined) patch.startsAt = String(body.startsAt);
    if (body.endsAt !== undefined) patch.endsAt = String(body.endsAt);
    if (Array.isArray(body.scheduleDays))
      patch.scheduleDays = body.scheduleDays.map(Number);
    if (body.stackable !== undefined) patch.stackable = body.stackable === true;
    if (body.abGroup === "A" || body.abGroup === "B")
      patch.abGroup = body.abGroup;
    if (body.tiers !== undefined) patch.tiers = parseTiers(body);

    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { error: "No editable fields provided" },
        { status: 400 },
      );
    }

    const updated = await updateCampaign(campaignId, patch);
    if (!updated) {
      return NextResponse.json(
        { error: "Campaign not found" },
        { status: 404 },
      );
    }
    await logAuditEvent({
      traceId,
      actorType: "merchant",
      actorId: "merchant_admin",
      eventType: "campaign_updated",
      explanation: `Merchant updated campaign "${updated.name}" (${Object.keys(patch).join(", ")}).`,
      metadata: { campaignId: updated.id, fields: Object.keys(patch) },
    });
    return NextResponse.json({ success: true, campaign: updated });
  } catch (error) {
    console.error("Error updating campaign:", error);
    return NextResponse.json(
      { error: "Failed to update campaign" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const auth = requireMerchantAuth(request);
  if (auth instanceof NextResponse) return auth;

  const traceId = generateTraceId();

  try {
    const body = await request.json().catch(() => ({}));
    const campaignId = String(body.campaignId || "");
    if (!campaignId) {
      return NextResponse.json(
        { error: "campaignId is required" },
        { status: 400 },
      );
    }

    const hardDelete = body.delete === true;
    if (hardDelete) {
      const ok = await deleteCampaign(campaignId);
      if (!ok) {
        return NextResponse.json(
          { error: "Campaign not found" },
          { status: 404 },
        );
      }
      await logAuditEvent({
        traceId,
        actorType: "merchant",
        actorId: "merchant_admin",
        eventType: "campaign_deleted",
        explanation: `Merchant permanently deleted campaign ${campaignId}.`,
        metadata: { campaignId },
      });
      return NextResponse.json({ success: true, deleted: true });
    }

    const ended = await endCampaign(campaignId);
    if (!ended) {
      return NextResponse.json(
        { error: "Campaign not found" },
        { status: 404 },
      );
    }
    await logAuditEvent({
      traceId,
      actorType: "merchant",
      actorId: "merchant_admin",
      eventType: "campaign_ended",
      explanation: `Merchant ended campaign "${ended.name}" (${ended.id}).`,
      metadata: { campaignId: ended.id, name: ended.name },
    });
    return NextResponse.json({ success: true, campaign: ended });
  } catch (error) {
    console.error("Error ending campaign:", error);
    return NextResponse.json(
      { error: "Failed to end campaign" },
      { status: 500 },
    );
  }
}
