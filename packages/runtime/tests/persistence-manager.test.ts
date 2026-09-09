// SPDX-License-Identifier: Apache-2.0
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  FileEventStore,
  FileRuntimePersistence,
  backupRuntimePersistence,
} from "../src/persistence-manager.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("FileEventStore", () => {
  it("creates parent dirs, appends records and replays them", async () => {
    const store = new FileEventStore(path.join(dir, "a", "events.jsonl"));
    expect(store.getEventLogPath()).toContain("events.jsonl");
    await store.saveEvent("task_routed", { id: "t1" });
    await store.saveEvent("execution_succeeded", { id: "t1" });
    const events = await store.replayEvents();
    expect(events.map((e) => e.event)).toEqual(["task_routed", "execution_succeeded"]);
    expect(events[0].payload).toEqual({ id: "t1" });
    expect(events[0].timestamp).toBeTruthy();
  });

  it("filters by since timestamp", async () => {
    const store = new FileEventStore(path.join(dir, "events.jsonl"));
    await store.saveEvent("older", {});
    await new Promise((r) => setTimeout(r, 5));
    const marker = new Date();
    await new Promise((r) => setTimeout(r, 5));
    await store.saveEvent("newer", {});
    const events = await store.replayEvents(marker);
    expect(events.map((e) => e.event)).toEqual(["newer"]);
  });

  it("skips and quarantines corrupt lines without dropping valid ones", async () => {
    const filePath = path.join(dir, "events.jsonl");
    fs.writeFileSync(
      filePath,
      '{"event":"ok","payload":{},"timestamp":"2026-01-01T00:00:00.000Z"}\ncorrupt-line\n',
      "utf8",
    );
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const store = new FileEventStore(filePath, logger as never);
    const events = await store.replayEvents();
    expect(events).toHaveLength(1);
    expect(store.lastReplayCorruptLines).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("corrupt"));
    const quarantine = fs.readdirSync(dir).find((f) => f.includes(".corrupt."));
    expect(quarantine).toBeTruthy();
  });

  it("logs corrupt lines to the console when no logger is attached", async () => {
    const filePath = path.join(dir, "events2.jsonl");
    fs.writeFileSync(filePath, "garbage\n", "utf8");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new FileEventStore(filePath);
    await store.replayEvents();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns empty on a missing log and copies backups", async () => {
    const store = new FileEventStore(path.join(dir, "missing.jsonl"));
    expect(await store.replayEvents()).toEqual([]);
    await store.saveEvent("x", {});
    const dest = store.backupTo(path.join(dir, "backups"));
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, "utf8")).toContain('"x"');
  });
});

describe("FileRuntimePersistence", () => {
  it("saves, reads, overwrites and clears state keys", async () => {
    const p = new FileRuntimePersistence(path.join(dir, "cache.json"));
    expect(p.getStateFilePath()).toContain("cache.json");
    await p.saveState("alpha", { n: 1 });
    await p.saveState("beta", "text");
    expect(await p.getState("alpha")).toEqual({ n: 1 });
    expect(await p.getState("beta")).toBe("text");
    await p.saveState("alpha", { n: 2 });
    expect(await p.getState("alpha")).toEqual({ n: 2 });
    await p.clearState("beta");
    expect(await p.getState("beta")).toBeUndefined();
  });

  it("recovers from a corrupt state file by quarantining it", async () => {
    const filePath = path.join(dir, "cache-corrupt.json");
    fs.writeFileSync(filePath, "{not json", "utf8");
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const p = new FileRuntimePersistence(filePath, logger as never);
    expect(await p.getState("anything")).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("corrupt"));
    expect(fs.existsSync(`${filePath}.corrupt.`)).toBe(false); // timestamped suffix
    const corruptFiles = fs.readdirSync(dir).filter((f) => f.includes(".corrupt."));
    expect(corruptFiles).toHaveLength(1);
  });

  it("warns and retries on a write-verify mismatch, then throws if it persists", async () => {
    const filePath = path.join(dir, "cache-verify.json");
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const p = new FileRuntimePersistence(filePath, logger as never);
    // Force every post-write read to observe a stale value so the write-verify
    // retry also fails — simulating an external writer clobbering the file.
    (p as unknown as { readState(): Record<string, unknown> }).readState = () => ({
      k: "stale",
    });
    await expect(p.saveState("k", { v: 2 })).rejects.toThrow(/write-verify FAILED/i);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Write-verify mismatch"));
  });

  it("backs up state to a target directory", async () => {
    const p = new FileRuntimePersistence(path.join(dir, "cache.json"));
    await p.saveState("k", "v");
    const dest = p.backupTo(path.join(dir, "backups"));
    expect(fs.readFileSync(dest, "utf8")).toContain('"k"');
    // backup of a never-existing file writes an empty object
    const p2 = new FileRuntimePersistence(path.join(dir, "ghost.json"));
    const dest2 = p2.backupTo(path.join(dir, "backups"));
    expect(fs.readFileSync(dest2, "utf8")).toBe("{}");
  });
});

describe("backupRuntimePersistence", () => {
  it("snapshots both event log and KV state", async () => {
    const eventStore = new FileEventStore(path.join(dir, "events.jsonl"));
    const persistence = new FileRuntimePersistence(path.join(dir, "cache.json"));
    await eventStore.saveEvent("e1", {});
    await persistence.saveState("s1", 1);
    const backups = backupRuntimePersistence(eventStore, persistence, path.join(dir, "snap"));
    expect(fs.existsSync(backups.eventsBackup)).toBe(true);
    expect(fs.existsSync(backups.stateBackup)).toBe(true);
    expect(backups.eventsBackup).not.toBe(backups.stateBackup);
  });
});
