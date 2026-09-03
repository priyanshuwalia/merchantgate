import { eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, merchants, products } from "@/db";
import { callLlm } from "@/lib/ai/llm";
import type { AiConfigInput } from "@/lib/ai/provider";
import { logAuditEvent } from "@/lib/audit/logger";
import { authenticateAgentRequest } from "@/lib/auth/agent-auth";
import { getMerchantAgentRules } from "@/lib/merchant/agent";
import {
  aiSalesPausedResponse,
  getMerchantGateState,
} from "@/lib/merchant/guard";
import {
  getNegotiationSession,
  type NegotiationItem,
  openNegotiation,
  respondToCounter,
} from "@/lib/merchant/negotiation";
import {
  hydrateRuntimeState,
  persistRuntimeState,
} from "@/lib/merchant/runtime-state";
import { isSurgePricingActive } from "@/lib/merchant/surge";
import { generateTraceId } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * When the merchant has configured an AI model, the merchant negotiating
 * agent phrases its replies with it. The deterministic engine still owns ALL
 * commercial terms (discount bps, outcome, approval flag) — the LLM only
 * provides the natural-language voice for those fixed terms.
 */
function negotiatorVoicePrompt(agentName: string): string {
  return `You are "${agentName}", the automated sales negotiator for an online electronics store, talking to an AI buyer agent over a structured commerce protocol.

You will receive the negotiation transcript and the FINAL decided terms (they are non-negotiable and computed by the store's pricing engine).

Write your reply as ${agentName}:
- Maximum 2 short sentences, professional, warm but firm.
- You MUST state exactly the decided discount percentage and unit price given to you. Never invent, round, or renegotiate numbers.
- If the outcome is REJECTED or AGREED, make that unambiguous.
- Output plain text only. No markdown, no lists, no quotes around the whole message.`;
}

function buyerGuidancePrompt(): string {
  return `You are advising an AI buyer agent mid-negotiation. Given the transcript and the merchant's latest decided terms, produce ONE short coaching sentence (max 25 words) telling the buyer agent what it can do next (accept / counter within limits / walk away). Plain text only.`;
}

