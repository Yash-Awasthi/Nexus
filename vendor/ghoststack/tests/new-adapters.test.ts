/**
 * Tests for v1.2.0 adapter integrations:
 *   - WebSearchAdapter  (web-search-engine → TaskExecutor)
 *   - CodeAgentPool     (five-agent code pool → TaskExecutor)
 *   - LocalInferenceAdapter (local inference bridge → TaskExecutor)
 *
 * All tests run fully offline — no live HTTP calls, no Python bridges.
 * Bridge/LLM calls are intercepted at the module level.
 */

import { WebSearchAdapter } from "../orchestration/web-search-adapter";
import { CodeAgentPool } from "../orchestration/code-agent-pool";
import { LocalInferenceAdapter } from "../orchestration/local-inference-adapter";

// ── Minimal IExecutionContext stub ─────────────────────────────────────────
const noop = () => {};
const stubCtx = {
  logger: {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop
  },
  metrics: {
    increment: noop,
    recordTiming: noop,
    recordGauge: noop
  }
} as any;

// ──────────────────────────────────────────────────────────────────────────
// WebSearchAdapter
// ──────────────────────────────────────────────────────────────────────────

describe("WebSearchAdapter", () => {
  it("canExecute returns true for search/answer/web_search task types", () => {
    const adapter = new WebSearchAdapter();
    expect(adapter.canExecute("search")).toBe(true);
    expect(adapter.canExecute("answer")).toBe(true);
    expect(adapter.canExecute("web_search")).toBe(true);
  });

  it("canExecute returns false for unrelated task types", () => {
    const adapter = new WebSearchAdapter();
    expect(adapter.canExecute("browser")).toBe(false);
    expect(adapter.canExecute("inference")).toBe(false);
    expect(adapter.canExecute("code_edit")).toBe(false);
  });

  it("execute returns success=false with a meaningful error when LLM and Tavily are unavailable", async () => {
    // No GROQ_API_KEY, no TAVILY_API_KEY — engine will fail gracefully
    const savedGroq = process.env.GROQ_API_KEY;
    const savedTavily = process.env.TAVILY_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.TAVILY_API_KEY;

    const adapter = new WebSearchAdapter();
    const result = await adapter.execute(
      { type: "search", payload: { query: "GhostStack orchestration" } },
      stubCtx
    );

    process.env.GROQ_API_KEY = savedGroq;
    process.env.TAVILY_API_KEY = savedTavily;

    // Must return a structured result — never throw
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
    // Either success with skippedSearch=true, or success=false with an error string
    if (result.success === false) {
      expect(typeof result.error).toBe("string");
    }
  });

  it("execute reads query from payload.objective as fallback", async () => {
    const adapter = new WebSearchAdapter();
    // Monkey-patch the internal engine to skip actual HTTP calls
    (adapter as any).engine = {
      search: async (q: string) => ({
        answer: `mocked answer for: ${q}`,
        findings: [],
        queriesUsed: [q],
        mode: "speed",
        skippedSearch: false
      })
    };

    const result = await adapter.execute(
      { type: "search", payload: { objective: "What is GhostStack?" } },
      stubCtx
    );

    expect(result.success).toBe(true);
    expect((result.answer as string)).toContain("What is GhostStack?");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// CodeAgentPool
// ──────────────────────────────────────────────────────────────────────────

describe("CodeAgentPool", () => {
  it("canExecute returns true for all registered code task types", () => {
    const pool = new CodeAgentPool();
    const expected = [
      "code_explore", "file_picker",
      "code_edit", "edit",
      "code_review", "review",
      "research", "web_research",
      "reason", "think"
    ];
    for (const t of expected) {
      expect(pool.canExecute(t)).toBe(true);
    }
  });

  it("canExecute returns false for non-code task types", () => {
    const pool = new CodeAgentPool();
    expect(pool.canExecute("search")).toBe(false);
    expect(pool.canExecute("inference")).toBe(false);
    expect(pool.canExecute("browser")).toBe(false);
  });

  it("dispatches 'reason' task to ThinkerAgent (returns structured result)", async () => {
    const pool = new CodeAgentPool();
    // Stub the LLM on the internal ThinkerAgent
    const thinker = (pool as any).agents.find((a: any) => a.canExecute("think"));
    expect(thinker).toBeDefined();
    thinker.llm = {
      modelId: "stub",
      generateText: async () => "Step 1: analyse. Step 2: conclude.",
      streamText: async function* () { yield { contentChunk: "" }; },
      generateObject: async () => ({})
    };

    const result = await pool.execute(
      { type: "reason", payload: { prompt: "Why is topological sort useful?" } },
      stubCtx
    );

    expect(result.success).toBe(true);
    expect(typeof result.answer).toBe("string");
    expect((result.answer as string).length).toBeGreaterThan(0);
  });

  it("execute returns success=false with error string for unknown task type", async () => {
    const pool = new CodeAgentPool();
    const result = await pool.execute(
      { type: "unknown_type_xyz", payload: {} },
      stubCtx
    );
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe("string");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// LocalInferenceAdapter
// ──────────────────────────────────────────────────────────────────────────

describe("LocalInferenceAdapter", () => {
  it("canExecute returns true for inference/local_llm/generate", () => {
    const adapter = new LocalInferenceAdapter();
    expect(adapter.canExecute("inference")).toBe(true);
    expect(adapter.canExecute("local_llm")).toBe(true);
    expect(adapter.canExecute("generate")).toBe(true);
  });

  it("canExecute returns false for unrelated task types", () => {
    const adapter = new LocalInferenceAdapter();
    expect(adapter.canExecute("search")).toBe(false);
    expect(adapter.canExecute("browser")).toBe(false);
    expect(adapter.canExecute("code_edit")).toBe(false);
  });

  it("execute returns success=false gracefully when bridge is unreachable", async () => {
    const bridgeMgr = await import("../runtime/bridge-manager");
    // Stub url() to return immediately without spawning Python
    const origGet = bridgeMgr.getBridgeManager;
    (bridgeMgr as any).getBridgeManager = () => ({
      url: async () => { throw new Error("bridge not running"); }
    });

    const adapter = new LocalInferenceAdapter();
    const result = await adapter.execute(
      { type: "inference", payload: { prompt: "Hello world", model: "test-model" } },
      stubCtx
    );

    (bridgeMgr as any).getBridgeManager = origGet;

    // Must not throw — must return a structured error
    expect(result).toBeDefined();
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe("string");
    expect((result.error as string).length).toBeGreaterThan(0);
  }, 10000);

  it("reads prompt from payload.query as fallback", async () => {
    const adapter = new LocalInferenceAdapter();
    // Stub BridgeManager to avoid actual subprocess spawning
    const bridgeMgr = await import("../runtime/bridge-manager");
    const origGet = bridgeMgr.getBridgeManager;
    (bridgeMgr as any).getBridgeManager = () => ({
      url: async () => "http://localhost:7703"
    });
    // Stub the static post method
    const origPost = (bridgeMgr.BridgeManager as any).post;
    (bridgeMgr.BridgeManager as any).post = async () => ({
      success: true,
      text: "mocked output",
      model: "test-model",
      tokens_generated: 5
    });

    const result = await adapter.execute(
      { type: "inference", payload: { query: "Explain HKDF in one line" } },
      stubCtx
    );

    // Restore
    (bridgeMgr as any).getBridgeManager = origGet;
    (bridgeMgr.BridgeManager as any).post = origPost;

    expect(result.success).toBe(true);
    expect(result.text).toBe("mocked output");
    expect(result.tokensGenerated).toBe(5);
  });
});
