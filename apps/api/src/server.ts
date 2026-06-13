// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/api — Fastify server factory
 *
 * Creates and configures a Fastify instance with:
 *  - Helmet (security headers)
 *  - CORS
 *  - Sensible error defaults
 *  - All API route groups mounted under /api/v1
 */

import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";

import { auditRoutes } from "./routes/audit.js";
import { councilRoutes } from "./routes/council.js";
import { gatewayRoutes } from "./routes/gateway.js";
import { governanceRoutes } from "./routes/governance.js";
import { healthRoutes } from "./routes/health.js";
import { ingestRoutes } from "./routes/ingest.js";
import { runtimeRoutes } from "./routes/runtime.js";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      transport:
        process.env.NODE_ENV === "development"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    },
  });

  // ── Plugins ───────────────────────────────────────────────────────────────
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: process.env.ALLOWED_ORIGINS?.split(",") ?? true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(sensible);

  // ── Health (no prefix — /health, /health/ready) ───────────────────────────
  await app.register(healthRoutes);

  // ── API v1 routes ─────────────────────────────────────────────────────────
  await app.register(
    async (api) => {
      await api.register(ingestRoutes);
      await api.register(councilRoutes);
      await api.register(runtimeRoutes);
      await api.register(governanceRoutes);
      await api.register(auditRoutes);
      await api.register(gatewayRoutes);
    },
    { prefix: "/api/v1" },
  );

  // ── Global error handler ──────────────────────────────────────────────────
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    app.log.error(error);
    const statusCode = error.statusCode ?? 500;
    reply.code(statusCode).send({
      error: statusCode >= 500 ? "Internal Server Error" : error.message,
      statusCode,
    });
  });

  return app;
}
