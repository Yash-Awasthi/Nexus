// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/agent-checkpoint — Checkpoint system for agent state persistence.
 *
 * Inspired by LangGraph's checkpoint architecture.
 * Provides state serialization, delta snapshots, checkpoint metadata,
 * and fork/restore capabilities for agent workflows.
 */

import { createHash } from "node:crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export type CheckpointSource = "input" | "loop" | "update" | "fork";

export interface CheckpointMetadata {
  source: CheckpointSource;
  step: number;
  parentId?: string;
  runId: string;
  createdAt: number;
}

export interface Checkpoint {
  id: string;
  namespace: string;
  state: Record<string, unknown>;
  metadata: CheckpointMetadata;
  version: number;
  parentCheckpointId?: string;
}

export interface DeltaSnapshot {
  checkpointId: string;
  channelUpdates: Map<string, unknown>;
  superstepsSinceSnapshot: number;
  timestamp: number;
}

export interface CheckpointStoreConfig {
  maxSize?: number;
  serialize?: (state: Record<string, unknown>) => string;
  deserialize?: (data: string) => Record<string, unknown>;
}

// ── Default Serializer ───────────────────────────────────────────────────────

function defaultSerialize(state: Record<string, unknown>): string {
  return JSON.stringify(state);
}

function defaultDeserialize(data: string): Record<string, unknown> {
  return JSON.parse(data);
}

// ── Checkpoint Store ─────────────────────────────────────────────────────────

export class CheckpointStore {
  private checkpoints: Map<string, Checkpoint> = new Map();
  private namespaceIndex: Map<string, string[]> = new Map();
  private serialize: (state: Record<string, unknown>) => string;
  private deserialize: (data: string) => Record<string, unknown>;
  private maxSize: number;

  constructor(config?: CheckpointStoreConfig) {
    this.maxSize = config?.maxSize ?? 10_000;
    this.serialize = config?.serialize ?? defaultSerialize;
    this.deserialize = config?.deserialize ?? defaultDeserialize;
  }

