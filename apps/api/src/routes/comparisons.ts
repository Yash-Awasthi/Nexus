// SPDX-License-Identifier: Apache-2.0
/**
 * Saved comparisons of two council runs.
 *
 * A comparison is *stored*, not recomputed on read: the point of saving it is that the two
 * runs happened once and their numbers are evidence, so a later edit to the diff code must
 * not silently change a number somebody already cited. The snapshot also outlives the runs
 * themselves (discussions are pruned at 30 days; the comparison keeps the verdicts it was
 * built from, in the `verdict` terms, so the finding is still readable afterwards).
 *
 *   POST   /comparisons       { left, right, label? } → 201 saved comparison
 *   GET    /comparisons              → list, newest first, summary only
 *   GET    /comparisons/:id          → one comparison, full diff
 *   DELETE /comparisons/:id          → 204
 *
 * Both runs must belong to the caller and both must be finished — comparing a running debate
 * to a finished one would report a latency that is really just "still going".
 */
import type { FastifyInstance } from "fastify";

import { compareRuns, summarise, type ComparisonDiff } from "../lib/comparison.ts";
import { ANON_OWNER, ownerIdFor } from "../lib/owner.ts";
import { PersistentStore } from "../lib/persistent-store.ts";
import { fail } from "../lib/reply-errors.ts";
import { requireAuthWithTier } from "../middleware/auth.ts";

import { readDiscussion } from "./discussion.ts";

interface SavedComparison {
  id: string;
  ownerId: string;
  label: string;
  leftId: string;
  rightId: string;
  /** One line, computed once: "verdict overlap 62%, +1400 tokens, -12s". */
  summary: string;
  diff: ComparisonDiff;
  createdAt: string;
}

const comparisons = new PersistentStore<SavedComparison>("comparisons");
/** Long enough to cite in a review, short enough not to be an archive. */
const COMPARISON_TTL_MS = 90 * 24 * 3600_000;

let _loaded: Promise<void> | null = null;
function load(): Promise<void> {
  _loaded ??= comparisons.load().then(() => {
    const cutoff = Date.now() - COMPARISON_TTL_MS;
    for (const [id, record] of [...comparisons.entries()]) {
      const created = Date.parse(record.createdAt);
      if (Number.isFinite(created) && created < cutoff) comparisons.delete(id);
    }
  });
  return _loaded;
}

function view(record: SavedComparison, full: boolean) {
  const base = {
    id: record.id,
    label: record.label,
    left: record.leftId,
    right: record.rightId,
    summary: record.summary,
    createdAt: record.createdAt,
  };
  return full ? { ...base, diff: record.diff } : base;
}

export async function comparisonRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireAuthWithTier };

  app.get("/comparisons", auth, async (request) => {
    await load();
    const owner = request.nexusUserId ?? ANON_OWNER;
    const rows = [...comparisons.values()]
      .filter((record) => record.ownerId === owner)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((record) => view(record, false));
    return { object: "list", comparisons: rows, total: rows.length };
  });

  app.post<{ Body: { left?: unknown; right?: unknown; label?: unknown } }>(
    "/comparisons",
    auth,
    async (request, reply) => {
      await load();
      const { left, right, label } = request.body ?? {};
      if (typeof left !== "string" || typeof right !== "string") {
        return fail(reply, 400, "invalid_request", { message: "left and right must be discussion ids" });
      }
      if (left === right) {
        return fail(reply, 400, "invalid_request", { message: "a run cannot be compared to itself" });
      }
      const owner = ownerIdFor(request);
      const runs = await Promise.all([readDiscussion(left), readDiscussion(right)]);
      const missing = runs.findIndex((run) => !run || run.ownerId !== owner);
      if (missing !== -1) {
        // Same 404 for "does not exist" and "not yours": which one it is stays private.
        return fail(reply, 404, "not_found", {
          message: `no finished discussion ${missing === 0 ? left : right} for this account`,
        });
      }
      const [a, b] = runs as NonNullable<(typeof runs)[number]>[];
      if (!a!.finishedAt || !b!.finishedAt) {
        return fail(reply, 409, "conflict", {
          message: "both discussions must be finished before they can be compared",
        });
      }

      const record: SavedComparison = {
        id: `cmp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        ownerId: owner,
        label:
          typeof label === "string" && label.trim()
            ? label.trim().slice(0, 120)
            : `${a!.topic} — A/B`,
        leftId: a!.id,
        rightId: b!.id,
        summary: summarise(a!, b!),
        diff: compareRuns(a!, b!),
        createdAt: new Date().toISOString(),
      };
      await comparisons.save(record.id, record);
      return reply.code(201).send(view(record, true));
    },
  );

  app.get<{ Params: { id: string } }>("/comparisons/:id", auth, async (request, reply) => {
    await load();
    const record = comparisons.get(request.params.id);
    if (!record || record.ownerId !== ownerIdFor(request)) return fail(reply, 404, "not_found");
    return view(record, true);
  });

  app.delete<{ Params: { id: string } }>("/comparisons/:id", auth, async (request, reply) => {
    await load();
    const record = comparisons.get(request.params.id);
    if (!record || record.ownerId !== ownerIdFor(request)) return fail(reply, 404, "not_found");
    comparisons.delete(record.id);
    return reply.code(204).send();
  });
}
