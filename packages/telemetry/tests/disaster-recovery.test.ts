// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  DisasterRecovery,
  MemoryDisasterRecovery,
  type RuntimeCheckpoint,
} from "../src/disaster-recovery.js";

function makeCheckpoint(overrides: Partial<RuntimeCheckpoint> = {}): RuntimeCheckpoint {
  return {
    lastEventSequence: 42,
    runningTaskIds: ["task-1", "task-2"],
    pendingVerdictIds: ["verdict-a"],
    queueHighWaterMarks: { "nexus-high": "job-99" },
    ...overrides,
  };
}

// ─── DisasterRecovery (file-backed) ───────────────────────────────────────────

describe("DisasterRecovery", () => {
  let tmpDir: string;
  let dr: DisasterRecovery;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nexus-dr-test-"));
    dr = new DisasterRecovery({ dir: tmpDir, maxCheckpoints: 3, prefix: "test-ckpt" });
    await dr.init();
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  describe("init()", () => {
    it("creates the checkpoint directory if it does not exist", async () => {
      const newDir = path.join(tmpDir, "sub", "nested");
      const dr2 = new DisasterRecovery({ dir: newDir });
      await dr2.init();
      const stat = await fs.promises.stat(newDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe("checkpoint()", () => {
    it("writes a JSON file to the checkpoint directory", async () => {
      const filePath = await dr.checkpoint(makeCheckpoint());
      const stat = await fs.promises.stat(filePath);
      expect(stat.isFile()).toBe(true);
    });

    it("the written file contains the checkpoint state", async () => {
      const ckpt = makeCheckpoint({ lastEventSequence: 100 });
      const filePath = await dr.checkpoint(ckpt);
      const raw = await fs.promises.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as {
        checkpoint: RuntimeCheckpoint;
        digest: string;
        version: number;
      };
      expect(parsed.checkpoint.lastEventSequence).toBe(100);
      expect(parsed.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(parsed.version).toBe(1);
    });

    it("rotates old files when maxCheckpoints is exceeded", async () => {
      await dr.checkpoint(makeCheckpoint({ lastEventSequence: 1 }));
      await dr.checkpoint(makeCheckpoint({ lastEventSequence: 2 }));
      await dr.checkpoint(makeCheckpoint({ lastEventSequence: 3 }));
      await dr.checkpoint(makeCheckpoint({ lastEventSequence: 4 }));

      const files = (await fs.promises.readdir(tmpDir)).filter(
        (f) => f.startsWith("test-ckpt") && f.endsWith(".json"),
      );
      expect(files).toHaveLength(3);
    });
  });

  describe("restore()", () => {
    it("returns found=false when no checkpoint files exist", async () => {
      const result = await dr.restore();
      expect(result.found).toBe(false);
      expect(result.filesExamined).toBe(0);
    });

    it("restores the most recent valid checkpoint", async () => {
      await dr.checkpoint(makeCheckpoint({ lastEventSequence: 1 }));
      // Small delay to ensure different timestamps in filenames
      await new Promise((r) => setTimeout(r, 5));
      await dr.checkpoint(makeCheckpoint({ lastEventSequence: 99 }));

      const result = await dr.restore();
      expect(result.found).toBe(true);
      expect(result.checkpoint?.lastEventSequence).toBe(99);
      expect(result.takenAt).toBeInstanceOf(Date);
    });

    it("skips corrupt checkpoint files (bad digest)", async () => {
      const filePath = await dr.checkpoint(makeCheckpoint({ lastEventSequence: 50 }));
      // Corrupt the file by modifying the digest
      const raw = JSON.parse(await fs.promises.readFile(filePath, "utf8")) as {
        digest: string;
        checkpoint: RuntimeCheckpoint;
      };
      raw.digest = "badf00d".repeat(9);
      await fs.promises.writeFile(filePath, JSON.stringify(raw), "utf8");

      const result = await dr.restore();
      expect(result.found).toBe(false);
      expect(result.corruptFiles).toBe(1);
    });

    it("falls back to older valid checkpoint when newest is corrupt", async () => {
      await dr.checkpoint(makeCheckpoint({ lastEventSequence: 10 }));
      await new Promise((r) => setTimeout(r, 5));
      const newerPath = await dr.checkpoint(makeCheckpoint({ lastEventSequence: 20 }));

      // Corrupt only the newer file
      const raw = JSON.parse(await fs.promises.readFile(newerPath, "utf8")) as { digest: string };
      raw.digest = "0".repeat(64);
      await fs.promises.writeFile(newerPath, JSON.stringify(raw), "utf8");

      const result = await dr.restore();
      expect(result.found).toBe(true);
      expect(result.checkpoint?.lastEventSequence).toBe(10);
      expect(result.corruptFiles).toBe(1);
    });
  });

  describe("empty()", () => {
    it("returns an empty checkpoint with zero sequence and empty arrays", () => {
      const empty = DisasterRecovery.empty();
      expect(empty.lastEventSequence).toBe(0);
      expect(empty.runningTaskIds).toEqual([]);
      expect(empty.pendingVerdictIds).toEqual([]);
      expect(empty.queueHighWaterMarks).toEqual({});
    });
  });
});

// ─── MemoryDisasterRecovery (in-memory) ───────────────────────────────────────

describe("MemoryDisasterRecovery", () => {
  let mdr: MemoryDisasterRecovery;

  beforeEach(() => {
    mdr = new MemoryDisasterRecovery(3);
  });

  it("init() resolves immediately", async () => {
    await expect(mdr.init()).resolves.toBeUndefined();
  });

  it("count() starts at 0", () => {
    expect(mdr.count()).toBe(0);
  });

  it("stores checkpoints and increments count", async () => {
    await mdr.checkpoint(makeCheckpoint({ lastEventSequence: 1 }));
    await mdr.checkpoint(makeCheckpoint({ lastEventSequence: 2 }));
    expect(mdr.count()).toBe(2);
  });

  it("restore() returns found=false when no checkpoints exist", async () => {
    const result = await mdr.restore();
    expect(result.found).toBe(false);
    expect(result.filesExamined).toBe(0);
    expect(result.corruptFiles).toBe(0);
  });

  it("restore() returns the most recent checkpoint", async () => {
    await mdr.checkpoint(makeCheckpoint({ lastEventSequence: 1 }));
    await mdr.checkpoint(makeCheckpoint({ lastEventSequence: 77 }));

    const result = await mdr.restore();
    expect(result.found).toBe(true);
    expect(result.checkpoint?.lastEventSequence).toBe(77);
    expect(result.takenAt).toBeInstanceOf(Date);
  });

  it("respects the max limit by evicting oldest checkpoints", async () => {
    await mdr.checkpoint(makeCheckpoint({ lastEventSequence: 1 }));
    await mdr.checkpoint(makeCheckpoint({ lastEventSequence: 2 }));
    await mdr.checkpoint(makeCheckpoint({ lastEventSequence: 3 }));
    await mdr.checkpoint(makeCheckpoint({ lastEventSequence: 4 }));

    expect(mdr.count()).toBe(3);

    const result = await mdr.restore();
    expect(result.checkpoint?.lastEventSequence).toBe(4);
  });

  it("checkpoint() returns a memory: URI", async () => {
    const ref = await mdr.checkpoint(makeCheckpoint());
    expect(ref).toMatch(/^memory:/);
  });
});
