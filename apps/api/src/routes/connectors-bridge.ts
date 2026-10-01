// SPDX-License-Identifier: Apache-2.0
/**
 * A user's own document connectors (Notion, Jira, GitHub, a website, ...).
 *
 * Credentials are stored encrypted. A sync pulls documents through the
 * matching @nexus/connectors document connector into a knowledge base named
 * after the connector, so KB search and @kb chat mentions can use them.
 * Cron schedules run from an in-process ticker.
 *
 *   GET    /api/connectors                              — the caller's connectors
 *   POST   /api/connectors                              — { name, source, credentials, syncConfig }
 *   DELETE /api/connectors/:id
 *   POST   /api/connectors/:id/sync                     — { mode: load | poll | slim }
 *   GET    /api/connectors/:id/sync/jobs | /sync-jobs   — job history
 *   DELETE /api/connectors/:id/sync/jobs/:jobId         — cancel or remove a job
 *   GET|POST /api/connectors/:id/sync/schedules, PUT|PATCH|DELETE .../:scheduleId
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import crypto from "node:crypto";

import {
  ConfluenceDocumentConnector,
  DiscordDocumentConnector,
  GitHubDocumentConnector,
  GitLabDocumentConnector,
  JiraDocumentConnector,
  LinearDocumentConnector,
  NotionDocumentConnector,
  SlackDocumentConnector,
  WebDocumentConnector,
  ZendeskDocumentConnector,
  type DocumentConnector,
} from "@nexus/connectors";
import type { MemoryManager } from "@nexus/memory";
import { nextCronRun, cronMatches, parseCron } from "@nexus/trigger-engine";
import type { FastifyInstance } from "fastify";

import { PersistentStore } from "../lib/persistent-store.js";
import { callerFetch, unsafeUrlReason } from "../lib/public-url.js";
import { emitReaction } from "../lib/reactions.js";
import {
  decryptSecret,
  encryptSecret,
  SecretCryptoUnavailableError,
} from "../lib/secret-crypto.js";

import { ensureKb, htmlToText, pruneKbDocs, putKbText } from "./kb.js";

const now = (): string => new Date().toISOString();

type SyncMode = "load" | "poll" | "slim";
type Creds = Record<string, string>;

interface StoredConnector {
  id: string;
  ownerId: string | null;
  name: string;
  source: string;
  credentials: string;
  status: "connected" | "syncing" | "error";
  lastSyncAt: string | null;
  totalDocCount: number;
  errorMsg: string | null;
  kbId: string | null;
  createdAt: string;
}
interface SyncJob {
  id: string;
  connectorId: string;
  syncMode: SyncMode;
  status: "pending" | "running" | "completed" | "failed";
  startedAt: string | null;
  completedAt: string | null;
  documentsProcessed: number;
  documentsDeleted: number;
  errorMessage: string | null;
  createdAt: string;
}
interface Schedule {
  id: string;
  connectorId: string;
  syncMode: SyncMode;
  cronExpression: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

const _connectors = new PersistentStore<StoredConnector>("user_connectors");
const _jobs = new PersistentStore<SyncJob>("connector_sync_jobs_v2");
const _schedules = new PersistentStore<Schedule>("connector_sync_schedules");
const _cancelled = new Set<string>();

const MAX_DOCS_PER_SYNC = 200;

function need(c: Creds, ...keys: string[]): void {
  const missing = keys.filter((k) => !c[k]?.trim());
  if (missing.length) throw new Error(`Missing ${missing.join(", ")}`);
}
function publicUrl(url: string): string {
  const reason = unsafeUrlReason(url);
  if (reason) throw new Error(reason);
  return url.replace(/\/+$/, "");
}
const list = (v: string | undefined) =>
  (v ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Build the document connector for a source from its saved fields; throws on bad input. */
