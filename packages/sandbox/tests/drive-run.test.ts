// SPDX-License-Identifier: Apache-2.0
/** A hard-quota drive run: the result lands only when the container finished copying it out. */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildDockerArgs, RUN_COMPLETE, runOnDrive, type Runner } from "../src/index.js";

function drive(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "drive-run-"));
  const dir = join(root, "d");
  return { root, dir };
}

/** The host directory mounted at the given container path in a docker argument list. */
const mounted = (args: string[], target: string) =>
  args
    .find((a) => a.endsWith(`:${target}:rw`) || a.endsWith(`:${target}:ro`))
    ?.split(`:${target}`)[0];

describe("runOnDrive", () => {
  it("swaps in what the command left behind", async () => {
    const { root, dir } = drive();
    await mkdir(dir);
    await writeFile(join(dir, "keep.txt"), "old");
    const run: Runner = async (_cmd, args) => {
      const out = mounted(args, "/nexus-out")!;
      await writeFile(join(out, "keep.txt"), "old");
      await writeFile(join(out, "made.txt"), "new");
      await writeFile(join(out, RUN_COMPLETE), "");
      return { stdout: "done", stderr: "", exitCode: 0, timedOut: false };
    };
    const r = await runOnDrive({
      driveDir: dir,
      quotaBytes: 1 << 20,
      command: "x",
      timeoutMs: 1000,
      run,
    });
    expect(r).toMatchObject({ applied: true, exitCode: 0, stdout: "done" });
    expect(readFileSync(join(dir, "made.txt"), "utf8")).toBe("new");
    expect(existsSync(join(dir, RUN_COMPLETE))).toBe(false);
    expect(readdirSync(root)).toEqual(["d"]);
  });

  it("leaves the drive alone when the copy never finished", async () => {
    const { root, dir } = drive();
    await mkdir(dir);
    await writeFile(join(dir, "keep.txt"), "old");
    const run: Runner = async (_cmd, args) => {
      await writeFile(join(mounted(args, "/nexus-out")!, "half.txt"), "partial");
      return { stdout: "", stderr: "No space left on device", exitCode: 1, timedOut: false };
    };
    const r = await runOnDrive({
      driveDir: dir,
      quotaBytes: 1 << 20,
      command: "x",
      timeoutMs: 1000,
      run,
    });
    expect(r.applied).toBe(false);
    expect(readdirSync(dir)).toEqual(["keep.txt"]);
    expect(readdirSync(root)).toEqual(["d"]);
  });

  it("removes a container that outlived its time", async () => {
    const { dir } = drive();
    await mkdir(dir);
    const calls: string[][] = [];
    const run: Runner = async (_cmd, args) => {
      calls.push(args);
      if (args[0] === "rm") return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      writeFileSync(join(mounted(args, "/nexus-out")!, RUN_COMPLETE), "");
      return { stdout: "", stderr: "", exitCode: null, timedOut: true };
    };
    const r = await runOnDrive({
      driveDir: dir,
      quotaBytes: 1 << 20,
      command: "x",
      timeoutMs: 10,
      run,
    });
    expect(r.applied).toBe(false);
    const name = calls[0]!.find((a) => a.startsWith("--name="))!.slice("--name=".length);
    expect(calls[1]).toEqual(["rm", "-f", name]);
  });
});

describe("buildDockerArgs hard quota", () => {
  it("puts the drive on a tmpfs of the quota and grows the memory cap to hold it", () => {
    const args = buildDockerArgs({
      workspacePath: "/drives/u",
      outputPath: "/drives/u.run-1",
      quotaMb: 512,
      memoryMb: 128,
    });
    expect(args).toContain("/drives/u:/nexus-src:ro");
    expect(args).toContain("/drives/u.run-1:/nexus-out:rw");
    expect(args).toContain("--tmpfs=/workspace:rw,nosuid,nodev,size=512m,mode=1777");
    expect(args).toContain("--memory=640m");
    expect(args.some((a) => a.endsWith(":/workspace:rw"))).toBe(false);
  });
});

describe("drive runs under a VM runtime", () => {
  it("attach stdin only when there is input, since Kata never returns from an empty -i", async () => {
    expect(buildDockerArgs({})).toContain("-i");
    expect(buildDockerArgs({ interactive: false })).not.toContain("-i");
    const { dir } = drive();
    await mkdir(dir);
    let seen: string[] = [];
    const run: Runner = async (_cmd, args) => {
      seen = args;
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };
    await runOnDrive({ driveDir: dir, quotaBytes: 1 << 20, command: "x", timeoutMs: 10, run });
    expect(seen).not.toContain("-i");
  });

  it("copies the drive's entries, not the tmpfs root, so the drive keeps its own mode", async () => {
    const { dir } = drive();
    await mkdir(dir);
    let script = "";
    const run: Runner = async (_cmd, args) => {
      script = args[args.indexOf("-c") + 1]!;
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };
    await runOnDrive({ driveDir: dir, quotaBytes: 1 << 20, command: "x", timeoutMs: 10, run });
    expect(script).not.toMatch(/cp -a \S+\/\. /);
    expect(script).toContain("-mindepth 1 -maxdepth 1");
  });
});

describe("drive run permissions", () => {
  it.skipIf(process.platform === "win32")(
    "lets the container user write the staging copy and gives the drive back its own mode",
    async () => {
      const { dir } = drive();
      await mkdir(dir, { mode: 0o750 });
      const { chmodSync, statSync } = await import("node:fs");
      chmodSync(dir, 0o750);
      let stagingMode = 0;
      const run: Runner = async (_cmd, args) => {
        const out = mounted(args, "/nexus-out")!;
        stagingMode = statSync(out).mode & 0o777;
        writeFileSync(join(out, RUN_COMPLETE), "");
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      };
      await runOnDrive({ driveDir: dir, quotaBytes: 1 << 20, command: "x", timeoutMs: 10, run });
      expect(stagingMode).toBe(0o777);
      expect(statSync(dir).mode & 0o777).toBe(0o750);
    },
  );
});
