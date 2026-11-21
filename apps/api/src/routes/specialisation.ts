// SPDX-License-Identifier: Apache-2.0
/**
 * Specialisation surface OWNER — extracted from api-bridge.ts.
 *
 * Profiles and per-thread domain choices live in this module. The chat stream
 * reads the applied domain through {@link specialisationPreamble}, so the
 * stores stay here and the bridge only injects nothing back.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import type { AgentDefinition } from "@nexus/agent-core/runtime";
import type { FastifyInstance } from "fastify";

import { PersistentStore } from "../lib/persistent-store.ts";
import { getThread } from "../lib/threads-store.ts";

type Profile = AgentDefinition & { ownerId?: string | null };

const agentRegistry = new PersistentStore<Profile>("specialisation_profiles");
const threadDomains = new PersistentStore<{ id: string; domain: string }>("specialisation_threads");

const profileKey = (req: { nexusUserId?: string }, id: string) =>
  `${req.nexusUserId ?? "anonymous"}:${id}`;

const DOMAINS: {
  id: string;
  name: string;
  description: string;
  focus: string;
  modelHint: string;
}[] = [
  {
    id: "code-review",
    name: "Code Review",
    description: "Correctness, security and maintainability of code changes.",
    focus:
      "Review like a senior engineer: correctness first, then security, then maintainability. Cite lines.",
    modelHint: "anthropic:claude-sonnet-4-6",
  },
  {
    id: "debugger",
    name: "Debugging",
    description: "Finding the root cause of a failure.",
    focus:
      "Debug methodically: state hypotheses, name the evidence that would confirm each, find the root cause before proposing a fix.",
    modelHint: "openai:gpt-5.6-sol",
  },
  {
    id: "architect",
    name: "Architecture",
    description: "System design, trade-offs and boundaries.",
    focus:
      "Think as a systems architect: name the trade-offs, the failure modes and what would change the recommendation.",
    modelHint: "anthropic:claude-sonnet-4-6",
  },
  {
    id: "devops",
    name: "DevOps",
    description: "Deployment, infrastructure and operations.",
    focus:
      "Answer as an SRE: reliability, rollback, observability and cost come before convenience.",
    modelHint: "groq:openai/gpt-oss-120b",
  },
  {
    id: "data-science",
    name: "Data Science",
    description: "Statistics, experiments and data analysis.",
    focus:
      "Answer as a data scientist: state assumptions, check for confounders and say how confident the conclusion can be.",
    modelHint: "gemini:gemini-3.6-flash",
  },
];

/** The applied domain's focus for a chat thread, or "". */
export function specialisationPreamble(req: { nexusUserId?: string }, threadId: unknown): string {
  if (typeof threadId !== "string") return "";
  const applied = threadDomains.get(profileKey(req, threadId));
  const d = DOMAINS.find((x) => x.id === applied?.domain);
  return d ? `Specialisation (${d.name}): ${d.focus}` : "";
}

/** Register /specialisation and /specialisation/*. */
export async function specialisationRoutes(app: FastifyInstance): Promise<void> {
  await Promise.all([agentRegistry.load(), threadDomains.load()]);

  /** POST /specialisation — save an agent specialisation profile (API clients). */
  app.post<{ Body: AgentDefinition }>(
    "/specialisation",
    {
      schema: {
        body: {
          type: "object",
          required: ["id", "displayName", "model"],
          properties: {
            id: { type: "string", maxLength: 64 },
            displayName: { type: "string", maxLength: 128 },
            model: { type: "string", maxLength: 128 },
            systemPrompt: { type: "string", maxLength: 32_768 },
            toolNames: { type: "array", items: { type: "string" }, maxItems: 100 },
          },
          additionalProperties: true,
        },
      },
    },
    async (request, reply) => {
      const profile = { ...request.body, ownerId: request.nexusUserId ?? null };
      agentRegistry.set(profileKey(request, request.body.id), profile);
      return reply.code(201).send(request.body);
    },
  );

  app.get("/specialisation", async (request, reply) => {
    const mine = Array.from(agentRegistry.values()).filter(
      (p) => (p.ownerId ?? null) === (request.nexusUserId ?? null),
    );
    return reply.send(mine.map(({ ownerId: _o, ...p }) => p));
  });

  app.get("/specialisation/domains", async (_req, reply) => {
    return reply.send({
      domains: DOMAINS.map(({ focus: _f, ...d }) => ({ ...d, enabled: true })),
    });
  });

  app.get<{ Params: { id: string } }>("/specialisation/:id", async (request, reply) => {
    const profile = agentRegistry.get(profileKey(request, request.params.id));
    if (!profile) return reply.code(404).send({ error: "not_found" });
    const { ownerId: _o, ...p } = profile;
    return reply.send(p);
  });

  app.delete<{ Params: { id: string } }>("/specialisation/:id", async (request, reply) => {
    const key = profileKey(request, request.params.id);
    if (!agentRegistry.has(key)) return reply.code(404).send({ error: "not_found" });
    agentRegistry.delete(key);
    return reply.code(204).send();
  });

  /** POST /specialisation/apply — steer a chat thread (sessionId = its id) toward a domain. */
  app.post<{ Body: { domain?: string; sessionId?: string } }>(
    "/specialisation/apply",
    async (request, reply) => {
      const domain = DOMAINS.find((d) => d.id === request.body?.domain?.trim());
      const threadId = request.body?.sessionId?.trim();
      if (!domain || !threadId) {
        return reply.code(400).send({
          error: `sessionId (a chat id) and a domain (${DOMAINS.map((d) => d.id).join(", ")}) are required`,
        });
      }
      if (!(await getThread(request.nexusUserId, threadId))) {
        return reply
          .code(404)
          .send({ error: "No conversation with that id — copy it from /chat/<id>" });
      }
      const key = profileKey(request, threadId);
      threadDomains.set(key, { id: key, domain: domain.id });
      return reply.send({
        message: `${domain.name} now steers every answer in this conversation.`,
        domain: domain.id,
        model: domain.modelHint,
      });
    },
  );

  app.get<{ Params: { id: string } }>("/specialisation/thread/:id", async (request, reply) =>
    reply.send({
      domain: threadDomains.get(profileKey(request, request.params.id))?.domain ?? null,
    }),
  );

  app.delete<{ Params: { id: string } }>("/specialisation/thread/:id", async (request, reply) => {
    threadDomains.delete(profileKey(request, request.params.id));
    return reply.code(204).send();
  });
}
