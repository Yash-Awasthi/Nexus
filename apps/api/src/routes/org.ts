// SPDX-License-Identifier: Apache-2.0
/**
 * Org surface: wires the org runtime to the rest of Nexus and mounts the
 * routes, which live in org-structure.ts, org-tasks.ts and org-governance.ts.
 *
 * Mounted in the /api scope, so every request already carries the caller's
 * identity and runs inside their user context (their own provider keys come
 * first for any model call an agent makes). All state lives in lib/org-*.ts.
 */

import { MemoryManager, createBestEmbedder } from "@nexus/memory";
import type { FastifyInstance } from "fastify";

import { ANON_OWNER, listArchetypes } from "../lib/archetype-store.js";
import { emitAuditEvent } from "../lib/audit-emitter.js";
import { getMemoryStore } from "../lib/memory-store.js";
import { nativeAdapter, type DriverResolver } from "../lib/org-adapters.js";
import { setCouncilRunner } from "../lib/org-approvals.js";
import { registerExternalAdapters, setSkillResolver } from "../lib/org-cli-adapters.js";
import { setDiscussionSpeaker } from "../lib/org-discussion.js";
import { setKnowledgeRecall, setMemoryMirror } from "../lib/org-memory.js";
import { setPerformanceCouncil } from "../lib/org-performance.js";
import { setReplayCaller } from "../lib/org-replay.js";
import { registerAdapter, setOwnerContextRunner, setPersonaResolver } from "../lib/org-runtime.js";
import { fireRoutineWebhook, startScheduler } from "../lib/org-scheduler.js";
import { OrgError, loadOrgStore, setAuditSink, type Agent } from "../lib/org-store.js";
import { asUser } from "../lib/provider-keys.js";

import { getPinnedDriver } from "./api-bridge.js";
import { deliberateForUser, resolveMemberModel } from "./council.js";
import { searchKb } from "./kb.js";
import { orgGovernanceRoutes } from "./org-governance.js";
import { forMember, isMemberRead, orgReply, shareGuard } from "./org-http.js";
import { orgStructureRoutes } from "./org-structure.js";
import { orgTaskRoutes } from "./org-tasks.js";
import { getSkillsByIds } from "./skills.js";

// Runs happen outside any request; give each one its owner's identity and keys.
setOwnerContextRunner((ownerId, steps, fn) =>
  asUser(ownerId === ANON_OWNER ? null : ownerId, fn, steps),
);

registerExternalAdapters();
setSkillResolver((ownerId, ids) =>
  getSkillsByIds(ids, ownerId === ANON_OWNER ? undefined : ownerId),
);

setAuditSink((row) => {
  void emitAuditEvent({
    entityType: `org.${row.entityType}`,
    entityId: row.entityId,
    action: `org.${row.action}`,
    actor: `${row.actorType}:${row.actorId}`,
    payload: { ownerId: row.ownerId, companyId: row.companyId, ...row.details },
  });
});

// Lessons also land in the owner's Nexus memory when an embedder is available.
try {
  const memory = new MemoryManager({ store: getMemoryStore(), embedder: createBestEmbedder() });
  setMemoryMirror(async (ownerId, lesson) => {
    await memory.remember(lesson.text, {
      metadata: {
        userId: ownerId,
        source: "org",
        companyId: lesson.companyId,
        lessonId: lesson.id,
      },
    });
  });
  setKnowledgeRecall(async (ownerId, query, kbIds) => {
    const userId = ownerId === ANON_OWNER ? undefined : ownerId;
    const fromKbs = (await Promise.all(kbIds.map((id) => searchKb(memory, userId, query, id, 3))))
      .flat()
      .map((h) => ({ source: h.docName || "knowledge base", text: h.text }));
    // Personal memory only: knowledge-base chunks and mirrored org lessons have their own paths.
    const personal = (await memory.recall(query, 8, { userId: userId ?? "local" }))
      .filter((h) => h.entry.metadata.category !== "kb" && h.entry.metadata.source !== "org")
      .slice(0, 3)
      .map((h) => ({ source: "memory", text: h.entry.text }));
    return [...fromKbs, ...personal];
  });
} catch {
  /* no embedder configured: lessons stay in the org store only */
}

