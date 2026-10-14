// SPDX-License-Identifier: Apache-2.0
/**
 * NX-SEC-001: Python from users and models must never run inside the API
 * process, where Pyodide's `js` module is the host's globalThis.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runViaPyodide } from "../../src/routes/sandbox.ts";

// Each run boots Pyodide in a fresh child (about 2 s, more on a loaded machine).
vi.setConfig({ testTimeout: 90_000 });

const CANARY = "nexus-sandbox-canary-7f3a";

beforeAll(() => {
  process.env.NEXUS_SANDBOX_CANARY = CANARY;
});

afterAll(() => {
  delete process.env.NEXUS_SANDBOX_CANARY;
});

describe("runViaPyodide", () => {
  it("runs Python and returns its output", async () => {
    const r = await runViaPyodide("print(6 * 7)");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("42");
  });

  it("cannot read the server's environment", async () => {
    const r = await runViaPyodide(
      "from js import process\nprint(str(process.env.NEXUS_SANDBOX_CANARY))",
    );
    expect(r.stdout).not.toContain(CANARY);
  });

  it("cannot start host processes", async () => {
    const r = await runViaPyodide(
      'from js import process\nprocess.getBuiltinModule("child_process").exec("exit 0")\nprint("spawned")',
    );
    expect(r.stdout).not.toContain("spawned");
    expect(r.exitCode).not.toBe(0);
  });

  it("keeps nothing between runs", async () => {
    await runViaPyodide("leaked = 'from-a-previous-caller'");
    const r = await runViaPyodide("print(leaked)");
    expect(r.stdout).not.toContain("from-a-previous-caller");
    expect(r.exitCode).not.toBe(0);
  });

  it("stops a run that never ends", async () => {
    const started = Date.now();
    const r = await runViaPyodide("while True:\n    pass", 1_000);
    expect(r.exitCode).toBe(124);
    expect(Date.now() - started).toBeLessThan(60_000);
  });
});
