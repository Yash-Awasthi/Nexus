// SPDX-License-Identifier: Apache-2.0
/** Org routes for goals, tasks and the runs that work them. */

import type { FastifyInstance } from "fastify";

import { revokeGrants } from "../lib/org-cli-adapters.js";
import { startDiscussion, type DiscussionOptions } from "../lib/org-discussion.js";
import { agentRecord, reviewAgent } from "../lib/org-performance.js";
import { modelScorecard, replayRun, replayTask } from "../lib/org-replay.js";
import {
  WAKE_SOURCES,
  cancelRun,
  enqueueWake,
  getRun,
  listRuns,
  type WakeSource,
} from "../lib/org-runtime.js";
import { OrgError, getAgent } from "../lib/org-store.js";
import {
  addComment,
  allowedTransitions,
  checkoutTask,
  createGoal,
  createTask,
  deleteGoal,
  deleteTask,
  fileVerdict,
  getTask,
  listComments,
  listGoals,
  listTasks,
  openBlockers,
  projectGoals,
  releaseTask,
  setTaskStatus,
  updateGoal,
  updateTask,
  whyChain,
  type GoalInput,
  type TaskInput,
  type TaskStatus,
} from "../lib/org-work.js";

import { actorOf, orgReply, ownerOf, type Id } from "./org-http.js";

