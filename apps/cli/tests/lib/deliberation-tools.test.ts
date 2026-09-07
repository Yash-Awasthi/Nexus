// SPDX-License-Identifier: Apache-2.0
// End-to-end wiring test (pass 63): `nexus code --local` now serves the
// deliberation surface — the batch-35 council protocols + debate-engine's
// converging debate — as in-process runtime tools over the CLI's injected
// LlmToolFn seam, with the pass-58/59 transcript sink attached. DB-free and
// offline: a scripted LlmToolFn drives every protocol call (the same
// DeliberativeCouncil-convention scripts the worker's pass-60 test uses).
import { describe, it, expect, vi } from "vitest";
import type { LlmToolFn } from "@nexus/agent-runtime";
import type { ILLMMessage, ILLMTransport } from "@nexus/council";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  councilRuntimeTools,
  councilRuntimeToolsFromLlm,
  debateRuntimeToolFromLlm,
  graphRagRuntimeTools,
  hybridSearchRuntimeTools,
  transportFromLlm,
} from "../../src/lib/deliberation-tools.js";
import {
  runLocalAgent,
  type ToolTranscriptEvent,
} from "../../src/lib/local-agent.js";
import {
  InMemoryBM25,
  type SearchHit,
  type VectorSearchAdapter,
} from "@nexus/hybrid-search";

const CORPUS = [
  { id: "d1", text: "Hybrid search fuses dense vector and bm25 results.", metadata: { tier: "gold" } },
  { id: "d2", text: "RRF fusion ranks documents by reciprocal rank.", metadata: { tier: "free" } },
];

/** Deterministic dense leg for CLI tests: overlap of query tokens with doc tokens. */
function lexicalDense(): VectorSearchAdapter {
  const tokenize = (t: string): string[] =>
    t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const corpus = CORPUS.map((d) => ({ ...d, toks: tokenize(d.text) }));
  return {
    async search(query: string, limit: number): Promise<SearchHit[]> {
      const qt = new Set(tokenize(query));
      return corpus
        .map((d) => ({
          id: d.id,
          score: d.toks.filter((t) => qt.has(t)).length,
          text: d.text,
          metadata: d.metadata,
        }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },
  };
}

function makeAdapters() {
  const bm25 = new InMemoryBM25();
  bm25.index(CORPUS);
  return { vector: lexicalDense(), bm25 };
}

/** DeliberativeCouncil-convention scripted llm (convene → review → verdict). */
function scriptedCouncilLlm(): LlmToolFn {
  return (async (messages) => {
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    let content = "";
    if (user.includes("brought this question to the council")) {
      content = "Position: the plan is workable if scoped tightly.";
    } else if (user.includes("advisors independently answered this question")) {
      content =
        "1. Strongest: B — grounded in the evidence.\n" +
        "2. Biggest blind spot: D — it ignores rollout cost.\n" +
        "3. Missed by all: the timeline is unrealistic.";
    } else if (user.includes("Produce the COUNCIL VERDICT")) {
      content =
        "AGREEMENTS:\n- everyone agrees scope matters\n\n" +
        "CLASHES:\n- The Architect wants modularity now; the Minimalist wants to defer it\n\n" +
        "BLIND SPOTS:\n- only the review round surfaced the rollout risk\n\n" +
        "RECOMMENDATION:\nStart small and ship the module behind a flag.\n\n" +
        "NEXT ACTION:\nDraft the RFC this week.";
    }
    return { content, toolCalls: [] };
  }) as LlmToolFn;
}

describe("transportFromLlm", () => {
  it("adapts an LlmToolFn into council's ILLMTransport", async () => {
    const llm = vi.fn(async () => ({
      content: "plain answer",
      toolCalls: [],
      usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 },
    }));
    const t = transportFromLlm(llm as unknown as LlmToolFn, "model-x");
    const res = await t.chat([{ role: "user", content: "hi" } as ILLMMessage]);
    expect(res.content).toBe("plain answer");
    expect(res.model).toBe("model-x");
    expect(res.usage).toEqual({ promptTokens: 11, completionTokens: 4 });
  });
});

describe("councilRuntimeToolsFromLlm (CLI seam)", () => {
  it("surfaces all five protocol tools namespaced under the prefix", async () => {
    const tools = await councilRuntimeToolsFromLlm(scriptedCouncilLlm());
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "council__council_critique",
        "council__council_debate",
        "council__council_deliberate",
        "council__council_verify",
        "council__council_vote",
      ].sort(),
    );
    const deliberate = tools.find((t) => t.name === "council__council_deliberate")!;
    expect(deliberate.description).toContain("deliberative council");
    expect((deliberate.parameters as { required?: string[] }).required).toEqual(["question"]);
  });

  it("a tool request reaches the council and returns a parsed verdict", async () => {
    const tools = await councilRuntimeTools(
      { llm: transportFromLlm(scriptedCouncilLlm()), tools: ["deliberate"] as const },
      "council",
    );
    const deliberate = tools.find((t) => t.name === "council__council_deliberate")!;
    const raw = await deliberate.handler({ question: "Should we ship the migration?" });
    const parsed = JSON.parse(raw) as { verdict: unknown; advisors: string[] };
    expect(parsed.advisors).toHaveLength(5); // default archetype panel
    expect(JSON.stringify(parsed.verdict)).toContain("Start small");
  });

  it("leaves the pass-58 transcript on a served call via the CLI seam", async () => {
    const onTranscript = vi.fn();
    const tools = await councilRuntimeToolsFromLlm(scriptedCouncilLlm(), {
      tools: ["deliberate"] as const,
      hooks: { onTranscript },
    });
    const deliberate = tools.find((t) => t.name === "council__council_deliberate")!;
    await deliberate.handler({ question: "Should we ship the migration?" });
    expect(onTranscript).toHaveBeenCalledTimes(1);
    const t = onTranscript.mock.calls[0]![0] as {
      protocol: string;
      degraded: boolean;
      stages: { name: string }[];
    };
    expect(t.protocol).toBe("council_deliberate");
    expect(t.degraded).toBe(false);
    expect(t.stages.some((s) => s.name === "verdict")).toBe(true);
  });

  it("records a degraded transcript when the executor fails", async () => {
    const onTranscript = vi.fn();
    const failing = (async () => {
      throw new Error("provider unreachable");
    }) as unknown as LlmToolFn;
    const tools = await councilRuntimeToolsFromLlm(failing, {
      tools: ["deliberate"] as const,
      hooks: { onTranscript },
    });
    const deliberate = tools.find((t) => t.name === "council__council_deliberate")!;
    await expect(deliberate.handler({ question: "X?" })).rejects.toThrow(/provider unreachable/);
    expect(onTranscript).toHaveBeenCalledTimes(1);
    const t = onTranscript.mock.calls[0]![0] as { degraded: boolean; warnings: string[] };
    expect(t.degraded).toBe(true);
    expect(JSON.stringify(t.warnings)).toContain("provider unreachable");
  });
});

