// SPDX-License-Identifier: Apache-2.0
/**
 * DisasterRecovery — checkpoint / restore for critical Nexus runtime state.
 *
 * Problem:
 *   After a crash, the CrashRecovery service re-queues stale tasks, but
 *   higher-level state (last processed event sequence, queue high-water marks,
 *   active council deliberation IDs) is lost. Replaying from scratch is
 *   expensive and may produce duplicate work.
 *
 * Solution:
 *   DisasterRecovery periodically serialises a Checkpoint to a durable store
 *   (local JSON file + optional remote mirror).  On startup it restores the
 *   latest valid checkpoint and hands back a RestoreResult telling the
 *   runtime how far to fast-forward.
 *
 * Checkpoint integrity:
 *   Each checkpoint includes a SHA-256 digest of its serialised payload.
 *   On restore, the digest is re-verified; corrupted checkpoints are skipped
 *   and the previous clean checkpoint is used instead.
 *
 * Rotation:
 *   At most `maxCheckpoints` files are retained. Older files are pruned
 *   automatically after a successful write.
 *
 * Usage:
 *   const dr = new DisasterRecovery({ dir: "/var/nexus/checkpoints" });
 *   await dr.init();
 *
 *   // On startup:
 *   const restore = await dr.restore();
 *   if (restore.found) {
 *     runtime.fastForwardTo(restore.checkpoint.lastEventSequence);
 *   }
 *
 *   // Periodic (e.g. every 60s):
 *   await dr.checkpoint({ lastEventSequence: 1234, runningTaskIds: [...] });
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Checkpoint schema ────────────────────────────────────────────────────────

export interface RuntimeCheckpoint {
  /** Monotonic sequence number of the last processed audit_log entry */
  lastEventSequence: number;
  /** IDs of tasks that were in "running" state when the checkpoint was taken */
  runningTaskIds: string[];
  /** IDs of verdicts that were in-progress (council deliberating) */
  pendingVerdictIds: string[];
  /** Queue high-water marks: { queueName → last processed job ID } */
  queueHighWaterMarks: Record<string, string>;
  /** Arbitrary key-value metadata for extensibility */
  metadata?: Record<string, unknown>;
}

interface CheckpointFile {
  version: number;
  takenAt: string;   // ISO 8601
  checkpoint: RuntimeCheckpoint;
  digest: string;    // SHA-256 hex of JSON.stringify(checkpoint)
}

export interface RestoreResult {
  found: boolean;
  checkpoint?: RuntimeCheckpoint;
  takenAt?: Date;
  /** How many candidate files were examined (including invalid ones) */
  filesExamined: number;
  /** How many files were skipped due to corrupt digest */
  corruptFiles: number;
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface DisasterRecoveryConfig {
  /** Directory where checkpoint files are stored */
  dir: string;
  /** Maximum number of checkpoint files to retain (default: 5) */
  maxCheckpoints?: number;
  /** File prefix (default: "nexus-checkpoint") */
  prefix?: string;
}

// ─── DisasterRecovery ─────────────────────────────────────────────────────────

export class DisasterRecovery {
  private readonly dir: string;
  private readonly maxCheckpoints: number;
  private readonly prefix: string;

  constructor(config: DisasterRecoveryConfig) {
    this.dir = config.dir;
    this.maxCheckpoints = config.maxCheckpoints ?? 5;
    this.prefix = config.prefix ?? "nexus-checkpoint";
  }

  /** Ensure the checkpoint directory exists */
  async init(): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
  }

