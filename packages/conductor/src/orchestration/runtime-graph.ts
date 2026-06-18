/**
 * Runtime Graph — Unified Topology for Conductor Resources
 *
 * Tracks all resources (workflows, Floci services, MCP servers, agents, tasks)
 * in a single graph with dependency relationships, health status, and
 * persistent state. All state mutations publish events with causal chain IDs
 * for lineage tracking and replay ordering.
 *
 * Hardened with:
 * - Serialized mutation queue (atomic updates, no race conditions)
 * - Mutation journal (forensic replay, diagnostics)
 * - Topology snapshots (point-in-time captures, recovery)
 * - Integrity checkpoints (auto-save before/after mutations)
 * - Deepened repair (edge-node ref consistency, duplicate cleanup)
 */

import { IEventBus } from "./event-bus";
import { IRuntimePersistence } from "./interfaces/persistence.interface";

// ─── Types ───────────────────────────────────────────────────────────

export type ResourceType =
  | "workflow"
  | "floci_s3_bucket"
  | "floci_sqs_queue"
  | "floci_dynamodb_table"
  | "floci_lambda_function"
  | "floci_sns_topic"
  | "mcp_server"
  | "agent"
  | "task_execution";

export type ResourceStatus =
  | "active"
  | "degraded"
  | "failed"
  | "pending"
  | "removed";

export interface ResourceNode {
  id: string;
  type: ResourceType;
  name: string;
  status: ResourceStatus;
  metadata: Record<string, unknown>;
  dependencies: string[]; // IDs of other ResourceNodes
  createdAt: Date;
  updatedAt: Date;
}

export interface ResourceEdge {
  from: string;
  to: string;
  relationship: "depends_on" | "triggers" | "manages" | "routes_to";
  metadata?: Record<string, unknown>;
}

export interface RuntimeGraphSnapshot {
  nodes: ResourceNode[];
  edges: ResourceEdge[];
  summary: {
    totalNodes: number;
    byType: Record<string, number>;
    byStatus: Record<string, number>;
    workflows: number;
    activeServices: number;
    failedServices: number;
  };
  timestamp: Date;
}

export interface GraphIntegrityReport {
  valid: boolean;
  nodeCount: number;
  edgeCount: number;
  danglingEdgeCount: number;
  danglingEdgeList: { from: string; to: string; relationship: string }[];
  missingDependencyCount: number;
  missingDependencyList: { nodeId: string; missingDepId: string }[];
  cycleCount: number;
  cycleList: string[][];
  desyncedEdgeCount: number;
  duplicateNodeCount?: number;
  duplicateEdgeCount?: number;
  staleStatusCount?: number;
  repaired: boolean;
  warnings: string[];
}

/** Mutation journal entry for replay/forensics */
export interface MutationJournalEntry {
  opId: string;
  op: "addNode" | "updateNode" | "removeNode" | "addEdge" | "removeEdge" | "repair" | "bulk";
  timestamp: Date;
  params: Record<string, unknown>;
  affectedNodeIds: string[];
  previousNodeCount: number;
  currentNodeCount: number;
}

/** Integrity checkpoint — saves graph state + integrity report at a point in time */
export interface IntegrityCheckpoint {
  id: string;
  timestamp: Date;
  snapshot: RuntimeGraphSnapshot;
  report: GraphIntegrityReport;
  label?: string;
}

// ─── Error Types ─────────────────────────────────────────────────────

export class GraphMutationError extends Error {
  constructor(
    message: string,
    public op: string,
    public cause?: Error
  ) {
    super(message);
    this.name = "GraphMutationError";
  }
}

export class GraphConsistencyError extends Error {
  constructor(
    message: string,
    public report: GraphIntegrityReport
  ) {
    super(message);
    this.name = "GraphConsistencyError";
  }
}

// ─── Implementation ──────────────────────────────────────────────────

export class RuntimeGraph {
  private nodes = new Map<string, ResourceNode>();
  private edges: ResourceEdge[] = [];
  private persistence?: IRuntimePersistence;
  private eventBus?: IEventBus;
  private loaded = false;
  private opCounter = 0;

  private readonly STORAGE_KEY = "runtime_graph_data";
  private readonly SNAPSHOT_PREFIX = "runtime_graph_snapshot_";
  private readonly CHECKPOINT_KEY = "runtime_graph_checkpoints";

