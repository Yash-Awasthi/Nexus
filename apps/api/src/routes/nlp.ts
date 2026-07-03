// SPDX-License-Identifier: Apache-2.0
/**
 * NLP utility routes — powered by @nexus/nlp-utils.
 *
 * POST /nlp/chunk         — chunk text by strategy (fixed / sentence / paragraph / semantic)
 * POST /nlp/language      — detect language from text
 * POST /nlp/keywords      — extract top keywords (TF-IDF weighted, stop-word filtered)
 * POST /nlp/entities      — extract named entities (LLM-backed when keys present; null extractor fallback)
 * POST /nlp/relationships — extract subject-predicate-object triples (LLM-backed)
 *
 * LLM operations use nexus/fast (Groq → NullProvider) so they degrade gracefully
 * when no API key is configured.
 */

import { ClaudeProvider, GroqProvider, LLMRouter } from "@nexus/llm-router";
import {
  chunkByStrategy,
  detectLanguage,
  extractEntities,
  extractKeywords,
  extractRelationships,
  nullNlpLlmClient,
  type ChunkStrategy,
  type NlpLlmClient,
} from "@nexus/nlp-utils";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── LLM adapter — wraps LLMRouter into NlpLlmClient ──────────────────────────

function buildNlpLlmClient(): NlpLlmClient {
  const providers = [];

  if (process.env.GROQ_API_KEY) {
    providers.push(new GroqProvider({ apiKey: process.env.GROQ_API_KEY }));
  }
  if (process.env.ANTHROPIC_API_KEY) {
    providers.push(new ClaudeProvider({ apiKey: process.env.ANTHROPIC_API_KEY }));
  }
  if (providers.length === 0) {
    // Return nullNlpLlmClient — no LLM available, entity/relationship endpoints will
    // return empty arrays with a warning rather than erroring.
    return nullNlpLlmClient;
  }

  const router = new LLMRouter({
    providers,
    aliases: [
      { alias: "nexus/fast", provider: "groq", model: "llama-3.1-70b-versatile" },
      { alias: "nexus/fast", provider: "claude", model: "claude-haiku-4-5" },
    ],
    fallbacks: {},
    strategy: "first",
  });

  return async (messages, opts) => {
    const resp = await router.complete({
      model: "nexus/fast",
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      maxTokens: opts?.maxTokens ?? 512,
      temperature: opts?.temperature ?? 0.0,
    });
    return { content: resp.content, model: resp.model };
  };
}

const _nlpLlm = buildNlpLlmClient();
const _llmAvailable = _nlpLlm !== nullNlpLlmClient;

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function nlpRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /nlp/chunk
   *
   * Body: { text: string, strategy?: "fixed"|"sentence"|"paragraph"|"semantic",
   *         maxTokens?: number, overlapTokens?: number, maxCharsPerChunk?: number }
   * Returns: { chunks: TextChunk[], total: number, strategy: string }
   */
  app.post<{
    Body: {
      text: string;
      strategy?: ChunkStrategy;
      maxTokens?: number;
      overlapTokens?: number;
      maxCharsPerChunk?: number;
    };
  }>("/nlp/chunk", { preHandler: requireAuth }, async (request, reply) => {
    const {
      text,
      strategy = "sentence",
      maxTokens,
      overlapTokens,
      maxCharsPerChunk,
    } = request.body ?? {};

    if (!text || typeof text !== "string") {
      return reply.code(400).send({ error: "text is required" });
    }

    const validStrategies: ChunkStrategy[] = ["fixed", "sentence", "paragraph", "semantic"];
    if (!validStrategies.includes(strategy)) {
      return reply.code(400).send({ error: "invalid strategy", valid: validStrategies });
    }

    const chunks = chunkByStrategy(text, strategy, { maxTokens, overlapTokens, maxCharsPerChunk });
    return reply.send({ chunks, total: chunks.length, strategy });
  });

  /**
   * POST /nlp/language
   *
   * Body: { text: string }
   * Returns: { language, script, confidence, isoCode }
   */
  app.post<{ Body: { text: string } }>(
    "/nlp/language",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { text } = request.body ?? {};
      if (!text || typeof text !== "string") {
        return reply.code(400).send({ error: "text is required" });
      }
      const result = detectLanguage(text);
      return reply.send(result);
    },
  );

  /**
   * POST /nlp/keywords
   *
   * Body: { text: string, topK?: number, minFrequency?: number, includeScores?: boolean }
   * Returns: { keywords: KeywordResult[], total: number }
   */
  app.post<{
    Body: { text: string; topK?: number; minFrequency?: number; includeScores?: boolean };
  }>("/nlp/keywords", { preHandler: requireAuth }, async (request, reply) => {
    const { text, topK = 10, minFrequency = 1, includeScores = true } = request.body ?? {};
    if (!text || typeof text !== "string") {
      return reply.code(400).send({ error: "text is required" });
    }
    const keywords = extractKeywords(text, { topK, minLength: minFrequency });
    const result = includeScores ? keywords : keywords.map((k) => ({ keyword: k.keyword }));
    return reply.send({ keywords: result, total: result.length });
  });

  /**
   * POST /nlp/entities
   *
   * Body: { text: string }
   * Returns: { entities: Entity[], total: number, llmBacked: boolean }
   *
   * Uses LLM (Groq / Claude) when configured; returns [] with llmBacked:false otherwise.
   */
  app.post<{ Body: { text: string } }>(
    "/nlp/entities",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { text } = request.body ?? {};
      if (!text || typeof text !== "string") {
        return reply.code(400).send({ error: "text is required" });
      }
      const entities = await extractEntities(text, _nlpLlm);
      return reply.send({ entities, total: entities.length, llmBacked: _llmAvailable });
    },
  );

  /**
   * POST /nlp/relationships
   *
   * Body: { text: string, entities?: Entity[] }
   *
   * If entities not provided, extracts them first then builds relationships.
   * Returns: { entities, relationships, llmBacked: boolean }
   */
  app.post<{
    Body: {
      text: string;
      entities?: { text: string; type: string; confidence: number }[];
    };
  }>("/nlp/relationships", { preHandler: requireAuth }, async (request, reply) => {
    const { text, entities: providedEntities } = request.body ?? {};
    if (!text || typeof text !== "string") {
      return reply.code(400).send({ error: "text is required" });
    }

    const entities = providedEntities?.length
      ? (providedEntities as Awaited<ReturnType<typeof extractEntities>>)
      : await extractEntities(text, _nlpLlm);

    const relationships = await extractRelationships(text, entities, _nlpLlm);

    return reply.send({
      entities,
      relationships,
      total: { entities: entities.length, relationships: relationships.length },
      llmBacked: _llmAvailable,
    });
  });
}
