// SPDX-License-Identifier: Apache-2.0
/**
 * Exec approvals
 *   GET  /api/v1/exec/policy              — the mode and rules in force
 *   GET  /api/v1/exec/approvals           — this user's requests
 *   POST /api/v1/exec/approvals/:id/approve
 *   POST /api/v1/exec/approvals/:id/deny
 *
 * The surfaces that execute call `classifyAction` and `requestApproval`
 * themselves (see routes/local-pty.ts); this is where a human answers. Every
 * record is scoped to the user who asked for it, so one caller cannot approve
 * another's action.
 */

import { policyFromEnv } from "@nexus/exec-policy";
import type { FastifyInstance } from "fastify";

import { decideApproval, listApprovals, loadApprovalStore } from "../lib/exec-approvals.js";
import { HOST_SHELL_ADMIN_ONLY, hostShellNeedsAdmin } from "../lib/exec-guard.js";
import { ownerIdFor } from "../lib/owner.js";
import { requireAuthWithTier } from "../middleware/auth.js";

export async function execApprovalRoutes(app: FastifyInstance): Promise<void> {
  await loadApprovalStore();

  app.get("/exec/policy", { preHandler: requireAuthWithTier }, async (_request, reply) => {
    const policy = policyFromEnv();
    return reply.send({
      mode: policy.mode,
      allow: policy.allow ?? [],
      deny: policy.deny ?? [],
      workspaceRoots: policy.workspaceRoots ?? [],
    });
  });

  app.get("/exec/approvals", { preHandler: requireAuthWithTier }, async (request, reply) => {
    return reply.send({ approvals: listApprovals(ownerIdFor(request)) });
  });

  for (const [suffix, approved] of [
    ["approve", true],
    ["deny", false],
  ] as const) {
    app.post<{ Params: { id: string } }>(
      `/exec/approvals/:id/${suffix}`,
      { preHandler: requireAuthWithTier },
      async (request, reply) => {
        const owner = ownerIdFor(request);
        const asked = listApprovals(owner).find((a) => a.id === request.params.id);
        if (approved && asked && hostShellNeedsAdmin(request, asked.surface))
          return reply.code(403).send(HOST_SHELL_ADMIN_ONLY);
        const result = decideApproval(owner, request.params.id, approved);
        if (result === "not_found") {
          return reply.code(404).send({ error: "not_found" });
        }
        if (result === "expired") {
          return reply.code(410).send({
            error: "expired",
            message: "The request timed out. Ask again to get a fresh one.",
          });
        }
        if (result === "already_decided") {
          return reply.code(409).send({ error: "already_decided" });
        }
        return reply.send({ approval: result });
      },
    );
  }
}