  // ── Mutation Queue ─────────────────────────────────────────────────
  /** Promise chain that serializes all graph mutations for atomicity */
  private mutationQueue: Promise<void> = Promise.resolve();
  private journal: MutationJournalEntry[] = [];
  private readonly MAX_JOURNAL_SIZE = 1000;

  // ── Snapshots ──────────────────────────────────────────────────────
  private snapshots: RuntimeGraphSnapshot[] = [];
  private readonly MAX_SNAPSHOTS = 50;

  // ── Checkpoints ────────────────────────────────────────────────────
  private checkpoints: IntegrityCheckpoint[] = [];
  private readonly MAX_CHECKPOINTS = 20;
  private autoCheckpointEnabled = true;
  private mutationCountSinceCheckpoint = 0;
  private readonly AUTO_CHECKPOINT_INTERVAL = 25; // every N mutations

  constructor(persistence?: IRuntimePersistence, eventBus?: IEventBus) {
    this.persistence = persistence;
    this.eventBus = eventBus;
  }

  // ── Queue Helpers ──────────────────────────────────────────────────

  /**
   * Enqueue a mutation function to the serialized mutation queue.
   * All graph mutations (addNode, updateNode, removeNode, etc.) go
   * through this queue to prevent concurrent mutation races.
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.mutationQueue = this.mutationQueue
        .then(async () => {
          try {
            const result = await fn();
            resolve(result);
          } catch (e) {
            reject(e);
          }
        })
        .catch(async () => {
          // Even if previous mutation failed, still process this one
          // to prevent cascade failure / queue deadlock.
          try {
            const result = await fn();
            resolve(result);
          } catch (e) {
            reject(e);
          }
        });
    });
  }

  /**
   * Record a mutation journal entry for forensic replay.
   */
  private recordJournal(
    op: MutationJournalEntry["op"],
    params: Record<string, unknown>,
    affectedNodeIds: string[]
  ): void {
    const entry: MutationJournalEntry = {
      opId: this.genOpId(),
      op,
      timestamp: new Date(),
      params,
      affectedNodeIds,
      previousNodeCount: this.nodes.size,
      currentNodeCount: this.nodes.size,
    };
    this.journal.push(entry);
    // Prune excess journal entries (oldest first)
    if (this.journal.length > this.MAX_JOURNAL_SIZE) {
      this.journal.splice(0, this.journal.length - this.MAX_JOURNAL_SIZE);
    }
  }

  /**
   * Optionally auto-checkpoint after mutations.
   */
  private async maybeAutoCheckpoint(): Promise<void> {
    if (!this.autoCheckpointEnabled) return;
    this.mutationCountSinceCheckpoint++;
    if (this.mutationCountSinceCheckpoint >= this.AUTO_CHECKPOINT_INTERVAL) {
      // Use internal method to avoid re-entering the mutation queue
      await this.createCheckpointInternal(`auto-mutation-${this.mutationCountSinceCheckpoint}`);
      this.mutationCountSinceCheckpoint = 0;
    }
  }