const BUILDERS: Record<string, (c: Creds) => DocumentConnector> = {
  notion: (c) => {
    need(c, "api_key", "database_id");
    return new NotionDocumentConnector({
      token: c.api_key!,
      databaseId: c.database_id!,
      fetch: callerFetch,
    });
  },
  confluence: (c) => {
    need(c, "url", "username", "api_token", "space_key");
    return new ConfluenceDocumentConnector({
      baseUrl: publicUrl(c.url!),
      email: c.username!,
      apiToken: c.api_token!,
      spaceKey: c.space_key!,
      fetch: callerFetch,
    });
  },
  github: (c) => {
    need(c, "token", "repository");
    const [owner, repo] = c.repository!.split("/");
    if (!owner || !repo) throw new Error("Repository must look like owner/name");
    return new GitHubDocumentConnector({ token: c.token!, owner, repo, fetch: callerFetch });
  },
  gitlab: (c) => {
    need(c, "url", "api_token", "project_id");
    return new GitLabDocumentConnector({
      baseUrl: publicUrl(c.url!),
      token: c.api_token!,
      projectId: c.project_id!,
      fetch: callerFetch,
    });
  },
  linear: (c) => {
    need(c, "api_key");
    return new LinearDocumentConnector({
      apiKey: c.api_key!,
      ...(c.team_id ? { teamId: c.team_id } : {}),
      fetch: callerFetch,
    });
  },
  jira: (c) => {
    need(c, "url", "username", "api_token");
    return new JiraDocumentConnector({
      baseUrl: publicUrl(c.url!),
      email: c.username!,
      apiToken: c.api_token!,
      ...(c.jql ? { jql: c.jql } : {}),
      fetch: callerFetch,
    });
  },
  slack: (c) => {
    need(c, "bot_token", "channel_id");
    return new SlackDocumentConnector({
      token: c.bot_token!,
      channelId: c.channel_id!,
      fetch: callerFetch,
    });
  },
  discord: (c) => {
    need(c, "bot_token", "channel_ids");
    return new DiscordDocumentConnector({
      botToken: c.bot_token!,
      channelIds: list(c.channel_ids),
      fetch: callerFetch,
    });
  },
  web: (c) => {
    need(c, "base_url");
    return new WebDocumentConnector({
      urls: list(c.base_url).map(publicUrl),
      fetch: callerFetch,
    });
  },
  zendesk: (c) => {
    need(c, "subdomain", "email", "api_token");
    if (!/^[a-z0-9-]+$/i.test(c.subdomain!))
      throw new Error("Subdomain must be letters, digits or dashes");
    return new ZendeskDocumentConnector({
      subdomain: c.subdomain!,
      email: c.email!,
      apiToken: c.api_token!,
      fetch: callerFetch,
    });
  },
};

const view = ({ credentials: _c, ownerId: _o, ...rest }: StoredConnector) => rest;

