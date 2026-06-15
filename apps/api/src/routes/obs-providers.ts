// SPDX-License-Identifier: Apache-2.0
/**
 * Observation-provider routes — session observation store + generation trigger.
 *
 * Persists to Postgres `obs_entries` table when DATABASE_URL is set;
 * falls back to an in-memory array for local dev / CI without a database.
 *
 * GET  /api/v1/obs/memories             — return stored observations as MemoryEntry[]
 * POST /api/v1/obs/generate             — generate an observation for a session
 * POST /api/v1/obs/store                — manually store an observation
 * DELETE /api/v1/obs/:id                — remove an observation
 * GET  /api/v1/obs/providers            — list registered provider names
 */

import { randomUUID } from "crypto";

import {
  LlmObservationProvider,
  MockObservationProvider,
  ProviderRegistry,
  type ObservationEvent,
} from "@nexus/obs-providers";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";

import { requireAuth } from "../middleware/auth.js";

// ── Observation shape ─────────────────────────────────────────────────────────

export interface StoredObservation {
  id: string;
  content: string;
  category: string;
  tags: string[];
  confidence: number;
  provider: string;
  model: string;
  sessionId?: string;
  createdAt: string;
}

// ── Backing store — Postgres when DATABASE_URL is set, in-memory fallback ─────

interface ObsStore {
  all(limit: number, category?: string): Promise<StoredObservation[]>;
  add(obs: StoredObservation): Promise<void>;
  remove(id: string): Promise<boolean>;
}

class InMemoryObsStore implements ObsStore {
  private entries: StoredObservation[] = [];

  constructor() {
    // Seed with a startup entry
    this.entries.push({
      id: "obs-seed-1",
      content: "Nexus platform is initialised and ready. Observation pipeline connected.",
      category: "event",
      tags: ["nexus", "startup"],
      confidence: 1.0,
      provider: "system",
      model: "built-in",
      createdAt: new Date().toISOString(),
    });
  }

  async all(limit: number, category?: string): Promise<StoredObservation[]> {
    let entries = [...this.entries].reverse();
    if (category) entries = entries.filter((e) => e.category === category);
    return entries.slice(0, limit);
  }

  async add(obs: StoredObservation): Promise<void> {
    this.entries.push(obs);
  }

  async remove(id: string): Promise<boolean> {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    this.entries.splice(idx, 1);
    return true;
  }
}

class PgObsStore implements ObsStore {
  private pool: Pool;
  private ready: Promise<void>;

