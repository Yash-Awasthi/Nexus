// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LlmToolFn } from "@nexus/agent-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildLocalCodingTools, makeLocalLlm, runLocalAgent } from "../../src/lib/local-agent.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nexus-local-agent-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("buildLocalCodingTools", () => {
  it("confines file ops to the workspace root and rejects escapes", async () => {
    const tools = buildLocalCodingTools(dir);
    expect(tools.names()).toContain("read_file");
    expect(tools.names()).toContain("run_command");

    const w = await tools.invoke("write_file", { path: "a.txt", content: "hi" });
    expect(w.error).toBeUndefined();
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("hi");

    const escape = await tools.invoke("read_file", { path: "../../etc/passwd" });
    expect(escape.error).toMatch(/escapes workspace/);
  });

  it("omits run_command when shell is disabled", () => {
    expect(buildLocalCodingTools(dir, false).names()).not.toContain("run_command");
  });
});

describe("runLocalAgent", () => {
  it("drives the in-process loop with an injected llm — tool writes land on disk", async () => {
    // Turn 1: ask to write a file. Turn 2: finish (no tool calls).
    const llm = vi
      .fn()
      .mockResolvedValueOnce({
        content: "writing",
        toolCalls: [
          { id: "t1", name: "write_file", arguments: { path: "out.txt", content: "done" } },
        ],
      })
      .mockResolvedValueOnce({ content: "all set", toolCalls: [] });

    const result = await runLocalAgent({
      instruction: "create out.txt",
      rootDir: dir,
      llm: llm as unknown as LlmToolFn,
      maxSteps: 5,
    });

    expect(await readFile(join(dir, "out.txt"), "utf8")).toBe("done");
    expect(result.finalContent).toBe("all set");
    expect(result.aborted).toBe(false);
    expect(llm).toHaveBeenCalledTimes(2);
  });
});

describe("makeLocalLlm", () => {
  it("throws missing_api_key when no key resolves", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => makeLocalLlm("anthropic")).toThrow(/missing_api_key/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("builds a driver-backed llm when a key is passed", () => {
    expect(typeof makeLocalLlm("groq", "llama-3.1-8b-instant", "test-key")).toBe("function");
  });
});
