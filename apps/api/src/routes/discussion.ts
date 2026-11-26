// SPDX-License-Identifier: Apache-2.0
/**
 * Discussion routes
 *   POST /api/v1/discussion/stream — SSE: ledger entries as they land
 *
 * The third council shape (`runDiscussion` in @nexus/council). Unlike the vote
 * and the debate, participants here are not round-locked: each reads the shared
 * ledger from its own watermark and contributes on its own clock, and a
 * supervisor keeps the record and decides when the result has arrived.
 *
 * Personas and per-member models come from the same archetype registry the
 * other two paths resolve against.
 *
 * The ledger outlives the stream: every entry is written to `nexus_kv` (collection
 * `discussions`) as it lands, `GET /discussion/:id` returns the record and
 * `GET /discussion/:id/export` returns the same document the stream ends with, so
 * a client that disconnects mid-discussion loses nothing.
 */

import { randomUUID } from "node:crypto";

import {
  detectTaskCategory,
  runDiscussion,
  type DebateMember,
  type DiscussionOutcome,
  type IStreamingTransport,
  type LedgerEntry,
} from "@nexus/council";
import type { LlmRole } from "@nexus/llm/drivers";
import type { FastifyInstance } from "fastify";

import { ANON_OWNER, loadArchetypeStore, resolveCouncilMembers } from "../lib/archetype-store.ts";
import { ownerIdFor } from "../lib/owner.ts";
import { PersistentStore } from "../lib/persistent-store.ts";
import { publish } from "../lib/webhooks.ts";
import { buildUserDriverRegistry } from "../lib/provider-keys.ts";
import { requireAuthWithTier } from "../middleware/auth.ts";

import { resolveCouncilModelAlias, resolveMemberModel } from "./council.ts";

/** Caps a caller may lower but not raise. */
const LIMITS = {
  participants: 6,
  contributions: 40,
  wallMs: 600_000,
  settlePauseMs: 30_000,
} as const;

interface DiscussionBody {
  topic: string;
  participants: { label: string; provider: string; model: string }[];
  /** Council alias, `provider/model`, or a bare model id. */
  supervisorModel?: string;
  settlePauseMs?: number;
  maxContributions?: number;
  maxWallMs?: number;
}

const clamp = (value: number | undefined, fallback: number, max: number): number =>
  Math.min(max, Math.max(1, Math.round(value ?? fallback)));

/** One discussion, kept after the stream ends so a page can reopen it. */
interface DiscussionRecord {
  id: string;
  ownerId: string;
  topic: string;
  participants: string[];
  entries: LedgerEntry[];
  digest: string;
  settled: boolean;
  /** `settled`, `budget`, `wall-clock`, `error`, or `running` while it is open. */
  reason: string;
  contributions: number;
  totalTokens: number;
  startedAt: string;
  finishedAt?: string;
}

const discussions = new PersistentStore<DiscussionRecord>("discussions");
/** A discussion older than this is not worth keeping; the export was the point. */
const DISCUSSION_TTL_MS = 30 * 24 * 3600_000;
let _discussionsLoaded: Promise<void> | null = null;

function loadDiscussions(): Promise<void> {
  _discussionsLoaded ??= discussions.load().then(() => {
    const cutoff = Date.now() - DISCUSSION_TTL_MS;
    for (const [id, record] of [...discussions.entries()]) {
      const started = Date.parse(record.startedAt);
      if (Number.isFinite(started) && started < cutoff) discussions.delete(id);
    }
  });
  return _discussionsLoaded;
}

/** The record a restart would read back for one discussion. */
export async function _discussionForTests(id: string): Promise<DiscussionRecord | undefined> {
  await loadDiscussions();
  return discussions.get(id);
}

/**
 * A finished (or open) discussion, for the comparison surface.
 *
 * Deliberately un-scoped: the caller checks ownership, because the one legitimate reader
 * that is not the owner is an admin export, and a helper that silently hides a row from it
 * would be the wrong half of the check to centralise here.
 */
export async function readDiscussion(id: string): Promise<DiscussionRecord | undefined> {
  await loadDiscussions();
  return discussions.get(id);
}

/**
 * The caller's discussions, newest first — for global search.
 *
 * Returns the shape a result list needs (topic, who took part, whether it settled, where to
 * open it) rather than the whole ledger: a search result that carries forty rounds of text
 * is a search result nobody scrolls.
 */
