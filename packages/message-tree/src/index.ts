// SPDX-License-Identifier: Apache-2.0
/**
 * message-tree — Branching conversation tree for Nexus.
 *
 * Provides:
 *   • MessageNode    — single node: id, role, content, parent, children
 *   • MessageState   — IDLE | PENDING | STREAMING | COMPLETE | ERROR
 *   • MessageTree    — tree structure with add/get/fork/linearPath/snapshot
 *   • BranchManager  — list branches, checkout, compare, prune
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type NodeRole = "user" | "assistant" | "system" | "tool";

/** Message state type alias. */
export type MessageState = "idle" | "pending" | "streaming" | "complete" | "error";

/** Message node data interface definition. */
export interface MessageNodeData {
  role: NodeRole;
  content: string;
  model?: string;
  metadata?: Record<string, unknown>;
  state?: MessageState;
}

/** Message node interface definition. */
export interface MessageNode extends MessageNodeData {
  id: string;
  parentId: string | null;
  childIds: string[];
  depth: number;
  createdAt: string;
  state: MessageState;
}

// ── ID generation ─────────────────────────────────────────────────────────────

let _counter = 0;
function uid(): string {
  return `node-${Date.now()}-${++_counter}`;
}

// ── MessageTree ───────────────────────────────────────────────────────────────

export class MessageTree {
  private nodes = new Map<string, MessageNode>();
  private rootId: string | null = null;

  /** Add a node. If parentId is null, this becomes the root. */
  add(data: MessageNodeData, parentId?: string | null): MessageNode {
    const id = uid();
    const parent = parentId !== undefined ? parentId : null;
    const depth = parent === null ? 0 : (this.nodes.get(parent)?.depth ?? 0) + 1;

    if (parent !== null && !this.nodes.has(parent)) {
      throw new Error(`Parent node not found: ${parent}`);
    }

    const node: MessageNode = {
      ...data,
      id,
      parentId: parent,
      childIds: [],
      depth,
      createdAt: new Date().toISOString(),
      state: data.state ?? "complete",
    };
    this.nodes.set(id, node);

    if (parent !== null) {
      this.nodes.get(parent)!.childIds.push(id);
    } else {
      this.rootId = id;
    }

    return node;
  }

  get(id: string): MessageNode | undefined {
    return this.nodes.get(id);
  }

  get root(): MessageNode | undefined {
    return this.rootId ? this.nodes.get(this.rootId) : undefined;
  }

  get size(): number { return this.nodes.size; }

  /** Update the state of a node. */
  setState(id: string, state: MessageState): void {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Node not found: ${id}`);
    node.state = state;
  }

  /** Return the linear path from root to the given node. */
  pathTo(id: string): MessageNode[] {
    const path: MessageNode[] = [];
    let current: MessageNode | undefined = this.nodes.get(id);
    while (current) {
      path.unshift(current);
      current = current.parentId ? this.nodes.get(current.parentId) : undefined;
    }
    return path;
  }

  /** Fork: create a new tree from the given node (inclusive of its ancestors). */
  fork(fromNodeId: string, newRootRole: NodeRole = "system"): MessageTree {
    const path = this.pathTo(fromNodeId);
    const newTree = new MessageTree();
    let prevId: string | null = null;
    for (const n of path) {
      const added = newTree.add({ role: n.role, content: n.content, model: n.model, metadata: n.metadata }, prevId);
      prevId = added.id;
    }
    return newTree;
  }

  /** All nodes at a given depth level. */
  level(depth: number): MessageNode[] {
    return [...this.nodes.values()].filter((n) => n.depth === depth);
  }

  /** All leaf nodes (nodes with no children). */
  leaves(): MessageNode[] {
    return [...this.nodes.values()].filter((n) => n.childIds.length === 0);
  }

  /** Snapshot: export nodes as a serializable array. */
  snapshot(): MessageNode[] {
    return [...this.nodes.values()];
  }

  /** Restore from snapshot. */
  static fromSnapshot(nodes: MessageNode[]): MessageTree {
    const tree = new MessageTree();
    // Sort by depth to ensure parents are inserted before children
    const sorted = [...nodes].sort((a, b) => a.depth - b.depth);
    for (const n of sorted) {
      tree.nodes.set(n.id, { ...n, childIds: [...n.childIds] });
      if (n.parentId === null) tree.rootId = n.id;
    }
    return tree;
  }
}

// ── BranchManager ─────────────────────────────────────────────────────────────

export interface Branch {
  name: string;
  tipNodeId: string;
  createdAt: string;
}

/** Branch manager. */
export class BranchManager {
  private branches = new Map<string, Branch>();

  /** Mark a node as the tip of a named branch. */
  create(name: string, tipNodeId: string): Branch {
    const branch: Branch = { name, tipNodeId, createdAt: new Date().toISOString() };
    this.branches.set(name, branch);
    return branch;
  }

  get(name: string): Branch | undefined {
    return this.branches.get(name);
  }

  list(): Branch[] {
    return [...this.branches.values()];
  }

  update(name: string, newTipNodeId: string): void {
    const b = this.branches.get(name);
    if (!b) throw new Error(`Branch not found: ${name}`);
    b.tipNodeId = newTipNodeId;
  }

  delete(name: string): boolean {
    return this.branches.delete(name);
  }

  has(name: string): boolean {
    return this.branches.has(name);
  }

  /** Compare two branches: return node ids in branchB not in branchA's path */
  diff(tree: MessageTree, branchA: string, branchB: string): string[] {
    const a = this.branches.get(branchA);
    const b = this.branches.get(branchB);
    if (!a || !b) throw new Error("Branch not found");
    const pathA = new Set(tree.pathTo(a.tipNodeId).map((n) => n.id));
    const pathB = tree.pathTo(b.tipNodeId).map((n) => n.id);
    return pathB.filter((id) => !pathA.has(id));
  }
}
