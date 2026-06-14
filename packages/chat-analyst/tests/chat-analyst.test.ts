// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DomainSystemPrompt,
  ContextAssembler,
  RateLimiter,
  InAppActionExtractor,
  StreamingAnalyst,
  AnalystSession,
  AnalystSessionManager,
  type AnalystEvent,
  type AnalystDomain,
  type StreamingLlmFn,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function collectEvents(iter: AsyncIterable<AnalystEvent>): Promise<AnalystEvent[]> {
  const events: AnalystEvent[] = [];
  for await (const ev of iter) events.push(ev);
  return events;
}

function makeStreamingLlm(chunks: string[]): StreamingLlmFn {
  return async function* () {
    for (const chunk of chunks) yield chunk;
  };
}

// ── DomainSystemPrompt ────────────────────────────────────────────────────────

describe("DomainSystemPrompt", () => {
  it("get returns a non-empty prompt for all domains", () => {
    for (const domain of DomainSystemPrompt.list()) {
      const prompt = DomainSystemPrompt.get(domain);
      expect(prompt.length).toBeGreaterThan(20);
    }
  });

  it("list returns at least 8 domains", () => {
    expect(DomainSystemPrompt.list().length).toBeGreaterThanOrEqual(8);
  });

  it("aviation prompt mentions aviation", () => {
    expect(DomainSystemPrompt.get("aviation").toLowerCase()).toContain("aviation");
  });

  it("cyber prompt mentions cyber or security", () => {
    expect(DomainSystemPrompt.get("cyber").toLowerCase()).toMatch(/cyber|security/);
  });

  it("get falls back to general for unknown domain", () => {
    const prompt = DomainSystemPrompt.get("unknownDomain" as AnalystDomain);
    expect(prompt.length).toBeGreaterThan(0);
  });
});

// ── ContextAssembler ──────────────────────────────────────────────────────────

describe("ContextAssembler", () => {
  it("assemble returns system prompt and trimmed messages", () => {
    const assembler = new ContextAssembler(4);
    const messages = Array.from({ length: 6 }, (_, i) => ({
      role: "user" as const, content: `msg ${i}`,
    }));
    const ctx = assembler.assemble("aviation", messages);
    expect(ctx.messages.length).toBeLessThanOrEqual(4);
    expect(ctx.systemPrompt).toContain("aviation");
  });

  it("includes geo timezone in system prompt", () => {
    const assembler = new ContextAssembler();
    const ctx = assembler.assemble("general", [], undefined, { timezone: "Asia/Tokyo" });
    expect(ctx.systemPrompt).toContain("Asia/Tokyo");
  });

  it("includes geo region in system prompt", () => {
    const assembler = new ContextAssembler();
    const ctx = assembler.assemble("general", [], undefined, { region: "Southeast Asia" });
    expect(ctx.systemPrompt).toContain("Southeast Asia");
  });

  it("includes domain data summary in prompt", () => {
    const assembler = new ContextAssembler();
    const ctx = assembler.assemble("economic", [], { inflationRate: 3.2 });
    expect(ctx.systemPrompt).toContain("inflationRate");
  });

  it("tokenEstimate is positive", () => {
    const assembler = new ContextAssembler();
    const ctx = assembler.assemble("general", [{ role: "user", content: "Hello world" }]);
    expect(ctx.tokenEstimate).toBeGreaterThan(0);
  });
});

// ── RateLimiter ───────────────────────────────────────────────────────────────

