// SPDX-License-Identifier: Apache-2.0
/**
 * Workflows surface OWNER — extracted from api-bridge.ts (§16.7).
 *
 * /workflows CRUD + /workflows/:id/run. Runs are built on
 * @nexus/workflow-chain (createWorkflowChain, dynamically imported); agent
 * steps delegate to an LLM via @nexus/gateway's runFallbackChain with BYOK
 * registry semantics. Response shapes are byte-identical to the
 * pre-extraction handlers.
 *
 * The two bridge-local LLM wiring helpers (getDefaultDriver, buildChatRegistry)
 * are injected rather than imported, keeping this module free of a circular
 * dependency on api-bridge.ts.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import crypto from "node:crypto";

import type { DriverRegistry, LlmDriver, LlmRole } from "@nexus/llm-drivers";
import type { FastifyInstance } from "fastify";

import { PersistentStore } from "../lib/persistent-store.js";

const now = (): string => new Date().toISOString();

const _workflowStore = new PersistentStore<{
  id: string;
  name: string;
  steps: unknown[];
  status: string;
  createdAt: string;
  timeout?: number;
  lastResult?: unknown;
  lastError?: string;
  lastRunAt?: string;
}>("workflows");

/** Which key backs a chat member — surfaced to the UI as a per-member hint. */
type MemberKeySource = "user" | "oauth" | "env" | "local" | "none";

/** Bridge-owned LLM wiring handed in at registration (no circular import). */
export interface WorkflowsRoutesDeps {
  /** Highest-priority available LLM driver across all registered providers. */
  getDefaultDriver: () => LlmDriver | undefined;
  /** Per-request chat registry with BYOK semantics (user key wins, env fallback). */
  buildChatRegistry: (
    userId: string | undefined,
    providers: Iterable<string>,
  ) => Promise<{ registry: DriverRegistry; sources: Map<string, MemberKeySource> }>;
}

