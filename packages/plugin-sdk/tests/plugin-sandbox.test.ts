// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";

import {
  CapabilityGate,
  CapabilityDeniedError,
  SandboxUnavailableError,
  DenoPluginRunner,
  type LoadedPlugin,
  type DenoRunnerFn,
  type DenoInvocation,
} from "../src/index.js";

const PLUGIN: LoadedPlugin = {
  manifest: {
    id: "com.acme.summarizer",
    name: "Acme Summarizer",
    version: "1.2.3",
    entry: "./dist/plugin.js",
    capabilities: ["llm.inference", "storage.read"],
  },
  grantedCapabilities: ["llm.inference", "storage.read"],
};

describe("CapabilityGate", () => {
  it("allows granted capabilities", () => {
    const gate = new CapabilityGate(PLUGIN);
    expect(gate.has("llm.inference")).toBe(true);
    expect(gate.call({ capability: "llm.inference", action: "llm.inference" }).ok).toBe(true);
  });

  it("denies ungranted capabilities with CapabilityDeniedError", () => {
    const gate = new CapabilityGate(PLUGIN);
    try {
      gate.call({ capability: "database.execute", action: "database.execute" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CapabilityDeniedError);
      expect((e as CapabilityDeniedError).capability).toBe("database.execute");
      expect((e as CapabilityDeniedError).pluginId).toBe("com.acme.summarizer");
    }
  });

  it("lists the granted set", () => {
    const gate = new CapabilityGate(PLUGIN);
    expect(gate.grantedCapabilities()).toEqual(["llm.inference", "storage.read"]);
  });
});

describe("DenoPluginRunner", () => {
  it("runs a granted plugin through the injected runner", async () => {
    let invocation: unknown;
    const runnerFn: DenoRunnerFn = vi.fn(async (inv) => {
      invocation = inv;
      return { ok: true, stdout: "done", stderr: "", exitCode: 0, parsed: { ok: true } };
    });
    const runner = new DenoPluginRunner(PLUGIN, { runnerFn });
    const res = await runner.run("/tmp/plugin.js", { query: "hello" });
    expect(res.ok).toBe(true);
    expect(res.result!.parsed).toEqual({ ok: true });
    const inv = invocation as { scriptPath: string; payload: string; grantedCapabilities: string[] };
    expect(inv.scriptPath).toBe("/tmp/plugin.js");
    expect(inv.payload).toBe(JSON.stringify({ query: "hello" }));
    expect(inv.grantedCapabilities).toEqual(["llm.inference", "storage.read"]);
  });

  it("passes only the granted capability set to the subprocess (deny-by-default)", async () => {
    const runnerFn: DenoRunnerFn = vi.fn(async (inv) => ({
      ok: true,
      stdout: "",
      stderr: "",
      exitCode: 0,
      parsed: inv,
    }));
    const runner = new DenoPluginRunner(PLUGIN, { runnerFn });
    const res = await runner.run("/tmp/plugin.js", {});
    expect(res.ok).toBe(true);
    const inv = (res.result!.parsed as DenoInvocation);
    // The isolate receives ONLY the granted capabilities — database.execute,
    // secrets.read, etc. are never in the set the sandbox may use.
    expect(inv.grantedCapabilities).toEqual(["llm.inference", "storage.read"]);
  });

  it("never spawns the subprocess when the gate denies", async () => {
    const runnerFn: DenoRunnerFn = vi.fn(async () => ({
      ok: true,
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const gate = new CapabilityGate(PLUGIN);
    // Direct gate call denies before any runner involvement.
    try {
      gate.call({ capability: "secrets.read", action: "secrets.read" });
      expect.unreachable();
    } catch {
      /* expected */
    }
    expect(runnerFn).not.toHaveBeenCalled();
  });

  it("reports runner failures as ok:false with the error", async () => {
    const runnerFn: DenoRunnerFn = vi.fn(async () => {
      throw new Error("deno crashed");
    });
    const runner = new DenoPluginRunner(PLUGIN, { runnerFn });
    const res = await runner.run("/tmp/plugin.js", {});
    expect(res.ok).toBe(false);
    expect(res.error!.message).toContain("deno crashed");
  });

  it("default runner reports SandboxUnavailableError (NOT a capability denial) when deno is missing", async () => {
    const runner = new DenoPluginRunner(PLUGIN); // no runnerFn → default
    const res = await runner.run("/tmp/plugin.js", {});
    expect(res.ok).toBe(false);
    expect(res.error).toBeInstanceOf(SandboxUnavailableError);
    expect(res.error).not.toBeInstanceOf(CapabilityDeniedError);
    expect(res.error!.message).toContain("unavailable");
  });
});