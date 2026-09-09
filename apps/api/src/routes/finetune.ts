// SPDX-License-Identifier: Apache-2.0
/**
 * Evaluation + Fine-Tune surface OWNER — extracted from api-bridge.ts (§16.7).
 *
 * All /api/evaluation* routes, the eval results store, and the /api/fine-tune/*
 * routes (dataset stats, JSONL export, OpenAI initiate) live here — the whole
 * feature is findable in this one module instead of inside the legacy bridge
 * monolith.
 *
 * §16.4: EvalEntry now carries an optional `response` field — the actual
 * assistant text captured at rating time. The fine-tune export emits it when
 * present and falls back to a clearly-labeled placeholder (quality metadata
 * only) for legacy entries recorded before this change.
 *
 * Dependency seam: the /evaluate LLM-scoring path needs the bridge's `_llm`
 * helper (used across ~30 endpoints). It is passed in as a narrow, explicitly-
 * typed dep (FineTuneBridgeDeps) at the registration site inside
 * apiBridgeRoutes. This module never imports the bridge.
 */

import type { FastifyInstance } from "fastify";

import { PersistentStore } from "../lib/persistent-store.js";
import { resolveUserProviderKey } from "../lib/provider-keys.js";

const now = (): string => new Date().toISOString();

/** One rated evaluation entry. `response` (§16.4) is the real assistant text. */
export interface EvalEntry {
  id: string;
  conversation: string;
  /** Actual assistant response text, captured at rating time (§16.4). */
  response?: string;
  quality: number;
  coherence: number;
  consensus: number;
  diversity: number;
  date: string;
}

/** Shared singleton — the fine-tune routes read the same store the eval routes write. */
export const evalStore = new PersistentStore<EvalEntry>("eval_results");

/** Number of rated examples (quality ≥ 4) eligible for a fine-tune export. */
export function ratedExamples(): EvalEntry[] {
  return Array.from(evalStore.values()).filter((e) => e.quality >= 4);
}

/** Minimum rated examples required before an export/initiate is allowed. */
export const MIN_RATED_EXAMPLES = 10;

/**
 * Build the OpenAI chat-completions JSONL for the rated examples. Real
 * assistant text when captured (§16.4); labeled placeholder otherwise.
 */
export function buildEvalJsonl(examples: EvalEntry[]): string {
  return examples
    .map((e) =>
      JSON.stringify({
        messages: [
          {
            role: "system",
            content: "You are a helpful AI assistant participating in a council deliberation.",
          },
          { role: "user", content: e.conversation ?? `Evaluation ${e.id}` },
          {
            role: "assistant",
            content:
              e.response?.trim() ||
              `High-quality response. Quality score: ${e.quality}/5. Coherence: ${e.coherence}/5. Consensus: ${e.consensus}/5.`,
          },
        ],
      }),
    )
    .join("\n");
}

/** Narrow seam to the bridge's shared LLM helper (see module docblock). */
export interface FineTuneBridgeDeps {
  /** One-shot LLM completion with automatic cost tracking; returns content. */
  llm: (
    messages: { role: "system" | "user" | "assistant"; content: string }[],
    maxTokens: number,
  ) => Promise<string>;
}

/**
 * Register the evaluation + fine-tune endpoints. Called from apiBridgeRoutes
 * at the exact point the inline blocks used to live — routes land on the same
 * Fastify scope, so auth hooks and framing are unchanged.
 */
