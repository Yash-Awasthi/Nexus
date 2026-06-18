// SPDX-License-Identifier: Apache-2.0
import * as fs from "fs";
import * as path from "path";

import type { EventRecord } from "./interfaces/event-store.interface.js";
import type { ILogger } from "./interfaces/logger.interface.js";
import type { IEventStore, IRuntimePersistence } from "./interfaces/persistence.interface.js";

/**
 * Append-only JSONL event log with best-effort replay.
 * Corrupt lines are skipped; optional quarantine file preserves them for recovery.
 */
export class FileEventStore implements IEventStore {
  private filePath: string;
  private appendQueue: Promise<void> = Promise.resolve();
  lastReplayCorruptLines = 0;
  private logger?: ILogger;

  constructor(filePath: string, logger?: ILogger) {
    this.filePath = filePath;
    this.logger = logger;
    this.ensureFileExists();
  }

  private ensureFileExists() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Use exclusive-create flag to avoid TOCTOU race between existsSync + writeFileSync.
    try {
      fs.writeFileSync(this.filePath, "", { flag: "wx", encoding: "utf8" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; // File already exists — that's fine
    }
  }

  getEventLogPath(): string {
    return this.filePath;
  }

  async saveEvent(event: string, payload: unknown): Promise<void> {
    const record = {
      event,
      payload,
      timestamp: new Date().toISOString(),
    };
    const line = JSON.stringify(record) + "\n";

    this.appendQueue = this.appendQueue.then(() => {
      fs.appendFileSync(this.filePath, line, "utf8");
      return;
    });
    return this.appendQueue;
  }

  async replayEvents(since?: Date): Promise<EventRecord[]> {
    this.lastReplayCorruptLines = 0;
    if (!fs.existsSync(this.filePath)) {
      return [];
    }
    const content = fs.readFileSync(this.filePath, "utf8");
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    const parsed: EventRecord[] = [];
    const corruptLines: string[] = [];

    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line) as EventRecord);
      } catch {
        this.lastReplayCorruptLines++;
        corruptLines.push(line);
      }
    }

    if (corruptLines.length > 0) {
      const quarantinePath = `${this.filePath}.corrupt.${Date.now()}.jsonl`;
      fs.appendFileSync(quarantinePath, corruptLines.join("\n") + "\n", "utf8");
      const msg = `[Conductor] event log replay skipped ${this.lastReplayCorruptLines} corrupt JSONL line(s); quarantined to ${quarantinePath}`;
      if (this.logger) {
        this.logger.warn(msg);
      } else {
        console.warn(msg);
      }
    }

    if (since) {
      const sinceTime = since.getTime();
      return parsed.filter((item: EventRecord) => new Date(item.timestamp).getTime() >= sinceTime);
    }

    return parsed;
  }

  /** Copy event log to backups directory with timestamp suffix. */
  backupTo(targetDir: string): string {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(targetDir, `events-${stamp}.jsonl`);
    if (fs.existsSync(this.filePath)) {
      fs.copyFileSync(this.filePath, dest);
    } else {
      fs.writeFileSync(dest, "", "utf8");
    }
    return dest;
  }
}

export class FileRuntimePersistence implements IRuntimePersistence {
  private filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private logger?: ILogger;

  constructor(filePath: string, logger?: ILogger) {
    this.filePath = filePath;
    this.logger = logger;
    this.ensureFileExists();
  }

  private ensureFileExists() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  getStateFilePath(): string {
    return this.filePath;
  }

  private readState(): Record<string, unknown> {
    if (!fs.existsSync(this.filePath)) {
      return {};
    }
    try {
      const content = fs.readFileSync(this.filePath, "utf8");
      return JSON.parse(content || "{}");
    } catch {
      const corruptPath = `${this.filePath}.corrupt.${Date.now()}.json`;
      if (fs.existsSync(this.filePath)) {
        fs.copyFileSync(this.filePath, corruptPath);
      }
      const corruptMsg = `[Conductor] state file corrupt; reset to {} (backup: ${corruptPath})`;
      if (this.logger) {
        this.logger.warn(corruptMsg);
      } else {
        console.warn(corruptMsg);
      }
      return {};
    }
  }

  private writeState(state: Record<string, unknown>) {
    // Write sequentially via writeQueue; writeFileSync is safe here
    // because the queue serializes all access. We avoid the temp+rename
    // pattern which fails with EPERM on Windows (rename when dest exists).
    const payload = JSON.stringify(state, null, 2);
    fs.writeFileSync(this.filePath, payload, "utf8");
  }

  async saveState(key: string, state: unknown, options?: { verifyWrite?: boolean }): Promise<void> {
    this.writeQueue = this.writeQueue
      .then(() => {
        const current = this.readState();
        current[key] = state;
        this.writeState(current);
        // Write-verify: read back and confirm the value matches
        if (options?.verifyWrite !== false) {
          const verify = this.readState();
          const written = JSON.stringify(verify[key]);
          const expected = JSON.stringify(state);
          if (written !== expected) {
            // Write verification failed — attempt a second write
            const verifyMsg = `[ConductorPersistence] Write-verify mismatch for key: ${key}. Rewriting...`;
            if (this.logger) {
              this.logger.warn(verifyMsg);
            } else {
              console.warn(verifyMsg);
            }
            this.writeState(current);
            const verify2 = this.readState();
            if (JSON.stringify(verify2[key]) !== expected) {
              throw new Error(
                `Persistence write-verify FAILED for key: ${key}. Data may be corrupt.`,
              );
            }
          }
        }
        return;
      })
      .catch((e) => {
        throw e;
      });
    return this.writeQueue;
  }

  async getState<T>(key: string): Promise<T | undefined> {
    await this.writeQueue;
    const current = this.readState();
    return current[key] as T;
  }

  async clearState(key: string): Promise<void> {
    this.writeQueue = this.writeQueue
      .then(() => {
        const current = this.readState();
        delete current[key];
        this.writeState(current);
        return;
      })
      .catch((e) => {
        throw e;
      });
    return this.writeQueue;
  }

  backupTo(targetDir: string): string {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(targetDir, `cache-${stamp}.json`);
    if (fs.existsSync(this.filePath)) {
      fs.copyFileSync(this.filePath, dest);
    } else {
      fs.writeFileSync(dest, "{}", "utf8");
    }
    return dest;
  }
}

/** Snapshot both event log and KV state into backupsDir. */
export function backupRuntimePersistence(
  eventStore: FileEventStore,
  persistence: FileRuntimePersistence,
  backupsDir: string,
): { eventsBackup: string; stateBackup: string } {
  return {
    eventsBackup: eventStore.backupTo(backupsDir),
    stateBackup: persistence.backupTo(backupsDir),
  };
}
