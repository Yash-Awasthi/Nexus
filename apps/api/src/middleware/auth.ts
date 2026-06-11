// SPDX-License-Identifier: Apache-2.0
/**
 * Bearer token authentication for @nexus/api.
 *
 * Reads NEXUS_API_KEY from env.  If not set, auth is bypassed (dev mode).
 * Register as a Fastify preHandler hook on protected route groups.
 */

import type { FastifyRequest, FastifyReply } from "fastify";

const BEARER_PREFIX = "Bearer ";

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const expected = process.env.NEXUS_API_KEY;
  if (!expected) return; // auth disabled in dev

  const authHeader = request.headers.authorization ?? "";
  if (!authHeader.startsWith(BEARER_PREFIX)) {
    return reply.code(401).send({ error: "Missing Bearer token" });
  }

  const token = authHeader.slice(BEARER_PREFIX.length);
  if (token !== expected) {
    return reply.code(401).send({ error: "Invalid API key" });
  }
}