  constructor(pool: Pool) {
    this.pool = pool;
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS obs_entries (
        id          TEXT PRIMARY KEY,
        content     TEXT        NOT NULL,
        category    TEXT        NOT NULL DEFAULT 'event',
        tags        JSONB       NOT NULL DEFAULT '[]',
        confidence  REAL        NOT NULL DEFAULT 1.0,
        provider    TEXT        NOT NULL DEFAULT 'system',
        model       TEXT        NOT NULL DEFAULT 'built-in',
        session_id  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS obs_entries_category_idx  ON obs_entries (category);
      CREATE INDEX IF NOT EXISTS obs_entries_created_at_idx ON obs_entries (created_at DESC);
    `);
    // Seed startup entry if table is empty
    const { rows } = await this.pool.query(`SELECT COUNT(*) AS cnt FROM obs_entries`);
    if (Number(rows[0]?.cnt) === 0) {
      await this.pool.query(
        `INSERT INTO obs_entries (id, content, category, tags, confidence, provider, model)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
        [
          "obs-seed-1",
          "Nexus platform is initialised and ready. Observation pipeline connected.",
          "event",
          JSON.stringify(["nexus", "startup"]),
          1.0,
          "system",
          "built-in",
        ],
      );
    }
  }

  async all(limit: number, category?: string): Promise<StoredObservation[]> {
    await this.ready;
    const params: unknown[] = [limit];
    const where = category ? `WHERE category=$2` : "";
    if (category) params.push(category);
    const { rows } = await this.pool.query(
      `SELECT * FROM obs_entries ${where} ORDER BY created_at DESC LIMIT $1`,
      params,
    );
    return rows.map(rowToObs);
  }

  async add(obs: StoredObservation): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO obs_entries (id, content, category, tags, confidence, provider, model, session_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO NOTHING`,
      [
        obs.id,
        obs.content,
        obs.category,
        JSON.stringify(obs.tags),
        obs.confidence,
        obs.provider,
        obs.model,
        obs.sessionId ?? null,
        obs.createdAt,
      ],
    );
  }

  async remove(id: string): Promise<boolean> {
    await this.ready;
    const { rowCount } = await this.pool.query(
      `DELETE FROM obs_entries WHERE id=$1`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }
}

function rowToObs(row: Record<string, unknown>): StoredObservation {
  return {
    id: row["id"] as string,
    content: row["content"] as string,
    category: row["category"] as string,
    tags: Array.isArray(row["tags"]) ? (row["tags"] as string[]) : (JSON.parse(row["tags"] as string) as string[]),
    confidence: Number(row["confidence"]),
    provider: row["provider"] as string,
    model: row["model"] as string,
    sessionId: row["session_id"] as string | undefined,
    createdAt: row["created_at"] instanceof Date
      ? (row["created_at"] as Date).toISOString()
      : String(row["created_at"]),
  };
}

// ── Singleton store ───────────────────────────────────────────────────────────

const obsStore: ObsStore = process.env.DATABASE_URL
  ? new PgObsStore(new Pool({ connectionString: process.env.DATABASE_URL }))
  : new InMemoryObsStore();

// ── Provider registry ─────────────────────────────────────────────────────────
// When NEXUS_OBSERVATION_DRIVER is set, LlmObservationProvider is the primary
// provider (e.g. NEXUS_OBSERVATION_DRIVER=groq/llama-3.3-70b).
// MockObservationProvider is always registered as the final fallback.

const obsRegistry = new ProviderRegistry();

if (process.env.NEXUS_OBSERVATION_DRIVER && process.env.GROQ_API_KEY) {
  const model = process.env.NEXUS_OBSERVATION_DRIVER;
  const apiKey = process.env.GROQ_API_KEY;

  // Groq-backed LLM call function (non-streaming, accumulates full response)
  const groqCallFn = async (prompt: string, system: string, maxTokens: number): Promise<string> => {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model.replace("groq/", ""),
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        max_tokens: maxTokens,
        temperature: 0.2,
      }),
    });
    if (!resp.ok) throw new Error(`Groq API error: ${resp.status}`);
    const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content ?? "";
  };

  obsRegistry.register(new LlmObservationProvider({ model, callFn: groqCallFn }));
}

obsRegistry.register(new MockObservationProvider("mock", "mock-model", {
  observation: "Observation generated from session context.",
}));

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function obsProvidersRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /obs/memories
   *
   * Returns stored observations shaped as MemoryEntry[] for the MemoryTimeline UI.
   */
  app.get<{ Querystring: { limit?: string; category?: string } }>(
    "/obs/memories",
    { preHandler: requireAuth },
    async (request, reply) => {
      const limit = Math.min(parseInt(request.query.limit ?? "100"), 500);
      const entries = await obsStore.all(limit, request.query.category);

      const memories = entries.map((e) => ({
        id: e.id,
        content: e.content,
        category: e.category,
        tags: e.tags,
        confidence: e.confidence,
        createdAt: e.createdAt,
      }));

      return reply.send({ memories, total: memories.length });
    },
  );

  /**
   * POST /obs/generate — run the observation provider on session events
   */
  app.post<{
    Body: {
      sessionId: string;
      events: ObservationEvent[];
      locale?: string;
      maxTokens?: number;
      category?: string;
      tags?: string[];
    };
  }>("/obs/generate", { preHandler: requireAuth }, async (request, reply) => {
    const { sessionId, events, locale, maxTokens, category = "context", tags = [] } = request.body;

    const result = await obsRegistry.generateWithFallback({
      sessionId,
      events,
      locale,
      maxTokens,
    });

    if (result.observation) {
      const stored: StoredObservation = {
        id: randomUUID(),
        content: result.observation,
        category,
        tags: ["session", ...tags],
        confidence: result.errorClass ? 0.5 : 0.85,
        provider: result.provider,
        model: result.model,
        sessionId,
        createdAt: new Date().toISOString(),
      };
      await obsStore.add(stored);
      return reply.code(201).send({ observation: stored, result });
    }

    return reply.code(200).send({ observation: null, result });
  });

  /**
   * POST /obs/store — manually store an observation without generation
   */
  app.post<{
    Body: {
      content: string;
      category?: string;
      tags?: string[];
      confidence?: number;
      sessionId?: string;
    };
  }>("/obs/store", { preHandler: requireAuth }, async (request, reply) => {
    const stored: StoredObservation = {
      id: randomUUID(),
      content: request.body.content,
      category: request.body.category ?? "fact",
      tags: request.body.tags ?? [],
      confidence: request.body.confidence ?? 1.0,
      provider: "manual",
      model: "none",
      sessionId: request.body.sessionId,
      createdAt: new Date().toISOString(),
    };
    await obsStore.add(stored);
    return reply.code(201).send(stored);
  });

  /**
   * DELETE /obs/:id
   */
  app.delete<{ Params: { id: string } }>(
    "/obs/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const deleted = await obsStore.remove(request.params.id);
      if (!deleted) return reply.code(404).send({ error: "Observation not found" });
      return reply.code(204).send();
    },
  );

  /**
   * GET /obs/providers — list registered provider names
   */
  app.get("/obs/providers", { preHandler: requireAuth }, async (_req, reply) => {
    const providers = obsRegistry.names().map((name) => {
      const p = obsRegistry.get(name)!;
      return { name: p.name, model: p.model };
    });
    return reply.send({ providers });
  });
}
