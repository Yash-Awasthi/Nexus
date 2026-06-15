// SPDX-License-Identifier: Apache-2.0
/**
 * Doc-pipeline routes — document ingestion pipeline (extract → chunk → embed → store).
 *
 * POST /doc-pipeline/ingest   — run the full pipeline for a document
 * GET  /doc-pipeline/formats  — list supported document formats
 *
 * Stages
 * ──────
 *   1. Extract  — text/html/markdown pass-through via defaultExtractor
 *   2. Chunk    — overlapping fixed-size windows (default 256 tokens, 32 overlap)
 *   3. Embed    — Groq nomic-embed-text-v1.5 if GROQ_API_KEY set; zero-vector fallback
 *   4. Store    — nullStore (chunks logged but not persisted separately from memory store)
 *
 * PDF/DOCX: not supported without external Extractor — returns 422.
 */

import { GroqEmbedder } from "@nexus/memory";
import {
  defaultExtractor,
  nullStore,
  runDocPipeline,
  type DocFormat,
  type DocInput,
  type Embedder,
} from "@nexus/doc-pipeline";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Embedder ──────────────────────────────────────────────────────────────────

// Batch wrapper: GroqEmbedder.embed() takes one string; doc-pipeline Embedder takes string[].
const groqSingleton = process.env.GROQ_API_KEY
  ? new GroqEmbedder({ apiKey: process.env.GROQ_API_KEY })
  : null;

const embedder: Embedder = groqSingleton
  ? async (texts: string[]) => Promise.all(texts.map((t) => groqSingleton.embed(t)))
  : async (texts: string[]) => texts.map(() => [0, 0, 0, 0]); // null embedder

// ── Supported formats ─────────────────────────────────────────────────────────

const SUPPORTED_FORMATS: DocFormat[] = ["text", "markdown", "html"];

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function docPipelineRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /doc-pipeline/formats
   * List document formats supported by the built-in extractor.
   * PDF/DOCX require an external extractor and are not available via this API.
   */
  app.get("/doc-pipeline/formats", { schema: { response: { 200: { type: "object", additionalProperties: true }, 201: { type: "object", additionalProperties: true } } }, preHandler: requireAuth }, async (_request, reply) => {
    return reply.send({ formats: SUPPORTED_FORMATS });
  });

  /**
   * POST /doc-pipeline/ingest
   *
   * Run the full document processing pipeline.
   *
   * Body:
   *   format        — "text" | "markdown" | "html"  (required)
   *   content       — raw document content (required)
   *   source        — optional human-readable label (URL, filename, …)
   *   metadata      — optional key-value pairs persisted alongside chunks
   *   chunkOptions  — optional { maxTokens, overlapTokens }
   *
   * Returns PipelineResult: { source, format, rawTextLength, chunks, embedded, storeResult, durationMs }
   */
  app.post<{
    Body: DocInput & { chunkOptions?: { maxTokens?: number; overlapTokens?: number } };
  }>(
    "/doc-pipeline/ingest",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { format, content, source, metadata, chunkOptions } = request.body;

      if (!format || !content) {
        return reply.code(400).send({ error: "format and content are required" });
      }

      if (!(SUPPORTED_FORMATS as string[]).includes(format)) {
        return reply.code(422).send({
          error: `Unsupported format: "${format}". Supported: ${SUPPORTED_FORMATS.join(", ")}`,
        });
      }

      try {
        const result = await runDocPipeline(
          { format, content, source, metadata },
          {
            extractor:    defaultExtractor,
            embedder,
            store:        nullStore,
            chunkOptions,
          },
        );

        return reply.code(201).send(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: message });
      }
    },
  );
}