describe("debateRuntimeToolFromLlm (CLI seam)", () => {
  /** Scripted llm playing per-agent answers keyed by the debate request text. */
  function scriptedDebateLlm(scripts: Record<string, string[]>): LlmToolFn {
    const counts: Record<string, number> = {};
    return (async (messages) => {
      const text = messages.map((m) => m.content).join("\n");
      for (const [agent, script] of Object.entries(scripts)) {
        if (text.includes(`are Debater for position: ${agent}`) || text.includes(`You are debating as ${agent}`)) {
          const i = Math.min(counts[agent] ?? 0, script.length - 1);
          counts[agent] = (counts[agent] ?? 0) + 1;
          return { content: script[i]!, toolCalls: [] };
        }
      }
      const first = Object.values(scripts)[0] ?? [];
      return { content: first[0] ?? "ok", toolCalls: [] };
    }) as LlmToolFn;
  }

  it("is namespaced, schema-valid, and returns the majority result", async () => {
    const llm = scriptedDebateLlm({
      "Debater A": ["a0", "pos-a", "pos-a"],
      "Debater B": ["b0", "pos-b", "pos-b"],
    });
    const tool = debateRuntimeToolFromLlm(llm, { agents: ["Debater A", "Debater B"] });
    expect(tool.name).toBe("debate__run");
    expect((tool.parameters as { required?: string[] }).required).toEqual(["question"]);
    const raw = await tool.handler({ question: "X or Y?", rounds: 2, convergence: true });
    const parsed = JSON.parse(raw) as {
      converged: boolean;
      roundsRun: number;
      finalAnswers: { agent: string; answer: string }[];
    };
    expect(parsed.converged).toBe(true);
    expect(parsed.finalAnswers).toHaveLength(2);
  });

  it("leaves a transcript with one stage per final answer", async () => {
    const onTranscript = vi.fn();
    const llm = scriptedDebateLlm({
      "Debater A": ["pos-a", "pos-a"],
      "Debater B": ["pos-b", "pos-b"],
    });
    const tool = debateRuntimeToolFromLlm(llm, {
      agents: ["Debater A", "Debater B"],
      hooks: { onTranscript },
    });
    await tool.handler({ question: "X or Y?", rounds: 1, convergence: true });
    expect(onTranscript).toHaveBeenCalledTimes(1);
    const t = onTranscript.mock.calls[0]![0] as {
      protocol: string;
      stages: { name: string }[];
      auditTrail: { step: string }[];
    };
    expect(t.protocol).toBe("debate__run");
    expect(t.stages.filter((s) => s.name.startsWith("answer:"))).toHaveLength(2);
    expect(t.auditTrail.some((a) => a.step === "debate")).toBe(true);
  });

  it("propagates an llm failure and records a degraded transcript", async () => {
    const onTranscript = vi.fn();
    const failing = (async () => {
      throw new Error("debate provider down");
    }) as unknown as LlmToolFn;
    const tool = debateRuntimeToolFromLlm(failing, { hooks: { onTranscript } });
    await expect(tool.handler({ question: "X or Y?", rounds: 2 })).rejects.toThrow(
      /debate provider down/,
    );
    expect(onTranscript).toHaveBeenCalledTimes(1);
    const t = onTranscript.mock.calls[0]![0] as { degraded: boolean; warnings: string[] };
    expect(t.degraded).toBe(true);
    expect(JSON.stringify(t.warnings)).toContain("debate provider down");
  });
});

