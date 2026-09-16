"use client";

import { Bot, Cpu } from "lucide-react";
import { useState } from "react";
import { InventoryAgentConsole } from "@/components/sandbox/inventory-agent-console";
import { SimulationRunner } from "@/components/sandbox/simulation-runner";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * Agent Sandbox — intentional, externally visible testing surface for the
 * agent-commerce protocol. Exercises the same public API and policy engine the
 * live agent gateway serves, so this is a demo/QA surface, not a toy.
 */

export default function SandboxPage() {
  const [tab, setTab] = useState("runner");

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <TabsList>
            <TabsTrigger value="runner" className="gap-1.5 text-xs">
              <Cpu className="h-3.5 w-3.5" />
              Scenario Runner
            </TabsTrigger>
            <TabsTrigger value="inventory" className="gap-1.5 text-xs">
              <Bot className="h-3.5 w-3.5" />
              Inventory Agent
            </TabsTrigger>
          </TabsList>
        </div>
        <Badge variant="outline" className="gap-1.5 text-[10px] py-1">
          <span className="h-1.5 w-1.5 rounded-full bg-[#00b874] animate-pulse" />
          Sandbox — drives the live /v1/agent API
        </Badge>
      </div>

      {tab === "runner" ? <SimulationRunner /> : <InventoryAgentConsole />}
    </Tabs>
  );
}