export function registerFineTuneRoutes(app: FastifyInstance, deps: FineTuneBridgeDeps): void {
  // ── EVALUATION (LLM-backed scoring) ──────────────────────────────────────

  app.get<{ Querystring: { days?: string } }>("/evaluation/dashboard", async (req, reply) => {
    const days = parseInt(req.query.days ?? "30", 10);
    const cutoff = Date.now() - days * 86_400_000;
    const entries = Array.from(evalStore.values()).filter(
      (e) => new Date(e.date).getTime() >= cutoff,
    );
    const avg = (key: keyof EvalEntry) =>
      entries.length ? entries.reduce((s, e) => s + (e[key] as number), 0) / entries.length : 0;
    return reply.send({
      period: `${days} days`,
      totalRuns: entries.length,
      currentPerformance: {
        overallScore: Math.round(avg("quality") * 100) / 100,
        quality: Math.round(avg("coherence") * 100) / 100,
        consensus: Math.round(avg("consensus") * 100) / 100,
        diversity: Math.round(avg("diversity") * 100) / 100,
      },
    });
  });

  app.get("/evaluation/metrics", async (_req, reply) => {
    const entries = Array.from(evalStore.values());
    if (!entries.length) return reply.send({ metrics: [], message: "No evaluation runs yet." });
    const avg = (key: keyof EvalEntry) =>
      entries.reduce((s, e) => s + (e[key] as number), 0) / entries.length;
    return reply.send({
      metrics: [
        { name: "Quality", value: Math.round(avg("quality") * 100) / 100, trend: "stable" },
        { name: "Coherence", value: Math.round(avg("coherence") * 100) / 100, trend: "stable" },
        { name: "Consensus", value: Math.round(avg("consensus") * 100) / 100, trend: "stable" },
        { name: "Diversity", value: Math.round(avg("diversity") * 100) / 100, trend: "stable" },
      ],
    });
  });

  app.get("/evaluation/results", async (_req, reply) => {
    return reply.send({
      results: Array.from(evalStore.values()).sort((a, b) => b.date.localeCompare(a.date)),
    });
  });

  app.post<{ Body: EvalEntry }>("/evaluation/results", async (req, reply) => {
    const entry: EvalEntry = {
      ...req.body,
      id: req.body.id ?? crypto.randomUUID(),
      date: req.body.date ?? now().slice(0, 10),
    };
    evalStore.set(entry.id, entry);
    return reply.code(201).send(entry);
  });

  app.post<{ Body: { topic?: string; prompt?: string; response?: string } }>(
    "/evaluate",
    async (req, reply) => {
      const prompt =
        req.body.prompt ?? req.body.topic ?? "Evaluate the quality of this council deliberation.";
      // LLM-scored eval run
      const scoreText = await deps.llm(
        [
          {
            role: "system",
            content:
              "You are an AI evaluation system. Score the given topic on four dimensions: quality, coherence, consensus, diversity. Each score is 0.0–1.0. Return only JSON: {quality, coherence, consensus, diversity}",
          },
          { role: "user", content: prompt },
        ],
        128,
      );
      const scores = { quality: 0.75, coherence: 0.72, consensus: 0.68, diversity: 0.81 };
      try {
        Object.assign(scores, parseJsonLoose(scoreText) as Record<string, unknown>);
      } catch {
        /* use defaults */
      }
      const entry: EvalEntry = {
        id: crypto.randomUUID(),
        conversation: prompt.slice(0, 80),
        // §16.4: capture the actual response when the caller provides one.
        ...(req.body.response?.trim() ? { response: req.body.response } : {}),
        quality: Math.min(1, Math.max(0, scores.quality)),
        coherence: Math.min(1, Math.max(0, scores.coherence)),
        consensus: Math.min(1, Math.max(0, scores.consensus)),
        diversity: Math.min(1, Math.max(0, scores.diversity)),
        date: now().slice(0, 10),
      };
      evalStore.set(entry.id, entry);
      return reply.send(entry);
    },
  );

  // ── FINE TUNE — real OpenAI fine-tune API when OPENAI_API_KEY present ────

  app.get("/fine-tune/dataset", async (_req, reply) => {
    const apiKey = process.env.OPENAI_API_KEY;
    const examples = ratedExamples();
    let jobs: unknown[] = [];
    if (apiKey) {
      try {
        const r = await fetch("https://api.openai.com/v1/fine_tuning/jobs?limit=10", {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(8_000),
        });
        if (r.ok) {
          const d = (await r.json()) as { data?: unknown[] };
          jobs = d.data ?? [];
        }
      } catch {
        /* offline gracefully */
      }
    }
    return reply.send({
      success: true,
      count: examples.length,
      eligible: examples.length >= MIN_RATED_EXAMPLES,
      configured: !!apiKey,
      jobs,
      threshold: MIN_RATED_EXAMPLES,
      message: apiKey
        ? examples.length >= MIN_RATED_EXAMPLES
          ? `${examples.length} eligible examples ready.`
          : `Need ${MIN_RATED_EXAMPLES - examples.length} more rated examples (threshold: ${MIN_RATED_EXAMPLES}).`
        : "Add OPENAI_API_KEY to enable fine-tuning.",
    });
  });

  app.get("/fine-tune/export", async (_req, reply) => {
    const examples = ratedExamples();
    if (examples.length === 0) {
      return reply.code(404).send({
        error: "no_data",
        message: "No rated examples yet. Score responses in the Evaluation page first.",
      });
    }
    if (examples.length < MIN_RATED_EXAMPLES) {
      // §15.3/B: the export precondition is ≥10 rated examples — fail loudly
      // instead of handing out a too-small dataset.
      return reply.code(422).send({
        error: "insufficient_data",
        message: `Need at least ${MIN_RATED_EXAMPLES} rated examples to export (have ${examples.length}). Rate ${MIN_RATED_EXAMPLES - examples.length} more in the Evaluation page.`,
      });
    }
    reply.header("Content-Type", "application/jsonl");
    reply.header(
      "Content-Disposition",
      `attachment; filename="nexus-finetune-${now().slice(0, 10)}.jsonl"`,
    );
    return reply.send(buildEvalJsonl(examples));
  });

  app.post<{ Body: { baseModel?: string; model?: string } }>(
    "/fine-tune/initiate",
    async (req, reply) => {
      // BYOK: platform key → x-openai-key header → stored user provider key
      const headerKey = req.headers["x-openai-key"] as string | undefined;
      const storedKey = (await resolveUserProviderKey(req.nexusUserId, "openai")) ?? undefined;
      const apiKey = process.env.OPENAI_API_KEY || headerKey || storedKey;
      if (!apiKey)
        return reply.code(503).send({
          error: "not_configured",
          message:
            "Fine-tuning requires an OpenAI key. Set OPENAI_API_KEY, pass x-openai-key header, or store via POST /user/provider-keys.",
        });
      const examples = ratedExamples();
      if (examples.length < MIN_RATED_EXAMPLES) {
        return reply.code(422).send({
          error: "insufficient_data",
          message: `Need at least ${MIN_RATED_EXAMPLES} rated examples (have ${examples.length}). Rate more responses in the Evaluation page.`,
        });
      }
      const jsonl = buildEvalJsonl(examples);
      // 1. Upload dataset file
      const formData = new FormData();
      formData.append("file", new Blob([jsonl], { type: "application/jsonl" }), "dataset.jsonl");
      formData.append("purpose", "fine-tune");
      let fileId: string;
      try {
        const uploadR = await fetch("https://api.openai.com/v1/files", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: formData,
          signal: AbortSignal.timeout(30_000),
        });
        if (!uploadR.ok) {
          const e = (await uploadR.json()) as { error?: { message?: string } };
          return reply
            .code(502)
            .send({ error: "upload_failed", message: e.error?.message ?? uploadR.statusText });
        }
        fileId = ((await uploadR.json()) as { id: string }).id;
      } catch (e) {
        return reply
          .code(502)
          .send({ error: "upload_failed", message: e instanceof Error ? e.message : String(e) });
      }
      // 2. Create fine-tune job
      try {
        const jobR = await fetch("https://api.openai.com/v1/fine_tuning/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            training_file: fileId,
            model: req.body?.baseModel ?? req.body?.model ?? "gpt-4o-mini-2024-07-18",
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!jobR.ok) {
          const e = (await jobR.json()) as { error?: { message?: string } };
          return reply
            .code(502)
            .send({ error: "job_create_failed", message: e.error?.message ?? jobR.statusText });
        }
        const job = (await jobR.json()) as { id: string; status: string };
        return reply.code(202).send({
          success: true,
          jobId: job.id,
          status: job.status,
          fileId,
          examples: examples.length,
        });
      } catch (e) {
        return reply.code(502).send({
          error: "job_create_failed",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
  );
}

/** Tolerant JSON parse for LLM score output (fence-stripping + fallback). */
function parseJsonLoose(content: string): unknown {
  const cleaned = content.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object found");
  return JSON.parse(cleaned.slice(start, end + 1)) as unknown;
}
