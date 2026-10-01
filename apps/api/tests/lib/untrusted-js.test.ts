// SPDX-License-Identifier: Apache-2.0
/**
 * The runner executes real child processes: what matters is what the code can
 * and cannot reach, which only running it shows.
 */
import { describe, it, expect } from "vitest";

import { runUntrustedJs } from "../../src/lib/untrusted-js.js";

describe("runUntrustedJs", () => {
  it("returns console output and the completion value", async () => {
    const r = await runUntrustedJs('console.log("hi"); 6 * 7');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hi\n42");
  });

  it("cannot read files, spawn processes or open sockets", async () => {
    const fs = await runUntrustedJs('require("node:fs").readFileSync("package.json", "utf8")');
    expect(fs.exitCode).not.toBe(0);
    const cp = await runUntrustedJs('require("node:child_process").execSync("echo pwned")');
    expect(cp.exitCode).not.toBe(0);
    const net = await runUntrustedJs('require("node:net").connect(80, "127.0.0.1")');
    expect(net.stderr).toMatch(/network access is disabled/);
  });

  it("sees none of the server's environment", async () => {
    const r = await runUntrustedJs("JSON.stringify(Object.keys(process.env))");
    expect(r.stdout).toBe("[]");
  });

  it("stops code that runs too long", async () => {
    const r = await runUntrustedJs("while (true) {}", 500);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(124);
  });
});

describe("runUntrustedJs timeout", () => {
  it("counts only the code's own run time, not the child Node's start-up", async () => {
    // The code uses most of its second; the child's own start-up would push it past.
    const r = await runUntrustedJs(
      "const t = Date.now(); while (Date.now() - t < 850) {} 6 * 7",
      1_000,
    );
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toBe("42");
    const spin = await runUntrustedJs("for (;;) {}", 300);
    expect(spin.timedOut).toBe(true);
  });
});
