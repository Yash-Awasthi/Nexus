// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { extractMissionInsights, sanitizeInsights } from "../../src/lib/memory-extractor.js";

/** Ollama /api/chat-shaped responder over a scripted content body. */
function ollama(content: string, ok = true) {
  return (async () =>
    ok
      ? new Response(JSON.stringify({ message: { content } }), { status: 200 })
      : new Response("boom", { status: 500 })) as unknown as typeof fetch;
}

const RECORD = {
  goal: "write a report",
  outcome: "failed — reviewer rejected",
  finalContent: "partial draft",
};

afterEach(() => {
  delete process.env.NEXUS_MEMORY_EXTRACTOR;
});

describe("sanitizeInsights", () => {
  it("keeps ≤3 bullet lines and strips fences", () => {
    const out = sanitizeInsights(
      "```text\n- first insight about the run\n- second insight\n- third insight here\n- fourth dropped\n```",
    );
    expect(out).toBe("- first insight about the run\n- second insight\n- third insight here");
  });

  it("strips llama <think> reasoning blocks", () => {
    const out = sanitizeInsights(
      "<think>let me consider the failure modes at length...</think>\n- the real insight",
    );
    expect(out).toBe("- the real insight");
  });

  it("drops prose-only output (no bullets) → null", () => {
    expect(sanitizeInsights("Sure! Here are my thoughts about this run.")).toBeNull();
  });
});

describe("extractMissionInsights", () => {
  it("returns sanitized insights + model on success", async () => {
    const out = await extractMissionInsights(RECORD, {
      fetchImpl: ollama("- what worked: the skeleton\n- what failed: review claims"),
      baseUrl: "http://x",
    });
    expect(out).toEqual({
      text: "- what worked: the skeleton\n- what failed: review claims",
      model: "llama3.2:1b",
    });
  });

  it("degrades to null on HTTP failure", async () => {
    expect(
      await extractMissionInsights(RECORD, { fetchImpl: ollama("x", false), baseUrl: "http://x" }),
    ).toBeNull();
  });

  it("degrades to null on timeout (hung endpoint)", async () => {
    const hung = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    expect(await extractMissionInsights(RECORD, { fetchImpl: hung, timeoutMs: 30 })).toBeNull();
  });

  it("kill switch returns null without calling the model", async () => {
    process.env.NEXUS_MEMORY_EXTRACTOR = "0";
    let called = 0;
    const out = await extractMissionInsights(RECORD, {
      fetchImpl: (() => {
        called++;
        return Promise.resolve(new Response("{}"));
      }) as unknown as typeof fetch,
    });
    expect(out).toBeNull();
    expect(called).toBe(0);
  });
});
