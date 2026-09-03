import { SimulatedBuyerAgent } from "../lib/simulation/buyer-agent";
import { SimulationRunner } from "../lib/simulation/runner";
import { PRESET_SCENARIOS } from "../lib/simulation/scenarios";

async function testSimulationScenarios() {
  console.log(
    "\n🤖 Running AgentPay Simulation Engine Test Across All 4 Scenarios...\n",
  );

  const agent = new SimulatedBuyerAgent();
  const runner = new SimulationRunner(agent, "http://localhost:3000");

  for (const [key, scenario] of Object.entries(PRESET_SCENARIOS)) {
    console.log(`▶️ Executing [${scenario.name}]...`);
    const result = await runner.run(scenario);
    console.log(`   Trace ID: ${result.traceId}`);
    console.log(
      `   Final Policy Decision: [${result.finalDecision}] (Expected: [${result.expectedDecision}])`,
    );
    console.log(
      `   Steps Executed: ${result.events.length} | Latency: ${result.totalDurationMs}ms`,
    );
    console.log(`   Result: ${result.success ? "✅ SUCCESS" : "❌ FAILED"}\n`);

    if (!result.success) {
      throw new Error(
        `Scenario ${key} failed to achieve expected decision ${scenario.expectedDecision}`,
      );
    }
  }

  console.log("🌟 ALL 4 SIMULATION SCENARIOS PASSED CONFORMANCE TESTS!\n");
}

testSimulationScenarios().catch((err) => {
  console.error(err);
  process.exit(1);
});
