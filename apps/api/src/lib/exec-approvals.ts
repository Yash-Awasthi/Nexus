// SPDX-License-Identifier: Apache-2.0
/**
 * Pending approvals: the human half of the exec gate.
 *
 * `@nexus/exec-policy` decides allow, ask or deny. This is what "ask" means in
 * practice — a record an operator can see, approve or refuse, and a surface
 * that cannot run until they do.
 *
 * Three properties the surfaces depend on:
 *
 *   Single use. An approval is spent the moment it is redeemed, so an approved
 *   action cannot be replayed, and a caller cannot approve one `npm install`
 *   and run twenty.
 *
 *   Bound to the action. Redemption checks the command and arguments against
 *   the ones that were approved, so a request cannot be approved and then
 *   quietly widened before it runs.
 *
 *   Owned. An approval belongs to the user who asked for it; nobody else can
 *   see it, approve it, or redeem it.
 */

import crypto from "node:crypto";

import { decide, policyFromEnv, type ExecAction, type PolicyDecision } from "@nexus/exec-policy";

import { PersistentStore } from "./persistent-store.js";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "spent";

export interface ApprovalRecord {
  id: string;
  ownerId: string;
  surface: ExecAction["surface"];
  command: string;
  args: string[];
  cwd?: string;
  /** Why the policy stopped for this action. */
  reason: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

/** How long an unanswered request stays approvable. */
export const APPROVAL_TTL_MS = 10 * 60_000;

const _store = new PersistentStore<ApprovalRecord>("exec-approvals");
let _loaded: Promise<void> | null = null;

export function loadApprovalStore(): Promise<void> {
  _loaded ??= _store.load();
  return _loaded;
}

/** Reset the load latch. Tests use this to prove records survive a restart. */
export function _resetApprovalStoreForTests(): void {
  _loaded = null;
}

/**
 * A record whose window has closed reads as expired, whatever is stored.
 *
 * The window covers `approved` as well as `pending`: a grant is permission to
 * run something now, and one that outlives its window is a standing permission
 * nobody asked for. `denied` and `spent` are terminal and stay as they are.
 */
function withExpiry(record: ApprovalRecord, now: number): ApprovalRecord {
  if (record.status !== "pending" && record.status !== "approved") return record;
  if (Date.parse(record.expiresAt) > now) return record;
  return { ...record, status: "expired" };
}

export function classifyAction(action: ExecAction): PolicyDecision {
  return decide(action, policyFromEnv());
}

/** Record an action that needs a human. Returns the pending record. */
export function requestApproval(
  ownerId: string,
  action: ExecAction,
  reason: string,
  now: number = Date.now(),
): ApprovalRecord {
  const record: ApprovalRecord = {
    id: crypto.randomUUID(),
    ownerId,
    surface: action.surface,
    command: action.command,
    args: [...(action.args ?? [])],
    ...(action.cwd ? { cwd: action.cwd } : {}),
    reason,
    status: "pending",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + APPROVAL_TTL_MS).toISOString(),
  };
  _store.set(record.id, record);
  return record;
}

/** One user's approvals, newest first. */
export function listApprovals(ownerId: string, now: number = Date.now()): ApprovalRecord[] {
  return [..._store.values()]
    .filter((r) => r.ownerId === ownerId)
    .map((r) => withExpiry(r, now))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type DecisionFailure = "not_found" | "already_decided" | "expired";

/** Approve or refuse a pending request. Only its owner may decide it. */
export function decideApproval(
  ownerId: string,
  id: string,
  approved: boolean,
  now: number = Date.now(),
): ApprovalRecord | DecisionFailure {
  const stored = _store.get(id);
  // Another owner's record is reported as missing rather than as forbidden:
  // "this id exists" is itself information about someone else's session.
  if (!stored || stored.ownerId !== ownerId) return "not_found";

  const current = withExpiry(stored, now);
  if (current.status === "expired") {
    _store.set(id, current);
    return "expired";
  }
  if (current.status !== "pending") return "already_decided";

  const next: ApprovalRecord = {
    ...current,
    status: approved ? "approved" : "denied",
    decidedAt: new Date(now).toISOString(),
    decidedBy: ownerId,
  };
  _store.set(id, next);
  return next;
}

export type RedeemFailure = "not_found" | "not_approved" | "expired" | "action_mismatch";

/**
 * Spend an approval for exactly the action it was granted for. The record is
 * marked `spent` before the caller executes, so a second attempt with the same
 * id fails even if the first one is still running.
 */
export function redeemApproval(
  ownerId: string,
  id: string,
  action: ExecAction,
  now: number = Date.now(),
): ApprovalRecord | RedeemFailure {
  const stored = _store.get(id);
  if (!stored || stored.ownerId !== ownerId) return "not_found";

  const current = withExpiry(stored, now);
  if (current.status === "expired") {
    _store.set(id, current);
    return "expired";
  }
  if (current.status !== "approved") return "not_approved";

  const sameAction =
    current.surface === action.surface &&
    current.command === action.command &&
    current.args.length === (action.args?.length ?? 0) &&
    current.args.every((arg, i) => arg === action.args?.[i]) &&
    (current.cwd ?? "") === (action.cwd ?? "");
  if (!sameAction) return "action_mismatch";

  const spent: ApprovalRecord = { ...current, status: "spent" };
  _store.set(id, spent);
  return spent;
}

/** Drop decided records that are long past their window. */
export function pruneApprovals(now: number = Date.now(), keepMs = 24 * 60 * 60_000): number {
  let removed = 0;
  for (const record of [..._store.values()]) {
    if (record.status === "pending") continue;
    if (Date.parse(record.createdAt) + keepMs > now) continue;
    _store.delete(record.id);
    removed += 1;
  }
  return removed;
}