  /**
   * Write a checkpoint and rotate old files.
   * Returns the path of the written file.
   */
  async checkpoint(state: RuntimeCheckpoint): Promise<string> {
    const payload = JSON.stringify(state);
    const digest = createHash("sha256").update(payload, "utf8").digest("hex");

    const file: CheckpointFile = {
      version: 1,
      takenAt: new Date().toISOString(),
      checkpoint: state,
      digest,
    };

    const filename = `${this.prefix}-${Date.now()}.json`;
    const filepath = path.join(this.dir, filename);

    // Write atomically: write to temp, then rename
    const tmp = filepath + ".tmp";
    await fs.promises.writeFile(tmp, JSON.stringify(file, null, 2), "utf8");
    await fs.promises.rename(tmp, filepath);

    await this.rotate();
    return filepath;
  }

  /**
   * Restore the most recent valid checkpoint.
   * Returns a RestoreResult with found=false if no valid checkpoint exists.
   */
  async restore(): Promise<RestoreResult> {
    const candidates = await this.listCheckpointFiles();
    let filesExamined = 0;
    let corruptFiles = 0;

    // Try from newest to oldest
    for (const filepath of candidates.reverse()) {
      filesExamined++;
      const result = await this.tryRead(filepath);
      if (!result) {
        corruptFiles++;
        continue;
      }
      return {
        found: true,
        checkpoint: result.checkpoint,
        takenAt: new Date(result.takenAt),
        filesExamined,
        corruptFiles,
      };
    }

    return { found: false, filesExamined, corruptFiles };
  }

  /**
   * Return an empty checkpoint (all zeros) suitable as a "never checkpointed" baseline.
   */
  static empty(): RuntimeCheckpoint {
    return {
      lastEventSequence: 0,
      runningTaskIds: [],
      pendingVerdictIds: [],
      queueHighWaterMarks: {},
    };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async listCheckpointFiles(): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(this.dir);
      return entries
        .filter((f) => f.startsWith(this.prefix) && f.endsWith(".json"))
        .sort() // lexicographic = chronological (timestamp in name)
        .map((f) => path.join(this.dir, f));
    } catch {
      return [];
    }
  }

  private async tryRead(filepath: string): Promise<CheckpointFile | undefined> {
    try {
      const raw = await fs.promises.readFile(filepath, "utf8");
      const parsed = JSON.parse(raw) as CheckpointFile;

      if (!parsed.checkpoint || !parsed.digest || parsed.version !== 1) {
        return undefined;
      }

      // Verify digest
      const expected = createHash("sha256")
        .update(JSON.stringify(parsed.checkpoint), "utf8")
        .digest("hex");

      if (expected !== parsed.digest) {
        return undefined;
      }

      return parsed;
    } catch {
      return undefined;
    }
  }

  private async rotate(): Promise<void> {
    const files = await this.listCheckpointFiles();
    if (files.length <= this.maxCheckpoints) return;

    const toDelete = files.slice(0, files.length - this.maxCheckpoints);
    await Promise.all(toDelete.map((f) => fs.promises.unlink(f).catch(() => {})));
  }
}

// ─── MemoryDisasterRecovery — for tests ──────────────────────────────────────

export class MemoryDisasterRecovery {
  private checkpoints: { state: RuntimeCheckpoint; takenAt: Date }[] = [];
  private readonly max: number;

  constructor(max = 5) {
    this.max = max;
  }

  async init(): Promise<void> {}

  async checkpoint(state: RuntimeCheckpoint): Promise<string> {
    this.checkpoints.push({ state, takenAt: new Date() });
    if (this.checkpoints.length > this.max) {
      this.checkpoints.splice(0, this.checkpoints.length - this.max);
    }
    return `memory:${this.checkpoints.length}`;
  }

  async restore(): Promise<RestoreResult> {
    if (this.checkpoints.length === 0) {
      return { found: false, filesExamined: 0, corruptFiles: 0 };
    }
    const latest = this.checkpoints[this.checkpoints.length - 1]!;
    return {
      found: true,
      checkpoint: latest.state,
      takenAt: latest.takenAt,
      filesExamined: this.checkpoints.length,
      corruptFiles: 0,
    };
  }

  count(): number {
    return this.checkpoints.length;
  }
}
