import "./_setup";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  generateAgentApiKey,
  getAgentAuthMode,
  hashAgentKey,
} from "@/lib/auth/agent-auth";

describe("agent auth primitives", () => {
  test("hashAgentKey is a deterministic 64-char hex digest", () => {
    const h1 = hashAgentKey("agt_secret_test_key");
    const h2 = hashAgentKey("agt_secret_test_key");
    assert.match(h1, /^[0-9a-f]{64}$/);
    assert.equal(h1, h2);
    assert.notEqual(h1, hashAgentKey("agt_secret_other_key"));
  });

  test("generateAgentApiKey emits the expected credential shape", () => {
    const key = generateAgentApiKey();
    assert.match(key, /^agt_secret_[0-9a-f]{48}$/);
    // The raw key is never equal to its stored hash.
    assert.notEqual(key, hashAgentKey(key));
  });

  test("getAgentAuthMode falls back to demo", () => {
    const saved = process.env.AGENT_AUTH_MODE;
    delete process.env.AGENT_AUTH_MODE;
    assert.equal(getAgentAuthMode(undefined), "demo");
    assert.equal(getAgentAuthMode({ agentAuthMode: "strict" }), "strict");
    assert.equal(getAgentAuthMode({ agentAuthMode: "bogus" }), "demo");
    if (saved) process.env.AGENT_AUTH_MODE = saved;
  });
});
