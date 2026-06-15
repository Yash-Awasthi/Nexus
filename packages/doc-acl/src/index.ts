// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/doc-acl — Row-level document access control.
 *
 * Architecture
 * ─────────────
 *   Principal      — user | group | public
 *   Permission     — read | write | admin
 *   DocumentACL    — set of ACL entries for one document
 *   ACLStore       — injectable persistence interface
 *   InMemoryACLStore — default in-process store
 *   ACLEnforcer    — check / assert / filter operations on top of a store
 *
 * Permission hierarchy:  read < write < admin
 * A principal with "admin" implicitly has "write" and "read".
 * "public" principal grants access to all callers regardless of identity.
 *
 * Usage
 * ─────
 * ```ts
 * import { ACLEnforcer, InMemoryACLStore } from "@nexus/doc-acl";
 * const enforcer = new ACLEnforcer(new InMemoryACLStore());
 * await enforcer.grant("doc-1", { type: "user", id: "alice" }, "read");
 * await enforcer.assertAccess("doc-1", { type: "user", id: "alice" }, "read"); // ok
 * await enforcer.assertAccess("doc-1", { type: "user", id: "bob" }, "read");   // throws
 * ```
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type PrincipalType = "user" | "group" | "public";

/** Principal type alias. */
export type Principal =
  | { type: "user"; id: string }
  | { type: "group"; id: string }
  | { type: "public" };

/** Permission type alias. */
export type Permission = "read" | "write" | "admin";

const PERM_ORDER: Record<Permission, number> = { read: 0, write: 1, admin: 2 };

/** Acl entry interface definition. */
export interface ACLEntry {
  principal: Principal;
  permission: Permission;
  grantedAt: number;
  grantedBy?: string;
}

/** Document acl interface definition. */
export interface DocumentACL {
  documentId: string;
  entries: ACLEntry[];
  createdAt: number;
  updatedAt: number;
}

// ── ACLError ──────────────────────────────────────────────────────────────────

export class ACLError extends Error {
  readonly code: "ACCESS_DENIED" | "NOT_FOUND";
  readonly documentId: string;
  readonly principal: Principal;
  readonly requiredPermission: Permission;

  constructor(
    code: "ACCESS_DENIED" | "NOT_FOUND",
    documentId: string,
    principal: Principal,
    requiredPermission: Permission,
  ) {
    const who = principal.type === "public" ? "public" : `${principal.type}:${principal.id}`;
    super(`${code}: ${who} cannot "${requiredPermission}" on document "${documentId}"`);
    this.name = "ACLError";
    this.code = code;
    this.documentId = documentId;
    this.principal = principal;
    this.requiredPermission = requiredPermission;
  }
}

// ── ACLStore interface ────────────────────────────────────────────────────────

export interface ACLStore {
  get(documentId: string): Promise<DocumentACL | undefined>;
  set(documentId: string, acl: DocumentACL): Promise<void>;
  delete(documentId: string): Promise<boolean>;
  list(): Promise<DocumentACL[]>;
}

// ── InMemoryACLStore ──────────────────────────────────────────────────────────

export class InMemoryACLStore implements ACLStore {
  private readonly store = new Map<string, DocumentACL>();

  async get(documentId: string): Promise<DocumentACL | undefined> {
    return this.store.get(documentId);
  }

  async set(documentId: string, acl: DocumentACL): Promise<void> {
    this.store.set(documentId, acl);
  }

  async delete(documentId: string): Promise<boolean> {
    return this.store.delete(documentId);
  }

  async list(): Promise<DocumentACL[]> {
    return [...this.store.values()];
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function principalKey(p: Principal): string {
  return p.type === "public" ? "__public__" : `${p.type}:${p.id}`;
}

function satisfies(granted: Permission, required: Permission): boolean {
  return PERM_ORDER[granted] >= PERM_ORDER[required];
}

function principalMatches(entry: ACLEntry, principal: Principal): boolean {
  if (entry.principal.type === "public") return true;
  if (entry.principal.type !== principal.type) return false;
  if (entry.principal.type === "public") return true;
  return (entry.principal as { id: string }).id === (principal as { id: string }).id;
}

// ── ACLEnforcer ───────────────────────────────────────────────────────────────

export class ACLEnforcer {
  constructor(private readonly store: ACLStore) {}

  /** Grant a permission to a principal on a document. */
  async grant(
    documentId: string,
    principal: Principal,
    permission: Permission,
    grantedBy?: string,
  ): Promise<void> {
    const now = Date.now();
    let acl = await this.store.get(documentId);
    if (!acl) {
      acl = { documentId, entries: [], createdAt: now, updatedAt: now };
    }

    const key = principalKey(principal);
    const existing = acl.entries.find((e) => principalKey(e.principal) === key);
    if (existing) {
      existing.permission = permission;
      existing.grantedAt = now;
      existing.grantedBy = grantedBy;
    } else {
      acl.entries.push({ principal, permission, grantedAt: now, grantedBy });
    }
    acl.updatedAt = now;
    await this.store.set(documentId, acl);
  }

  /** Revoke a principal's access to a document. */
  async revoke(documentId: string, principal: Principal): Promise<void> {
    const acl = await this.store.get(documentId);
    if (!acl) return;
    const key = principalKey(principal);
    acl.entries = acl.entries.filter((e) => principalKey(e.principal) !== key);
    acl.updatedAt = Date.now();
    await this.store.set(documentId, acl);
  }

  /** Returns true if the principal has at least the required permission. */
  async canAccess(
    documentId: string,
    principal: Principal,
    permission: Permission,
  ): Promise<boolean> {
    const acl = await this.store.get(documentId);
    if (!acl) return false;
    return acl.entries.some(
      (e) => principalMatches(e, principal) && satisfies(e.permission, permission),
    );
  }

  /** Throws ACLError if the principal does not have the required permission. */
  async assertAccess(
    documentId: string,
    principal: Principal,
    permission: Permission,
  ): Promise<void> {
    const acl = await this.store.get(documentId);
    if (!acl) throw new ACLError("NOT_FOUND", documentId, principal, permission);
    const allowed = await this.canAccess(documentId, principal, permission);
    if (!allowed) throw new ACLError("ACCESS_DENIED", documentId, principal, permission);
  }

  /** Filter a list of document IDs to only those accessible by the principal. */
  async filterDocuments(
    documentIds: string[],
    principal: Principal,
    permission: Permission,
  ): Promise<string[]> {
    const checks = await Promise.all(
      documentIds.map((id) => this.canAccess(id, principal, permission)),
    );
    return documentIds.filter((_, i) => checks[i]);
  }

  async getACL(documentId: string): Promise<DocumentACL | undefined> {
    return this.store.get(documentId);
  }
}
