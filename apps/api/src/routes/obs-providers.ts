// SPDX-License-Identifier: Apache-2.0
/**
 * Observation-provider routes — session observation store + generation trigger.
 *
 * GET  /api/v1/obs/memories             — return stored observations as MemoryEntry[]
 * POST /api/v1/obs/generate             — generate an observation for a session
 * POST /api/v1/obs/store                — manually store an observation
 * DELETE /api/v1/obs/:id                — remove an observation
 * GET  /api/v1/obs/providers            — list registered provider names
 */

import { randomUUID } from "crypto";

import {
  MockObservationProvider,
  ProviderRegistry,
  type ObservationEvent,
} from "@nexus/obs-providers";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── In-memory observation store ───────────────────────────────────────────────

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

const obsStore: StoredObservation[] = [];

// Seed with a welcome observation
obsStore.push({
  id: "obs-seed-1",
  content: "Nexus platform is initialised and ready. Observation pipeline connected.",
  category: "event",
  tags: ["nexus", "startup"],
  confidence: 1.0,
  provider: "system",
  model: "built-in",
  createdAt: new Date().toISOString(),
});

// ── Provider registry (mock by default; swap callFn for real LLM in prod) ────

const obsRegistry = new ProviderRegistry();
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
      let entries = [...obsStore].reverse(); // newest first
      if (request.query.category) {
        entries = entries.filter((e) => e.category === request.query.category);
      }
      const limit = Math.min(parseInt(request.query.limit ?? "100"), 500);
      entries = entries.slice(0, limit);

      // Shape to MemoryEntry (matches apps/web/src/pages/MemoryTimeline.tsx)
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
      obsStore.push(stored);
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
    obsStore.push(stored);
    return reply.code(201).send(stored);
  });

  /**
   * DELETE /obs/:id
   */
  app.delete<{ Params: { id: string } }>(
    "/obs/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const idx = obsStore.findIndex((e) => e.id === request.params.id);
      if (idx === -1) return reply.code(404).send({ error: "Observation not found" });
      obsStore.splice(idx, 1);
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
