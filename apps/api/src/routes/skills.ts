// SPDX-License-Identifier: Apache-2.0
/**
 * Skills surface OWNER — full /skills API.
 *
 *   GET    /api/skills          → { skills } (full records)
 *   POST   /api/skills          → create { name, description?, language?, code? }
 *   DELETE /api/skills/:id      → 204
 *   POST   /api/skills/merge    → merge N skills into one
 *
 * Extracted from api-bridge.ts so the whole skills feature is findable in one
 * module. Registered from inside apiBridgeRoutes (same /api scope, same auth),
 * mirroring the research.ts precedent. Persistence is the shared PersistentStore
 * (collection "skills" — existing data survives the move unchanged).
 *
 * Merge semantics: deterministic structural merge (dedupe shared imports,
 * section per source skill) computed locally — zero LLM tokens. An optional
 * `polish: true` LLM pass rewrites the merged body (cost-tracked, bounded by
 * SKILL_POLISH_TIMEOUT_MS); any failure falls back to the deterministic
 * result, so a merge can never fail outright.
 */

import type { FastifyInstance } from "fastify";

import { PersistentStore } from "../lib/persistent-store.js";
import { compressSkillsForTaskSemantic, polishComposite } from "../lib/skill-compress.js";
import {
  mergeReport,
  mergeSkillCodes,
  pickLanguage,
  polishMergedSkill,
  type PolishDriver,
  type SkillSource,
} from "../lib/skill-merge.js";

const POLISH_TIMEOUT_MS = parseInt(process.env.SKILL_POLISH_TIMEOUT_MS ?? "60000", 10);

export interface StoredSkill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  code?: string;
  language?: string;
  version?: string;
  parameters?: Record<string, unknown>;
  createdAt: string;
}

export interface SkillBridgeDeps {
  defaultModel: string;
  getDefaultDriver: () => PolishDriver | undefined;
  trackCost: (model: string, usage?: { inputTokens?: number; outputTokens?: number }) => void;
}

const _store = new PersistentStore<StoredSkill>("skills");

/** Look up stored skills by id (unknown ids skipped) — used by the missions
 *  runner to attach executable skills to a run. */
export function getSkillsByIds(ids: string[]): StoredSkill[] {
  const out: StoredSkill[] = [];
  for (const id of ids) {
    const s = _store.get(id);
    if (s) out.push(s);
  }
  return out;
}

/** Reject `p` if it hasn't settled within `ms` — bounds the polish LLM call. */
function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

