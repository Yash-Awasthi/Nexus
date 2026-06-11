// SPDX-License-Identifier: Apache-2.0
import type { FastifyInstance } from "fastify";
import { db } from "@nexus/db";
import { sql } from "drizzle-orm";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async (_req, reply) => {
    return reply.code(200).send({
      status: "ok",
      version: process.env["npm_package_version"] ?? "0.1.0",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/health/ready", async (_req, reply) => {
    const checks: Record<string, string> = {};
    let ok = true;

    // DB check
    try {
      await db.execute(sql`SELECT 1`);
      checks["db"] = "ok";
    } catch (err) {
      checks["db"] = `error: ${err instanceof Error ? err.message : String(err)}`;
      ok = false;
    }

    const status = ok ? 200 : 503;
    return reply.code(status).send({ status: ok ? "ready" : "not_ready", checks });
  });
}
