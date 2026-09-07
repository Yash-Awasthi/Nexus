// SPDX-License-Identifier: Apache-2.0
/**
 * Peer critique + red-team protocols — focused tests with a recording
 * transport: assertions target WHO each critic saw (never its own response),
 * WHICH framing reached the prompt, and anonymization, not model text.
 */
import { describe, expect, it } from "vitest";
import { runCritique, type CritiqueTarget } from "./critique.js";
import type { ILLMResponse, ILLMTransport } from "./engine.js";

const Q = "Should we shard the event store now?";

const TARGETS: readonly CritiqueTarget[] = [
  { label: "Alpha", content: "Shard by tenant id immediately." },
  { label: "Beta", content: "Defer sharding until read p95 exceeds 80ms." },
  { label: "Gamma", content: "Adopt a partitioned-then-sharded hybrid." },
];

/** Records every user prompt; replies with a canned critique blob. */
function recordingTransport() {
  const seen: { criticHint: string | null; prompt: string }[] = [];
  const transport: ILLMTransport = {
    async chat(messages): Promise<ILLMResponse> {
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      // Critic identity is implied by which target is excluded — recover it.
      seen.push({ criticHint: null, prompt: user });
      return {
        content: `CRITIQUE for all listed responses.`,
        model: "fake",
        usage: { promptTokens: 5, completionTokens: 5 },
        latencyMs: 1,
      };
    },
  };
  return { transport, seen };
}

/** Which target labels appear in a critique prompt. */
function labelsIn(prompt: string): string[] {
  return ["Alpha", "Beta", "Gamma"].filter((l) => prompt.includes(`"${l}"`));
}

describe("runCritique", () => {
  it("gives every critic every other response, never its own", async () => {
    const { transport, seen } = recordingTransport();
    const res = await runCritique({
      question: Q,
      targets: TARGETS,
      critics: ["Alpha", "Beta", "Gamma"],
      transport,
      mode: "critique",
    });
    expect(res.critiques).toHaveLength(3);
    expect(res.mode).toBe("critique");

    // Critic Alpha saw Beta+Gamma, not itself.
    const alphaPrompt = seen[0]!.prompt;
    expect(labelsIn(alphaPrompt).sort()).toEqual(["Beta", "Gamma"]);
    const betaPrompt = seen[1]!.prompt;
    expect(labelsIn(betaPrompt).sort()).toEqual(["Alpha", "Gamma"]);
    const gammaPrompt = seen[2]!.prompt;
    expect(labelsIn(gammaPrompt).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("uses the reviewer framing for critique mode", async () => {
    const { transport, seen } = recordingTransport();
    await runCritique({
      question: Q,
      targets: TARGETS,
      critics: ["Alpha", "Beta"],
      transport,
      mode: "critique",
    });
    expect(seen[0]!.prompt).toContain("critical reviewer");
    expect(seen[0]!.prompt).toContain("**Strengths**");
    expect(seen[0]!.prompt).toContain("**Confidence**");
    expect(seen[0]!.prompt).not.toContain("red team adversary");
  });

  it("uses the adversarial framing for redteam mode", async () => {
    const { transport, seen } = recordingTransport();
    const res = await runCritique({
      question: Q,
      targets: TARGETS,
      critics: ["Alpha", "Beta"],
      transport,
      mode: "redteam",
    });
    expect(res.mode).toBe("redteam");
    expect(seen[0]!.prompt).toContain("red team adversary");
    expect(seen[0]!.prompt).toContain("**Flaws**");
    expect(seen[0]!.prompt).toContain("**Adversarial Inputs**");
    expect(seen[0]!.prompt).toContain("**Failure Modes**");
    expect(seen[0]!.prompt).not.toContain("**Strengths**");
  });

  it("anonymizes target identity in the prompt", async () => {
    const { transport, seen } = recordingTransport();
    await runCritique({
      question: Q,
      targets: TARGETS,
      critics: ["Alpha", "Beta"],
      transport,
      anonymize: true,
    });
    expect(seen[0]!.prompt).not.toContain('"Alpha"');
    expect(seen[0]!.prompt).not.toContain('"Beta"');
    expect(seen[0]!.prompt).toContain("an anonymous response");
  });

  it("skips critics with no other responses to critique", async () => {
    const { transport } = recordingTransport();
    const res = await runCritique({
      question: Q,
      targets: [TARGETS[0]!], // single target
      critics: ["Alpha", "Beta"],
      transport,
    });
    // Beta is a critic but not a target → still critiques Alpha; Alpha's own
    // is excluded, so only Beta produces a critique.
    expect(res.critiques.map((c) => c.critic)).toEqual(["Beta"]);
  });

  it("carries the question through and returns per-critic blobs", async () => {
    const { transport } = recordingTransport();
    const res = await runCritique({
      question: Q,
      targets: TARGETS,
      critics: ["Alpha"],
      transport,
    });
    expect(res.question).toBe(Q);
    expect(res.critiques[0]!.critic).toBe("Alpha");
    expect(res.critiques[0]!.content).toContain("CRITIQUE");
  });
});