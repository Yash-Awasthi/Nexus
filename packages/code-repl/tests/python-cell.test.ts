// SPDX-License-Identifier: Apache-2.0
/** A kernel is one long-lived interpreter: names persist, earlier cells never rerun. */
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  InterpreterProcess,
  KernelManager,
  kernelCommand,
  type ReplExecutor,
  type ReplProcess,
} from "../src/index.js";

// On Windows "python3" can be the install manager's alias, which installs a runtime into the cwd.
const python = (process.platform === "win32" ? ["python"] : ["python3", "python"]).find(
  (bin) => spawnSync(bin, ["--version"]).status === 0,
);
const MARK = "__nexus_test_marker__";
const open = () => {
  const [, ...args] = kernelCommand("python", MARK, true);
  return new InterpreterProcess(python!, args, MARK);
};
const out = (s: string) => s.replace(/\r\n/g, "\n");

describe.skipIf(!python)("InterpreterProcess (python)", () => {
  it("keeps names across cells and runs each cell once", async () => {
    const p = open();
    try {
      expect(out((await p.run("x = 6*7\nprint('once')", 10_000)).stdout)).toBe("once\n");
      const second = await p.run("x + 1", 10_000);
      expect(out(second.stdout)).toBe("43\n");
      expect(second.exitCode).toBe(0);
      expect(out((await p.run("y = 1", 10_000)).stdout)).toBe("");
    } finally {
      p.close();
    }
  });

  it("reports a failing cell and keeps the state from before it", async () => {
    const p = open();
    try {
      await p.run("a = 5", 10_000);
      const bad = await p.run("1 / 0", 10_000);
      expect(bad.exitCode).toBe(1);
      expect(bad.stderr).toContain("ZeroDivisionError");
      expect(out((await p.run("a", 10_000)).stdout)).toBe("5\n");
      const exited = await p.run("raise SystemExit(3)", 10_000);
      expect(exited.exitCode).toBe(1);
      expect(out((await p.run("a * 2", 10_000)).stdout)).toBe("10\n");
    } finally {
      p.close();
    }
  });

  it("kills a cell past its timeout and is no longer alive", async () => {
    const p = open();
    const r = await p.run("import time\ntime.sleep(20)", 1_500);
    expect(r.exitCode).toBe(124);
    expect(p.alive).toBe(false);
  });
});

describe("KernelSession", () => {
  it("opens one process per session, reopens after it dies, and closes it on destroy", async () => {
    const opened: { closed: boolean; ran: string[] }[] = [];
    const exec: ReplExecutor = {
      execute: () => Promise.reject(new Error("one-shot path must not run")),
      open: (): ReplProcess => {
        const rec = { closed: false, ran: [] as string[] };
        opened.push(rec);
        return {
          get alive() {
            return !rec.closed;
          },
          run: async (code) => {
            rec.ran.push(code);
            if (code === "die") rec.closed = true;
            return { stdout: "", stderr: "", exitCode: code === "die" ? 124 : 0, durationMs: 1 };
          },
          close: () => {
            rec.closed = true;
          },
        };
      },
    };
    const km = new KernelManager({ executor: exec });
    const s = km.create("python");
    await s.execute({ code: "a = 1" });
    await s.execute({ code: "a" });
    expect(opened).toHaveLength(1);
    expect(opened[0]!.ran).toEqual(["a = 1", "a"]);
    await s.execute({ code: "die" });
    await s.execute({ code: "b = 2" });
    expect(opened).toHaveLength(2);
    km.destroy(s.id);
    expect(opened[1]!.closed).toBe(true);
  });
});
