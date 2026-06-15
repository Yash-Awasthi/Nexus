// SPDX-License-Identifier: Apache-2.0
import { db } from "@nexus/db";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async (_req, reply) => {
    // Health liveness: must always reflect current state — no caching.
    reply.header("Cache-Control", "no-cache");
    return reply.code(200).send({
      status: "ok",
      version: process.env.npm_package_version ?? "0.1.0",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/health/ready", async (_req, reply) => {
    // Readiness check must not be cached — K8s kubelet polls this.
    reply.header("Cache-Control", "no-cache, no-store");
    const checks: Record<string, string> = {};
    let ok = true;

    // DB check
    try {
      await db.execute(sql`SELECT 1`);
      checks.db = "ok";
    } catch (err) {
      checks.db = `error: ${err instanceof Error ? err.message : String(err)}`;
      ok = false;
    }

    const status = ok ? 200 : 503;
    return reply.code(status).send({ status: ok ? "ready" : "not_ready", checks });
  });
}
