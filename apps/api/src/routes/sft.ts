// SPDX-License-Identifier: Apache-2.0
/**
 * SFT (Supervised Fine-Tuning) tagger routes — conversation tagging + dataset export.
 *
 * POST /sft/conversations          — add a conversation; returns tagged SftSample
 * GET  /sft/conversations          — list all samples (with optional quality filter)
 * GET  /sft/conversations/:id      — get a single sample by ID
 * GET  /sft/export?format=<fmt>    — export dataset (jsonl | alpaca | sharegpt)
 * GET  /sft/stats                  — count, quality distribution
 *
 * Tagging: RuleTagger (rule-based; zero ML calls). QualityScorer assigns 0–1 score.
 * Store: in-process SftDataset singleton.
 */

import {
  DatasetFilter,
  SftDataset,
  SftExporter,
  type ExportFormat,
  type TurnRole,
} from "@nexus/sft-tagger";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Singletons ────────────────────────────────────────────────────────────────

const dataset  = new SftDataset();
const filter   = new DatasetFilter();
const exporter = new SftExporter();

const EXPORT_MIME: Record<ExportFormat, string> = {
  jsonl:     "application/x-ndjson",
  alpaca:    "application/json",
  sharegpt:  "application/json",
};

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function sftRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /sft/conversations
   *
   * Add a conversation and get back an auto-tagged SftSample with quality score.
   *
   * Body:
   *   turns  — [{ role: "user"|"assistant"|"system"|"tool", content: string }]
   *   source — optional label (dataset name, URL, etc.)
   */
  app.post<{
    Body: {
      turns: Array<{ role: TurnRole; content: string; metadata?: Record<string, unknown> }>;
      source?: string;
    };
  }>("/sft/conversations", { preHandler: requireAuth }, async (request, reply) => {
    const { turns, source } = request.body;

    if (!Array.isArray(turns) || turns.length === 0) {
      return reply.code(400).send({ error: "turns must be a non-empty array" });
    }

    const sample = dataset.addConversation(turns, source);
    return reply.code(201).send(sample);
  });

  /**
   * GET /sft/conversations?minQuality=<n>&maxQuality=<n>&minTurns=<n>&source=<s>
   *
   * List all samples with optional quality / turn-count / source filters.
   */
  app.get<{
    Querystring: {
      minQuality?: string;
      maxQuality?: string;
      minTurns?:   string;
      maxTurns?:   string;
      source?:     string;
    };
  }>("/sft/conversations", { preHandler: requireAuth }, async (request, reply) => {
    const { minQuality, maxQuality, minTurns, maxTurns, source } = request.query;

    const filtered = filter.filter(dataset.list(), {
      minQualityScore: minQuality ? parseFloat(minQuality) : undefined,
      maxQualityScore: maxQuality ? parseFloat(maxQuality) : undefined,
      minTurns:        minTurns   ? parseInt(minTurns, 10) : undefined,
      maxTurns:        maxTurns   ? parseInt(maxTurns, 10) : undefined,
      source,
    });

    return reply.send({ samples: filtered, total: filtered.length });
  });

  /**
   * GET /sft/conversations/:id
   *
   * Get a single SftSample by ID.
   */
  app.get<{ Params: { id: string } }>(
    "/sft/conversations/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const sample = dataset.get(request.params.id);
      if (!sample) return reply.code(404).send({ error: "Sample not found" });
      return reply.send(sample);
    },
  );

  /**
   * GET /sft/export?format=jsonl|alpaca|sharegpt&minQuality=<n>
   *
   * Export the dataset in the specified format.
   * Applies minQuality filter before export (default: 0 — include all).
   */
  app.get<{
    Querystring: { format?: string; minQuality?: string };
  }>("/sft/export", { preHandler: requireAuth }, async (request, reply) => {
    const fmt = (request.query.format ?? "jsonl") as ExportFormat;
    const validFormats: ExportFormat[] = ["jsonl", "alpaca", "sharegpt"];
    if (!validFormats.includes(fmt)) {
      return reply.code(400).send({ error: `format must be one of: ${validFormats.join(", ")}` });
    }

    const minQuality = request.query.minQuality ? parseFloat(request.query.minQuality) : 0;
    const samples = filter.filter(dataset.list(), { minQualityScore: minQuality });
    const output  = exporter.export(samples, fmt);

    return reply
      .header("Content-Type", EXPORT_MIME[fmt])
      .header("Content-Disposition", `attachment; filename="sft-dataset.${fmt === "jsonl" ? "jsonl" : "json"}"`)
      .send(output);
  });

  /**
   * GET /sft/stats
   *
   * Count samples + quality distribution (min, max, mean, p50).
   */
  app.get("/sft/stats", { preHandler: requireAuth }, async (_request, reply) => {
    const samples = dataset.list();
    const count = samples.length;

    let min = 1, max = 0, sum = 0;
    const scores = samples.map((s) => s.qualityScore).sort((a, b) => a - b);

    if (scores.length > 0) {
      min = scores[0]!;
      max = scores[scores.length - 1]!;
      sum = scores.reduce((a, b) => a + b, 0);
    }

    const mean = count > 0 ? sum / count : 0;
    const p50  = count > 0 ? (scores[Math.floor(count / 2)] ?? 0) : 0;

    return reply.send({ count, quality: { min, max, mean, p50 } });
  });
}
