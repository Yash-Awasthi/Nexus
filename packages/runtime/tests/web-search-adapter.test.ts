// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";

import type { ILanguageModel } from "../src/interfaces/language-model.interface.js";
import type { IExecutionContext } from "../src/interfaces/execution.interface.js";
import { WebSearchAdapter } from "../src/web-search-adapter.js";

const ctx = {
  taskId: "ws-1",
  startTime: new Date(),
  attempt: 1,
  environment: {},
  logger: { info: vi.fn(), warn: () => {}, error: vi.fn() },
} as unknown as IExecutionContext;

function fakeLLM(
  opts: {
    objects?: Array<() => Promise<unknown>>;
    texts?: Array<() => Promise<string>>;
  } = {},
): ILanguageModel {
  const objects = [...(opts.objects ?? [])];
  const texts = [...(opts.texts ?? [])];
  return {
    modelId: "test:stub",
    async generateObject(): Promise<unknown> {
      const impl = objects.shift();
      if (!impl) throw new Error("no object stub");
      return impl();
    },
    async generateText(): Promise<string> {
      const impl = texts.shift();
      if (!impl) throw new Error("no text stub");
      return impl();
    },
    async *streamText() {
      // unused
    },
  };
}

describe("WebSearchAdapter", () => {
  it("handles the search task types", () => {
    const adapter = new WebSearchAdapter({ llm: fakeLLM() });
    expect(adapter.canExecute("search")).toBe(true);
    expect(adapter.canExecute("answer")).toBe(true);
    expect(adapter.canExecute("web_search")).toBe(true);
    expect(adapter.canExecute("browser")).toBe(false);
  });

  it("rejects a task with no query", async () => {
    const adapter = new WebSearchAdapter({ llm: fakeLLM() });
    const out = await adapter.execute({ payload: {} }, ctx);
    expect(out.success).toBe(false);
    expect(out.error).toContain("No query");
  });

  it("answers from knowledge when classification skips search", async () => {
    const llm = fakeLLM({
      objects: [
        async () => ({
          skipSearch: true,
          webSearch: false,
          academicSearch: false,
          discussionSearch: false,
          standaloneQuery: "what is 2+2",
        }),
      ],
      texts: [async () => "4"],
    });
    const adapter = new WebSearchAdapter({ llm, tavilyApiKey: "k" });
    const out = await adapter.execute(
      {
        payload: {
          query: "what is 2+2",
          mode: "speed",
          history: [{ role: "user", content: "hi" }],
        },
      },
      ctx,
    );
    expect(out.success).toBe(true);
    expect(out.answer).toBe("4");
    expect(out.skippedSearch).toBe(true);
    expect(out.findingsCount).toBe(0);
  });

  it("falls back through alternate payload keys", async () => {
    const llm = fakeLLM({
      objects: [
        async () => ({
          skipSearch: true,
          webSearch: false,
          academicSearch: false,
          discussionSearch: false,
          standaloneQuery: "x",
        }),
      ],
      texts: [async () => "answer"],
    });
    const adapter = new WebSearchAdapter({ llm });
    const out = await adapter.execute({ payload: { objective: "find stuff" } }, ctx);
    expect(out.success).toBe(true);
  });

  it("accepts a bare task object as the payload", async () => {
    const llm = fakeLLM({
      objects: [
        async () => ({
          skipSearch: true,
          webSearch: false,
          academicSearch: false,
          discussionSearch: false,
          standaloneQuery: "x",
        }),
      ],
      texts: [async () => "ok"],
    });
    const adapter = new WebSearchAdapter({ llm });
    const out = await adapter.execute({ prompt: "bare prompt" }, ctx);
    expect(out.success).toBe(true);
  });

  it("reports engine failures as errors", async () => {
    const skipLLM = fakeLLM({
      objects: [
        async () => ({
          skipSearch: true,
          webSearch: false,
          academicSearch: false,
          discussionSearch: false,
          standaloneQuery: "x",
        }),
      ],
      texts: [
        async () => {
          throw new Error("synthesis down");
        },
      ],
    });
    const adapter = new WebSearchAdapter({ llm: skipLLM });
    const out = await adapter.execute({ payload: { query: "q" } }, ctx);
    expect(out.success).toBe(false);
    expect(out.error).toBe("synthesis down");
    expect(ctx.logger.error).toHaveBeenCalled();
  });
});
