// SPDX-License-Identifier: Apache-2.0
/**
 * Bearer token authentication for @nexus/api.
 *
 * Delegates to @nexus/auth which uses constant-time comparison (timingSafeEqual)
 * to prevent timing-based API key brute-force attacks.
 *
 * When NEXUS_API_KEY is unset auth is bypassed (dev mode).
 * Register as a Fastify preHandler hook on protected route groups.
 */

import { authenticate, AuthError } from "@nexus/auth";
import type { FastifyRequest, FastifyReply } from "fastify";

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Read env dynamically so tests can mutate NEXUS_API_KEY after module load
  const authConfig = {
    apiKey: process.env.NEXUS_API_KEY || undefined,
    disabled: !process.env.NEXUS_API_KEY,
  };
  try {
    authenticate(request.headers.authorization, authConfig);
  } catch (err) {
    if (err instanceof AuthError) {
      await reply.code(err.httpStatus).send({ code: err.code, message: err.message });
      return;
    }
    await reply.code(500).send({ code: "INTERNAL_ERROR", message: "Auth check failed" });
  }
}
