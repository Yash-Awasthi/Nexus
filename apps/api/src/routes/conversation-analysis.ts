// SPDX-License-Identifier: Apache-2.0
/**
 * Conversation analysis routes — powered by @nexus/lens.
 *
 * POST /conversation-analysis/analyze  — analyze a message array, return ConversationInsight
 * GET  /conversation-analysis/:id      — retrieve a stored insight by conversation ID
 * GET  /conversation-analysis          — list all stored insight IDs (most recent first)
 *
 * Pure analysis — no LLM, no network. Regex + TF-IDF frequency analysis only.
 * Results are stored in-memory keyed by conversationId for retrieval.
 */

import {
  analyzeConversation,
  type ConversationInsight,
  type ConversationMessage,
} from "@nexus/lens";
import type { FastifyInstance } from "fastify";

import { evictOldestEntry } from "../lib/lru-utils.js";
import { requireAuth } from "../middleware/auth.js";

// ── In-memory store (survives request lifetime, not process restarts) ─────────

const _insights = new Map<string, ConversationInsight>();
const MAX_STORED = 500;

function store(insight: ConversationInsight): void {
  evictOldestEntry(_insights, MAX_STORED);
  _insights.set(insight.conversationId, insight);
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function conversationAnalysisRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /conversation-analysis/analyze
   *
   * Body: { id?: string, messages: { role: "user"|"assistant", content: string }[] }
   *
   * Returns ConversationInsight: themes, intents, sentiment, topKeywords,
   * questionCount, codeBlockCount, messageCount, estimatedTokens, etc.
   */
  app.post<{
    Body: {
      id?: string;
      messages: ConversationMessage[];
    };
  }>("/conversation-analysis/analyze", { preHandler: requireAuth }, async (request, reply) => {
    const { id, messages } = request.body ?? {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return reply.code(400).send({ error: "messages array is required and must be non-empty" });
    }

    // Validate each message shape
    for (const msg of messages) {
      if (!msg.role || !["user", "assistant"].includes(msg.role)) {
        return reply.code(400).send({
          error: "each message must have role: 'user' | 'assistant'",
        });
      }
      if (typeof msg.content !== "string") {
        return reply.code(400).send({ error: "each message must have a string content field" });
      }
    }

    const conversationId = id ?? crypto.randomUUID();
    const insight = analyzeConversation({ id: conversationId, messages });
    store(insight);

    return reply.code(200).send({ insight });
  });

  /**
   * GET /conversation-analysis/:id
   *
   * Retrieve a previously analyzed conversation's insight.
   */
  app.get<{ Params: { id: string } }>(
    "/conversation-analysis/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const insight = _insights.get(request.params.id);
      if (!insight) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "No insight stored for this conversation ID" });
      }
      return reply.send({ insight });
    },
  );

  /**
   * GET /conversation-analysis
   *
   * List stored conversation IDs and summary stats (no full insight payload).
   * Query: ?limit=20
   */
  app.get<{ Querystring: { limit?: string } }>(
    "/conversation-analysis",
    { preHandler: requireAuth },
    async (request, reply) => {
      const limit = Math.min(parseInt(request.query.limit ?? "20", 10) || 20, 100);
      const entries = [..._insights.values()]
        .sort((a, b) => b.analyzedAt - a.analyzedAt)
        .slice(0, limit)
        .map((i) => ({
          conversationId: i.conversationId,
          analyzedAt: i.analyzedAt,
          messageCount: i.messageCount,
          sentiment: i.sentiment,
          themes: i.themes,
          topIntent: i.intents[0]?.type ?? null,
        }));

      return reply.send({ entries, total: _insights.size });
    },
  );
}
