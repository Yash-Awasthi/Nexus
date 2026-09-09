// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/proposal-system — Operator-gated proposal system for autonomous agents.
 *
 * Inspired by claude-code-hermit's proposal resolution.
 * Agents propose changes that are validated, batched, and applied atomically.
 * Prevents malformed outputs from leaving half-patched state.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type ProposalStatus = "pending" | "approved" | "rejected" | "applied" | "failed";

export interface Proposal {
  id: string;
  title: string;
  description: string;
  actions: ProposalAction[];
  status: ProposalStatus;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

export interface ProposalAction {
  type: "create" | "update" | "delete" | "rename";
  target: string;
  content?: string;
  backup?: string;
}

export interface ResolutionAction {
  proposalId: string;
  action: "auto-resolve" | "nudge" | "skip";
  reason?: string;
}

export interface ApplyResult {
  ok: boolean;
  applied: Record<string, boolean>;
  errors: string[];
  reason?: string;
}

// ── Proposal Store ───────────────────────────────────────────────────────────

export class ProposalStore {
  private proposals: Map<string, Proposal> = new Map();
  private nextId = 1;

  /**
   * Create a new proposal.
   */
  create(config: {
    title: string;
    description: string;
    actions: ProposalAction[];
    metadata?: Record<string, unknown>;
  }): Proposal {
    const id = `PROP-${String(this.nextId++).padStart(4, "0")}`;
    const now = Date.now();

    const proposal: Proposal = {
      id,
      title: config.title,
      description: config.description,
      actions: config.actions,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      metadata: config.metadata,
    };

    this.proposals.set(id, proposal);
    return proposal;
  }

  /**
   * Get a proposal by ID.
   */
  get(id: string): Proposal | undefined {
    return this.proposals.get(id);
  }

  /**
   * List proposals by status.
   */
  list(status?: ProposalStatus): Proposal[] {
    const all = Array.from(this.proposals.values());
    return status ? all.filter((p) => p.status === status) : all;
  }

  /**
   * Approve a proposal.
   */
  approve(id: string): Proposal | null {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.status !== "pending") return null;
    proposal.status = "approved";
    proposal.updatedAt = Date.now();
    return proposal;
  }

  /**
   * Reject a proposal.
   */
  reject(id: string, reason?: string): Proposal | null {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.status !== "pending") return null;
    proposal.status = "rejected";
    proposal.updatedAt = Date.now();
    if (reason) proposal.metadata = { ...proposal.metadata, rejectReason: reason };
    return proposal;
  }

  /**
   * Delete a proposal.
   */
  delete(id: string): boolean {
    return this.proposals.delete(id);
  }

  size(): number {
    return this.proposals.size;
  }
}

// ── Proposal Applier ─────────────────────────────────────────────────────────

export class ProposalApplier {
  private store: ProposalStore;
  private fileSystem: Map<string, string> = new Map();

  constructor(store: ProposalStore) {
    this.store = store;
  }

  /**
   * Validate all actions in a batch before any writes.
   */
  validateBatch(proposalIds: string[]): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const id of proposalIds) {
      const proposal = this.store.get(id);
      if (!proposal) {
        errors.push(`Proposal ${id} not found`);
        continue;
      }
      if (proposal.status !== "approved") {
        errors.push(`Proposal ${id} is ${proposal.status}, not approved`);
        continue;
      }
      if (proposal.actions.length === 0) {
        errors.push(`Proposal ${id} has no actions`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Apply a batch of approved proposals atomically.
   * All-or-nothing: if any action fails, no changes are made.
   */
  applyBatch(proposalIds: string[]): ApplyResult {
    // 1. Validate
    const validation = this.validateBatch(proposalIds);
    if (!validation.valid) {
      return { ok: false, applied: {}, errors: validation.errors };
    }

    // 2. Backup current state
    const backups = new Map<string, string>();
    const applied: Record<string, boolean> = {};
    const errors: string[] = [];

    try {
      for (const id of proposalIds) {
        const proposal = this.store.get(id)!;
        for (const action of proposal.actions) {
          switch (action.type) {
            case "create":
              if (this.fileSystem.has(action.target)) {
                throw new Error(`File ${action.target} already exists`);
              }
              backups.set(action.target, "");
              this.fileSystem.set(action.target, action.content ?? "");
              break;

            case "update":
              if (!this.fileSystem.has(action.target)) {
                throw new Error(`File ${action.target} not found`);
              }
              backups.set(action.target, this.fileSystem.get(action.target)!);
              this.fileSystem.set(action.target, action.content ?? "");
              break;

            case "delete":
              if (!this.fileSystem.has(action.target)) {
                throw new Error(`File ${action.target} not found`);
              }
              backups.set(action.target, this.fileSystem.get(action.target)!);
              this.fileSystem.delete(action.target);
              break;

            case "rename":
              if (!this.fileSystem.has(action.target)) {
                throw new Error(`File ${action.target} not found`);
              }
              if (!action.content) throw new Error("Rename requires target path in content");
              backups.set(action.target, this.fileSystem.get(action.target)!);
              this.fileSystem.set(action.content, this.fileSystem.get(action.target)!);
              this.fileSystem.delete(action.target);
              break;
          }
        }

        // Mark as applied
        proposal.status = "applied";
        proposal.updatedAt = Date.now();
        applied[id] = true;
      }
    } catch (err) {
      // 3. Rollback on failure
      for (const [path, content] of backups) {
        if (content === "") {
          this.fileSystem.delete(path);
        } else {
          this.fileSystem.set(path, content);
        }
      }

      // Mark failed proposals
      for (const id of proposalIds) {
        if (!applied[id]) {
          const proposal = this.store.get(id);
          if (proposal) {
            proposal.status = "failed";
            proposal.updatedAt = Date.now();
          }
        }
      }

      errors.push(err instanceof Error ? err.message : String(err));
      return { ok: false, applied, errors };
    }

    return { ok: true, applied, errors: [] };
  }

  /**
   * Resolve proposals based on operator decisions.
   */
  resolve(resolutions: ResolutionAction[]): ApplyResult {
    const approved: string[] = [];

    for (const resolution of resolutions) {
      const proposal = this.store.get(resolution.proposalId);
      if (!proposal) continue;

      switch (resolution.action) {
        case "auto-resolve":
          proposal.status = "approved";
          proposal.updatedAt = Date.now();
          approved.push(resolution.proposalId);
          break;
        case "nudge":
          // Leave as pending but add nudge metadata
          proposal.metadata = {
            ...proposal.metadata,
            nudged: true,
            nudgeReason: resolution.reason,
          };
          break;
        case "skip":
          proposal.status = "rejected";
          proposal.updatedAt = Date.now();
          break;
      }
    }

    if (approved.length > 0) {
      return this.applyBatch(approved);
    }

    return { ok: true, applied: {}, errors: [] };
  }

  /**
   * Get filesystem state (for testing/debugging).
   */
  getFileSystem(): Map<string, string> {
    return new Map(this.fileSystem);
  }
}

export default ProposalStore;
