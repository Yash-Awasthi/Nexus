// SPDX-License-Identifier: Apache-2.0
/**
 * Workflows surface OWNER — extracted from api-bridge.ts (§16.7).
 *
 * /workflows CRUD + /workflows/:id/run. A workflow with a `schedule` (five-field
 * cron, server local time) also runs from a minute tick. Runs are built on
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
import { isDue, minuteKey, nextCronRun, parseCron } from "@nexus/trigger-engine";
import type { FastifyInstance } from "fastify";

import { handOff } from "../lib/org-work.js";
import { ANON_OWNER, claimable, ownsRow } from "../lib/owner.js";
import { PersistentStore } from "../lib/persistent-store.js";
import { emitReaction, provideReactionDeps } from "../lib/reactions.js";

const now = (): string => new Date().toISOString();

type _Workflow = {
  id: string;
  ownerId?: string | null;
  name: string;
  steps: unknown[];
  status: string;
  createdAt: string;
  timeout?: number;
  lastResult?: unknown;
  lastError?: string;
  lastRunAt?: string;
  /** The editor's canvas; `steps` is what runs. */
  graph?: { nodes: unknown[]; edges: unknown[] };
  schedule?: string | null;
  nextRunAt?: string | null;
  lastFiredMinute?: string | null;
};
const _workflowStore = new PersistentStore<_Workflow>("workflows");
claimable("workflows", _workflowStore);

/** Which key backs a chat member — surfaced to the UI as a per-member hint. */
class WorkflowInputError extends Error {}

/** Set `schedule` from a request body value: a cron, or empty/null to stop. */
function applySchedule(wf: _Workflow, value: unknown): void {
  if (value === undefined) return;
  if (value !== null && typeof value !== "string")
    throw new WorkflowInputError("schedule must be a cron string or null");
  const expr = (value ?? "").trim();
  if (expr && !parseCron(expr))
    throw new WorkflowInputError("schedule must be a five-field cron, e.g. 0 9 * * 1-5");
  wf.schedule = expr || null;
  wf.nextRunAt = expr ? (nextCronRun(expr, new Date())?.toISOString() ?? null) : null;
}

let runDue: ((at: Date) => Promise<string[]>) | null = null;

/** Run every scheduled workflow due at `at` and resolve with their ids once they finish. */
export function runDueWorkflows(at = new Date()): Promise<string[]> {
  return runDue ? runDue(at) : Promise.resolve([]);
}

type MemberKeySource = "user" | "oauth" | "env" | "local" | "none";

/** Bridge-owned LLM wiring handed in at registration (no circular import). */
interface WorkflowsRoutesDeps {
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

  const visible = (req: { nexusUserId?: string }, wf: _Workflow) => ownsRow(req, wf);
  const mine = (req: { nexusUserId?: string }, id: string) => {
    const wf = _workflowStore.get(id);
    return wf && visible(req, wf) ? wf : undefined;
  };

  app.get("/workflows", async (request, reply) => {
    return reply.send([..._workflowStore.values()].filter((wf) => visible(request, wf)));
  });