function stripFences(text: string): string {
  return text
    .replace(/```[a-z]*[\s\S]*?```/g, "")
    .replace(/```/g, "")
    .trim();
}

/**
 * POST /v1/agent/negotiate
 *
 * Agent-to-agent negotiation protocol between the AI buyer agent and the
 * merchant's negotiating agent. Deterministic engine; rules are merchant-owned.
 *
 * Body (action = "open"):
 *   { action: "open", items: [{variantId, quantity}], buyerMessage?, agentId? }
 * Body (action = "respond"):
 *   { action: "respond", sessionId, targetDiscountBps?, acceptCurrentOffer?, buyerMessage? }
 */
export async function POST(request: Request) {
  const traceId = generateTraceId();

  try {
    const body = await request.json();
    const action = body.action as "open" | "respond";

    const merchantId = "mch_nimbus_gear_001";
    const [merchant] = await db
      .select()
      .from(merchants)
      .where(eq(merchants.id, merchantId))
      .limit(1);

    if (!merchant) {
      return NextResponse.json(
        { success: false, error: "Merchant not found" },
        { status: 404 },
      );
    }

    const merchantConfig = (merchant.config as Record<string, unknown>) || {};
    const gate = await getMerchantGateState();
    if (!gate.aiSalesEnabled) {
      return aiSalesPausedResponse({ endpoint: "/v1/agent/negotiate" });
    }

    // Agent authentication + rate limiting (C7), then rehydrate runtime state
    // so negotiation sessions survive restarts and span instances (C8).
    const auth = await authenticateAgentRequest(request, { merchantConfig });
    if (!auth.ok && auth.response) return auth.response;
    await hydrateRuntimeState();

    const rules = getMerchantAgentRules(merchantConfig);
    const surgeActive = isSurgePricingActive();

    let result:
      | ReturnType<typeof openNegotiation>
      | ReturnType<typeof respondToCounter>;

    if (action === "open") {
      const requestedItems = body.items as Array<{
        variantId: string;
        quantity?: number;
      }>;
      if (!requestedItems?.length) {
        return NextResponse.json(
          {
            success: false,
            error: "items array with at least one variantId is required",
          },
          { status: 400 },
        );
      }

      const variantIds = requestedItems.map((i) => i.variantId);
      const dbProducts = await db
        .select()
        .from(products)
        .where(inArray(products.variant_id, variantIds));
      const productMap = new Map(dbProducts.map((p) => [p.variant_id, p]));

      const items: NegotiationItem[] = [];
      for (const item of requestedItems) {
        const dbProduct = productMap.get(item.variantId);
        if (!dbProduct) {
          return NextResponse.json(
            {
              success: false,
              error: `Product variant not found: ${item.variantId}`,
            },
            { status: 404 },
          );
        }
        const quantity = Math.max(1, Number(item.quantity) || 1);
        const unitAmountMinor = surgeActive
          ? Math.round(dbProduct.base_price_minor * 1.15)
          : dbProduct.base_price_minor;

        items.push({
          variantId: dbProduct.variant_id,
          title: dbProduct.title,
          category: dbProduct.category,
          quantity,
          unitAmountMinor,
        });
      }

      result = openNegotiation(
        items,
        String(body.agentId || "agt_buyer_unknown"),
        body.buyerMessage,
        rules,
      );

      if ("session" in result) {
        await logAuditEvent({
          traceId,
          actorType: "agent",
          actorId: result.session.agentId,
          eventType: "negotiation_opened",
          explanation: `Buyer agent opened negotiation ${result.session.id}. Merchant outcome: ${result.evaluation.outcome} @ ${result.evaluation.discountBps} bps.`,
          metadata: {
            sessionId: result.session.id,
            outcome: result.evaluation.outcome,
            discountBps: result.evaluation.discountBps,
            reasonCodes: result.evaluation.reasonCodes,
            items: result.session.items,
            surgeActive,
            agentAuthMode: auth.mode,
            rateLimitRemaining: auth.rateLimitInfo.remaining,
          },
        });
      }
    } else if (action === "respond") {
      const sessionBefore = getNegotiationSession(String(body.sessionId || ""));
      if (!sessionBefore) {
        return NextResponse.json(
          { success: false, error: "NEGOTIATION_SESSION_NOT_FOUND_OR_EXPIRED" },
          { status: 404 },
        );
      }

      result = respondToCounter(
        String(body.sessionId),
        Number(body.targetDiscountBps) || 0,
        Boolean(body.acceptCurrentOffer),
        body.buyerMessage,
        rules,
      );

      if ("error" in result) {
        return NextResponse.json(
          { success: false, error: result.error },
          { status: 409 },
        );
      }

      await logAuditEvent({
        traceId,
        actorType: "agent",
        actorId: sessionBefore.agentId,
        eventType: "negotiation_round",
        explanation: `Negotiation round ${result.session.round}: ${result.evaluation.outcome} @ ${result.evaluation.discountBps} bps.`,
        metadata: {
          sessionId: result.session.id,
          round: result.session.round,
          outcome: result.evaluation.outcome,
          discountBps: result.evaluation.discountBps,
          requiresMerchantApproval: result.evaluation.requiresMerchantApproval,
          reasonCodes: result.evaluation.reasonCodes,
        },
      });
    } else {
      return NextResponse.json(
        { success: false, error: "action must be 'open' or 'respond'" },
        { status: 400 },
      );
    }

    if (!("session" in result)) {
      return NextResponse.json(
        { success: false, error: "Negotiation failed" },
        { status: 500 },
      );
    }

    const { session, evaluation } = result;
    let finalMerchantMessage = evaluation.merchantMessage;
    let finalBuyerGuidance = evaluation.buyerGuidance;

    // Voice the merchant agent with the merchant's own configured model
    const merchantAi =
      (merchantConfig.ai as AiConfigInput | undefined) || undefined;
    if (merchantAi?.apiKey) {
      const voicePrimaryItem = [...session.items].sort(
        (a, b) => b.quantity - a.quantity,
      )[0];
      const discountedUnitMinor = Math.round(
        (voicePrimaryItem.unitAmountMinor * (10000 - evaluation.discountBps)) /
          10000,
      );
      const transcriptText = session.transcript
        .map((t) => `${t.actor}: ${t.message}`)
        .join("\n")
        .slice(-1600);

      const [voiceOut, guidanceOut] = await Promise.all([
        callLlm(
          [
            { role: "system", content: negotiatorVoicePrompt(rules.agentName) },
            {
              role: "user",
              content: `Negotiation transcript:\n${transcriptText}\n\nDECIDED TERMS (fixed): outcome=${evaluation.outcome}, discount=${(evaluation.discountBps / 100).toFixed(1)}%, list unit price=₹${(voicePrimaryItem.unitAmountMinor / 100).toFixed(2)}, discounted unit price=₹${(discountedUnitMinor / 100).toFixed(2)}. Write your reply.`,
            },
          ],
          { ...merchantAi, temperature: 0.5, timeoutMs: 8_000 },
        ),
        callLlm(
          [
            { role: "system", content: buyerGuidancePrompt() },
            {
              role: "user",
              content: `Transcript:\n${transcriptText}\n\nMerchant decision: ${evaluation.outcome} at ${(evaluation.discountBps / 100).toFixed(1)}% off. Rounds left: ${Math.max(0, session.maxRounds - session.round)}.`,
            },
          ],
          { ...merchantAi, temperature: 0.4, timeoutMs: 8_000 },
        ),
      ]);

      if (voiceOut && voiceOut.trim().length > 0) {
        finalMerchantMessage = `${rules.agentName}: ${stripFences(voiceOut)}`;
        // Keep stored transcript consistent with what was actually said
        if (session.transcript.length > 0) {
          session.transcript[session.transcript.length - 1].message =
            finalMerchantMessage;
        }
      }
      if (guidanceOut && guidanceOut.trim().length > 0) {
        finalBuyerGuidance = stripFences(guidanceOut);
      }
    }

    // Persist the session (and surge state) so it survives restarts (C8).
    await persistRuntimeState();

    const primaryItem = [...session.items].sort(
      (a, b) => b.quantity - a.quantity,
    )[0];
    const agreedUnitAmountMinor =
      primaryItem.unitAmountMinor -
      Math.round(
        (primaryItem.unitAmountMinor * evaluation.discountBps) / 10000,
      );

    return NextResponse.json({
      success: true,
      sessionId: session.id,
      outcome: evaluation.outcome,
      round: session.round,
      roundsRemaining: Math.max(0, session.maxRounds - session.round),
      discountBps: evaluation.discountBps,
      listUnitAmountMinor: primaryItem.unitAmountMinor,
      agreedUnitAmountMinor,
      lineSavingsMinor: Math.round(
        (primaryItem.unitAmountMinor - agreedUnitAmountMinor) *
          primaryItem.quantity,
      ),
      requiresMerchantApproval: evaluation.requiresMerchantApproval,
      merchantMessage: finalMerchantMessage,
      buyerGuidance: finalBuyerGuidance,
      reasonCodes: evaluation.reasonCodes,
      status: session.status,
      transcript: session.transcript,
    });
  } catch (error) {
    console.error("Error in negotiate endpoint:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Internal server error during negotiation",
      },
      { status: 500 },
    );
  }
}