export async function listDiscussionsFor(userId: string | undefined): Promise<{
  id: string;
  topic: string;
  settled: boolean;
  reason: string;
  startedAt: string;
  finishedAt?: string;
  contributions: number;
  participants: string[];
}[]> {
  await loadDiscussions();
  const owner = userId ?? ANON_OWNER;
  return [...discussions.values()]
    .filter((record) => record.ownerId === owner)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map((record) => ({
      id: record.id,
      topic: record.topic,
      settled: record.settled,
      reason: record.reason,
      startedAt: record.startedAt,
      ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
      contributions: record.contributions,
      participants: record.participants,
    }));
}

/** What a comparison needs to read: the record type, exported for `routes/comparisons.ts`. */
export type { DiscussionRecord };

/** Write a discussion as another account would have left it. */
export async function _seedDiscussionForTests(record: DiscussionRecord): Promise<void> {
  await discussions.save(record.id, record);
  _discussionsLoaded = null;
}

/** The `notes.md` document, from the outcome when it exists and from the entries until then. */
function renderDiscussion(record: DiscussionRecord, markdown?: string): string {
  if (markdown) return markdown;
  const head = `# Discussion — ${record.topic}\n`;
  return `${head}${record.entries
    .map(
      (entry) =>
        `\n## L${entry.line} · ${entry.at} · ${entry.author}${
          entry.kind === "digest" ? " (record)" : ""
        }\n\n${entry.text}\n`,
    )
    .join("")}`;
}