  app.post<{ Body: { name?: string; steps?: unknown[]; schedule?: unknown } }>(
    "/workflows",
    async (request, reply) => {
      const name = request.body?.name?.trim();
      if (!name) return reply.code(400).send({ error: "name is required" });
      const wf: _Workflow = {
        id: crypto.randomUUID(),
        ownerId: request.nexusUserId ?? null,
        name: name.slice(0, 200),
        steps: Array.isArray(request.body.steps) ? request.body.steps : [],
        status: "idle",
        createdAt: now(),
      };
      try {
        applySchedule(wf, request.body.schedule);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      _workflowStore.set(wf.id, wf);
      return reply.code(201).send(wf);
    },
  );

  app.patch<{
    Params: { id: string };
    Body: {
      status?: string;
      steps?: unknown[];
      name?: string;
      graph?: { nodes?: unknown; edges?: unknown };
      schedule?: unknown;
    };
  }>("/workflows/:id", async (request, reply) => {
    const wf = mine(request, request.params.id);
    if (!wf) return reply.code(404).send({ error: "not_found" });
    try {
      applySchedule(wf, request.body?.schedule);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    if (request.body?.status) wf.status = request.body.status;
    if (Array.isArray(request.body?.steps)) wf.steps = request.body.steps;
    if (request.body?.name?.trim()) wf.name = request.body.name.trim().slice(0, 200);
    const graph = request.body?.graph;
    if (graph && Array.isArray(graph.nodes) && Array.isArray(graph.edges))
      wf.graph = { nodes: graph.nodes, edges: graph.edges };
    _workflowStore.set(wf.id, wf);
    return reply.send(wf);
  });

  app.delete<{ Params: { id: string } }>("/workflows/:id", async (request, reply) => {
    if (!mine(request, request.params.id)) return reply.code(404).send({ error: "not_found" });
    _workflowStore.delete(request.params.id);
    return reply.code(204).send();
  });

  /** Build the stored steps into a chain and run it; records status on the row. */
  async function runStoredWorkflow(
    wf: _Workflow,
    input: unknown,
    userId: string | undefined,
    stepsOverride?: unknown[],
  ): Promise<{ status: string } & Record<string, unknown>> {
    const { createWorkflowChain } = await import("@nexus/workflow-chain");

    // Build chain from stored steps definition. A steps array in the body
    // overrides the stored definition so a run right after (or while)
    // saving always executes the canvas as the user sees it.
    let chain = createWorkflowChain({
      id: wf.id,
      name: wf.name,
    });

    const stepsArr = Array.isArray(stepsOverride)
      ? stepsOverride
      : Array.isArray(wf.steps)
        ? wf.steps
        : [];
    if (stepsArr.length === 0) {
      throw new WorkflowInputError("workflow has no steps to run — add nodes and save first");
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
                userId,
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
      } else if (kind === "org_task") {
        // Hand the step to a company agent as a task; with `wait`, the agent's
        // deliverable becomes the step's output.
        chain = chain.andThen({
          id: stepId,
          name: s.name ? String(s.name) : undefined,
          execute: async ({ data, signal }) => {
            const orgTask = await handOff(
              userId ?? ANON_OWNER,
              String(s.companyId ?? ""),
              {
                title: String(s.title ?? s.name ?? "Workflow step").slice(0, 300),
                description: `Input from workflow "${wf.name}":\n${JSON.stringify(data, null, 2).slice(0, 8000)}`,
                assigneeAgentId: s.agentId ? String(s.agentId) : null,
              },
              { wait: s.wait === true, signal },
            );
            return { ...(data as object), orgTask };
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
            if (typeof s.transform === "string" && s.transform.trim() !== "data") {
              // A transform is code; on a shared server it would run as the
              // API process for whoever saved the workflow.
              if (process.env.NEXUS_DESKTOP !== "1") {
                throw new Error("transform expressions only run in the desktop app");
              }
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

    const controller = new AbortController();
    const overallTimeout = typeof wf.timeout === "number" ? wf.timeout : 120_000;
    const timer = setTimeout(() => controller.abort(), overallTimeout);
    emitReaction(userId, "workflow.run.started", { workflowId: wf.id, name: wf.name });
    try {
      wf.status = "running";
      _workflowStore.set(wf.id, wf);
      const result = await chain.run(input ?? {}, { signal: controller.signal });
      wf.status = result.status === "completed" ? "completed" : "error";
      wf.lastResult = result;
      wf.lastRunAt = now();
      _workflowStore.set(wf.id, wf);
      emitReaction(userId, "workflow.run.completed", {
        workflowId: wf.id,
        name: wf.name,
        status: result.status,
      });
      return result as unknown as { status: string } & Record<string, unknown>;
    } catch (err) {
      wf.status = "error";
      wf.lastError = err instanceof Error ? err.message : String(err);
      wf.lastRunAt = now();
      _workflowStore.set(wf.id, wf);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  runDue = async (at) => {
    const due = [..._workflowStore.values()].filter(
      (wf) =>
        wf.schedule &&
        wf.status !== "running" &&
        isDue({ cron: wf.schedule, lastFiredMinute: wf.lastFiredMinute }, at),
    );
    await Promise.allSettled(
      due.map((wf) => {
        wf.lastFiredMinute = minuteKey(at);
        wf.nextRunAt = nextCronRun(wf.schedule!, at)?.toISOString() ?? null;
        _workflowStore.set(wf.id, wf);
        return runStoredWorkflow(wf, { scheduledAt: at.toISOString() }, wf.ownerId ?? undefined);
      }),
    );
    return due.map((wf) => wf.id);
  };
  // Every half minute, so a late timer never skips a minute; lastFiredMinute stops a repeat.
  const tick = setInterval(() => void runDueWorkflows(), 30_000);
  tick.unref();
  app.addHook("onClose", async () => clearInterval(tick));

  provideReactionDeps({
    runWorkflow: async (ownerId, workflowId, input) => {
      const wf = _workflowStore.get(workflowId);
      if (!wf || (wf.ownerId && wf.ownerId !== ownerId)) throw new Error("workflow not found");
      const result = await runStoredWorkflow(wf, { event: input }, ownerId ?? undefined);
      return `workflow ${result.status}`;
    },
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
      const wf = mine(request, request.params.id);
      if (!wf) return reply.code(404).send({ error: "not_found" });
      try {
        return reply.send(
          await runStoredWorkflow(
            wf,
            request.body?.input,
            request.nexusUserId,
            request.body?.steps,
          ),
        );
      } catch (err) {
        const code = err instanceof WorkflowInputError ? 400 : 500;
        return reply.code(code).send({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}