export async function orgTaskRoutes(app: FastifyInstance): Promise<void> {
  // ── Goals ──────────────────────────────────────────────────────────────────
  app.get<Id>("/org/companies/:id/goals", async (request, reply) =>
    orgReply(reply, () => ({ goals: listGoals(ownerOf(request), request.params.id) })),
  );

  app.post<Id & { Body: GoalInput }>("/org/companies/:id/goals", async (request, reply) =>
    orgReply(reply, () => createGoal(ownerOf(request), request.params.id, request.body ?? {}), 201),
  );

  app.patch<Id & { Body: GoalInput }>("/org/goals/:id", async (request, reply) =>
    orgReply(reply, () => updateGoal(ownerOf(request), request.params.id, request.body ?? {})),
  );

  app.delete<Id>("/org/goals/:id", async (request, reply) =>
    orgReply(reply, () => deleteGoal(ownerOf(request), request.params.id)),
  );

  // ── Tasks ──────────────────────────────────────────────────────────────────
  app.get<
    Id & { Querystring: { status?: string; assignee?: string; goal?: string; parent?: string } }
  >("/org/companies/:id/tasks", async (request, reply) =>
    orgReply(reply, () => ({
      tasks: listTasks(ownerOf(request), request.params.id, {
        status: request.query.status,
        assigneeAgentId: request.query.assignee,
        goalId: request.query.goal,
        parentId: request.query.parent,
      }),
    })),
  );

  // Workspace members may file tasks and hand them to agents, as themselves.
  app.post<Id & { Body: TaskInput }>(
    "/org/companies/:id/tasks",
    { config: { memberWrite: "fileTask" } },
    async (request, reply) =>
      orgReply(
        reply,
        () => createTask(ownerOf(request), request.params.id, request.body ?? {}, actorOf(request)),
        201,
      ),
  );

  /** One task with everything its detail view needs. */
  app.post<Id & { Body: { question?: string; verdict?: string } }>(
    "/org/companies/:id/verdicts",
    async (request, reply) =>
      orgReply(
        reply,
        () => fileVerdict(ownerOf(request), request.params.id, request.body ?? {}),
        201,
      ),
  );

  app.get<Id>("/org/projects/:id/goals", async (request, reply) =>
    orgReply(reply, () => ({ goals: projectGoals(ownerOf(request), request.params.id) })),
  );

  app.get<Id>("/org/tasks/:id", async (request, reply) =>
    orgReply(reply, () => {
      const owner = ownerOf(request);
      const task = getTask(owner, request.params.id);
      return {
        task,
        comments: listComments(owner, task.id),
        why: whyChain(owner, task),
        subtasks: listTasks(owner, task.companyId, { parentId: task.id }),
        openBlockers: openBlockers(task),
        transitions: allowedTransitions(task.status, { type: "user", id: owner }),
      };
    }),
  );

  app.patch<Id & { Body: TaskInput }>(
    "/org/tasks/:id",
    { config: { memberWrite: "assign" } },
    async (request, reply) =>
      orgReply(reply, () =>
        updateTask(ownerOf(request), request.params.id, request.body ?? {}, actorOf(request)),
      ),
  );

  app.post<Id & { Body: { status?: TaskStatus } }>(
    "/org/tasks/:id/status",
    async (request, reply) =>
      orgReply(reply, () =>
        setTaskStatus(
          ownerOf(request),
          request.params.id,
          request.body?.status ?? ("" as TaskStatus),
        ),
      ),
  );

  app.delete<Id>("/org/tasks/:id", async (request, reply) =>
    orgReply(reply, () => deleteTask(ownerOf(request), request.params.id)),
  );

  /** Board-side checkout, e.g. to hand a task to an agent by hand. */
  app.post<Id & { Body: { agentId?: string; runId?: string } }>(
    "/org/tasks/:id/checkout",
    async (request, reply) =>
      orgReply(reply, () => {
        const agentId = request.body?.agentId;
        if (!agentId) throw new OrgError(400, "invalid", "agentId is required.");
        return checkoutTask(
          ownerOf(request),
          request.params.id,
          agentId,
          request.body?.runId ?? `manual:${Date.now()}`,
        );
      }),
  );

  /** Board force-release of a stale hold. */
  app.post<Id>("/org/tasks/:id/release", async (request, reply) =>
    orgReply(reply, () => releaseTask(ownerOf(request), request.params.id, null)),
  );

  app.get<Id>("/org/tasks/:id/comments", async (request, reply) =>
    orgReply(reply, () => ({ comments: listComments(ownerOf(request), request.params.id) })),
  );

  // Members comment as themselves; their comments never act as the board.
  app.post<Id & { Body: { body?: string } }>(
    "/org/tasks/:id/comments",
    { config: { memberWrite: "comment" } },
    async (request, reply) =>
      orgReply(
        reply,
        () => addComment(ownerOf(request), request.params.id, request.body?.body, actorOf(request)),
        201,
      ),
  );

  /** Which model this agent should run on, from its runs and their replays. */
  app.get<Id>("/org/agents/:id/models", async (request, reply) =>
    orgReply(reply, () => modelScorecard(ownerOf(request), request.params.id)),
  );

  app.get<Id>("/org/agents/:id/performance", async (request, reply) =>
    orgReply(reply, () => agentRecord(ownerOf(request), request.params.id)),
  );

  app.post<Id>("/org/agents/:id/review", async (request, reply) =>
    orgReply(reply, () => reviewAgent(ownerOf(request), request.params.id)),
  );

  /** Forget the commands this agent was allowed to run; the next run asks again. */
  app.post<Id>("/org/agents/:id/forget-commands", async (request, reply) =>
    orgReply(reply, () => {
      const owner = ownerOf(request);
      getAgent(owner, request.params.id);
      return { forgotten: revokeGrants(owner, request.params.id) };
    }),
  );

  // ── Runs ───────────────────────────────────────────────────────────────────
  /** Wake an agent now. With a taskId the run works that task. */
  app.post<Id & { Body: { taskId?: string; reason?: string; source?: WakeSource } }>(
    "/org/agents/:id/wake",
    async (request, reply) =>
      orgReply(
        reply,
        () =>
          enqueueWake(ownerOf(request), request.params.id, {
            source:
              request.body?.source && WAKE_SOURCES.includes(request.body.source)
                ? request.body.source
                : "manual",
            reason: request.body?.reason ?? "Started by you",
            taskId: request.body?.taskId ?? null,
          }),
        202,
      ),
  );

  app.get<Id & { Querystring: { agent?: string; task?: string; limit?: string } }>(
    "/org/companies/:id/runs",
    async (request, reply) =>
      orgReply(reply, () => ({
        runs: listRuns(ownerOf(request), request.params.id, {
          agentId: request.query.agent,
          taskId: request.query.task,
          limit: Number(request.query.limit ?? 50) || 50,
        }).map(
          ({ log: _log, steps: _steps, output: _output, prompt: _prompt, ...summary }) => summary,
        ),
      })),
  );

  // The prompt stays server-side: it carries the owner's recalled memory, which a workspace member must not read.
  app.get<Id>("/org/runs/:id", async (request, reply) =>
    orgReply(reply, () => {
      const { prompt, ...run } = getRun(ownerOf(request), request.params.id);
      return { ...run, replayable: !!prompt };
    }),
  );

  app.post<Id & { Body: { agentIds?: unknown } & DiscussionOptions }>(
    "/org/tasks/:id/discuss",
    async (request, reply) =>
      orgReply(
        reply,
        () => {
          const { done: _done, ...started } = startDiscussion(
            ownerOf(request),
            request.params.id,
            request.body?.agentIds,
            request.body ?? {},
          );
          return started;
        },
        202,
      ),
  );

  app.post<Id & { Body: { model?: unknown } }>("/org/runs/:id/replay", async (request, reply) =>
    orgReply(reply, () => {
      const model = String(request.body?.model ?? "").trim();
      if (!model) throw new OrgError(400, "invalid", "Pick a model to replay on.");
      return replayRun(ownerOf(request), request.params.id, model);
    }),
  );

  app.post<Id & { Body: { model?: unknown } }>("/org/tasks/:id/replay", async (request, reply) =>
    orgReply(reply, () => {
      const model = String(request.body?.model ?? "").trim();
      if (!model) throw new OrgError(400, "invalid", "Pick a model to replay on.");
      return replayTask(ownerOf(request), request.params.id, model);
    }),
  );

  app.post<Id>("/org/runs/:id/cancel", async (request, reply) =>
    orgReply(reply, () => cancelRun(ownerOf(request), request.params.id)),
  );
}
