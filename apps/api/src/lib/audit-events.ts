// SPDX-License-Identifier: Apache-2.0
/**
 * The audit events that must exist, and where each one is written.
 *
 * "Audited" is a claim, and a claim about an event nobody writes is the worst kind: it reads as a control.
 * This file is the checklist — one row per action a security review asks about, naming the file that emits
 * it — and `apps/api/tests/security/audit-completeness.test.ts` holds it in both directions: every row's
 * action must appear in the file it names, and the eight categories the product promises must all be
 * covered. Deleting an emission therefore fails a test instead of quietly removing evidence.
 *
 * The list is not "every audit event in the tree": it is the ones that answer "who did that, when, to
 * what" for a person's account, a key, a permission or money. A test that also pinned every internal
 * `org.*` event would need editing on every feature and would stop being read.
 */

export type AuditCategory =
  | "register"
  | "login"
  | "key_add"
  | "key_remove"
  | "permission_change"
  | "budget_change"
  | "export"
  | "delete"
  | "admin_action";

export interface RequiredAuditEvent {
  category: AuditCategory;
  action: string;
  /** Repository-relative file that emits it. The test reads this file and looks for the string. */
  emittedBy: string;
  /** What a reviewer would otherwise have to take on trust. */
  why: string;
}

export const REQUIRED_AUDIT_EVENTS: readonly RequiredAuditEvent[] = [
  {
    category: "register",
    action: "auth.register",
    emittedBy: "apps/api/src/routes/auth-users.ts",
    why: "A new account is the event every later investigation is indexed by.",
  },
  {
    category: "login",
    action: "auth.login",
    emittedBy: "apps/api/src/routes/auth-users.ts",
    why: "Failed and successful sign-ins are what make a takeover timeline possible.",
  },
  {
    category: "key_add",
    action: "provider_key.create",
    emittedBy: "apps/api/src/routes/provider-keys.ts",
    why: "A provider key is billing access; adding one changes who can spend.",
  },
  {
    category: "key_remove",
    action: "provider_key.delete",
    emittedBy: "apps/api/src/routes/provider-keys.ts",
    why: "Removing a key is the thing an intruder does on the way out, so it must be recorded.",
  },
  {
    category: "permission_change",
    action: "workspace.member.role_changed",
    emittedBy: "apps/api/src/routes/workspaces.ts",
    why: "Role changes move access; the entry carries the previous and the new role.",
  },
  {
    category: "budget_change",
    action: "budget.policy_set",
    emittedBy: "apps/api/src/routes/org-governance.ts",
    why: "Budgets are the stop line for spend, so moving one is evidence rather than a preference.",
  },
  {
    category: "export",
    action: "audit.exported",
    emittedBy: "apps/api/src/lib/audit-export.ts",
    why: "Copying evidence out of the database is itself an event; an unrecorded export is a leak.",
  },
  {
    category: "delete",
    action: "account.erased",
    emittedBy: "apps/api/src/routes/user-data.ts",
    why: "Self-service deletion is irreversible and must name what was kept, so the receipt and the entry are written together.",
  },
  {
    category: "export",
    action: "account.exported",
    emittedBy: "apps/api/src/routes/user-data.ts",
    why: "An account taking its data out is a copy of everything it owns leaving the building.",
  },
  {
    category: "delete",
    action: "admin.user_deleted",
    emittedBy: "apps/api/src/routes/admin-users.ts",
    why: "Deleting an account is irreversible, so the operator who did it has to be identifiable.",
  },
  {
    category: "admin_action",
    action: "admin.user_suspended",
    emittedBy: "apps/api/src/routes/admin-users.ts",
    why: "Suspension is the routine enforcement action and must not rely on memory.",
  },
];

/** The eight promises the product makes in its audit section, in the order it makes them. */
export const REQUIRED_CATEGORIES: readonly AuditCategory[] = [
  "register",
  "login",
  "key_add",
  "key_remove",
  "permission_change",
  "budget_change",
  "export",
  "delete",
  "admin_action",
];

/** Action names, for a test or a dashboard that wants to look for rows without reading this file. */
export function requiredActions(): string[] {
  return REQUIRED_AUDIT_EVENTS.map((event) => event.action);
}
