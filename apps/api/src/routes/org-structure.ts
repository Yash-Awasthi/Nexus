// SPDX-License-Identifier: Apache-2.0
/** Org routes for companies, their agents and the reporting tree. */

import type { FastifyInstance } from "fastify";

import { inboxDigest, sendInboxDigests } from "../lib/org-inbox.js";
import { companyOverview, portfolio } from "../lib/org-overview.js";
import {
  TEMPLATES,
  exportCompany,
  importCompany,
  instantiateTemplate,
} from "../lib/org-portability.js";
import { askOrg } from "../lib/org-runtime.js";
import {
  createAgent,
  createCompany,
  deleteAgent,
  deleteCompany,
  getAgent,
  getCompany,
  listActivity,
  listAgentRevisions,
  listAgents,
  listCompanies,
  orgChart,
  rollbackAgent,
  setAgentStatus,
  setCompanyStatus,
  sharedCompanies,
  updateAgent,
  updateCompany,
  type AgentInput,
  type CompanyInput,
} from "../lib/org-store.js";
import { listComments, listTasks } from "../lib/org-work.js";

import {
  OWNER_CAN,
  capabilitiesFor,
  orgReply,
  ownerOf,
  workspaceRolesFor,
  type Id,
} from "./org-http.js";

export async function orgStructureRoutes(app: FastifyInstance): Promise<void> {
  // ── Companies ──────────────────────────────────────────────────────────────
  app.get("/org/companies", async (request, reply) => {
    const roles = await workspaceRolesFor(request.nexusUserId);
    const own = listCompanies(ownerOf(request)).map((c) => ({ ...c, can: OWNER_CAN }));
    const shared = sharedCompanies(ownerOf(request), [...roles.keys()]).map((c) => ({
      ...c,
      can: capabilitiesFor(roles.get(c.workspaceId!)),
    }));
    return orgReply(reply, () => ({ companies: [...own, ...shared] }));
  });

  app.get("/org/portfolio", async (request, reply) =>
    orgReply(reply, () => ({ companies: portfolio(ownerOf(request)) })),
  );

  /** What waits on you across companies; the same digest the daily notification carries. */
  app.get("/org/inbox", async (request, reply) =>
    orgReply(reply, () => inboxDigest(ownerOf(request))),
  );

  app.post("/org/inbox/send", async (request, reply) =>
    orgReply(reply, async () => ({
      sent: (await sendInboxDigests(new Date(), ownerOf(request))).length > 0,
    })),
  );

  app.get<Id>("/org/companies/:id/overview", async (request, reply) =>
    orgReply(reply, () => companyOverview(ownerOf(request), request.params.id)),
  );

  app.get("/org/templates", async (_request, reply) =>
    orgReply(reply, () => ({
      templates: TEMPLATES.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        agents: t.bundle.agents.map((a) => `${a.name} (${a.title})`),
      })),
    })),
  );

  app.post<{ Params: { id: string }; Body: { name?: string } }>(
    "/org/templates/:id",
    async (request, reply) =>
      orgReply(
        reply,
        () => instantiateTemplate(ownerOf(request), request.params.id, request.body?.name),
        201,
      ),
  );

  app.post<{ Body: { bundle?: unknown; name?: string } }>(
    "/org/import",
    { bodyLimit: 2_500_000 },
    async (request, reply) =>
      orgReply(
        reply,
        () => importCompany(ownerOf(request), request.body?.bundle, request.body?.name),
        201,
      ),
  );

  app.get<Id & { Querystring: { lessons?: string } }>(
    "/org/companies/:id/export",
    { config: { ownerOnly: true } },
    async (request, reply) =>
      orgReply(reply, () =>
        exportCompany(ownerOf(request), request.params.id, request.query.lessons !== "false"),
      ),
  );

  app.post<{ Body: CompanyInput }>("/org/companies", async (request, reply) =>
    orgReply(reply, () => createCompany(ownerOf(request), request.body ?? {}), 201),
  );

  app.get<Id>("/org/companies/:id", async (request, reply) =>
    orgReply(reply, () => getCompany(ownerOf(request), request.params.id)),
  );

  app.patch<Id & { Body: CompanyInput }>("/org/companies/:id", async (request, reply) => {
    const ws = request.body?.workspaceId;
    if (ws && !(await workspaceRolesFor(request.nexusUserId)).has(String(ws)))
      return reply
        .code(400)
        .send({ error: "invalid", message: "Share only into a workspace you belong to." });
    return orgReply(reply, () =>
      updateCompany(ownerOf(request), request.params.id, request.body ?? {}),
    );
  });

  app.get<Id>("/org/agents/:id/revisions", async (request, reply) =>
    orgReply(reply, () => listAgentRevisions(ownerOf(request), request.params.id)),
  );

  app.post<{ Params: { id: string; revisionId: string } }>(
    "/org/agents/:id/revisions/:revisionId/rollback",
    async (request, reply) =>
      orgReply(reply, () =>
        rollbackAgent(ownerOf(request), request.params.id, request.params.revisionId),
      ),
  );

  for (const [verb, status] of [
    ["pause", "paused"],
    ["resume", "active"],
    ["archive", "archived"],
  ] as const) {
    app.post<Id>(`/org/companies/:id/${verb}`, async (request, reply) =>
      orgReply(reply, () => setCompanyStatus(ownerOf(request), request.params.id, status)),
    );
  }

  app.delete<Id>("/org/companies/:id", async (request, reply) =>
    orgReply(reply, () => deleteCompany(ownerOf(request), request.params.id)),
  );

  app.get<Id>("/org/companies/:id/chart", async (request, reply) =>
    orgReply(reply, () => ({ roots: orgChart(ownerOf(request), request.params.id) })),
  );

  app.get<Id & { Querystring: { limit?: string } }>(
    "/org/companies/:id/activity",
    async (request, reply) =>
      orgReply(reply, () => ({
        activity: listActivity(
          ownerOf(request),
          request.params.id,
          Number(request.query.limit ?? 100) || 100,
        ),
      })),
  );

  // ── Agents ─────────────────────────────────────────────────────────────────
  app.get<Id>("/org/companies/:id/agents", async (request, reply) =>
    orgReply(reply, () => ({ agents: listAgents(ownerOf(request), request.params.id) })),
  );

  app.post<Id & { Body: AgentInput }>("/org/companies/:id/agents", async (request, reply) =>
    orgReply(
      reply,
      () => createAgent(ownerOf(request), request.params.id, request.body ?? {}),
      201,
    ),
  );

  app.get<Id>("/org/agents/:id", async (request, reply) =>
    orgReply(reply, () => getAgent(ownerOf(request), request.params.id)),
  );

  app.patch<Id & { Body: AgentInput }>("/org/agents/:id", async (request, reply) =>
    orgReply(reply, () => updateAgent(ownerOf(request), request.params.id, request.body ?? {})),
  );

  for (const [verb, status] of [
    ["pause", "paused"],
    ["resume", "idle"],
    ["terminate", "terminated"],
  ] as const) {
    app.post<Id>(`/org/agents/:id/${verb}`, async (request, reply) =>
      orgReply(reply, () => setAgentStatus(ownerOf(request), request.params.id, status)),
    );
  }

  app.delete<Id>("/org/agents/:id", async (request, reply) =>
    orgReply(reply, () => deleteAgent(ownerOf(request), request.params.id)),
  );

  /**
   * Ask the org a question. It becomes an answer-only task for the named agent
   * (the top of the org by default), woken at once; the answer lands in the
   * task's thread, and a question too big for one agent gets delegated.
   */
  app.post<Id & { Body: { question?: string; agentId?: string } }>(
    "/org/companies/:id/ask",
    async (request, reply) =>
      orgReply(
        reply,
        () =>
          askOrg(
            ownerOf(request),
            request.params.id,
            request.body?.question ?? "",
            request.body?.agentId,
          ),
        201,
      ),
  );

  /** Recent questions and the latest answer on each. */
  app.get<Id>("/org/companies/:id/asks", async (request, reply) =>
    orgReply(reply, () => {
      const owner = ownerOf(request);
      const asks = listTasks(owner, request.params.id)
        .filter((t) => t.workMode === "ask" && t.createdBy.type === "user")
        .slice(0, 10);
      return {
        asks: asks.map((t) => ({
          task: t,
          answer:
            listComments(owner, t.id)
              .filter((c) => c.author.type === "agent")
              .at(-1)?.body ?? null,
        })),
      };
    }),
  );
}
