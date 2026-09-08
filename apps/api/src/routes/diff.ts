// SPDX-License-Identifier: Apache-2.0
/**
 * Diff apply / rollback / history — ONE owner module for the whole diff
 * surface (the research.ts precedent). Moved out of api-bridge so a diff
 * behavior change lands in one obvious place.
 *
 * State lives in lib/diff-history.ts (KV-backed, per-user, 30-day TTL):
 * /diff/apply persists the original for rollback, /diff/rollback restores it,
 * /diff/history lists the caller's applied diffs newest-first so a rollback
 * stays available after a page reload (the rollbackId no longer lives only in
 * React state).
 *
 * Auth: explicit `requireAuthWithTier` per route (research.ts convention —
 * identical to the /api scope hook, kept so the module is self-contained).
 */

import type { FastifyInstance } from "fastify";
import { getDiffRecord, listDiffRecords, saveDiffRecord } from "../lib/diff-history.js";
import { requireAuthWithTier } from "../middleware/auth.js";

export async function diffRoutes(app: FastifyInstance): Promise<void> {
  app.post<{
    Body: { original: string; modified: string };
  }>("/diff/apply", { preHandler: requireAuthWithTier }, async (request, reply) => {
    // Missing body (or non-string fields) previously produced applied:true with
    // an empty rollback record — a no-op "successful" apply. Reject explicitly.
    const body = request.body ?? ({} as { original?: string; modified?: string });
    if (typeof body.original !== "string" || typeof body.modified !== "string") {
      return reply.code(400).send({
        error: "invalid_body",
        message: "original and modified (string) are required",
      });
    }
    const orig = body.original.split("\n");
    const mod = body.modified.split("\n");
    const hunks: { lineNo: number; type: "add" | "remove" | "change"; content: string }[] = [];
    const maxLen = Math.max(orig.length, mod.length);
    for (let i = 0; i < maxLen; i++) {
      if (i >= orig.length) hunks.push({ lineNo: i + 1, type: "add", content: mod[i] ?? "" });
      else if (i >= mod.length)
        hunks.push({ lineNo: i + 1, type: "remove", content: orig[i] ?? "" });
      else if (orig[i] !== mod[i])
        hunks.push({ lineNo: i + 1, type: "change", content: mod[i] ?? "" });
    }
    // Record the original so the applied change can be rolled back.
    let rollbackId: string;
    try {
      const record = await saveDiffRecord(request.nexusUserId, {
        original: body.original,
        modified: body.modified,
      });
      rollbackId = record.id;
    } catch (err) {
      return reply.code(413).send({
        error: "diff_too_large",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return reply.send({
      applied: true,
      rollbackId,
      hunks,
      linesAdded: hunks.filter((h) => h.type === "add").length,
      linesRemoved: hunks.filter((h) => h.type === "remove").length,
    });
  });

  /** POST /diff/rollback — restore a change previously applied via /diff/apply. */
  app.post<{
    Body: { rollbackId: string };
  }>("/diff/rollback", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const rec = await getDiffRecord(request.nexusUserId, request.body.rollbackId ?? "");
    if (!rec) return reply.code(404).send({ error: "rollback_not_found" });
    return reply.send({
      rolledBack: true,
      rollbackId: request.body.rollbackId,
      original: rec.original,
      appliedAt: rec.appliedAt,
    });
  });

  /**
   * GET /diff/history — the caller's applied diffs, newest-first. A page
   * reload clears the React-state rollbackId; this surface is what keeps the
   * rollback button alive across sessions.
   */
  app.get<{ Querystring: { limit?: string } }>(
    "/diff/history",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const parsed = Number(request.query.limit);
      const limit = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10;
      const records = await listDiffRecords(request.nexusUserId, limit);
      return reply.send({
        records: records.map((r) => ({
          id: r.id,
          appliedAt: r.appliedAt,
          originalPreview: r.original.slice(0, 200),
          modifiedPreview: r.modified.slice(0, 200),
        })),
        total: records.length,
      });
    },
  );
}
