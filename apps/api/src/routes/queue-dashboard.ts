// SPDX-License-Identifier: Apache-2.0
/**
 * Bull Board at /admin/queues: the BullMQ dashboard, served by the API itself.
 *
 * Mounted only when REDIS_URL and NEXUS_QUEUE_DASHBOARD_PASSWORD are both set. The
 * dashboard is a browser page, which cannot send the API's bearer tokens, so it sits
 * behind HTTP Basic auth (user "admin") instead.
 */
import { timingSafeEqual } from "node:crypto";

import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { FastifyAdapter } from "@bull-board/fastify";
import { Queue } from "bullmq";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { parseRedisUrl } from "../lib/agent-queue.ts";

const BASE_PATH = "/admin/queues";
const QUEUE_NAMES = ["nexus-high", "nexus-medium", "nexus-low", "nexus-dlq"];

/** True when `header` is HTTP Basic credentials for admin:`password`. */
export function basicAuthMatches(header: string | undefined, password: string): boolean {
  if (!header?.startsWith("Basic ")) return false;
  const given = Buffer.from(header.slice(6), "base64");
  const expected = Buffer.from(`admin:${password}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function queueDashboardRoutes(app: FastifyInstance): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  const password = process.env.NEXUS_QUEUE_DASHBOARD_PASSWORD;
  if (!redisUrl || !password) return;

  const connection = parseRedisUrl(redisUrl);
  const queues = QUEUE_NAMES.map((name) => new Queue(name, { connection }));
  const serverAdapter = new FastifyAdapter();
  serverAdapter.setBasePath(BASE_PATH);
  createBullBoard({ queues: queues.map((q) => new BullMQAdapter(q)), serverAdapter });

  await app.register(async (scope) => {
    scope.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
      if (basicAuthMatches(request.headers.authorization, password)) return;
      await reply
        .code(401)
        .header("WWW-Authenticate", 'Basic realm="nexus-queues"')
        .send({ error: "unauthorized" });
    });
    await scope.register(serverAdapter.registerPlugin(), { prefix: BASE_PATH });
  });
  app.addHook("onClose", async () => {
    await Promise.all(queues.map((q) => q.close()));
  });
}