  /**
   * Internal checkpoint creation that does NOT go through the mutation queue.
   * Used by maybeAutoCheckpoint() and repair() to avoid re-entrant deadlock.
   */
  private async createCheckpointInternal(label?: string): Promise<IntegrityCheckpoint> {
    const snapshot = await this.getSnapshot();
    const report = await this.validateInternal();
    const checkpoint: IntegrityCheckpoint = {
      id: `cp-${Date.now()}-${this.opCounter}`,
      timestamp: new Date(),
      snapshot,
      report,
      label: label || `mutation-${this.mutationCountSinceCheckpoint}`,
    };
    this.checkpoints.push(checkpoint);
    if (this.checkpoints.length > this.MAX_CHECKPOINTS) {
      this.checkpoints.shift();
    }
    if (this.persistence) {
      await this.persistence.saveState(this.CHECKPOINT_KEY, this.checkpoints);
    }
    return checkpoint;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.persistence) {
      const data = await this.persistence.getState<{
        nodes: [string, ResourceNode][];
        edges: ResourceEdge[];
      }>(this.STORAGE_KEY);
      if (data) {
        // Restore dates (JSON serialization loses Date types)
        this.nodes = new Map(
          data.nodes.map(([id, node]) => [
            id,
            { ...node, createdAt: new Date(node.createdAt), updatedAt: new Date(node.updatedAt) },
          ])
        );
        this.edges = data.edges;
      }
      // Load any persisted snapshots
      const snapshotIds = await this.persistence.getState<string[]>(`${this.STORAGE_KEY}_snapshot_ids`);
      if (snapshotIds) {
        for (const sid of snapshotIds.slice(-this.MAX_SNAPSHOTS)) {
          const snap = await this.persistence.getState<RuntimeGraphSnapshot>(`${this.SNAPSHOT_PREFIX}${sid}`);
          if (snap) this.snapshots.push(snap);
        }
      }
      // Load checkpoints
      const savedCheckpoints = await this.persistence.getState<IntegrityCheckpoint[]>(this.CHECKPOINT_KEY);
      if (savedCheckpoints) {
        this.checkpoints = savedCheckpoints;
      }
    }
    this.loaded = true;
  }

  private genOpId(): string {
    return `gr-op-${++this.opCounter}-${Date.now()}`;
  }

  private async persist(): Promise<void> {
    if (!this.persistence) return;
    await this.persistence.saveState(this.STORAGE_KEY, {
      nodes: Array.from(this.nodes.entries()),
      edges: this.edges,
    });
  }

  // ── Node Management ────────────────────────────────────────────────

  async addNode(
    id: string,
    type: ResourceType,
    name: string,
    options?: {
      status?: ResourceStatus;
      metadata?: Record<string, unknown>;
      dependencies?: string[];
    }
  ): Promise<ResourceNode> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const causeEventId = this.genOpId();

      if (this.nodes.has(id)) {
        const updated = await this.updateExistingNode(id, options, causeEventId);
        this.recordJournal("updateNode", { id, type, name, ...options }, [id]);
        await this.maybeAutoCheckpoint();
        return updated;
      }

      const node: ResourceNode = {
        id,
        type,
        name,
        status: options?.status || "active",
        metadata: options?.metadata || {},
        dependencies: options?.dependencies || [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.nodes.set(id, node);
      await this.persist();
      await this.eventBus?.publish("runtime_graph:node_added", { id, type, name }, { causeEventId });
      this.recordJournal("addNode", { id, type, name, ...options }, [id]);
      await this.maybeAutoCheckpoint();
      return node;
    });
  }

  private async updateExistingNode(
    id: string,
    options?: {
      status?: ResourceStatus;
      metadata?: Record<string, unknown>;
      dependencies?: string[];
    },
    causeEventId?: string
  ): Promise<ResourceNode> {
    const node = this.nodes.get(id)!;
    if (options?.status) node.status = options.status;
    if (options?.metadata) node.metadata = { ...node.metadata, ...options.metadata };
    if (options?.dependencies)
      node.dependencies = [...new Set([...node.dependencies, ...options.dependencies])];
    node.updatedAt = new Date();
    await this.persist();
    await this.eventBus?.publish("runtime_graph:node_updated", { id, status: node.status }, { causeEventId });
    return node;
  }

  async updateNodeStatus(
    id: string,
    status: ResourceStatus,
    metadata?: Record<string, unknown>,
    causeEventId?: string
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const node = this.nodes.get(id);
      if (!node) throw new Error(`Node not found: ${id}`);
      node.status = status;
      node.updatedAt = new Date();
      if (metadata) {
        node.metadata = { ...node.metadata, ...metadata };
      }
      await this.persist();
      await this.eventBus?.publish(
        "runtime_graph:node_updated",
        { id, status },
        { causeEventId: causeEventId || this.genOpId() }
      );
      this.recordJournal("updateNode", { id, status, metadata }, [id]);
      await this.maybeAutoCheckpoint();
    });
  }

  /** Update a node's metadata (merge). Through the mutation queue. */
  async updateNodeMetadata(
    id: string,
    metadata: Record<string, unknown>,
    causeEventId?: string
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const node = this.nodes.get(id);
      if (!node) throw new Error(`Node not found: ${id}`);
      node.metadata = { ...node.metadata, ...metadata };
      node.updatedAt = new Date();
      await this.persist();
      await this.eventBus?.publish(
        "runtime_graph:node_updated",
        { id, metadata },
        { causeEventId: causeEventId || this.genOpId() }
      );
      this.recordJournal("updateNode", { id, metadata }, [id]);
      await this.maybeAutoCheckpoint();
    });
  }

  async removeNode(id: string, causeEventId?: string): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      this.nodes.delete(id);
      // Cascade: remove all edges referencing this node
      const removedEdges = this.edges.filter((e) => e.from === id || e.to === id).length;
      this.edges = this.edges.filter((e) => e.from !== id && e.to !== id);
      // Cascade: remove this node from other nodes' dependency arrays
      for (const [, node] of this.nodes) {
        if (node.dependencies.includes(id)) {
          node.dependencies = node.dependencies.filter((d) => d !== id);
          node.updatedAt = new Date();
        }
      }
      await this.persist();
      await this.eventBus?.publish(
        "runtime_graph:node_removed",
        { id, cascadeRemovedEdges: removedEdges },
        { causeEventId: causeEventId || this.genOpId() }
      );
      this.recordJournal("removeNode", { id, cascadeRemovedEdges: removedEdges }, [id]);
      await this.maybeAutoCheckpoint();
    });
  }

  /**
   * Bulk-add nodes atomically. All nodes are added within a single
   * mutation queue execution, ensuring atomicity.
   */
  async bulkAddNodes(
    nodes: Array<{
      id: string;
      type: ResourceType;
      name: string;
      status?: ResourceStatus;
      metadata?: Record<string, unknown>;
      dependencies?: string[];
    }>
  ): Promise<ResourceNode[]> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const results: ResourceNode[] = [];
      const addedIds: string[] = [];
      for (const n of nodes) {
        if (this.nodes.has(n.id)) {
          const existing = this.nodes.get(n.id)!;
          results.push(existing);
          continue;
        }
        const node: ResourceNode = {
          id: n.id,
          type: n.type,
          name: n.name,
          status: n.status || "active",
          metadata: n.metadata || {},
          dependencies: n.dependencies || [],
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        this.nodes.set(n.id, node);
        results.push(node);
        addedIds.push(n.id);
      }
      if (addedIds.length > 0) {
        await this.persist();
        for (const addedId of addedIds) {
          await this.eventBus?.publish("runtime_graph:node_added", { id: addedId }, { causeEventId: this.genOpId() });
        }
      }
      if (addedIds.length > 0) {
        this.recordJournal("bulk", { addedIds, count: addedIds.length }, addedIds);
        await this.maybeAutoCheckpoint();
      }
      return results;
    });
  }

  // ── Edge Management ────────────────────────────────────────────────

  async addEdge(
    from: string,
    to: string,
    relationship: ResourceEdge["relationship"],
    metadata?: Record<string, unknown>
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      if (!this.nodes.has(from)) throw new Error(`Source node not found: ${from}`);
      if (!this.nodes.has(to)) throw new Error(`Target node not found: ${to}`);
      const exists = this.edges.some(
        (e) => e.from === from && e.to === to && e.relationship === relationship
      );
      if (!exists) {
        this.edges.push({ from, to, relationship, metadata });
        await this.persist();
        this.recordJournal("addEdge", { from, to, relationship }, [from, to]);
        await this.maybeAutoCheckpoint();
      }
    });
  }

  async removeEdge(from: string, to: string, relationship: ResourceEdge["relationship"]): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const before = this.edges.length;
      this.edges = this.edges.filter(
        (e) => !(e.from === from && e.to === to && e.relationship === relationship)
      );
      if (this.edges.length !== before) {
        await this.persist();
        this.recordJournal("removeEdge", { from, to, relationship }, [from, to]);
        await this.maybeAutoCheckpoint();
      }
    });
  }

  // ── Queries ────────────────────────────────────────────────────────

  async getNode(id: string): Promise<ResourceNode | undefined> {
    await this.ensureLoaded();
    return this.nodes.get(id);
  }

  async getNodesByType(type: ResourceType): Promise<ResourceNode[]> {
    await this.ensureLoaded();
    return Array.from(this.nodes.values()).filter((n) => n.type === type);
  }

  async getNodesByStatus(status: ResourceStatus): Promise<ResourceNode[]> {
    await this.ensureLoaded();
    return Array.from(this.nodes.values()).filter((n) => n.status === status);
  }

  async getDependents(id: string): Promise<ResourceNode[]> {
    await this.ensureLoaded();
    const dependentIds = this.edges
      .filter((e) => e.to === id)
      .map((e) => e.from);
    return dependentIds.map((did) => this.nodes.get(did)).filter(Boolean) as ResourceNode[];
  }

  async getDependencies(id: string): Promise<ResourceNode[]> {
    await this.ensureLoaded();
    const node = this.nodes.get(id);
    if (!node) return [];

    // Combine static dependency declarations + edge-based dependencies
    const depSet = new Set(node.dependencies);
    for (const edge of this.edges) {
      if (edge.from === id && edge.relationship === "depends_on") {
        depSet.add(edge.to);
      }
    }

    return Array.from(depSet)
      .map((depId) => this.nodes.get(depId))
      .filter(Boolean) as ResourceNode[];
  }

  async getAllNodes(): Promise<ResourceNode[]> {
    await this.ensureLoaded();
    return Array.from(this.nodes.values());
  }

  async getSnapshot(): Promise<RuntimeGraphSnapshot> {
    await this.ensureLoaded();
    // Deep-clone nodes to prevent mutation contamination across snapshots
    const allNodes = Array.from(this.nodes.values()).map((n) => ({
      ...n,
      createdAt: new Date(n.createdAt),
      updatedAt: new Date(n.updatedAt),
      metadata: { ...n.metadata },
      dependencies: [...n.dependencies],
    }));

    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let workflows = 0;
    let activeServices = 0;
    let failedServices = 0;

    for (const node of allNodes) {
      byType[node.type] = (byType[node.type] || 0) + 1;
      byStatus[node.status] = (byStatus[node.status] || 0) + 1;
      if (node.type === "workflow") workflows++;
      if (node.status === "active" && node.type !== "workflow") activeServices++;
      if (node.status === "failed") failedServices++;
    }

    return {
      nodes: allNodes,
      edges: [...this.edges],
      summary: {
        totalNodes: allNodes.length,
        byType,
        byStatus,
        workflows,
        activeServices,
        failedServices,
      },
      timestamp: new Date(),
    };
  }

  // ── Topology Snapshots ─────────────────────────────────────────────

  /**
   * Save a point-in-time topology snapshot.
   * Snapshots are persisted and can be loaded for comparison/recovery.
   */
  async saveSnapshot(label?: string): Promise<RuntimeGraphSnapshot> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const snapshot = await this.getSnapshot();
      snapshot.timestamp = new Date(); // ensure current time

      this.snapshots.push(snapshot);
      if (this.snapshots.length > this.MAX_SNAPSHOTS) {
        const _removed = this.snapshots.shift()!;
        // Note: we don't try to delete old persisted snapshots here because
        // the persistence layer (FileRuntimePersistence) writes to a single
        // JSON file and can't delete individual keys. Old snapshots are left
        // in the persisted file but will be ignored on reload since we only
        // load the last MAX_SNAPSHOTS entries.
      }

      // Persist the new snapshot
      if (this.persistence) {
        const snapshotKey = `${this.SNAPSHOT_PREFIX}${snapshot.timestamp.toISOString().replace(/[:.]/g, "-")}`;
        await this.persistence.saveState(snapshotKey, snapshot);
        // Save index of snapshot IDs for faster loading
        const snapshotIds = this.snapshots.map((s) => s.timestamp.toISOString().replace(/[:.]/g, "-"));
        await this.persistence.saveState(`${this.STORAGE_KEY}_snapshot_ids`, snapshotIds);
      }

      this.recordJournal("bulk", { op: "saveSnapshot", label: label || "manual" }, []);
      return snapshot;
    });
  }

  /**
   * Get the list of stored snapshots.
   */
  getSnapshots(): RuntimeGraphSnapshot[] {
    return [...this.snapshots];
  }

  /**
   * Compare two snapshots and return the diff.
   */
  compareSnapshots(
    before: RuntimeGraphSnapshot,
    after: RuntimeGraphSnapshot
  ): {
    addedNodes: ResourceNode[];
    removedNodes: ResourceNode[];
    changedNodes: { id: string; before: ResourceNode; after: ResourceNode }[];
    addedEdges: ResourceEdge[];
    removedEdges: ResourceEdge[];
  } {
    const beforeMap = new Map(before.nodes.map((n) => [n.id, n]));
    const afterMap = new Map(after.nodes.map((n) => [n.id, n]));

    const addedNodes: ResourceNode[] = [];
    const removedNodes: ResourceNode[] = [];
    const changedNodes: { id: string; before: ResourceNode; after: ResourceNode }[] = [];

    for (const n of after.nodes) {
      if (!beforeMap.has(n.id)) {
        addedNodes.push(n);
      } else {
        const b = beforeMap.get(n.id)!;
        if (
          b.status !== n.status ||
          b.name !== n.name ||
          JSON.stringify(b.dependencies) !== JSON.stringify(n.dependencies) ||
          JSON.stringify(b.metadata) !== JSON.stringify(n.metadata)
        ) {
          changedNodes.push({ id: n.id, before: b, after: n });
        }
      }
    }
    for (const n of before.nodes) {
      if (!afterMap.has(n.id)) {
        removedNodes.push(n);
      }
    }

    const edgeKey = (e: ResourceEdge) => `${e.from}|${e.to}|${e.relationship}`;
    const beforeEdgeSet = new Set(before.edges.map(edgeKey));
    const afterEdgeSet = new Set(after.edges.map(edgeKey));

    const addedEdges = after.edges.filter((e) => !beforeEdgeSet.has(edgeKey(e)));
    const removedEdges = before.edges.filter((e) => !afterEdgeSet.has(edgeKey(e)));

    return { addedNodes, removedNodes, changedNodes, addedEdges, removedEdges };
  }

  /**
   * Restore the graph to a previous snapshot state.
   */
  async restoreSnapshot(snapshot: RuntimeGraphSnapshot): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      this.nodes.clear();
      this.edges = [];
      for (const node of snapshot.nodes) {
        this.nodes.set(node.id, { ...node, createdAt: new Date(node.createdAt), updatedAt: new Date(node.updatedAt) });
      }
      this.edges = snapshot.edges.map((e) => ({ ...e }));
      await this.persist();
      this.recordJournal("bulk", { op: "restoreSnapshot", timestamp: snapshot.timestamp.toISOString() }, []);
    });
  }

  // ── Integrity Checkpoints ──────────────────────────────────────────

  /**
   * Create an integrity checkpoint: saves the current snapshot + integrity report.
   */
  async createCheckpoint(label?: string): Promise<IntegrityCheckpoint> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      return this.createCheckpointInternal(label);
    });
  }

  /**
   * Restore to the most recent valid integrity checkpoint.
   * Returns null if no valid checkpoints exist.
   */
  async restoreLastValidCheckpoint(): Promise<IntegrityCheckpoint | null> {
    // Walk backwards to find the most recent valid checkpoint
    for (let i = this.checkpoints.length - 1; i >= 0; i--) {
      const cp = this.checkpoints[i];
      if (cp.report.valid) {
        await this.restoreSnapshot(cp.snapshot);
        return cp;
      }
    }
    return null;
  }

  /**
   * Get all integrity checkpoints.
   */
  getCheckpoints(): IntegrityCheckpoint[] {
    return [...this.checkpoints];
  }

  /**
   * Get the mutation journal for diagnostics.
   */
  getJournal(): MutationJournalEntry[] {
    return [...this.journal];
  }

  /**
   * Clear the mutation journal.
   */
  clearJournal(): void {
    this.journal = [];
  }

  /**
   * Enable or disable auto-checkpointing.
   */
  setAutoCheckpoint(enabled: boolean): void {
    this.autoCheckpointEnabled = enabled;
  }

  // ── Integrity Validation ───────────────────────────────────────────

  /**
   * Internal validate that doesn't go through the mutation queue.
   * Used by repair() and createCheckpoint() which already run in the queue.
   */
  private async validateInternal(): Promise<GraphIntegrityReport> {
    const warnings: string[] = [];
    const danglingEdgeList: { from: string; to: string; relationship: string }[] = [];
    const missingDependencyList: { nodeId: string; missingDepId: string }[] = [];
    const cycleList: string[][] = [];

    // 1. Dangling edges
    for (const edge of this.edges) {
      if (!this.nodes.has(edge.from)) {
        danglingEdgeList.push({ from: edge.from, to: edge.to, relationship: edge.relationship });
      } else if (!this.nodes.has(edge.to)) {
        danglingEdgeList.push({ from: edge.from, to: edge.to, relationship: edge.relationship });
      }
    }

    // 2. Missing dependencies
    for (const [nodeId, node] of this.nodes) {
      for (const depId of node.dependencies) {
        if (!this.nodes.has(depId)) {
          missingDependencyList.push({ nodeId, missingDepId: depId });
        }
      }
    }

    // 3. DFS cycle detection
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    const dfs = (nodeId: string): void => {
      if (recursionStack.has(nodeId)) {
        const cycleStart = path.indexOf(nodeId);
        if (cycleStart >= 0) {
          cycleList.push([...path.slice(cycleStart), nodeId]);
        }
        return;
      }
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      recursionStack.add(nodeId);
      path.push(nodeId);

      const node = this.nodes.get(nodeId);
      if (node) {
        for (const depId of node.dependencies) {
          if (this.nodes.has(depId)) dfs(depId);
        }
      }

      path.pop();
      recursionStack.delete(nodeId);
    };

    for (const nodeId of this.nodes.keys()) {
      if (!visited.has(nodeId)) dfs(nodeId);
    }

    // 4. Desynced edges (edge says "depends_on" but target doesn't list us as dependency)
    let desyncedEdgeCount = 0;
    for (const edge of this.edges) {
      if (edge.relationship === "depends_on") {
        const targetNode = this.nodes.get(edge.to);
        if (targetNode && edge.from !== edge.to) {
          if (!targetNode.dependencies.includes(edge.from)) desyncedEdgeCount++;
        }
      }
    }

    // 5. Duplicate nodes
    const idCounts = new Map<string, number>();
    for (const [id] of this.nodes) {
      idCounts.set(id, (idCounts.get(id) || 0) + 1);
    }
    let duplicateNodeCount = 0;
    for (const [, count] of idCounts) {
      if (count > 1) duplicateNodeCount += count - 1;
    }

    // 6. Duplicate edges
    const edgeKeys = new Set<string>();
    let duplicateEdgeCount = 0;
    for (const edge of this.edges) {
      const key = `${edge.from}|${edge.to}|${edge.relationship}`;
      if (edgeKeys.has(key)) duplicateEdgeCount++;
      edgeKeys.add(key);
    }

    // 7. Stale status detection (nodes stuck in "pending" > threshold, or "removed" that should be deleted)
    const staleCutoff = Date.now() - 24 * 60 * 60 * 1000; // 24 hours
    let staleStatusCount = 0;
    for (const [, node] of this.nodes) {
      if (
        (node.status === "pending" && node.updatedAt.getTime() < staleCutoff) ||
        (node.status === "removed" && node.updatedAt.getTime() < staleCutoff)
      ) {
        staleStatusCount++;
      }
    }

    const isValid =
      danglingEdgeList.length === 0 &&
      missingDependencyList.length === 0 &&
      cycleList.length === 0;

    if (!isValid) {
      if (danglingEdgeList.length > 0)
        warnings.push(`${danglingEdgeList.length} dangling edge(s) found`);
      if (missingDependencyList.length > 0)
        warnings.push(`${missingDependencyList.length} missing dependency reference(s) found`);
      if (cycleList.length > 0) warnings.push(`${cycleList.length} cycle(s) detected`);
      if (desyncedEdgeCount > 0) warnings.push(`${desyncedEdgeCount} desynced edge(s) found`);
    }
    if (duplicateNodeCount > 0) warnings.push(`${duplicateNodeCount} duplicate node(s) detected`);
    if (duplicateEdgeCount > 0) warnings.push(`${duplicateEdgeCount} duplicate edge(s) detected`);
    if (staleStatusCount > 0) warnings.push(`${staleStatusCount} stale status(es) found`);

    return {
      valid: isValid,
      nodeCount: this.nodes.size,
      edgeCount: this.edges.length,
      danglingEdgeCount: danglingEdgeList.length,
      danglingEdgeList,
      missingDependencyCount: missingDependencyList.length,
      missingDependencyList,
      cycleCount: cycleList.length,
      cycleList,
      desyncedEdgeCount,
      duplicateNodeCount,
      duplicateEdgeCount,
      staleStatusCount,
      repaired: false,
      warnings,
    };
  }

  async validate(): Promise<GraphIntegrityReport> {
    await this.ensureLoaded();
    return this.validateInternal();
  }

  async repair(): Promise<GraphIntegrityReport> {
    return this.enqueue(async () => {
      const report = await this.validateInternal();

      // Create a checkpoint before repair (if auto-checkpoint is enabled)
      // Use internal method to avoid re-entering the mutation queue
      if (this.autoCheckpointEnabled) {
        await this.createCheckpointInternal("pre-repair");
      }

      const causeEventId = this.genOpId();

      // 1. Remove dangling edges
      const originalEdgeCount = this.edges.length;
      const removedDanglingEdges = this.edges.filter(
        (edge) => !this.nodes.has(edge.from) || !this.nodes.has(edge.to)
      ).length;
      this.edges = this.edges.filter((edge) => {
        return this.nodes.has(edge.from) && this.nodes.has(edge.to);
      });

      // 2. Clean missing dependency references from nodes
      for (const [, node] of this.nodes) {
        const originalDeps = node.dependencies.length;
        node.dependencies = node.dependencies.filter((depId) => this.nodes.has(depId));
        if (node.dependencies.length !== originalDeps) {
          node.updatedAt = new Date();
        }
      }

      // 3. Deduplicate edges
      const seen = new Set<string>();
      this.edges = this.edges.filter((edge) => {
        const key = `${edge.from}|${edge.to}|${edge.relationship}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // 4. Fix desynced edges: if edge says depends_on from A→B,
      // ensure B's dependencies include A (bidirectional consistency)
      for (const edge of this.edges) {
        if (edge.relationship === "depends_on" && edge.from !== edge.to) {
          const targetNode = this.nodes.get(edge.to);
          if (targetNode && !targetNode.dependencies.includes(edge.from)) {
            targetNode.dependencies.push(edge.from);
            targetNode.updatedAt = new Date();
          }
        }
      }

      // 5. Clean up "removed" nodes that are stale (>24h in removed state)
      const staleCutoff = Date.now() - 24 * 60 * 60 * 1000;
      const staleRemovedNodes: string[] = [];
      for (const [id, node] of this.nodes) {
        if (node.status === "removed" && node.updatedAt.getTime() < staleCutoff) {
          staleRemovedNodes.push(id);
        }
      }
      for (const id of staleRemovedNodes) {
        this.nodes.delete(id);
        this.edges = this.edges.filter((e) => e.from !== id && e.to !== id);
      }

      // Check if anything was actually repaired
      const repairedAnything =
        this.edges.length !== originalEdgeCount ||
        report.danglingEdgeCount > 0 ||
        report.missingDependencyCount > 0 ||
        (report.duplicateEdgeCount ?? 0) > 0 ||
        report.desyncedEdgeCount > 0 ||
        staleRemovedNodes.length > 0;

      if (repairedAnything) {
        await this.persist();
      }

      await this.eventBus?.publish(
        "runtime_graph:repaired",
        {
          before: {
            danglingEdgeCount: report.danglingEdgeCount,
            missingDependencyCount: report.missingDependencyCount,
            duplicateEdgeCount: report.duplicateEdgeCount ?? 0,
            desyncedEdgeCount: report.desyncedEdgeCount,
            staleRemovedNodes: staleRemovedNodes.length,
          },
        },
        { causeEventId }
      );

      this.recordJournal("repair", {
        removedDanglingEdges,
        cleanedDependencyRefs: report.missingDependencyCount,
        deduplicatedEdges: report.duplicateEdgeCount ?? 0,
        fixedDesyncedEdges: report.desyncedEdgeCount,
        cleanedStaleRemovedNodes: staleRemovedNodes.length,
      }, []);

      const finalReport = await this.validateInternal();
      finalReport.repaired = repairedAnything;
      return finalReport;
    });
  }

  async detectCycles(): Promise<string[][]> {
    await this.ensureLoaded();
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    const dfs = (nodeId: string): void => {
      if (recursionStack.has(nodeId)) {
        const cycleStart = path.indexOf(nodeId);
        if (cycleStart >= 0) cycles.push([...path.slice(cycleStart), nodeId]);
        return;
      }
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      recursionStack.add(nodeId);
      path.push(nodeId);
      const node = this.nodes.get(nodeId);
      if (node) {
        for (const depId of node.dependencies) {
          if (this.nodes.has(depId)) dfs(depId);
        }
      }
      path.pop();
      recursionStack.delete(nodeId);
    };

    for (const nodeId of this.nodes.keys()) {
      if (!visited.has(nodeId)) dfs(nodeId);
    }

    return cycles;
  }
}