/** Register the /connectors/* surface. Called from apiBridgeRoutes. */
export async function connectorsBridgeRoutes(
  app: FastifyInstance,
  deps: { getMemory: () => MemoryManager },
): Promise<void> {
  await Promise.all([_connectors.load(), _jobs.load(), _schedules.load()]);

  // A server restart ends every sync that was in flight.
  for (const j of _jobs.values()) {
    if (j.status === "pending" || j.status === "running") {
      _jobs.set(j.id, {
        ...j,
        status: "failed",
        completedAt: now(),
        errorMessage: "Interrupted by a restart",
      });
    }
  }
  for (const c of _connectors.values()) {
    if (c.status === "syncing") _connectors.set(c.id, { ...c, status: "connected" });
  }

  const mine = (req: { nexusUserId?: string }, id: string) => {
    const c = _connectors.get(id);
    return c && c.ownerId === (req.nexusUserId ?? null) ? c : undefined;
  };

  async function runSync(conn: StoredConnector, mode: SyncMode, job: SyncJob): Promise<void> {
    const userId = conn.ownerId ?? undefined;
    _jobs.set(job.id, { ...job, status: "running", startedAt: now() });
    _connectors.set(conn.id, { ...conn, status: "syncing" });
    let processed = 0;
    try {
      const creds = JSON.parse(decryptSecret(conn.credentials)) as Creds;
      const connector = BUILDERS[conn.source]!(creds);
      const kb = ensureKb(
        userId,
        `${conn.name} (${conn.source})`,
        `Synced from the ${conn.source} connector`,
      );
      // poll: only what changed; slim: list everything but only prune what is gone.
      const since = mode === "poll" && conn.lastSyncAt ? Date.parse(conn.lastSyncAt) : undefined;
      const seen = new Set<string>();
      for await (const doc of connector.sync({
        limit: MAX_DOCS_PER_SYNC,
        ...(since ? { since } : {}),
      })) {
        if (_cancelled.has(job.id)) throw new Error("Cancelled");
        const name = (doc.title || doc.sourceUrl || doc.id).slice(0, 200);
        seen.add(name);
        if (mode === "slim") continue;
        const text = /<(html|body|div|p)\b/i.test(doc.content)
          ? await htmlToText(doc.content)
          : doc.content;
        if (!text.trim()) continue;
        await putKbText(
          deps.getMemory(),
          userId,
          kb.id,
          name,
          `${name}\n${doc.sourceUrl}\n\n${text}`,
          {
            type: conn.source,
            replace: true,
          },
        );
        processed++;
        _jobs.set(job.id, { ..._jobs.get(job.id)!, documentsProcessed: processed });
      }
      const deleted =
        // A capped listing is incomplete, so nothing missing from it can be called gone.
        mode === "slim" && seen.size < MAX_DOCS_PER_SYNC
          ? await pruneKbDocs(deps.getMemory(), userId, kb.id, seen)
          : 0;
      const done = _jobs.get(job.id)!;
      _jobs.set(job.id, {
        ...done,
        status: "completed",
        completedAt: now(),
        documentsProcessed: mode === "slim" ? seen.size : processed,
        documentsDeleted: deleted,
      });
      const latest = _connectors.get(conn.id) ?? conn;
      _connectors.set(conn.id, {
        ...latest,
        status: "connected",
        lastSyncAt: now(),
        kbId: kb.id,
        totalDocCount: ensureKb(userId, kb.name).documents.length,
        errorMsg: null,
      });
      emitReaction(userId, "connector.sync.completed", {
        connectorId: conn.id,
        jobId: job.id,
        documents: processed,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      _jobs.set(job.id, {
        ..._jobs.get(job.id)!,
        status: "failed",
        completedAt: now(),
        documentsProcessed: processed,
        errorMessage: msg,
      });
      const latest = _connectors.get(conn.id);
      if (latest) _connectors.set(conn.id, { ...latest, status: "error", errorMsg: msg });
    } finally {
      _cancelled.delete(job.id);
    }
  }

  function startSync(conn: StoredConnector, mode: SyncMode): SyncJob | null {
    const busy = [..._jobs.values()].some(
      (j) => j.connectorId === conn.id && (j.status === "pending" || j.status === "running"),
    );
    if (busy) return null;
    const job: SyncJob = {
      id: crypto.randomUUID(),
      connectorId: conn.id,
      syncMode: mode,
      status: "pending",
      startedAt: null,
      completedAt: null,
      documentsProcessed: 0,
      documentsDeleted: 0,
      errorMessage: null,
      createdAt: now(),
    };
    _jobs.set(job.id, job);
    void runSync(conn, mode, job);
    return job;
  }

  // Schedules: once a minute, start the syncs whose cron matches this minute.
  const tick = setInterval(() => {
    const at = new Date();
    for (const s of _schedules.values()) {
      if (!s.enabled || !cronMatches(s.cronExpression, at)) continue;
      const conn = _connectors.get(s.connectorId);
      if (!conn) continue;
      if (startSync(conn, s.syncMode)) {
        _schedules.set(s.id, {
          ...s,
          lastRunAt: at.toISOString(),
          nextRunAt: nextCronRun(s.cronExpression, at)?.toISOString() ?? null,
        });
      }
    }
  }, 60_000);
  tick.unref();
  app.addHook("onClose", async () => clearInterval(tick));

  app.get("/connectors", async (request, reply) => {
    const connectors = [..._connectors.values()]
      .filter((c) => c.ownerId === (request.nexusUserId ?? null))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(view);
    return reply.send({ connectors, sources: Object.keys(BUILDERS) });
  });

  app.post<{
    Body: {
      name?: string;
      source?: string;
      credentials?: Record<string, unknown>;
      syncConfig?: { mode?: string; schedule?: string };
    };
  }>("/connectors", async (request, reply) => {
    const source = typeof request.body?.source === "string" ? request.body.source : "";
    const build = Object.hasOwn(BUILDERS, source) ? BUILDERS[source] : undefined;
    if (!build)
      return reply
        .code(400)
        .send({ error: "unsupported_source", message: `Unsupported connector: ${source}` });
    const creds: Creds = {};
    for (const [k, v] of Object.entries(request.body.credentials ?? {})) {
      if (typeof v === "string" && k !== "__proto__") creds[k] = v.trim();
    }
    try {
      build(creds);
    } catch (err) {
      return reply.code(400).send({
        error: "invalid_credentials",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    let sealed: string;
    try {
      sealed = encryptSecret(JSON.stringify(creds));
    } catch (err) {
      if (!(err instanceof SecretCryptoUnavailableError)) throw err;
      return reply.code(503).send({
        error: "encryption_unavailable",
        message:
          "The server has no secrets key (NEXUS_SECRETS_KEY), so it cannot store credentials.",
      });
    }
    const conn: StoredConnector = {
      id: crypto.randomUUID(),
      ownerId: request.nexusUserId ?? null,
      name: (request.body.name?.trim() || source).slice(0, 120),
      source,
      credentials: sealed,
      status: "connected",
      lastSyncAt: null,
      totalDocCount: 0,
      errorMsg: null,
      kbId: null,
      createdAt: now(),
    };
    _connectors.set(conn.id, conn);

    const cron = { hourly: "0 * * * *", daily: "0 3 * * *", weekly: "0 3 * * 1" }[
      request.body.syncConfig?.schedule ?? ""
    ];
    const mode: SyncMode = request.body.syncConfig?.mode === "poll" ? "poll" : "load";
    if (cron) {
      const s: Schedule = {
        id: crypto.randomUUID(),
        connectorId: conn.id,
        syncMode: "poll",
        cronExpression: cron,
        enabled: true,
        lastRunAt: null,
        nextRunAt: nextCronRun(cron, new Date())?.toISOString() ?? null,
        createdAt: now(),
      };
      _schedules.set(s.id, s);
    }
    startSync(conn, mode);
    return reply.code(201).send(view(conn));
  });

  app.delete<{ Params: { id: string } }>("/connectors/:id", async (request, reply) => {
    if (!mine(request, request.params.id))
      return reply.code(404).send({ error: "connector_not_found" });
    _connectors.delete(request.params.id);
    for (const s of _schedules.values())
      if (s.connectorId === request.params.id) _schedules.delete(s.id);
    for (const j of _jobs.values()) {
      if (j.connectorId !== request.params.id) continue;
      _cancelled.add(j.id);
      _jobs.delete(j.id);
    }
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string }; Body: { mode?: string } }>(
    "/connectors/:id/sync",
    async (request, reply) => {
      const conn = mine(request, request.params.id);
      if (!conn) return reply.code(404).send({ error: "connector_not_found" });
      const mode: SyncMode =
        request.body?.mode === "poll" || request.body?.mode === "slim" ? request.body.mode : "load";
      const job = startSync(conn, mode);
      if (!job)
        return reply
          .code(409)
          .send({ error: "sync_in_progress", message: "A sync is already running" });
      return reply.code(201).send(job);
    },
  );

  const jobsFor = (id: string, statuses: string[], limit: number) =>
    [..._jobs.values()]
      .filter((j) => j.connectorId === id && (!statuses.length || statuses.includes(j.status)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);

  for (const path of ["/connectors/:id/sync/jobs", "/connectors/:id/sync-jobs"]) {
    app.get<{ Params: { id: string }; Querystring: { status?: string; limit?: string } }>(
      path,
      async (request, reply) => {
        if (!mine(request, request.params.id))
          return reply.code(404).send({ error: "connector_not_found" });
        const statuses = (request.query.status ?? "").split(",").filter(Boolean);
        const jobs = jobsFor(request.params.id, statuses, Number(request.query.limit ?? 50) || 50);
        return reply.send({ jobs, total: jobs.length });
      },
    );
  }

  app.delete<{ Params: { id: string; jobId: string } }>(
    "/connectors/:id/sync/jobs/:jobId",
    async (request, reply) => {
      const job = _jobs.get(request.params.jobId);
      if (!mine(request, request.params.id) || !job || job.connectorId !== request.params.id) {
        return reply.code(404).send({ error: "job_not_found" });
      }
      if (job.status === "pending" || job.status === "running") _cancelled.add(job.id);
      else _jobs.delete(job.id);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>("/connectors/:id/sync/schedules", async (request, reply) => {
    if (!mine(request, request.params.id))
      return reply.code(404).send({ error: "connector_not_found" });
    const schedules = [..._schedules.values()].filter((s) => s.connectorId === request.params.id);
    return reply.send({ schedules });
  });

  app.post<{
    Params: { id: string };
    Body: { syncMode?: string; cronExpression?: string; enabled?: boolean };
  }>("/connectors/:id/sync/schedules", async (request, reply) => {
    if (!mine(request, request.params.id))
      return reply.code(404).send({ error: "connector_not_found" });
    const cronExpression = request.body?.cronExpression?.trim() ?? "0 * * * *";
    if (!parseCron(cronExpression)) {
      return reply
        .code(400)
        .send({ error: "invalid_cron", message: "Use five fields: minute hour day month weekday" });
    }
    const s: Schedule = {
      id: crypto.randomUUID(),
      connectorId: request.params.id,
      syncMode:
        request.body.syncMode === "poll" || request.body.syncMode === "slim"
          ? request.body.syncMode
          : "load",
      cronExpression,
      enabled: request.body.enabled ?? true,
      lastRunAt: null,
      nextRunAt: nextCronRun(cronExpression, new Date())?.toISOString() ?? null,
      createdAt: now(),
    };
    _schedules.set(s.id, s);
    return reply.code(201).send(s);
  });

  const updateSchedule = async (
    request: {
      nexusUserId?: string;
      params: { id: string; scheduleId: string };
      body: Partial<{ syncMode: string; cronExpression: string; enabled: boolean }> | undefined;
    },
    reply: {
      code: (n: number) => { send: (b: unknown) => unknown };
      send: (b: unknown) => unknown;
    },
  ) => {
    const { id, scheduleId } = request.params;
    const s = _schedules.get(scheduleId);
    if (!mine(request, id) || !s || s.connectorId !== id) {
      return reply.code(404).send({ error: "schedule_not_found" });
    }
    const body = request.body ?? {};
    const cronExpression = body.cronExpression?.trim() ?? s.cronExpression;
    if (!parseCron(cronExpression)) return reply.code(400).send({ error: "invalid_cron" });
    const updated: Schedule = {
      ...s,
      cronExpression,
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      ...(body.syncMode === "load" || body.syncMode === "poll" || body.syncMode === "slim"
        ? { syncMode: body.syncMode }
        : {}),
      nextRunAt: nextCronRun(cronExpression, new Date())?.toISOString() ?? null,
    };
    _schedules.set(scheduleId, updated);
    return reply.send(updated);
  };
  type ScheduleRoute = {
    Params: { id: string; scheduleId: string };
    Body: Partial<{ syncMode: string; cronExpression: string; enabled: boolean }>;
  };
  app.put<ScheduleRoute>("/connectors/:id/sync/schedules/:scheduleId", updateSchedule);
  app.patch<ScheduleRoute>("/connectors/:id/sync/schedules/:scheduleId", updateSchedule);

  app.delete<{ Params: { id: string; scheduleId: string } }>(
    "/connectors/:id/sync/schedules/:scheduleId",
    async (request, reply) => {
      const { id, scheduleId } = request.params;
      const s = _schedules.get(scheduleId);
      if (!mine(request, id) || !s || s.connectorId !== id) {
        return reply.code(404).send({ error: "schedule_not_found" });
      }
      _schedules.delete(scheduleId);
      return reply.code(204).send();
    },
  );
}
