// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/billing — API key management, quota enforcement, BYOK usage cost model.
 *
 * API key management
 * ------------------
 *   createApiKey       — generate a new hashed key pair
 *   lookupApiKey       — verify and retrieve a key by raw value
 *   revokeApiKey       — invalidate a key
 *   listApiKeys        — list all keys for an owner
 *
 * Quota
 * -----
 *   QuotaChecker       — monthly quota + RPM enforcement
 *   billingPreHandler  — Fastify preHandler hook (auth + quota)
 *
 * Cost
 * ----
 *   computeCost / estimateMaxCost — USD cost of a call from provider-registry
 *   BillingLedger                 — estimate → reserve → settle spend tracking
 *
 * Nexus is free and open: there is no payment provider. These primitives meter
 * usage of the user's own BYOK keys; they never charge anyone to use Nexus.
 */

export {
  createApiKey,
  lookupApiKey,
  revokeApiKey,
  listApiKeys,
  generateRawKey,
  hashKey,
} from "./api-keys.js";
export type { CreateApiKeyInput, CreateApiKeyResult } from "./api-keys.js";

export { QuotaChecker } from "./quota.js";
export type { QuotaCheckResult, UsageDetail } from "./quota.js";

export { computeCost, estimateMaxCost, BillingLedger, QuotaExceededError } from "./cost.js";
export type { TokenUsage, CostBreakdown, Reservation, SettleResult } from "./cost.js";

export { billingPreHandler } from "./middleware.js";
