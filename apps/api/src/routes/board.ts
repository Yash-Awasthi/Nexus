// SPDX-License-Identifier: Apache-2.0
/**
 * Board bridge — exposes the local Go orchestrator (`services/board`) through
 * the Nexus API: health, task listing, and task creation.
 */

import type { FastifyInstance } from "fastify";

import { boardConfig, checkHealth, createTask, listTasks } from "../lib/board-client.ts";

interface CreateTaskBody {
  thread?: string;
  title?: string;
  contract?: string;
  caps?: string;
  id?: string;
  depends?: string;
}

interface TaskQuery {
  thread?: string;
  state?: string;
}

export async function boardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/board/status", async () => {
    const health = await checkHealth();
    const config = boardConfig();
    return {
      boardConnected: health.ok,
      boardUrl: config.url,
      channel: config.channel,
      ...(health.version ? { version: health.version } : {}),
      ...(health.error ? { error: health.error } : {}),
    };
  });

  app.get<{ Querystring: TaskQuery }>("/board/tasks", async (request) => ({
    tasks: await listTasks(request.query.thread, request.query.state),
  }));

  app.post<{ Body: CreateTaskBody }>("/board/tasks", async (request, reply) => {
    const body = request.body ?? {};
    if (!body.thread || !body.title) {
      return reply.code(400).send({ error: "thread and title are required" });
    }
    const created = await createTask({
      thread: body.thread,
      title: body.title,
      contract: body.contract,
      caps: body.caps,
      id: body.id,
      depends: body.depends,
    });
    if (!created.ok) {
      return reply.code(502).send({ ok: false, error: created.error ?? "board unavailable" });
    }
    return reply.code(201).send({ ok: true, id: created.id, task: created.task });
  });
}