export async function registerSkillRoutes(
  app: FastifyInstance,
  deps: SkillBridgeDeps,
): Promise<void> {
  await _store.load();

  /** GET /skills — full records (code included; the UI renders from these). */
  app.get("/skills", async (_req, reply) => {
    return reply.send({ skills: Array.from(_store.values()) });
  });

  /** POST /skills — create a skill (full record persisted, incl. code). */
  app.post<{
    Body: {
      name?: unknown;
      description?: unknown;
      enabled?: unknown;
      language?: unknown;
      code?: unknown;
      version?: unknown;
      parameters?: unknown;
    };
  }>("/skills", async (request, reply) => {
    const name = str(request.body?.name, 200).trim();
    if (!name) return reply.code(400).send({ error: "name_required" });
    const id = crypto.randomUUID();
    const skill: StoredSkill = {
      id,
      name,
      description: str(request.body?.description, 2000) || "No description",
      enabled: request.body?.enabled !== false,
      code: str(request.body?.code, 200_000),
      language: str(request.body?.language, 50) || undefined,
      version: str(request.body?.version, 50) || "1.0.0",
      parameters:
        request.body?.parameters && typeof request.body.parameters === "object"
          ? (request.body.parameters as Record<string, unknown>)
          : undefined,
      createdAt: new Date().toISOString(),
    };
    _store.set(id, skill);
    return reply.code(201).send(skill);
  });

  /** DELETE /skills/:id */
  app.delete<{ Params: { id: string } }>("/skills/:id", async (request, reply) => {
    _store.delete(request.params.id);
    return reply.code(204).send();
  });

  /**
   * POST /skills/merge — compress N skills into one.
   * Body: { ids: string[], name?, description?, deleteOriginals?, polish? }
   * Returns the merged skill + a token-usage report. Never fails on the LLM
   * path: polish errors fall back to the deterministic merge.
   */
  app.post<{
    Body: {
      ids?: unknown;
      name?: unknown;
      description?: unknown;
      deleteOriginals?: unknown;
      polish?: unknown;
    };
  }>("/skills/merge", async (request, reply) => {
    const rawIds = request.body?.ids;
    if (!Array.isArray(rawIds) || rawIds.length < 2) {
      return reply
        .code(400)
        .send({ error: "ids_required", message: "Provide at least two skill ids to merge" });
    }
    const ids = [...new Set(rawIds.map((x) => str(x, 200)).filter(Boolean))];
    const sources: SkillSource[] = [];
    for (const id of ids) {
      const s = _store.get(id);
      if (s)
        sources.push({
          id: s.id,
          name: s.name,
          description: s.description,
          language: s.language,
          code: s.code ?? "",
        });
    }
    if (sources.length < 2) {
      return reply
        .code(400)
        .send({ error: "not_enough_skills", message: "Fewer than two known skill ids" });
    }

    let mergedCode = mergeSkillCodes(sources);
    let polished = false;
    let polishTokens = { inputTokens: 0, outputTokens: 0 };
    let polishError: string | undefined;
    let polishServedBy: string | undefined;

    if (request.body?.polish === true) {
      const driver = deps.getDefaultDriver();
      if (driver) {
        const attempt = await polishMergedSkill(sources, driver, {
          model: deps.defaultModel,
          timeoutMs: POLISH_TIMEOUT_MS,
        });
        if (attempt.polished) {
          mergedCode = attempt.code;
          polished = true;
          polishTokens = attempt.polishTokens;
          polishServedBy = attempt.servedBy;
          // Track the SAME numbers the report carries (real usage when the
          // driver reported it, estimates otherwise) — the cost log and the
          // merge response never disagree.
          deps.trackCost(deps.defaultModel, attempt.polishTokens);
        } else {
          polishError = attempt.error;
        }
      }
    }

    const language = pickLanguage(sources);
    const name = str(request.body?.name, 200).trim() || `Merged Skill (${sources.length})`;
    const skill: StoredSkill = {
      id: crypto.randomUUID(),
      name,
      description:
        str(request.body?.description, 2000).trim() ||
        `Merged from ${sources.length} skills: ${sources.map((s) => s.name).join(", ")}`,
      enabled: true,
      code: mergedCode,
      language,
      version: "1.0.0",
      createdAt: new Date().toISOString(),
    };
    _store.set(skill.id, skill);

    if (request.body?.deleteOriginals === true) {
      for (const id of ids) _store.delete(id);
    }

    return reply.code(201).send({
      skill,
      report: {
        ...mergeReport(sources, mergedCode),
        polished,
        polishTokens,
        // Honest fallback notice: set when polish was requested but the LLM
        // pass failed/timed out and the deterministic merge was kept.
        polishError,
        polishServedBy,
      },
    });
  });

  /**
   * POST /skills/compress — task-aware composite compression.
   * Body: { ids: string[], task: string, name?, description?, polish?, save? }
   * Returns ONE composite skill containing only the capability-relevant
   * sections for `task`, plus a before/after token report. Deterministic and
   * zero-token by default; `polish` adds an LLM pass (fail-safe); `save`
   * persists the composite to the store (default: temporary / not saved).
   */
  app.post<{
    Body: {
      ids?: unknown;
      task?: unknown;
      name?: unknown;
      description?: unknown;
      polish?: unknown;
      save?: unknown;
    };
  }>("/skills/compress", async (request, reply) => {
    const rawIds = request.body?.ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return reply
        .code(400)
        .send({ error: "ids_required", message: "Provide at least one skill id to compress" });
    }
    const task = str(request.body?.task, 2000).trim();
    if (!task) {
      return reply.code(400).send({ error: "task_required", message: "task is required" });
    }
    const ids = [...new Set(rawIds.map((x) => str(x, 200)).filter(Boolean))];
    const sources: SkillSource[] = [];
    for (const id of ids) {
      const s = _store.get(id);
      if (s)
        sources.push({
          id: s.id,
          name: s.name,
          description: s.description,
          language: s.language,
          code: s.code ?? "",
        });
    }
    if (sources.length === 0) {
      return reply
        .code(400)
        .send({ error: "unknown_skills", message: "None of the provided skill ids resolve" });
    }

    const composite = await compressSkillsForTaskSemantic(sources, task, {
      name: str(request.body?.name, 200),
      description: str(request.body?.description, 2000),
      embedBaseUrl: process.env.OLLAMA_BASE_URL,
    });

    let polished = false;
    let polishTokens = { inputTokens: 0, outputTokens: 0 };
    let polishError: string | undefined;
    let polishServedBy: string | undefined;
    if (request.body?.polish === true) {
      const driver = deps.getDefaultDriver();
      if (driver) {
        const attempt = await polishComposite(composite.keptSources, driver, {
          model: deps.defaultModel,
          timeoutMs: POLISH_TIMEOUT_MS,
        });
        if (attempt.polished) {
          composite.code = attempt.code;
          polished = true;
          polishTokens = attempt.polishTokens;
          polishServedBy = attempt.servedBy;
          deps.trackCost(deps.defaultModel, attempt.polishTokens);
        } else {
          polishError = attempt.error;
        }
      }
    }

    let skill: StoredSkill | undefined;
    if (request.body?.save === true) {
      skill = {
        id: crypto.randomUUID(),
        name: composite.name,
        description: composite.description,
        enabled: true,
        code: composite.code,
        language: composite.language,
        version: "1.0.0",
        createdAt: new Date().toISOString(),
      };
      _store.set(skill.id, skill);
    }

    return reply.code(200).send({
      composite: { name: composite.name, description: composite.description, code: composite.code },
      report: {
        ...composite.report,
        polished,
        polishTokens,
        polishError,
        polishServedBy,
      },
      skill,
    });
  });
}
