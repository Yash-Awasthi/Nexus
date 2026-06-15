// SPDX-License-Identifier: Apache-2.0
/**
 * Corpus-builder routes — RLHF/SFT training data pipeline via @nexus/hf-research.
 *
 * GET  /api/v1/corpus/batches           — list batches (free+)
 * GET  /api/v1/corpus/batches/:id       — get batch (free+)
 * GET  /api/v1/corpus/batches/:id/jsonl — download JSONL (pro+)
 * POST /api/v1/corpus/samples           — add sample to pending buffer
 * POST /api/v1/corpus/query             — query samples with filters (pro+)
 * POST /api/v1/corpus/flush             — flush + push to HuggingFace (enterprise+)
 * GET  /api/v1/corpus/pending           — count pending samples
 *
 * Publisher selection (at startup):
 *   HF_TOKEN set → HuggingFacePublisher (real HF datasets API)
 *   otherwise    → MockHfPublisher (in-memory log, no network)
 */

import {
  InMemoryBatchStore,
  MockHfPublisher,
  HuggingFacePublisher,
  ResearchApiRouter,
  type DataTier,
  type SampleTag,
} from "@nexus/hf-research";
import type { FastifyInstance } from "fastify";

import { requireAuthWithTier, getTierFromRequest } from "../middleware/auth.js";

// ── Singletons ────────────────────────────────────────────────────────────────

const batchStore = new InMemoryBatchStore();

const publisher = process.env.HF_TOKEN
  ? new HuggingFacePublisher({ token: process.env.HF_TOKEN })
  : new MockHfPublisher();

const router = new ResearchApiRouter({
  store: batchStore,
  publisher,
  defaultRepoId: process.env.HF_REPO_ID ?? "nexus/research",
});

// Tier comes from verified JWT/DB — never from a forgeable header
function callerTier(req: Parameters<typeof getTierFromRequest>[0]): DataTier {
  const t = getTierFromRequest(req);
  if (t === "pro" || t === "enterprise") return t;
  return "free";
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function corpusBuilderRoutes(app: FastifyInstance): Promise<void> {
  /** GET /corpus/batches */
  app.get<{ Querystring: { limit?: string } }>(
    "/corpus/batches",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const result = router.listBatches({
        userTier: callerTier(request),
        params: { limit: request.query.limit ?? "" },
      });
      return reply.code(result.status).send(result.data ?? { error: result.error });
    },
  );

  /** GET /corpus/batches/:id */
  app.get<{ Params: { id: string } }>(
    "/corpus/batches/:id",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const result = router.readBatch({
        userTier: callerTier(request),
        params: { id: request.params.id },
      });
      return reply.code(result.status).send(result.data ?? { error: result.error });
    },
  );

  /** GET /corpus/batches/:id/jsonl */
  app.get<{ Params: { id: string } }>(
    "/corpus/batches/:id/jsonl",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const result = router.downloadJsonl({
        userTier: callerTier(request),
        params: { id: request.params.id },
      });
      if (!result.data) return reply.code(result.status).send({ error: result.error });
      return reply
        .code(200)
        .header("Content-Type", "application/x-ndjson")
        .send(result.data);
    },
  );

  /** POST /corpus/samples — add sample to pending buffer */
  app.post<{
    Body: {
      prompt: string;
      completion: string;
      tag?: SampleTag;
      model?: string;
      sessionId?: string;
      metadata?: Record<string, unknown>;
    };
  }>("/corpus/samples", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const sample = batchStore.addSample({
      prompt: request.body.prompt,
      completion: request.body.completion,
      tag: request.body.tag ?? "neutral",
      model: request.body.model,
      sessionId: request.body.sessionId,
      metadata: request.body.metadata,
    });
    return reply.code(201).send(sample);
  });

  /** POST /corpus/query — filter samples (pro+) */
  app.post<{
    Body: {
      tier?: DataTier;
      tags?: SampleTag[];
      fromDate?: string;
      toDate?: string;
      model?: string;
      limit?: number;
    };
  }>("/corpus/query", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const result = router.querySamples({
      userTier: callerTier(request),
      body: request.body,
    });
    return reply.code(result.status).send(result.data ?? { error: result.error });
  });

  /** POST /corpus/flush — flush pending + push to HF (enterprise+) */
  app.post<{ Body: { name?: string } }>(
    "/corpus/flush",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const result = await router.flushAndPush({
        userTier: callerTier(request),
        body: { name: request.body.name },
      });
      return reply.code(result.status).send(result.data ?? { error: result.error });
    },
  );

  /** GET /corpus/pending */
  app.get("/corpus/pending", { preHandler: requireAuthWithTier }, async (_req, reply) => {
    return reply.send({
      pending: batchStore.pendingCount(),
      publisher: process.env.HF_TOKEN ? "huggingface" : "mock",
    });
  });
}
