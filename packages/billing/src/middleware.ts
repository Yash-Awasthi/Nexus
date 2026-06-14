// SPDX-License-Identifier: Apache-2.0
/**
 * Fastify quota middleware.
 *
 * Wires API key lookup + QuotaChecker into a Fastify preHandler hook.
 * Mount via:
 *
 *   app.addHook("preHandler", billingPreHandler);
 *
 * The resolved ApiKey is attached to request.billingKey so route handlers
 * can access plan info without re-querying.
 *
 * Requests without an Authorization: Bearer <key> header receive 401.
 * Quota-exceeded requests receive 429 with a JSON error body.
 */

import type { ApiKey } from "@nexus/db/schema";
import type { FastifyRequest, FastifyReply } from "fastify";

import { lookupApiKey } from "./api-keys.js";
import { QuotaChecker } from "./quota.js";

// Extend Fastify's request type so TypeScript knows about billingKey
declare module "fastify" {
  interface FastifyRequest {
    billingKey?: ApiKey;
  }
}

const quotaChecker = new QuotaChecker();

export async function billingPreHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Extract Bearer token
  const authHeader = request.headers["authorization"] ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
  if (!match?.[1]) {
    await reply.code(401).send({ error: "Missing or malformed Authorization header" });
    return;
  }

  const rawKey = match[1];
  const apiKey = await lookupApiKey(rawKey);

  if (!apiKey) {
    await reply.code(401).send({ error: "Invalid or revoked API key" });
    return;
  }

  // Quota check
  const quotaResult = await quotaChecker.check(apiKey);
  if (!quotaResult.allowed) {
    const message =
      quotaResult.reason === "rpm_limit_exceeded"
        ? "Rate limit exceeded — retry after 1 minute"
        : "Monthly quota exceeded — upgrade your plan";

    await reply.code(429).send({
      error: quotaResult.reason,
      message,
      ...(quotaResult.monthlyUsage !== undefined
        ? {
            monthlyUsage: quotaResult.monthlyUsage,
            monthlyRemaining: quotaResult.monthlyRemaining,
          }
        : {}),
    });
    return;
  }

  // Attach key to request for downstream use
  request.billingKey = apiKey;

  // Record usage asynchronously — don't block the request
  quotaChecker.recordUsage(apiKey.id, request.url).catch((err: unknown) => {
    request.log.error({ err, apiKeyId: apiKey.id }, "billing: failed to record usage event");
  });
}
