// SPDX-License-Identifier: Apache-2.0
/**
 * Node self-optimizer — focused tests mirroring gptswarm's optimize():
 * candidate construction from positive/negative examples, deterministic
 * demonstration capping, best-variant adoption, and no-op cases.
 */
import { describe, expect, it } from "vitest";
import { LLMNode } from "./index.js";
import { optimizeNodeVariant, type NodeOptimizerConfig, type NodeVariant } from "./optimizer.js";

const CURRENT: NodeVariant = { prompt: "Solve {{input}}", demonstrations: ["demo-1"] };

/** Score ladder: revised-prompt variants win, demos-extended next, current last. */
async function ladderScore(variant: NodeVariant): Promise<number> {
  if (variant.prompt.startsWith("REVISED")) return 10;
  if (variant.demonstrations.length > CURRENT.demonstrations.length) return 5;
  return 1;
}

function config(overrides: Partial<NodeOptimizerConfig> = {}): NodeOptimizerConfig {
  return {
    current: CURRENT,
    examples: [
      { task: "t1", success: true },
      { task: "t2", success: false },
      { task: "t3", success: true },
    ],
    revisePrompt: async () => "REVISED: {{input}}",
    score: ladderScore,
    ...overrides,
  };
}

describe("optimizeNodeVariant", () => {
  it("adopts the highest-scoring candidate (prompt revised from negatives)", async () => {
    const out = await optimizeNodeVariant(config());
    expect(out.adopted).toBe(true);
    expect(out.variant.prompt).toBe("REVISED: {{input}}");
    // current + demos-extended + revised + revised+demos
    expect(out.candidates.length).toBe(4);
  });

  it("extends demonstrations with positive examples when prompt learning is off", async () => {
    const out = await optimizeNodeVariant(config({ learnPrompt: false }));
    expect(out.variant.demonstrations).toEqual(["demo-1", "t1", "t3"]);
    expect(out.variant.prompt).toBe(CURRENT.prompt);
  });

  it("caps demonstrations at maxDemonstrations, keeping the most recent", async () => {
    const out = await optimizeNodeVariant(
      config({
        learnPrompt: false,
        maxDemonstrations: 3,
        examples: [
          { task: "a", success: true },
          { task: "b", success: true },
          { task: "c", success: true },
          { task: "d", success: true },
        ],
      }),
    );
    expect(out.variant.demonstrations).toEqual(["b", "c", "d"]);
  });

  it("only learns from the most recent historyWindow examples", async () => {
    let revisedFrom: readonly string[] = [];
    const out = await optimizeNodeVariant(
      config({
        historyWindow: 2,
        revisePrompt: async (negatives) => {
          revisedFrom = negatives;
          return "R: {{input}}";
        },
      }),
    );
    // Window is [t2(fail), t3(success)] → the only negative is t2.
    expect(revisedFrom).toEqual(["t2"]);
    expect(out.adopted).toBe(true);
  });

  it("is a no-op when there is nothing to learn from", async () => {
    const out = await optimizeNodeVariant(config({ examples: [] }));
    expect(out.candidates).toHaveLength(1);
    expect(out.adopted).toBe(false);
    expect(out.variant).toEqual(CURRENT);
  });

  it("reports not-adopted when the current variant still scores best", async () => {
    const out = await optimizeNodeVariant(
      config({
        // Current always wins.
        score: async () => 1,
      }),
    );
    expect(out.candidates.length).toBe(4);
    expect(out.adopted).toBe(false);
    expect(out.variant).toEqual(CURRENT);
  });

  it("composes with LLMNode via promptText + applyVariant", async () => {
    const node = new LLMNode(
      "coder",
      { complete: async () => ({ content: "" }) } as never,
      "Solve {{input}}",
    );
    const out = await optimizeNodeVariant(config());
    node.applyVariant(out.variant);
    expect(node.promptText).toBe("REVISED: {{input}}");
  });
});