describe("RateLimiter", () => {
  it("allows requests within limit", () => {
    const rl = new RateLimiter({ requestsPerMinute: 5 });
    for (let i = 0; i < 5; i++) {
      expect(rl.check("s1").allowed).toBe(true);
    }
  });

  it("blocks when limit exceeded", () => {
    const rl = new RateLimiter({ requestsPerMinute: 3 });
    rl.check("s1");
    rl.check("s1");
    rl.check("s1");
    const result = rl.check("s1");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("resets the window for a session", () => {
    const rl = new RateLimiter({ requestsPerMinute: 2 });
    rl.check("s1");
    rl.check("s1");
    expect(rl.check("s1").allowed).toBe(false);
    rl.reset("s1");
    expect(rl.check("s1").allowed).toBe(true);
  });

  it("tracks limits per session independently", () => {
    const rl = new RateLimiter({ requestsPerMinute: 1 });
    rl.check("s1");
    expect(rl.check("s1").allowed).toBe(false);
    expect(rl.check("s2").allowed).toBe(true); // different session
  });
});

// ── InAppActionExtractor ──────────────────────────────────────────────────────

describe("InAppActionExtractor", () => {
  it("extracts open_panel action", () => {
    const text = "Some text [ACTION:open_panel map-view] more text";
    const actions = InAppActionExtractor.extract(text);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.action).toBe("open_panel");
    expect(actions[0]!.target).toBe("map-view");
  });

  it("extracts set_view action with params", () => {
    const text = "[ACTION:set_view dashboard zoom=3 mode=dark]";
    const actions = InAppActionExtractor.extract(text);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.action).toBe("set_view");
    expect(actions[0]!.params?.["zoom"]).toBe("3");
  });

  it("extracts multiple actions", () => {
    const text = "[ACTION:open_panel alerts] text [ACTION:set_view map]";
    const actions = InAppActionExtractor.extract(text);
    expect(actions).toHaveLength(2);
  });

  it("returns empty array when no actions", () => {
    expect(InAppActionExtractor.extract("just plain text")).toHaveLength(0);
  });

  it("strip removes action directives from text", () => {
    const text = "Analyse this [ACTION:open_panel map] risk";
    expect(InAppActionExtractor.strip(text)).toBe("Analyse this risk");
  });
});

// ── StreamingAnalyst ──────────────────────────────────────────────────────────

