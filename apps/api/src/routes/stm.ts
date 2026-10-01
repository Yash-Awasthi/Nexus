// SPDX-License-Identifier: Apache-2.0
/**
 * STM routes — Style Transformation Module pipeline.
 *
 * GET  /api/v1/stm/modules          — list registered modules + descriptions
 * POST /api/v1/stm/transform        — transform text through all (or named) modules
 * POST /api/v1/stm/transform/partial — transform with graceful skip on unknown ids
 * GET  /api/v1/stm/drift            — per-model style metrics over the caller's council answers
 */

import { createDefaultPipeline } from "@nexus/stm";
import type { FastifyInstance } from "fastify";

import { driftReport } from "../lib/answer-drift.js";
import { ANON_OWNER } from "../lib/owner.js";
import { requireAuth } from "../middleware/auth.js";

// Singleton pipeline (HedgeReducer + DirectnessOptimizer + TruncationGuard)
const pipeline = createDefaultPipeline();

export async function stmRoutes(app: FastifyInstance): Promise<void> {
  app.get("/stm/drift", { preHandler: requireAuth }, async (request, reply) =>
    reply.send({ models: driftReport(request.nexusUserId ?? ANON_OWNER) }),
  );

  /** GET /stm/modules — list registered modules */
  app.get(
    "/stm/modules",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (_req, reply) => {
      const modules = pipeline
        .getRegistry()
        .list()
        .map((m) => ({
          id: m.id,
          description: m.description,
        }));
      return reply.send({ modules, total: modules.length });
    },
  );

  /** POST /stm/transform — full transform (throws on unknown moduleId) */
  app.post<{
    Body: {
      text: string;
      moduleIds?: string[];
      maxChars?: number;
      context?: { sessionId?: string; userId?: string; locale?: string };
    };
  }>("/stm/transform", { preHandler: requireAuth }, async (request, reply) => {
    try {
      const result = pipeline.transform({
        text: request.body.text,
        moduleIds: request.body.moduleIds,
        maxChars: request.body.maxChars,
        context: request.body.context,
      });
      return reply.send(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }
  });

  /** POST /stm/transform/partial — skips unknown moduleIds silently */
  app.post<{
    Body: {
      text: string;
      moduleIds?: string[];
      maxChars?: number;
      context?: { sessionId?: string; userId?: string; locale?: string };
    };
  }>(
    "/stm/transform/partial",
    {
      preHandler: requireAuth,
      schema: {
        body: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
      },
    },
    async (request, reply) => {
      const result = pipeline.transformPartial({
        text: request.body.text,
        moduleIds: request.body.moduleIds,
        maxChars: request.body.maxChars,
        context: request.body.context,
      });
      return reply.send(result);
    },
  );
}
