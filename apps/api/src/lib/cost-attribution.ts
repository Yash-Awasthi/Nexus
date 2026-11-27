// SPDX-License-Identifier: Apache-2.0
/**
 * Which part of the product a model call belongs to (M6.3.1).
 *
 * `_costLog` has recorded who spent since attribution was added; it could not say *what on*. A monthly report that
 * can only say "you spent $41" invites the next question — chat, council, or the agents running overnight? — and
 * the answer was not in the log. This module is the two dimensions that are knowable at the call site:
 *
 *   route family   from the request's route template, at one hook in server.ts. Prefix-matched, because the
 *                  alternatives (threading a family argument through every handler) drift the moment somebody adds
 *                  a route and forgets.
 *   company        set explicitly by the org runtime, which is the one place a company is unambiguously attached
 *                  to the spend. An HTTP request is *not* guessed into a company: the same person can act for two
 *                  companies, and a wrong attribution is worse than an unattributed row.
 *
 * Everything undefined here stays undefined on the entry, and the report carries it in an "unattributed" line
 * rather than silently folding it into a bucket.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** The parts of the product that spend money, in the order a report lists them. */
export type CostFamily = "chat" | "council" | "agent" | "org" | "knowledge" | "other";

export const COST_FAMILIES: readonly CostFamily[] = [
  "chat",
  "council",
  "agent",
  "org",
  "knowledge",
  "other",
];

/**
 * Route template prefix → family.
 *
 * Longest prefix wins, so `/org/agents/wake` is `org` rather than `agent`; the list is ordered by specificity and
 * the matcher checks from the longest key, which makes the ordering of the literal irrelevant to the result.
 */
const FAMILY_BY_PREFIX: readonly (readonly [string, CostFamily])[] = [
  ["/chat", "chat"],
  ["/council", "council"],
  ["/deliberate", "council"],
  ["/org", "org"],
  ["/agents", "agent"],
  ["/agent", "agent"],
  ["/missions", "agent"],
  ["/runtime", "agent"],
  ["/workflows", "agent"],
  ["/kb", "knowledge"],
  ["/knowledge-bases", "knowledge"],
  ["/search", "knowledge"],
  ["/graph", "knowledge"],
];

/**
 * Classify a route template (`/chat/stream`, `/org/companies/:id/budgets`).
 *
 * A query string is ignored and a trailing id is irrelevant: the prefix is the whole signal. Anything unknown is
 * `other` rather than guessed, so a new route shows up in the report as `other` — which is a to-do list — instead
 * of being absorbed into `chat` and never looked at again.
 */
export function familyOf(route: string | undefined): CostFamily {
  const path = (route ?? "").split("?")[0] ?? "";
  let best: { prefix: string; family: CostFamily } | undefined;
  for (const [prefix, family] of FAMILY_BY_PREFIX) {
    if (!path.startsWith(prefix)) continue;
    if (!best || prefix.length > best.prefix.length) best = { prefix, family };
  }
  return best?.family ?? "other";
}

/** What the current call site knows about the spend it is about to record. */
export interface CostScope {
  family?: CostFamily;
  companyId?: string;
}

export const costScope = new AsyncLocalStorage<CostScope>();

/** Run `fn` with this scope visible to `trackCost` (AsyncLocalStorage, so it survives awaits). */
export function withCostScope<T>(scope: CostScope, fn: () => T): T {
  const parent = costScope.getStore();
  return costScope.run({ ...parent, ...scope }, fn);
}

/** The scope of the call in progress, or an empty one outside a request. */
export function currentCostScope(): CostScope {
  return costScope.getStore() ?? {};
}
