// SPDX-License-Identifier: Apache-2.0
/**
 * Per-request user context (AsyncLocalStorage).
 *
 * The LLM response cache must key by user so one user's cached response can
 * never be served to another. The cache wrapper lives at the driver level
 * (lib/llm-cache-driver.ts), far from any request object — this module is the
 * seam: a preHandler in server.ts runs every /api (and /api/v1) request inside
 * `userContext.run({ userId }, done)`, and the cache reads the current user
 * from here at call time. Calls outside any HTTP request (worker handlers)
 * read `null` and land in the shared "anon" bucket, keyed additionally by the
 * full prompt — content-identical only, never cross-user data.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface UserContext {
  userId: string | null;
}

export const userContext = new AsyncLocalStorage<UserContext>();

/** Current request's resolved user id, or null outside a request context. */
export function getCacheUserId(): string | null {
  return userContext.getStore()?.userId ?? null;
}
