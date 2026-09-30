import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db, merchants } from "@/db";
import type { AiConfigInput } from "@/lib/ai/provider";
import { requireMerchantAuth } from "@/lib/auth/guard";
import { rateLimitRequest } from "@/lib/auth/rate-limit";
import { DEFAULT_MERCHANT_ID } from "@/lib/merchant/tenant";
import { SimulatedBuyerAgent } from "@/lib/simulation/buyer-agent";
import {
  type CustomSimulationConfig,
  type SimulationResult,
  SimulationRunner,
} from "@/lib/simulation/runner";
import { PRESET_SCENARIOS, type Scenario } from "@/lib/simulation/scenarios";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = requireMerchantAuth(request);
  if (auth instanceof NextResponse) return auth;

  // Runs are expensive (full agent negotiation + possible LLM calls) — cap
  // concurrent abuse from any one client.
  const limited = rateLimitRequest(request, {
    namespace: "simulation-run",
    limit: Number(process.env.RATE_LIMIT_SIMULATION_RUN) || 20,
  });
  if (limited) return limited;

  try {
    const body = await request.json().catch(() => ({}));
    const scenarioId = body.scenarioId || "happyPath";
    const customConfig: CustomSimulationConfig | undefined = body.customConfig;
    const customScenario: Scenario | undefined = body.customScenario;

    // Buyer-side LLM (user-provided key/model) powers genuine agent dialogue
    const llm: AiConfigInput | undefined = body.llm
      ? {
          provider: body.llm.provider,
          model: body.llm.model,
          apiKey: body.llm.apiKey,
          baseUrl: body.llm.baseUrl,
        }
      : undefined;

    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.host}`;

    const agent = new SimulatedBuyerAgent({
      agentId: customConfig?.agentId || body.agentId || "agt_apollo_buyer_v1",
      userId: customConfig?.userId || body.userId || "user_demo_shopper",
      intentMandate: body.intentMandate,
      // The sandbox issues no agent API keys, so settlement authorizes via the
      // operator's merchant session. This route is already session-guarded, so
      // forwarding the cookie lets the server-side buyer agent settle exactly as
      // the browser-side one does.
      cookie: request.headers.get("cookie") ?? undefined,
    });

    const runner = new SimulationRunner(agent, baseUrl, llm);

    let result: SimulationResult;
    if (customConfig) {
      result = await runner.runAutonomous(customConfig);
    } else {
      const scenario =
        customScenario ||
        PRESET_SCENARIOS[scenarioId] ||
        PRESET_SCENARIOS.happyPath;
      if (scenario.autonomousConfig) {
        // Negotiation scenarios run through the autonomous runner so real
        // agent-to-agent protocol calls (open → counter → accept) execute.
        result = await runner.runAutonomous({
          ...scenario.autonomousConfig,
          agentId: body.agentId,
          userId: body.userId,
        });
      } else {
        result = await withRail(scenario, () => runner.run(scenario));
      }
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error executing simulation:", error);
    return NextResponse.json(
      { error: "Internal error executing simulation" },
      { status: 500 },
    );
  }
}

/**
 * The gateway is single-tenant against the default (demonstration) merchant.
 * Scenarios may declare the settlement rail they describe: for the duration of
 * the run we switch that merchant's `paymentProvider` (e.g. a Stripe scenario
 * must quote + settle on the Stripe rail) and restore the previous value
 * afterwards — even when the run throws.
 */
async function withRail<T>(
  scenario: Scenario,
  run: () => Promise<T>,
): Promise<T> {
  const rail = scenario.paymentProvider;
  if (!rail) return run();

  const [merchant] = await db
    .select({ config: merchants.config })
    .from(merchants)
    .where(eq(merchants.id, DEFAULT_MERCHANT_ID))
    .limit(1);

  const prevConfig = (merchant?.config || {}) as Record<string, unknown>;
  const prevRail = prevConfig.paymentProvider as string | undefined;

  if (prevRail !== rail) {
    await db
      .update(merchants)
      .set({
        config: { ...prevConfig, paymentProvider: rail },
        updated_at: new Date(),
      })
      .where(eq(merchants.id, DEFAULT_MERCHANT_ID));
  }

  try {
    return await run();
  } finally {
    if (prevRail !== rail && prevRail) {
      await db
        .update(merchants)
        .set({
          config: { ...prevConfig, paymentProvider: prevRail },
          updated_at: new Date(),
        })
        .where(eq(merchants.id, DEFAULT_MERCHANT_ID));
    }
  }
}
