// SPDX-License-Identifier: Apache-2.0
/**
 * Model Gateway routes
 *
 * POST /api/v1/gateway/messages  — Anthropic Messages-compatible proxy
 * GET  /api/v1/gateway/models    — list available model aliases
 *
 * The gateway translates Anthropic-format requests to the configured
 * OpenAI-compatible backend (Groq by default) and returns responses
 * in Anthropic format.
 *
 * Provider selection precedence:
 *   1. x-nexus-provider header  (explicit override)
 *   2. Model alias table        (nexus/*, claude-* etc.)
 *   3. Default provider         (groq)
 */

import {
  routeMessage,
  BUILTIN_ALIASES,
  type AnthropicRequest,
  type GatewayConfig,
  type GatewayError,
} from "@nexus/gateway";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Config factory (reads env at request time so tests can mutate env) ────────

function buildGatewayConfig(): GatewayConfig {
  return {
    providers: {
      ...(process.env.GROQ_API_KEY && {
        groq: { apiKey: process.env.GROQ_API_KEY },
      }),
      ...(process.env.OPENAI_API_KEY && {
        openai: { apiKey: process.env.OPENAI_API_KEY },
      }),
      ...(process.env.LOCAL_LLM_URL && {
        local: {
          apiKey: process.env.LOCAL_LLM_API_KEY ?? "local",
          baseUrl: process.env.LOCAL_LLM_URL,
        },
      }),
    },
  };
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function gatewayRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /gateway/messages
   *
   * Drop-in replacement for POST https://api.anthropic.com/v1/messages.
   * Streams are not yet supported — stream:true is silently ignored and
   * a regular JSON response is returned.
   */
  app.post<{
    Headers: { "x-nexus-provider"?: string };
    Body: AnthropicRequest;
  }>("/gateway/messages", { preHandler: requireAuth }, async (request, reply) => {
    const overrideProvider = request.headers["x-nexus-provider"];
    const config = buildGatewayConfig();

    try {
      const response = await routeMessage(
        request.body,
        config,
        overrideProvider,
      );
      return reply.code(200).send(response);
    } catch (err) {
      const gwErr = err as GatewayError;
      if (gwErr.statusCode) {
        return reply.code(gwErr.statusCode).send({
          type: "error",
          error: { type: gwErr.code, message: gwErr.message },
        });
      }
      throw err;
    }
  });

  /**
   * GET /gateway/models
   *
   * Returns the list of supported model aliases and their backend targets.
   */
  app.get("/gateway/models", { preHandler: requireAuth }, async (_request, reply) => {
    const models = Object.entries(BUILTIN_ALIASES).map(([alias, target]) => ({
      id: alias,
      provider: target.provider,
      backend_model: target.model,
    }));
    return reply.send({ models });
  });
}
