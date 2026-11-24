// SPDX-License-Identifier: Apache-2.0
/**
 * Moderation surface OWNER — extracted from api-bridge.ts.
 *
 * The model scores each category; the configured thresholds and actions, not
 * the model, decide what is flagged and what happens. The chat stream runs the
 * same check through {@link runModeration}, so the store stays here.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import type { LlmDriver, LlmResponse, LlmRole } from "@nexus/llm/drivers";
import type { FastifyInstance } from "fastify";

import { heuristicScores, openaiScores } from "../lib/moderation-score.ts";
import { PersistentStore } from "../lib/persistent-store.ts";

import { requireAdminRole } from "./admin-users.ts";

export interface ModerationDeps {
  serviceKey(
    userId: string | null | undefined,
    provider: string,
    envVar: string,
  ): Promise<string | undefined>;
  getCacheUserId(): string | null;
  getDefaultDriver(): LlmDriver | undefined;
  defaultModel(): string;
  trackServed(res: LlmResponse, requested: string): void;
  parseJsonResponse<T = unknown>(content: string): T;
  noLlm: string;
}

interface ModCategory {
  name: string;
  enabled: boolean;
  threshold: number;
  action: "allow" | "warn" | "block";
}

const MOD_DEFAULTS: ModCategory[] = [
  { name: "hate", enabled: true, threshold: 0.8, action: "block" },
  { name: "violence", enabled: true, threshold: 0.8, action: "block" },
  { name: "sexual", enabled: true, threshold: 0.9, action: "block" },
  { name: "self_harm", enabled: true, threshold: 0.7, action: "block" },
  { name: "harassment", enabled: true, threshold: 0.8, action: "warn" },
  { name: "spam", enabled: true, threshold: 0.9, action: "warn" },
];

const modStore = new PersistentStore<{ id: string; categories: ModCategory[] }>(
  "moderation_config",
);

const modCategories = () => modStore.get("config")?.categories ?? MOD_DEFAULTS;

const SEVERITY = { allow: 0, warn: 1, block: 2 } as const;

/** OpenAI's moderation endpoint when keyed, else the chat model, else keywords. */
async function moderationScores(
  deps: ModerationDeps,
  text: string,
  names: string[],
): Promise<{ scores?: Record<string, unknown>; reason?: unknown }> {
  const openaiKey = await deps.serviceKey(deps.getCacheUserId(), "openai", "OPENAI_API_KEY");
  if (openaiKey) {
    const scores = await openaiScores(text, names, openaiKey).catch(() => null);
    if (scores) return { scores, reason: "Scored by OpenAI moderation." };
  }
  const driver = deps.getDefaultDriver();
  try {
    if (!driver) throw new Error(deps.noLlm);
    const res = await driver.complete({
      model: deps.defaultModel(),
      messages: [
        {
          role: "user" as LlmRole,
          content: `Rate how strongly this text contains each category, from 0 (not at all) to 1 (clearly).\nCategories: ${names.join(", ")}\nReturn JSON only: { "scores": { "<category>": <0-1>, ... }, "reason": "<one sentence>" }\n\nText:\n${text.slice(0, 4000)}`,
        },
      ],
      maxTokens: 512,
    });
    deps.trackServed(res, deps.defaultModel());
    return deps.parseJsonResponse(res.content);
  } catch {
    return { scores: heuristicScores(text, names), reason: "Keyword heuristic." };
  }
}

export async function runModeration(deps: ModerationDeps, text: string, only?: string[]) {
  const cats = modCategories().filter((c) => c.enabled && (!only || only.includes(c.name)));
  const parsed = await moderationScores(
    deps,
    text,
    cats.map((c) => c.name),
  );
  const scores: Record<string, number> = {};
  const categories: Record<string, boolean> = {};
  let action: "allow" | "warn" | "block" = "allow";
  for (const c of cats) {
    const score = Math.min(1, Math.max(0, Number(parsed.scores?.[c.name]) || 0));
    scores[c.name] = score;
    categories[c.name] = score >= c.threshold;
    if (categories[c.name] && SEVERITY[c.action] > SEVERITY[action]) action = c.action;
  }
  return {
    flagged: Object.values(categories).some(Boolean),
    action,
    reason: String(parsed.reason ?? ""),
    categories,
    scores,
  };
}

/** Register /moderation/*. */
export async function moderationRoutes(app: FastifyInstance, deps: ModerationDeps): Promise<void> {
  await modStore.load();

  app.post<{ Body: { text?: string } }>("/moderation/check", async (request, reply) => {
    const text = request.body?.text?.trim();
    if (!text) return reply.code(400).send({ error: "text is required" });
    try {
      return reply.send(await runModeration(deps, text));
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post<{ Body: { items?: { id: string; text: string }[] } }>(
    "/moderation/batch",
    async (request, reply) => {
      const items = (Array.isArray(request.body?.items) ? request.body.items : [])
        .filter((i) => i && typeof i.text === "string" && i.text.trim())
        .slice(0, 20);
      if (items.length === 0)
        return reply.code(400).send({ error: "items[] with text are required" });

      const results = await Promise.all(
        items.map(async (item) => {
          try {
            return { id: item.id, result: await runModeration(deps, item.text) };
          } catch (err) {
            return {
              id: item.id,
              result: {
                flagged: false,
                action: "allow" as const,
                reason: String(err),
                categories: {},
                scores: {},
              },
            };
          }
        }),
      );
      return reply.send({ results });
    },
  );

  app.get("/moderation/config", async (_req, reply) => reply.send({ categories: modCategories() }));
  app.post<{ Body: { categories?: Partial<ModCategory>[] } }>(
    "/moderation/config",
    { preHandler: requireAdminRole },
    async (request, reply) => {
      const incoming = Array.isArray(request.body?.categories) ? request.body.categories : [];
      const categories = modCategories().map((c) => {
        const u = incoming.find((x) => x?.name === c.name);
        if (!u) return c;
        return {
          ...c,
          ...(typeof u.enabled === "boolean" ? { enabled: u.enabled } : {}),
          ...(Number.isFinite(Number(u.threshold))
            ? { threshold: Math.min(1, Math.max(0, Number(u.threshold))) }
            : {}),
          ...(u.action === "allow" || u.action === "warn" || u.action === "block"
            ? { action: u.action }
            : {}),
        };
      });
      modStore.set("config", { id: "config", categories });
      return reply.send({ categories });
    },
  );
}