describe("StreamingAnalyst", () => {
  it("emits stream_start, stream_chunk(s), stream_end", async () => {
    const llm = makeStreamingLlm(["Hello ", "world"]);
    const analyst = new StreamingAnalyst({ llm });
    const events = await collectEvents(
      analyst.stream("s1", "general", [{ role: "user", content: "hi" }])
    );
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("stream_start");
    expect(types).toContain("stream_chunk");
    expect(types[types.length - 1]).toBe("stream_end");
  });

  it("stream_chunk events have correct index", async () => {
    const llm = makeStreamingLlm(["a", "b", "c"]);
    const analyst = new StreamingAnalyst({ llm });
    const events = await collectEvents(
      analyst.stream("s1", "general", [{ role: "user", content: "hi" }])
    );
    const chunks = events.filter((e) => e.type === "stream_chunk") as any[];
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it("extracts and emits in_app_action events", async () => {
    const llm = makeStreamingLlm(["Look here [ACTION:open_panel threats] for more"]);
    const analyst = new StreamingAnalyst({ llm });
    const events = await collectEvents(
      analyst.stream("s1", "aviation", [{ role: "user", content: "show me" }])
    );
    const actionEvents = events.filter((e) => e.type === "in_app_action");
    expect(actionEvents).toHaveLength(1);
    expect((actionEvents[0] as any).action.action).toBe("open_panel");
  });

  it("strips action directives from stream_chunk text", async () => {
    const llm = makeStreamingLlm(["Data [ACTION:open_panel map] follows"]);
    const analyst = new StreamingAnalyst({ llm });
    const events = await collectEvents(
      analyst.stream("s1", "general", [{ role: "user", content: "?" }])
    );
    const chunks = events.filter((e) => e.type === "stream_chunk") as any[];
    const combined = chunks.map((c) => c.chunk).join("");
    expect(combined).not.toContain("[ACTION:");
    expect(combined).toContain("Data");
  });

  it("emits rate_limited and stops when rate limiter blocks", async () => {
    const rl = new RateLimiter({ requestsPerMinute: 0 }); // always blocked
    const llm = makeStreamingLlm(["hello"]);
    const analyst = new StreamingAnalyst({ llm, rateLimiter: rl });
    const events = await collectEvents(
      analyst.stream("s1", "general", [{ role: "user", content: "hi" }])
    );
    expect(events[0]!.type).toBe("rate_limited");
    expect(events).toHaveLength(1);
  });

  it("emits error event when LLM throws", async () => {
    const llm = async function* () { throw new Error("llm crash"); };
    const analyst = new StreamingAnalyst({ llm });
    const events = await collectEvents(
      analyst.stream("s1", "general", [{ role: "user", content: "hi" }])
    );
    const errorEv = events.find((e) => e.type === "error") as any;
    expect(errorEv).toBeDefined();
    expect(errorEv.message).toContain("llm crash");
  });

  it("stream_end includes totalTokens and durationMs", async () => {
    const llm = makeStreamingLlm(["response text"]);
    const analyst = new StreamingAnalyst({ llm });
    const events = await collectEvents(
      analyst.stream("s1", "general", [{ role: "user", content: "hello" }])
    );
    const endEv = events.find((e) => e.type === "stream_end") as any;
    expect(endEv.totalTokens).toBeGreaterThan(0);
    expect(endEv.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── AnalystSession ────────────────────────────────────────────────────────────

describe("AnalystSession", () => {
  it("ask accumulates user message and assistant response in history", async () => {
    const llm = makeStreamingLlm(["Analysis complete"]);
    const analyst = new StreamingAnalyst({ llm });
    const session = new AnalystSession("conflict", analyst);
    await collectEvents(session.ask("What happened?"));
    const history = session.getHistory();
    expect(history.find((m) => m.role === "user")?.content).toBe("What happened?");
    expect(history.find((m) => m.role === "assistant")?.content).toContain("Analysis complete");
  });

  it("addMessage adds to history", () => {
    const llm = makeStreamingLlm([]);
    const analyst = new StreamingAnalyst({ llm });
    const session = new AnalystSession("general", analyst);
    session.addMessage("user", "test");
    expect(session.getHistory()).toHaveLength(1);
  });

  it("session id is unique", () => {
    const llm = makeStreamingLlm([]);
    const analyst = new StreamingAnalyst({ llm });
    const s1 = new AnalystSession("general", analyst);
    const s2 = new AnalystSession("general", analyst);
    expect(s1.id).not.toBe(s2.id);
  });
});

// ── AnalystSessionManager ─────────────────────────────────────────────────────

describe("AnalystSessionManager", () => {
  it("create returns new AnalystSession", () => {
    const analyst = new StreamingAnalyst({ llm: makeStreamingLlm([]) });
    const manager = new AnalystSessionManager(analyst);
    const session = manager.create("aviation");
    expect(session.domain).toBe("aviation");
    expect(manager.count()).toBe(1);
  });

  it("get retrieves session by id", () => {
    const analyst = new StreamingAnalyst({ llm: makeStreamingLlm([]) });
    const manager = new AnalystSessionManager(analyst);
    const s = manager.create("cyber");
    expect(manager.get(s.id)).toBe(s);
  });

  it("destroy removes session", () => {
    const analyst = new StreamingAnalyst({ llm: makeStreamingLlm([]) });
    const manager = new AnalystSessionManager(analyst);
    const s = manager.create("health");
    expect(manager.destroy(s.id)).toBe(true);
    expect(manager.has(s.id)).toBe(false);
  });

  it("list returns all sessions", () => {
    const analyst = new StreamingAnalyst({ llm: makeStreamingLlm([]) });
    const manager = new AnalystSessionManager(analyst);
    manager.create("aviation");
    manager.create("climate");
    expect(manager.list()).toHaveLength(2);
  });
});
