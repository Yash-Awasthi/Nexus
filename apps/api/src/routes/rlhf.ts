// SPDX-License-Identifier: Apache-2.0
/**
 * RLHF pipeline routes — human feedback collection and preference-pair export.
 *
 * POST /rlhf/feedback              — submit a feedback entry (thumbs up/down/neutral)
 * GET  /rlhf/feedback              — query feedback with optional filters
 * GET  /rlhf/reward/:sessionId     — compute reward signal for a session
 * POST /rlhf/pairs/generate        — auto-generate preference pairs from feedback
 * GET  /rlhf/pairs                 — list generated preference pairs
 * GET  /rlhf/export/pairs          — export preference pairs as JSONL
 * GET  /rlhf/export/feedback       — export raw feedback as JSONL
 * GET  /rlhf/stats                 — feedback + pairs summary stats
 *
 * Store: in-process FeedbackStore (singleton for this process lifetime).
 * Production: replace with a pg-backed store when durable persistence is needed.
 */

import {
  FeedbackStore,
  PipelineExporter,
  type FeedbackFilter,
  type FeedbackRating,
  type FeedbackSource,
} from "@nexus/rlhf-pipeline";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Singleton ─────────────────────────────────────────────────────────────────

const feedbackStore = new FeedbackStore();
const exporter = new PipelineExporter(feedbackStore);

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function rlhfRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /rlhf/feedback
   *
   * Submit human feedback for a model response.
   * Body: { sessionId, messageId, promptText, responseText, model, rating, comment?, source?, userId? }
   *   rating — "thumbs_up" | "thumbs_down" | "neutral"
   *   source — "ui" | "api" | "automated"  (default: "api")
   */
  app.post<{
    Body: {
      sessionId: string;
      messageId: string;
      promptText: string;
      responseText: string;
      model: string;
      rating: FeedbackRating;
      comment?: string;
      source?: FeedbackSource;
      userId?: string;
    };
  }>("/rlhf/feedback", { preHandler: requireAuth }, async (request, reply) => {
    const {
      sessionId,
      messageId,
      promptText,
      responseText,
      model,
      rating,
      comment,
      source = "api",
      userId,
    } = request.body;

    const valid: FeedbackRating[] = ["thumbs_up", "thumbs_down", "neutral"];
    if (!valid.includes(rating)) {
      return reply.code(400).send({ error: `rating must be one of: ${valid.join(", ")}` });
    }

    const entry = feedbackStore.addFeedback({
      sessionId,
      messageId,
      promptText,
      responseText,
      model,
      rating,
      comment,
      source,
      userId,
    });

    return reply.code(201).send(entry);
  });

  /**
   * GET /rlhf/feedback?sessionId=&rating=&model=&userId=&source=
   *
   * Query stored feedback with optional filters.
   */
  app.get<{
    Querystring: Partial<FeedbackFilter>;
  }>("/rlhf/feedback", { preHandler: requireAuth }, async (request, reply) => {
    const filter: FeedbackFilter = {};
    const { sessionId, rating, model, userId, source } = request.query;

    if (sessionId) filter.sessionId = sessionId;
    if (rating) filter.rating = rating as FeedbackRating;
    if (model) filter.model = model;
    if (userId) filter.userId = userId;
    if (source) filter.source = source as FeedbackSource;

    const results = feedbackStore.queryFeedback(filter);
    return reply.send({ feedback: results, total: results.length });
  });

  /**
   * GET /rlhf/reward/:sessionId
   *
   * Compute reward signal for a session.
   * Returns: { sessionId, totalFeedback, positiveCount, negativeCount, neutralCount, rewardScore }
   * rewardScore ∈ [-1, 1]: (positive - negative) / total
   */
  app.get<{ Params: { sessionId: string } }>(
    "/rlhf/reward/:sessionId",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const signal = feedbackStore.computeRewardSignal(request.params.sessionId);
      return reply.send(signal);
    },
  );

  /**
   * POST /rlhf/pairs/generate
   *
   * Auto-generate preference pairs by pairing thumbs_up responses against
   * thumbs_down responses on matching promptText.
   */
  app.post(
    "/rlhf/pairs/generate",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (_request, reply) => {
      const generated = feedbackStore.generatePreferencePairs();
      return reply.code(201).send({ generated: generated.length, pairs: generated });
    },
  );

  /**
   * GET /rlhf/pairs
   *
   * List all generated preference pairs.
   */
  app.get(
    "/rlhf/pairs",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (_request, reply) => {
      const pairs = feedbackStore.listPreferencePairs();
      return reply.send({ pairs, total: pairs.length });
    },
  );

  /**
   * GET /rlhf/export/pairs
   *
   * Export preference pairs as JSONL (one { prompt, chosen, rejected } per line).
   * Content-Type: application/x-ndjson
   */
  app.get(
    "/rlhf/export/pairs",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (_request, reply) => {
      const jsonl = exporter.toJSONL();
      return reply
        .header("Content-Type", "application/x-ndjson")
        .header("Content-Disposition", 'attachment; filename="rlhf-pairs.jsonl"')
        .send(jsonl);
    },
  );

  /**
   * GET /rlhf/export/feedback?sessionId=&rating=&model=
   *
   * Export raw feedback entries as JSONL.
   * Content-Type: application/x-ndjson
   */
  app.get<{
    Querystring: Partial<FeedbackFilter>;
  }>("/rlhf/export/feedback", { preHandler: requireAuth }, async (request, reply) => {
    const filter: FeedbackFilter = {};
    const { sessionId, rating, model } = request.query;
    if (sessionId) filter.sessionId = sessionId;
    if (rating) filter.rating = rating as FeedbackRating;
    if (model) filter.model = model;

    const jsonl = exporter.feedbackToJSONL(filter);
    return reply
      .header("Content-Type", "application/x-ndjson")
      .header("Content-Disposition", 'attachment; filename="rlhf-feedback.jsonl"')
      .send(jsonl);
  });

  /**
   * GET /rlhf/stats
   *
   * Summary statistics: total feedback, total pairs, rating breakdown.
   */
  app.get(
    "/rlhf/stats",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (_request, reply) => {
      return reply.send(exporter.stats());
    },
  );
}
