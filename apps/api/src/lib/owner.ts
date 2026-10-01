// SPDX-License-Identifier: Apache-2.0
/**
 * Who a request's data belongs to.
 *
 * Every per-user store asks the same question and has to answer it the same
 * way, or two surfaces disagree about whose row is whose. Callers that carry no
 * identity — the development bypass, and the master API key, which owns no user
 * — share one bucket. That bucket is not a security boundary; it exists so an
 * unauthenticated development server behaves like the real thing instead of
 * crashing or, worse, showing one user another's data.
 */

import { eq, isNull, or, type AnyColumn, type SQL } from "drizzle-orm";

import { PersistentStore } from "./persistent-store.js";

/** Owner bucket for callers that carry no identity. */
export const ANON_OWNER = "__anon__";

/** The owner id for a request, falling back to the shared anonymous bucket. */
export function ownerIdFor(request: { nexusUserId?: string }): string {
  return request.nexusUserId ?? ANON_OWNER;
}

/**
 * Whether the caller sees rows with no owner: written before owner scoping or by a caller with
 * no identity, they are the desktop user's or the anonymous bucket's, never an account's.
 */
export function seesOwnerless(request: { nexusUserId?: string }): boolean {
  return process.env.NEXUS_DESKTOP === "1" || !request.nexusUserId;
}

/** Whether the caller owns a row; see {@link seesOwnerless} for rows with none. */
export function ownsRow(
  request: { nexusUserId?: string },
  row: { ownerId?: string | null },
): boolean {
  if (!row.ownerId) return seesOwnerless(request);
  return row.ownerId === request.nexusUserId;
}

/** The SQL form of {@link ownsRow}: the caller's rows, plus ownerless ones where they see those. */
export function ownerScope(column: AnyColumn, request: { nexusUserId?: string }): SQL {
  const id = request.nexusUserId;
  if (!id) return isNull(column);
  return seesOwnerless(request) ? or(eq(column, id), isNull(column))! : eq(column, id);
}

interface Claimer {
  count(): number | Promise<number>;
  assign(userId: string): number | Promise<number>;
}
const _claimable = new Map<string, Claimer>();

/** Rows that may have no owner, so an admin can hand them to an account. */
export function claimable<T extends { id: string; ownerId?: string | null }>(
  name: string,
  from: PersistentStore<T> | Claimer,
): void {
  if (!(from instanceof PersistentStore)) {
    _claimable.set(name, from);
    return;
  }
  const rows = () => [...from.values()].filter((r) => !r.ownerId);
  _claimable.set(name, {
    count: () => rows().length,
    assign: (userId) => {
      const found = rows();
      for (const row of found) from.set(row.id, { ...row, ownerId: userId });
      return found.length;
    },
  });
}

/** How many ownerless rows each claimable source holds. */
export async function ownerlessCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [name, c] of _claimable) out[name] = await c.count();
  return out;
}

/** Give every ownerless row to `userId`; returns how many moved per source. */
export async function assignOwnerless(userId: string): Promise<Record<string, number>> {
  const moved: Record<string, number> = {};
  for (const [name, c] of _claimable) moved[name] = await c.assign(userId);
  return moved;
}