  /**
   * Create a new checkpoint.
   */
  put(
    namespace: string,
    state: Record<string, unknown>,
    options?: { source?: CheckpointSource; runId?: string; parentId?: string },
  ): Checkpoint {
    const parentCheckpoint = options?.parentId
      ? this.checkpoints.get(options.parentId)
      : undefined;

    const version = parentCheckpoint ? parentCheckpoint.version + 1 : 1;
    const step = parentCheckpoint ? parentCheckpoint.metadata.step + 1 : 0;

    const checkpoint: Checkpoint = {
      id: `cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      namespace,
      state: { ...state },
      metadata: {
        source: options?.source ?? "loop",
        step,
        parentId: options?.parentId,
        runId: options?.runId ?? `run-${Date.now()}`,
        createdAt: Date.now(),
      },
      version,
      parentCheckpointId: options?.parentId,
    };

    this.checkpoints.set(checkpoint.id, checkpoint);

    // Update namespace index
    if (!this.namespaceIndex.has(namespace)) {
      this.namespaceIndex.set(namespace, []);
    }
    this.namespaceIndex.get(namespace)!.push(checkpoint.id);

    // Evict old checkpoints if over capacity
    this.evictIfNeeded();

    return checkpoint;
  }

  /**
   * Get a checkpoint by ID.
   */
  get(id: string): Checkpoint | undefined {
    return this.checkpoints.get(id);
  }

  /**
   * Get the latest checkpoint in a namespace.
   */
  getLatest(namespace: string): Checkpoint | undefined {
    const ids = this.namespaceIndex.get(namespace) ?? [];
    if (ids.length === 0) return undefined;
    return this.checkpoints.get(ids[ids.length - 1]!);
  }

  /**
   * Get checkpoint history for a namespace.
   */
  getHistory(namespace: string, limit?: number): Checkpoint[] {
    const ids = this.namespaceIndex.get(namespace) ?? [];
    const checkpoints = ids
      .map((id) => this.checkpoints.get(id)!)
      .filter(Boolean)
      .sort((a, b) => b.metadata.step - a.metadata.step);
    return limit ? checkpoints.slice(0, limit) : checkpoints;
  }

  /**
   * Fork a checkpoint (create a copy with new state).
   */
  fork(
    checkpointId: string,
    newState?: Record<string, unknown>,
  ): Checkpoint | undefined {
    const original = this.checkpoints.get(checkpointId);
    if (!original) return undefined;

    return this.put(original.namespace, newState ?? { ...original.state }, {
      source: "fork",
      parentId: checkpointId,
      runId: original.metadata.runId,
    });
  }

  /**
   * Restore state from a checkpoint.
   */
  restore(checkpointId: string): Record<string, unknown> | undefined {
    const checkpoint = this.checkpoints.get(checkpointId);
    return checkpoint ? { ...checkpoint.state } : undefined;
  }

  /**
   * Delete a checkpoint.
   */
  delete(id: string): boolean {
    const checkpoint = this.checkpoints.get(id);
    if (!checkpoint) return false;

    this.checkpoints.delete(id);
    const ids = this.namespaceIndex.get(checkpoint.namespace);
    if (ids) {
      const idx = ids.indexOf(id);
      if (idx >= 0) ids.splice(idx, 1);
    }
    return true;
  }

  /**
   * Get checkpoint count.
   */
  size(): number {
    return this.checkpoints.size;
  }

  /**
   * Export all checkpoints.
   */
  export(): Checkpoint[] {
    return Array.from(this.checkpoints.values());
  }

  private evictIfNeeded(): void {
    while (this.checkpoints.size > this.maxSize) {
      // Evict oldest checkpoint from any namespace
      let oldest: Checkpoint | null = null;
      for (const cp of this.checkpoints.values()) {
        if (!oldest || cp.metadata.createdAt < oldest.metadata.createdAt) {
          oldest = cp;
        }
      }
      if (oldest) this.delete(oldest.id);
    }
  }
}

// ── Delta Snapshot Manager ───────────────────────────────────────────────────

export class DeltaSnapshotManager {
  private snapshots: Map<string, DeltaSnapshot[]> = new Map();
  private maxSupersteps: number;

  constructor(options?: { maxSupersteps?: number }) {
    this.maxSupersteps = options?.maxSupersteps ?? 5000;
  }

  /**
   * Record channel updates since last snapshot.
   */
  recordUpdates(
    checkpointId: string,
    channelUpdates: Map<string, unknown>,
    superstepsSinceSnapshot: number,
  ): DeltaSnapshot {
    const snapshot: DeltaSnapshot = {
      checkpointId,
      channelUpdates,
      superstepsSinceSnapshot,
      timestamp: Date.now(),
    };

    if (!this.snapshots.has(checkpointId)) {
      this.snapshots.set(checkpointId, []);
    }
    this.snapshots.get(checkpointId)!.push(snapshot);

    return snapshot;
  }

  /**
   * Check if a snapshot is needed based on thresholds.
   */
  needsSnapshot(
    checkpointId: string,
    updatesSinceLastSnapshot: number,
    superstepsSinceSnapshot: number,
    snapshotFrequency: number = 10,
  ): boolean {
    return (
      updatesSinceLastSnapshot >= snapshotFrequency ||
      superstepsSinceSnapshot >= this.maxSupersteps
    );
  }

  /**
   * Get all snapshots for a checkpoint.
   */
  getSnapshots(checkpointId: string): DeltaSnapshot[] {
    return this.snapshots.get(checkpointId) ?? [];
  }

  /**
   * Clear snapshots for a checkpoint.
   */
  clear(checkpointId: string): void {
    this.snapshots.delete(checkpointId);
  }
}

export default CheckpointStore;