setPerformanceCouncil((ownerId, request) =>
  deliberateForUser(ownerId === ANON_OWNER ? undefined : ownerId, request),
);
setCouncilRunner((ownerId, request) =>
  deliberateForUser(ownerId === ANON_OWNER ? undefined : ownerId, request),
);

const archetypeOf = (ownerId: string, id: string | null) =>
  id ? listArchetypes(ownerId).find((a) => a.id === id) : undefined;

setPersonaResolver((ownerId, agent) => {
  const a = archetypeOf(ownerId, agent.archetypeId);
  return a ? a.systemPrompt || a.description || `You are ${a.name}.` : "";
});

const resolveDriver: DriverResolver = (choice) => {
  const wanted = choice ? resolveMemberModel(choice) : null;
  // A model whose provider has no key degrades to the default chain, like a council member.
  const pinned = wanted ? getPinnedDriver(wanted.provider) : undefined;
  if (wanted && pinned)
    return { driver: pinned, model: wanted.model, label: `${wanted.provider}/${wanted.model}` };
  const driver = getPinnedDriver();
  if (!driver) return undefined;
  return {
    driver,
    model: driver.model,
    label: `default chain${wanted ? ` (no key for ${wanted.provider})` : ""}`,
  };
};
const modelFor = (agent: Agent) =>
  agent.model ?? archetypeOf(agent.ownerId, agent.archetypeId)?.model ?? null;

registerAdapter("nexus", nativeAdapter(resolveDriver, modelFor));

setDiscussionSpeaker(async (agent, messages, _steps, maxTokens, guard) => {
  const resolved = resolveDriver(modelFor(agent));
  if (!resolved) throw new Error("No LLM provider configured. Add a provider key in Settings.");
  const res = await resolved.driver.complete(
    { model: resolved.model, messages, maxTokens, temperature: 0.5 },
    guard,
  );
  return res.content;
});

setReplayCaller(async (choice, prompt) => {
  const wanted = resolveMemberModel(choice);
  // A replay compares models, so it never fails over to another one.
  const driver = wanted ? getPinnedDriver(wanted.provider, true) : undefined;
  if (!wanted || !driver) throw new OrgError(400, "invalid", `No key for ${choice}.`);
  const res = await driver
    .complete({
      model: wanted.model,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      maxTokens: 2048,
      temperature: 0.3,
    })
    .catch((err: unknown) => {
      throw new OrgError(502, "replay_failed", `${choice}: ${(err as Error).message}`);
    });
  return { content: res.content, model: `${wanted.provider}/${res.model || wanted.model}` };
});

export async function orgRoutes(app: FastifyInstance): Promise<void> {
  await loadOrgStore();
  startScheduler();

  app.addHook("preHandler", shareGuard);
  app.addHook("preSerialization", async (request, _reply, payload) =>
    isMemberRead(request) ? forMember(payload) : payload,
  );

  await orgStructureRoutes(app);
  await orgTaskRoutes(app);
  await orgGovernanceRoutes(app);
}

/**
 * The routine webhook, outside the authenticated /api scope: the caller is a
 * third-party system holding only the routine's secret. The body is kept raw
 * because the signature covers its exact bytes.
 */
export async function orgHookRoutes(app: FastifyInstance): Promise<void> {
  await loadOrgStore();
  app.addContentTypeParser(
    ["application/json", "text/plain"],
    { parseAs: "string", bodyLimit: 64 * 1024 },
    (_req, body, done) => done(null, body),
  );
  app.post<{
    Params: { hookId: string };
    Body: string;
    Headers: { "x-nexus-timestamp"?: string; "x-nexus-signature"?: string };
  }>("/org/hooks/:hookId", async (request, reply) =>
    orgReply(
      reply,
      () =>
        fireRoutineWebhook(
          request.params.hookId,
          typeof request.body === "string" ? request.body : "",
          request.headers["x-nexus-timestamp"],
          request.headers["x-nexus-signature"],
        ),
      202,
    ),
  );
}