export async function discussionRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: DiscussionBody }>(
    "/discussion/stream",
    {
      preHandler: requireAuthWithTier,
      schema: {
        body: {
          type: "object",
          required: ["topic", "participants"],
          properties: {
            topic: { type: "string", minLength: 1, maxLength: 10_000 },
            participants: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["label", "provider", "model"],
                properties: {
                  label: { type: "string", minLength: 1 },
                  provider: { type: "string", minLength: 1 },
                  model: { type: "string", minLength: 1 },
                },
              },
            },
            supervisorModel: { type: "string" },
            settlePauseMs: { type: "number", minimum: 0 },
            maxContributions: { type: "number", minimum: 1 },
            maxWallMs: { type: "number", minimum: 1_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const requested = body.participants.slice(0, LIMITS.participants);

      const supervisorChoice = body.supervisorModel ?? resolveCouncilModelAlias();
      let supervisorTarget = resolveMemberModel(supervisorChoice);
      if (!supervisorTarget) {
        return reply.code(400).send({
          error: "unknown_supervisor_model",
          message: `Unknown model "${supervisorChoice}".`,
        });
      }

      const providers = [
        ...new Set([...requested.map((p) => p.provider), supervisorTarget.provider]),
      ];
      const { registry } = await buildUserDriverRegistry(request.nexusUserId, providers);

      const available = requested.filter((p) => registry.get(p.provider));
      // With no supervisor asked for, one the caller cannot reach falls back to
      // a participant's model rather than refusing the discussion.
      if (!body.supervisorModel && !registry.get(supervisorTarget.provider) && available[0]) {
        supervisorTarget = { provider: available[0].provider, model: available[0].model };
      }
      if (available.length === 0 || !registry.get(supervisorTarget.provider)) {
        return reply.code(400).send({
          error: "no_provider_key",
          message:
            "No configured provider covers the requested participants and supervisor. " +
            "Add a key under Settings → Provider Keys.",
        });
      }

      await loadArchetypeStore();
      // One model alone only talks to itself, so a lone provider seats three personas.
      const seats =
        available.length === 1 ? [available[0]!, available[0]!, available[0]!] : available;
      const personas = resolveCouncilMembers(
        request.nexusUserId ?? ANON_OWNER,
        detectTaskCategory(body.topic),
        seats.length,
      );
      const participants: DebateMember[] = seats.map((p, i) => {
        const persona = personas[i];
        return {
          label: seats !== available && persona ? `${p.label} · ${persona.name}` : p.label,
          provider: p.provider,
          model: p.model,
          ...(persona ? { systemPrompt: persona.systemPrompt, archetype: persona.name } : {}),
          ...(persona?.temperature !== undefined ? { temperature: persona.temperature } : {}),
        };
      });

      const transport: IStreamingTransport = {
        async streamMember(member, messages, onDelta) {
          const driver = registry.get(member.provider);
          if (!driver) throw new Error(`No driver configured for provider "${member.provider}".`);
          let text = "";
          const res = await driver.stream(
            {
              model: member.model,
              messages: messages.map((m) => ({ role: m.role as LlmRole, content: m.content })),
              maxTokens: 1_024,
              ...(member.temperature !== undefined ? { temperature: member.temperature } : {}),
            },
            (delta) => {
              if (delta.delta) {
                text += delta.delta;
                onDelta(delta.delta);
              }
            },
          );
          return {
            text,
            usage: {
              promptTokens: res.usage?.inputTokens ?? 0,
              completionTokens: res.usage?.outputTokens ?? 0,
            },
          };
        },
      };

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const send = (event: string, data: unknown): void => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // The record exists before the first entry, so a client that disconnects has an id
      // to come back to. Entries are written through as they land, not at the end.
      await loadDiscussions();
      const record: DiscussionRecord = {
        id: randomUUID(),
        ownerId: ownerIdFor(request),
        topic: body.topic,
        participants: participants.map((member) => member.label),
        entries: [],
        digest: "",
        settled: false,
        reason: "running",
        contributions: 0,
        totalTokens: 0,
        startedAt: new Date().toISOString(),
      };
      await discussions.save(record.id, record);
      send("id", { discussionId: record.id });

      try {
        const outcome: DiscussionOutcome = await runDiscussion(
          transport,
          {
            topic: body.topic,
            participants,
            supervisor: {
              label: "Recorder",
              provider: supervisorTarget.provider,
              model: supervisorTarget.model,
            },
            settlePauseMs: clamp(body.settlePauseMs, 1_200, LIMITS.settlePauseMs),
            maxContributions: clamp(body.maxContributions, 18, LIMITS.contributions),
            maxWallMs: clamp(body.maxWallMs, 180_000, LIMITS.wallMs),
          },
          {
            onEntry: (entry) => {
              record.entries.push(entry);
              void discussions.save(record.id, record);
              send("entry", entry);
            },
            onDelta: (member, text) => send("delta", { label: member.label, text }),
            onError: (member, error) =>
              send("member_error", {
                label: member.label,
                message: error instanceof Error ? error.message : String(error),
              }),
          },
        );
        await discussions.save(record.id, {
          ...record,
          digest: outcome.digest,
          settled: outcome.settled,
          reason: outcome.reason,
          contributions: outcome.contributions,
          totalTokens: outcome.totalTokens,
          finishedAt: new Date().toISOString(),
        });
        // The stream ends here, but a client that connected over a mobile network and lost
        // the socket does not know that. The webhook is the durable half of "it finished".
        publish(
          "discussion.completed",
          {
            discussionId: record.id,
            topic: record.topic,
            settled: outcome.settled,
            reason: outcome.reason,
            contributions: outcome.contributions,
            totalTokens: outcome.totalTokens,
          },
          record.ownerId,
        );
        send("done", outcome);
      } catch (err) {
        request.log.error(err, "discussion/stream failed");
        await discussions.save(record.id, {
          ...record,
          reason: "error",
          finishedAt: new Date().toISOString(),
        });
        send("error", { message: err instanceof Error ? err.message : "Discussion failed" });
      } finally {
        reply.raw.end();
      }
      return reply;
    },
  );

  /** GET /discussion — this caller's discussions, newest first. */
  app.get("/discussion", { preHandler: requireAuthWithTier }, async (request) => {
    await loadDiscussions();
    const owner = ownerIdFor(request);
    const rows = [...discussions.values()]
      .filter((record) => record.ownerId === owner)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(({ entries, ...rest }) => ({ ...rest, lines: entries.length }));
    return { discussions: rows, total: rows.length };
  });

  /** GET /discussion/:id — one discussion, entries included. */
  app.get<{ Params: { id: string } }>(
    "/discussion/:id",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      await loadDiscussions();
      const record = discussions.get(request.params.id);
      if (!record || record.ownerId !== ownerIdFor(request))
        return reply.code(404).send({ error: "not_found" });
      return reply.send({
        ...record,
        markdown: renderDiscussion(record),
      });
    },
  );

  /** GET /discussion/:id/export — the same notes.md document the stream ends with. */
  app.get<{ Params: { id: string } }>(
    "/discussion/:id/export",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      await loadDiscussions();
      const record = discussions.get(request.params.id);
      if (!record || record.ownerId !== ownerIdFor(request))
        return reply.code(404).send({ error: "not_found" });
      const slug = record.topic
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60);
      return reply
        .header("content-type", "text/markdown; charset=utf-8")
        .header("content-disposition", `attachment; filename="discussion-${slug || record.id}.md"`)
        .send(renderDiscussion(record));
    },
  );
}
