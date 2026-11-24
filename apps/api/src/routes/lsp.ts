// SPDX-License-Identifier: Apache-2.0
/**
 * LSP surface: what the pool is doing, and the two operations an operator or
 * the UI needs — start one server and restart one.
 *
 *   GET  /api/v1/lsp/status                        — pool and per-language availability
 *   POST /api/v1/lsp/servers/:language/start       — spawn (202 when approval is needed)
 *   POST /api/v1/lsp/servers/:language/restart     — stop and clear it (admin only)
 *
 * Status never reports a command line or a path outside the workspace root.
 * Every spawn goes through the exec policy; see lib/lsp.ts for the gate.
 */

import type { LspFailure, LspLanguage } from "@nexus/lsp";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  getLspManager,
  LSP_LANGUAGES,
  lspStatus,
  redeemLspStart,
  withLspRequest,
  clearLspCounters,
} from "../lib/lsp.ts";
import { ownerIdFor } from "../lib/owner.ts";
import { requireAuthWithTier } from "../middleware/auth.ts";

import { requireAdminRole } from "./admin-users.ts";

function languageForParam(value: string): LspLanguage | undefined {
  return LSP_LANGUAGES.find((language) => language === value);
}

const DENIAL_RULE = /^Denied by rule \[([^\]]+)\]/;

/** Map a manager failure to the response the surface already uses for exec outcomes. */
function failureReply(reply: FastifyReply, failure: LspFailure): FastifyReply {
  if (failure.code === "APPROVAL_REQUIRED") {
    return reply.code(202).send({
      error: "approval_required",
      approvalId: failure.approvalId?.length ? failure.approvalId : undefined,
      message: `${failure.reason} Approve it at /api/v1/exec/approvals and send the request again with approvalId.`,
    });
  }
  if (failure.code === "DENIED") {
    const rule = DENIAL_RULE.exec(failure.reason)?.[1];
    return reply
      .code(403)
      .send({ error: "exec_denied", ...(rule ? { rule } : {}), message: failure.reason });
  }
  if (
    failure.code === "DISABLED" ||
    failure.code === "NO_SERVER" ||
    failure.code === "NO_ROOT" ||
    failure.code === "ROOT_OUTSIDE_EXEC_ROOTS"
  ) {
    return reply.code(409).send({ error: failure.code.toLowerCase(), message: failure.reason });
  }
  return reply.code(502).send({ error: failure.code.toLowerCase(), message: failure.reason });
}

export async function lspRoutes(app: FastifyInstance): Promise<void> {
  app.get("/lsp/status", { preHandler: requireAuthWithTier }, async (_request, reply) => {
    return reply.send(lspStatus());
  });

  app.post<{
    Params: { language: string };
    Body: { approvalId?: string } | undefined;
  }>(
    "/lsp/servers/:language/start",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const language = languageForParam(request.params.language);
      if (!language) {
        return reply.code(400).send({
          error: "unknown_language",
          message: `language must be one of ${LSP_LANGUAGES.join(", ")}`,
        });
      }

      // workspace/symbol is the cheapest call that forces a server to exist, so
      // it is what "start" means until the tool routes need a real file.
      const owner = ownerIdFor(request);
      const approvalId = request.body?.approvalId;
      if (approvalId) {
        const redeemed = redeemLspStart(owner, language, approvalId);
        if (redeemed !== "ok") {
          return reply.code(403).send({
            error: redeemed,
            message:
              redeemed === "action_mismatch"
                ? "That approval was granted for a different action."
                : "That approval cannot be used.",
          });
        }
      }
      const result = await withLspRequest(
        owner,
        approvalId,
        () => getLspManager().workspaceSymbols({ query: "", language }),
        Boolean(approvalId),
      );
      if (!result.ok) return failureReply(reply, result);
      return reply.send({ language, started: true });
    },
  );

  app.post<{ Params: { language: string } }>(
    "/lsp/servers/:language/restart",
    { preHandler: requireAdminRole },
    async (request, reply) => {
      const language = languageForParam(request.params.language);
      if (!language) {
        return reply.code(400).send({
          error: "unknown_language",
          message: `language must be one of ${LSP_LANGUAGES.join(", ")}`,
        });
      }
      await getLspManager().restart(language);
      clearLspCounters(language);
      return reply.send({
        language,
        restarted: true,
        servers: lspStatus().servers.filter((server) => server.language === language),
      });
    },
  );
}