/** Register the /workflows/* surface. Called from apiBridgeRoutes. */
export async function workflowsRoutes(
  app: FastifyInstance,
  deps: WorkflowsRoutesDeps,
): Promise<void> {
  await _workflowStore.load();

  app.get("/workflows", async (_req, reply) => {
    return reply.send([..._workflowStore.values()]);
  });

  app.post<{ Body: { name: string; steps?: unknown[] } }>("/workflows", async (request, reply) => {
    const id = crypto.randomUUID();
    const wf = {
      id,
      name: request.body.name,
      steps: request.body.steps ?? [],
      status: "idle",
      createdAt: now(),
    };
    _workflowStore.set(id, wf);
    return reply.code(201).send(wf);
  });

  app.patch<{ Params: { id: string }; Body: { status?: string; steps?: unknown[] } }>(
    "/workflows/:id",
    async (request, reply) => {
      const wf = _workflowStore.get(request.params.id);
      if (!wf) return reply.code(404).send({ error: "not_found" });
      if (request.body.status) wf.status = request.body.status;
      if (request.body.steps) wf.steps = request.body.steps;
      return reply.send(wf);
    },
  );

  app.delete<{ Params: { id: string } }>("/workflows/:id", async (request, reply) => {
    _workflowStore.delete(request.params.id);
    return reply.code(204).send();
  });

  /**
   * POST /workflows/:id/run — Execute a stored workflow.
   *
   * Builds a WorkflowChain from the stored steps definition and runs it.
   * Supports: steps with kind=fn|condition|agent|loop|parallel, retry config,
   * timeout, abort signal via AbortController.
   *
   * Body: { input?: any }
   * Response: WorkflowResult
   */
  app.post<{
    Params: { id: string };
    Body: { input?: unknown; steps?: unknown[] };
  }>(
    "/workflows/:id/run",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            input: {},
            steps: { type: "array" },
          },
        },
      },
    },
    async (request, reply) => {
      const wf = _workflowStore.get(request.params.id);
      if (!wf) return reply.code(404).send({ error: "not_found" });

      const { createWorkflowChain } = await import("@nexus/workflow-chain");

      // Build chain from stored steps definition. A steps array in the body
      // overrides the stored definition so a run right after (or while)
      // saving always executes the canvas as the user sees it.
      let chain = createWorkflowChain({
        id: wf.id,
        name: wf.name,
      });

      const stepsArr = Array.isArray(request.body.steps)
        ? request.body.steps
        : Array.isArray(wf.steps)
          ? wf.steps
          : [];
      if (stepsArr.length === 0) {
        return reply.code(400).send({
          status: "error",
          error: "workflow has no steps to run — add nodes and save first",
        });
      }
      for (const stepDef of stepsArr) {
        const s = stepDef as Record<string, unknown>;
        const kind = String(s.kind ?? "fn");
        const stepId = String(s.id ?? `step-${Math.random().toString(36).slice(2, 8)}`);
        const retries = typeof s.retries === "number" ? s.retries : 0;
        const timeout = typeof s.timeout === "number" ? s.timeout : undefined;

        if (kind === "condition") {
          chain = chain.andWhen({
            id: stepId,
            name: s.name ? String(s.name) : undefined,
            condition: async () => Boolean(s.conditionResult ?? true),
            execute: async ({ data }) => {
              if (typeof s.execute === "function")
                return (s.execute as (d: unknown) => unknown)(data);
              return data;
            },
            otherwise: s.otherwise
              ? async ({ data }) => {
                  if (typeof s.otherwise === "function")
                    return (s.otherwise as (d: unknown) => unknown)(data);
                  return data;
                }
              : undefined,
            retries: typeof s.retries === "number" ? s.retries : 0,
          });
        } else if (kind === "agent") {
          // Agent step — delegate to an LLM via a fallback chain (models tried
          // in order until one succeeds). Chain: s.models (array of
          // { provider, model }) when present, else a single entry built from
          // s.provider/s.model, else the server default driver.
          const { runFallbackChain } = await import("@nexus/gateway");
          const maxTokens = typeof s.maxTokens === "number" ? s.maxTokens : 2048;
          chain = chain.andThen({
            id: stepId,
            name: s.name ? String(s.name) : undefined,
            execute: async ({ data }) => {
              const prompt: string =
                typeof s.task === "function"
                  ? String(await (s.task as (d: unknown) => unknown)(data))
                  : String(s.task ?? JSON.stringify(data));
              const models: { model: string; provider?: string }[] = Array.isArray(s.models)
                ? (s.models as { model: string; provider?: string }[])
                : s.model
                  ? [
                      {
                        model: String(s.model),
                        provider: s.provider ? String(s.provider) : undefined,
                      },
                    ]
                  : [];
              const fallback =
                models.length > 0
                  ? models
                  : (() => {
                      const driver = deps.getDefaultDriver();
                      return driver
                        ? [{ model: (driver as { model?: string }).model ?? "default" }]
                        : [];
                    })();
              if (fallback.length === 0) {
                throw new Error("agent step: no model configured and no default driver available");
              }
              const result = await runFallbackChain(fallback, async (target) => {
                const { registry } = await deps.buildChatRegistry(
                  request.nexusUserId,
                  target.provider ? [target.provider] : [],
                );
                const driver =
                  (target.provider ? registry.get(target.provider) : undefined) ??
                  deps.getDefaultDriver();
                if (!driver) throw new Error(`no driver for ${target.provider ?? "default"}`);
                const res = await driver.complete({
                  model: target.model,
                  messages: [{ role: "user" as LlmRole, content: prompt }],
                  maxTokens,
                });
                return res.content;
              });
              const agentText = result.result;
              if (s.map && typeof s.map === "function") {
                return (s.map as (t: string, d: unknown) => unknown)(agentText, data);
              }
              return { ...(data as object), agentResult: agentText };
            },
            retries,
            timeout,
          });
        } else if (kind === "parallel") {
          const subSteps = Array.isArray(s.steps) ? s.steps : [];
          chain = chain.andParallel({
            id: stepId,
            name: s.name ? String(s.name) : undefined,
            steps: subSteps.map((sub: any, i: number) => ({
              id: `${stepId}-branch-${i}`,
              execute: async ({ data }: any) => {
                if (typeof sub.execute === "function") return sub.execute(data);
                return data;
              },
            })),
            continueOnFailure: Boolean(s.continueOnFailure),
          });
        } else {
          // Default: function step
          chain = chain.andThen({
            id: stepId,
            name: s.name ? String(s.name) : undefined,
            execute: async ({ data }) => {
              if (typeof s.execute === "function") {
                return (s.execute as (d: unknown) => unknown)(data);
              }
              // If the step has a 'transform' string, evaluate it as a simple expression
              if (typeof s.transform === "string") {
                try {
                  // Intentional dynamic expression eval: the stored workflow
                  // 'transform' is authored by the workflow owner (same trust
                  // boundary as the steps themselves).
                  // eslint-disable-next-line @typescript-eslint/no-implied-eval
                  const fn = new Function("data", `return (${s.transform});`);
                  return fn(data);
                } catch {
                  return data;
                }
              }
              return data;
            },
            retries: typeof s.retries === "number" ? s.retries : 0,
            timeout: typeof s.timeout === "number" ? s.timeout : undefined,
          });
        }
      }

      // Run with timeout
      const controller = new AbortController();
      const overallTimeout = typeof wf.timeout === "number" ? wf.timeout : 120_000;
      const timer = setTimeout(() => controller.abort(), overallTimeout);

      try {
        wf.status = "running";
        _workflowStore.set(wf.id, wf);

        const result = await chain.run(request.body.input ?? {}, {
          signal: controller.signal,
        });

        wf.status = result.status === "completed" ? "completed" : "error";
        wf.lastResult = result;
        wf.lastRunAt = now();
        _workflowStore.set(wf.id, wf);

        return reply.send(result);
      } catch (err) {
        wf.status = "error";
        wf.lastError = err instanceof Error ? err.message : String(err);
        wf.lastRunAt = now();
        _workflowStore.set(wf.id, wf);

        return reply.code(500).send({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        clearTimeout(timer);
      }
    },
  );
}
