// SPDX-License-Identifier: Apache-2.0
/**
 * Chat suggestion routes.
 *
 * POST /api/v1/chat-suggestions        — get follow-up prompt suggestions
 * GET  /api/v1/chat-suggestions/topics — get suggested conversation topics
 */

import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Static suggestion sets ────────────────────────────────────────────────────

const TOPIC_STARTERS = [
  "Explain this code and suggest improvements",
  "Write a unit test for the function above",
  "What are the edge cases I should handle?",
  "Summarise the key points from our conversation",
  "Generate a step-by-step implementation plan",
  "What security concerns should I be aware of?",
  "Refactor this for better readability",
  "How would I scale this to production?",
];

function generateSuggestions(lastMessage: string): string[] {
  const msg = lastMessage.toLowerCase();
  if (msg.includes("error") || msg.includes("bug") || msg.includes("fail")) {
    return [
      "What's the root cause of this error?",
      "Show me a minimal repro case",
      "How would I write a regression test for this?",
    ];
  }
  if (msg.includes("code") || msg.includes("function") || msg.includes("class")) {
    return [
      "Review this for potential issues",
      "Add TypeScript types to this",
      "Write tests for the edge cases",
    ];
  }
  if (msg.includes("architect") || msg.includes("design") || msg.includes("system")) {
    return [
      "What are the trade-offs of this approach?",
      "How would this scale to 10x traffic?",
      "Draw the data flow diagram",
    ];
  }
  return [
    "Tell me more about this",
    "Give me a concrete example",
    "What would you do differently?",
  ];
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function chatSuggestionsRoutes(app: FastifyInstance): Promise<void> {
  /** POST /chat-suggestions */
  app.post<{
    Body: {
      last_message?: string;
      conversation_length?: number;
      model?: string;
      limit?: number;
    };
  }>("/chat-suggestions", { preHandler: requireAuth }, async (request, reply) => {
    const { last_message = "", limit = 3 } = request.body;
    const suggestions = generateSuggestions(last_message).slice(0, Math.min(limit, 5));
    return reply.send({ suggestions, total: suggestions.length });
  });

  /** GET /chat-suggestions/topics */
  app.get<{ Querystring: { limit?: string } }>(
    "/chat-suggestions/topics",
    { preHandler: requireAuth },
    async (request, reply) => {
      const limit = Math.min(parseInt(request.query.limit ?? "6"), 8);
      const topics = TOPIC_STARTERS.slice(0, limit);
      return reply.send({ topics, total: topics.length });
    },
  );
}
