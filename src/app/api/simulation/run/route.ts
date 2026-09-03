import { type NextRequest, NextResponse } from "next/server";
import type { AiConfigInput } from "@/lib/ai/provider";
import { requireMerchantAuth } from "@/lib/auth/guard";
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
        result = await runner.run(scenario);
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
