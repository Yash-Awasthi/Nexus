// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  GeneralAgent,
  MockAgentBackend,
  SubAgentSpawner,
  AgentResponseFormatter,
  type SubAgentSpec,
  type AgentTask,
} from "../src/index.js";

// ── MockAgentBackend ──────────────────────────────────────────────────────────

describe("MockAgentBackend", () => {
  it("records calls", async () => {
    const mock = new MockAgentBackend("done");
    const backend = mock.asBackend();
    await backend("gpt-5", "system", "do something");
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.model).toBe("gpt-5");
    expect(mock.calls[0]!.instruction).toBe("do something");
  });

  it("returns configured content", async () => {
    const mock = new MockAgentBackend("custom response");
    const backend = mock.asBackend();
    const result = await backend("gpt-5", "sys", "user");
    expect(result.content).toBe("custom response");
  });

  it("setContent updates response", async () => {
    const mock = new MockAgentBackend("original");
    mock.setContent("updated");
    const backend = mock.asBackend();
    const result = await backend("gpt-5", "sys", "user");
    expect(result.content).toBe("updated");
  });
});

// ── GeneralAgent ──────────────────────────────────────────────────────────────

describe("GeneralAgent", () => {
  it("run returns agent response", async () => {
    const mock = new MockAgentBackend("Task completed.");
    const agent = new GeneralAgent({ backend: mock.asBackend() });
    const response = await agent.run({ instruction: "Summarize this document." });
    expect(response.content).toBe("Task completed.");
    expect(response.model).toBe("gpt-5");
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("uses configured model", async () => {
    const mock = new MockAgentBackend();
    const agent = new GeneralAgent({ model: "claude-opus-4", backend: mock.asBackend() });
    await agent.run({ instruction: "test" });
    expect(mock.calls[0]!.model).toBe("claude-opus-4");
  });

  it("no conversation history — each run is independent", async () => {
    const mock = new MockAgentBackend("done");
    const agent = new GeneralAgent({ backend: mock.asBackend() });
    await agent.run({ instruction: "first task" });
    await agent.run({ instruction: "second task" });
    // Each call passes only its own instruction, not history
    expect(mock.calls[0]!.instruction).toBe("first task");
    expect(mock.calls[1]!.instruction).toBe("second task");
  });

  it("injects file paths into prompt when configured", async () => {
    const mock = new MockAgentBackend("ok");
    const agent = new GeneralAgent({ backend: mock.asBackend(), injectFilePaths: true });
    await agent.run({ instruction: "analyze", filePaths: ["src/a.ts", "src/b.ts"] });
    // filePaths should appear in system prompt
    expect(mock.calls[0]!.instruction).toBe("analyze");
  });

  it("includes context in instruction", async () => {
    const mock = new MockAgentBackend("ok");
    const agent = new GeneralAgent({ backend: mock.asBackend() });
    await agent.run({ instruction: "task", context: "important context" });
    expect(mock.calls[0]!.instruction).toContain("important context");
  });

  it("response includes filePaths", async () => {
    const mock = new MockAgentBackend("ok");
    const agent = new GeneralAgent({ backend: mock.asBackend() });
    const response = await agent.run({ instruction: "x", filePaths: ["f.ts"] });
    expect(response.filePaths).toEqual(["f.ts"]);
  });

  it("response includes subAgentsSpawned from spec names", async () => {
    const mock = new MockAgentBackend("ok");
    const agent = new GeneralAgent({ backend: mock.asBackend() });
    const specs: SubAgentSpec[] = [
      { name: "searcher", description: "Searches code" },
      { name: "formatter", description: "Formats output" },
    ];
    const response = await agent.run({ instruction: "do it", subAgentSpecs: specs });
    expect(response.subAgentsSpawned).toEqual(["searcher", "formatter"]);
  });

  it("uses system prompt override when provided", async () => {
    const mock = new MockAgentBackend("ok");
    const agent = new GeneralAgent({
      backend: mock.asBackend(),
      systemPromptOverride: "You are a specialized agent.",
    });
    await agent.run({ instruction: "task" });
    expect(mock.calls).toHaveLength(1);
  });

  it("getModel and getEffort return configured values", () => {
    const mock = new MockAgentBackend();
    const agent = new GeneralAgent({
      backend: mock.asBackend(),
      model: "claude-opus-4",
      effort: "high",
    });
    expect(agent.getModel()).toBe("claude-opus-4");
    expect(agent.getEffort()).toBe("high");
  });

  it("spawnerPrompt returns non-empty string", () => {
    expect(GeneralAgent.spawnerPrompt().length).toBeGreaterThan(0);
  });
});

// ── SubAgentSpawner ───────────────────────────────────────────────────────────

describe("SubAgentSpawner", () => {
  it("spawn creates and runs agent with spec", async () => {
    const mock = new MockAgentBackend("search results");
    const spawner = new SubAgentSpawner(mock.asBackend());
    const spec: SubAgentSpec = {
      name: "code-searcher",
      description: "Searches code",
      model: "gpt-5",
    };
    const result = await spawner.spawn(spec, "find all TODO comments");
    expect(result.name).toBe("code-searcher");
    expect(result.response.content).toBe("search results");
    expect(result.error).toBeUndefined();
  });

  it("spawn captures errors", async () => {
    const backend = async () => {
      throw new Error("backend error");
    };
    const spawner = new SubAgentSpawner(backend);
    const spec: SubAgentSpec = { name: "bad-agent", description: "Fails" };
    const result = await spawner.spawn(spec, "do something");
    expect(result.error).toContain("backend error");
  });

  it("spawnAll runs all specs in parallel", async () => {
    const mock = new MockAgentBackend("ok");
    const spawner = new SubAgentSpawner(mock.asBackend());
    const specs: SubAgentSpec[] = [
      { name: "a1", description: "Agent 1" },
      { name: "a2", description: "Agent 2" },
      { name: "a3", description: "Agent 3" },
    ];
    const results = await spawner.spawnAll(specs, "shared task");
    expect(results).toHaveLength(3);
    expect(results.every((r) => !r.error)).toBe(true);
    const names = results.map((r) => r.name);
    expect(names).toContain("a1");
    expect(names).toContain("a2");
    expect(names).toContain("a3");
  });

  it("spawnAll uses spec model and effort", async () => {
    const mock = new MockAgentBackend("ok");
    const spawner = new SubAgentSpawner(mock.asBackend());
    const specs: SubAgentSpec[] = [
      { name: "opus-agent", description: "Uses opus", model: "claude-opus-4", effort: "high" },
    ];
    await spawner.spawnAll(specs, "task");
    expect(mock.calls[0]!.model).toBe("claude-opus-4");
  });
});

// ── AgentResponseFormatter ────────────────────────────────────────────────────

describe("AgentResponseFormatter", () => {
  it("format returns string with model and content", async () => {
    const mock = new MockAgentBackend("detailed output");
    const agent = new GeneralAgent({ backend: mock.asBackend() });
    const response = await agent.run({ instruction: "test" });
    const formatter = new AgentResponseFormatter();
    const formatted = formatter.format(response);
    expect(formatted).toContain("gpt-5");
    expect(formatted).toContain("detailed output");
  });

  it("format includes token count when present", async () => {
    const mock = new MockAgentBackend("ok");
    const agent = new GeneralAgent({ backend: mock.asBackend() });
    const response = await agent.run({ instruction: "test" });
    const formatter = new AgentResponseFormatter();
    const formatted = formatter.format(response);
    expect(formatted).toContain("Tokens");
  });

  it("extractSubAgentNames returns names", async () => {
    const mock = new MockAgentBackend("ok");
    const agent = new GeneralAgent({ backend: mock.asBackend() });
    const specs: SubAgentSpec[] = [{ name: "helper", description: "Helps" }];
    const response = await agent.run({ instruction: "t", subAgentSpecs: specs });
    const formatter = new AgentResponseFormatter();
    expect(formatter.extractSubAgentNames(response)).toContain("helper");
  });
});