describe("hybridSearchRuntimeTools (served hybrid single query, CLI seam)", () => {
  it("surfaces the search tool namespaced under the prefix with query required", async () => {
    const tools = await hybridSearchRuntimeTools(makeAdapters());
    expect(tools.map((t) => t.name)).toEqual(["hybrid__hybrid_search"]);
    expect(tools[0]!.description).toContain("Hybrid retrieval single query");
    expect((tools[0]!.parameters as { required?: string[] }).required).toEqual(["query"]);
  });

  it("a real call returns parsed fused hits with the where-filter holding", async () => {
    const tools = await hybridSearchRuntimeTools(makeAdapters());
    const raw = await tools[0]!.handler({
      query: "fuses bm25 ranks",
      where: { tier: "gold" },
    });
    const parsed = JSON.parse(raw) as {
      hits: Array<{ id: string; score: number; text: string; metadata?: Record<string, unknown> }>;
      vectorHits: unknown[];
      bm25Hits: unknown[];
      durationMs: number;
    };
    expect(parsed.hits.length).toBeGreaterThan(0);
    expect(parsed.hits.every((h) => h.metadata?.tier === "gold")).toBe(true);
    expect(parsed.hits.some((h) => h.id === "d2")).toBe(false);
    expect(parsed.vectorHits.length).toBeGreaterThan(0);
    expect(parsed.bm25Hits.length).toBeGreaterThan(0);
    expect(parsed.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("graphRagRuntimeTools (served graphrag search, CLI seam)", () => {
  const ENTITIES = [
    { name: "acme aerospace", type: "entity", descriptions: ["builds rockets"], mentions: 5 },
    { name: "green energy", type: "entity", descriptions: ["solar panels"], mentions: 2 },
  ];
  const RELATIONS = [
    {
      source: "acme aerospace",
      target: "rocket engine",
      type: "rel",
      descriptions: ["acme rel rocket engine"],
      mentions: 1,
    },
  ];

  function fakeTransport(contents: string[]): ILLMTransport & { calls: number } {
    let calls = 0;
    return {
      async chat(messages) {
        calls++;
        return {
          content: contents[Math.min(calls - 1, contents.length - 1)]!,
          model: "fake",
          usage: { promptTokens: 10, completionTokens: 20 },
          latencyMs: 1,
        };
      },
      get calls() {
        return calls;
      },
    };
  }

  it("surfaces both search tools namespaced under the prefix", async () => {
    const tools = await graphRagRuntimeTools({
      entities: ENTITIES,
      relations: RELATIONS,
      llm: fakeTransport(["x"]),
    });
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["graphrag__graphrag_global_search", "graphrag__graphrag_local_search"].sort(),
    );
    for (const t of tools) {
      expect((t.parameters as { required?: string[] }).required).toEqual(["question"]);
    }
  });

  it("a local-search request round-trips a grounded answer through the CLI seam", async () => {
    const transport = fakeTransport(["acme builds rockets (cli)."]);
    const tools = await graphRagRuntimeTools({
      entities: ENTITIES,
      relations: RELATIONS,
      llm: transport,
    });
    const local = tools.find((t) => t.name === "graphrag__graphrag_local_search")!;
    const raw = await local.handler({ question: "acme aerospace" });
    const parsed = JSON.parse(raw) as {
      answer: string;
      entitiesUsed: string[];
      durationMs: number;
    };
    expect(parsed.answer).toBe("acme builds rockets (cli).");
    expect(parsed.entitiesUsed).toContain("acme aerospace");
    expect(transport.calls).toBe(1);
    expect(parsed.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("runLocalAgent deliberation (worker-shaped tool.transcript event)", () => {
  /** Queue-based llm: a debate tool call, two debate answers, then a plain finish. */
  function queueLlm(): { llm: LlmToolFn; calls: number } {
    const state = { calls: 0 };
    const llm = (async () => {
      const n = ++state.calls;
      if (n === 1) {
        return {
          content: "debating",
          toolCalls: [
            {
              id: "t1",
              name: "debate__run",
              arguments: { question: "X or Y?", rounds: 1, agents: ["A", "B"] },
            },
          ],
        };
      }
      if (n <= 3) return { content: n === 2 ? "position-a" : "position-b", toolCalls: [] };
      return { content: "all set", toolCalls: [] };
    }) as LlmToolFn;
    return { llm, calls: state.calls };
  }

  it("emits the worker-shaped tool.transcript event with taskId on a debate round-trip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-delib-"));
    try {
      const events: ToolTranscriptEvent[] = [];
      const { llm } = queueLlm();
      await runLocalAgent({
        instruction: "debate it",
        rootDir: dir,
        llm,
        maxSteps: 8,
        enableShell: false,
        deliberation: true,
        taskId: "local-run-1",
        onToolTranscript: (e) => events.push(e),
      });

      expect(events).toHaveLength(1);
      const ev = events[0]!;
      // worker-shaped contract (pass 62): { level, event, taskId, transcript }
      expect(ev.level).toBe("info");
      expect(ev.event).toBe("tool.transcript");
      expect(ev.taskId).toBe("local-run-1");
      expect(ev.transcript.protocol).toBe("debate__run");
      expect(ev.transcript.query).toBe("X or Y?");
      expect(ev.transcript.degraded).toBe(false);
      expect(ev.transcript.metrics?.total_ms).toBeGreaterThanOrEqual(0);
      // JSON-serializable, matching the worker's console.log(JSON.stringify(...))
      expect(() => JSON.stringify(ev)).not.toThrow();
      expect(JSON.stringify(ev)).toContain('"event":"tool.transcript"');
      expect(JSON.stringify(ev)).toContain('"taskId":"local-run-1"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runLocalAgent retrieval (opt-in hybrid search)", () => {
  /** Queue-based llm: one hybrid__hybrid_search tool call, then a plain finish. */
  function queueLlm(): { llm: LlmToolFn; calls: number } {
    const state = { calls: 0 };
    const llm = (async () => {
      const n = ++state.calls;
      if (n === 1) {
        return {
          content: "searching",
          toolCalls: [
            {
              id: "h1",
              name: "hybrid__hybrid_search",
              arguments: { query: "fuses bm25 ranks", where: { tier: "gold" } },
            },
          ],
        };
      }
      return { content: "all set", toolCalls: [] };
    }) as LlmToolFn;
    return { llm, calls: state.calls };
  }

  it("registers the hybrid tool only when retrieval adapters are supplied, and the call round-trips", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-hybrid-"));
    try {
      const events: ToolTranscriptEvent[] = [];
      const { llm } = queueLlm();
      const result = await runLocalAgent({
        instruction: "search the corpus",
        rootDir: dir,
        llm,
        maxSteps: 6,
        enableShell: false,
        retrieval: makeAdapters(),
        taskId: "local-hybrid-1",
        onToolTranscript: (e) => events.push(e),
      });

      // The tool call round-tripped through the registered served tool...
      expect(result.aborted).toBe(false);
      expect(result.finalContent).toBe("all set");
      // ...and left the worker-shaped artifact (protocol hybrid_search).
      expect(events).toHaveLength(1);
      expect(events[0]!.event).toBe("tool.transcript");
      expect(events[0]!.taskId).toBe("local-hybrid-1");
      expect(events[0]!.transcript.protocol).toBe("hybrid_search");
      // hybrid args carry no `question`, so the recorder falls back to the tool name
      expect(events[0]!.transcript.query).toBe("hybrid_search");
      expect(events[0]!.transcript.degraded).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
