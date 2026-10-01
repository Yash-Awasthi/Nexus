// SPDX-License-Identifier: Apache-2.0
/** Org routes for budgets, routines, approvals and the company memory. */

import type { FastifyInstance } from "fastify";

import {
  cancelApproval,
  decide,
  getApproval,
  listApprovals,
  pendingCount,
  reviewApproval,
  type Decision,
} from "../lib/org-approvals.js";
import {
  budgetOverview,
  deletePolicy,
  resolveIncident,
  upsertPolicy,
  type PolicyInput,
} from "../lib/org-budget.js";
import { addLesson, deleteLesson, listLessons, recall } from "../lib/org-memory.js";
import {
  createRoutine,
  deleteRoutine,
  fireRoutine,
  getRoutine,
  listRoutines,
  publicRoutine,
  setRoutineWebhook,
  updateRoutine,
  type RoutineInput,
} from "../lib/org-scheduler.js";
import { getCompany } from "../lib/org-store.js";

import { orgReply, ownerOf, type Id } from "./org-http.js";

export async function orgGovernanceRoutes(app: FastifyInstance): Promise<void> {
  // ── Budgets ────────────────────────────────────────────────────────────────
  app.get<Id>("/org/companies/:id/budgets", async (request, reply) =>
    orgReply(reply, () => budgetOverview(ownerOf(request), request.params.id)),
  );

  app.put<Id & { Body: PolicyInput }>("/org/companies/:id/budgets", async (request, reply) =>
    orgReply(reply, () => upsertPolicy(ownerOf(request), request.params.id, request.body ?? {})),
  );

  app.delete<Id>("/org/budgets/:id", async (request, reply) =>
    orgReply(reply, () => deletePolicy(ownerOf(request), request.params.id)),
  );

  app.post<Id & { Body: { action?: string; amountUsd?: number } }>(
    "/org/budget-incidents/:id/resolve",
    async (request, reply) =>
      orgReply(reply, () =>
        resolveIncident(ownerOf(request), request.params.id, request.body ?? {}),
      ),
  );

  // ── Routines ───────────────────────────────────────────────────────────────
  app.get<Id>("/org/companies/:id/routines", async (request, reply) =>
    orgReply(reply, () => ({
      routines: listRoutines(ownerOf(request), request.params.id).map(publicRoutine),
    })),
  );

  app.post<Id & { Body: RoutineInput }>("/org/companies/:id/routines", async (request, reply) =>
    orgReply(
      reply,
      () => publicRoutine(createRoutine(ownerOf(request), request.params.id, request.body ?? {})),
      201,
    ),
  );

  app.patch<Id & { Body: RoutineInput }>("/org/routines/:id", async (request, reply) =>
    orgReply(reply, () =>
      publicRoutine(updateRoutine(ownerOf(request), request.params.id, request.body ?? {})),
    ),
  );

  app.delete<Id>("/org/routines/:id", async (request, reply) =>
    orgReply(reply, () => deleteRoutine(ownerOf(request), request.params.id)),
  );

  app.post<Id>("/org/routines/:id/fire", async (request, reply) =>
    orgReply(reply, () => fireRoutine(ownerOf(request), request.params.id, "manual")),
  );

  /** Turn the webhook trigger on or off. Turning it on returns the secret once. */
  app.post<Id & { Body: { enabled?: boolean } }>(
    "/org/routines/:id/webhook",
    async (request, reply) =>
      orgReply(reply, () => {
        const owner = ownerOf(request);
        const { routine, secret } = setRoutineWebhook(
          owner,
          request.params.id,
          request.body?.enabled !== false,
        );
        return {
          routine: publicRoutine(routine),
          secret,
          url: routine.webhookId ? `/api/v1/org/hooks/${routine.webhookId}` : null,
        };
      }),
  );

  app.get<Id>("/org/routines/:id", async (request, reply) =>
    orgReply(reply, () => publicRoutine(getRoutine(ownerOf(request), request.params.id))),
  );

  // ── Approvals ──────────────────────────────────────────────────────────────
  app.get<Id & { Querystring: { status?: string } }>(
    "/org/companies/:id/approvals",
    async (request, reply) =>
      orgReply(reply, () => ({
        approvals: listApprovals(ownerOf(request), request.params.id, request.query.status),
      })),
  );

  app.get("/org/approvals/pending-count", async (request, reply) =>
    orgReply(reply, () => ({ pending: pendingCount(ownerOf(request)) })),
  );

  app.get<Id>("/org/approvals/:id", async (request, reply) =>
    orgReply(reply, () => getApproval(ownerOf(request), request.params.id)),
  );

  for (const [verb, decision] of [
    ["approve", "approve"],
    ["reject", "reject"],
    ["request-revision", "request_revision"],
  ] as const) {
    app.post<Id & { Body: { note?: string; amountUsd?: number } }>(
      `/org/approvals/:id/${verb}`,
      async (request, reply) =>
        orgReply(reply, () =>
          decide(ownerOf(request), request.params.id, decision as Decision, request.body ?? {}),
        ),
    );
  }

  app.post<Id>("/org/approvals/:id/review", async (request, reply) =>
    orgReply(reply, () => reviewApproval(ownerOf(request), request.params.id), 202),
  );

  app.post<Id>("/org/approvals/:id/cancel", async (request, reply) =>
    orgReply(reply, () => cancelApproval(ownerOf(request), request.params.id)),
  );

  // ── Memory ─────────────────────────────────────────────────────────────────
  app.get<Id & { Querystring: { q?: string } }>(
    "/org/companies/:id/memory",
    async (request, reply) =>
      orgReply(reply, () => {
        const owner = ownerOf(request);
        const q = request.query.q?.trim();
        const all = listLessons(owner, request.params.id);
        return { lessons: q ? recall(owner, request.params.id, q, 50) : all.slice(0, 200) };
      }),
  );

  app.post<Id & { Body: { text?: string } }>("/org/companies/:id/memory", async (request, reply) =>
    orgReply(
      reply,
      () => {
        const owner = ownerOf(request);
        getCompany(owner, request.params.id);
        return addLesson({
          ownerId: owner,
          companyId: request.params.id,
          agentId: null,
          kind: "note",
          text: request.body?.text ?? "",
          source: null,
        });
      },
      201,
    ),
  );

  app.delete<Id>("/org/memory/:id", async (request, reply) =>
    orgReply(reply, () => deleteLesson(ownerOf(request), request.params.id)),
  );
}
