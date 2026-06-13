// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/billing — API key management, quota enforcement, Stripe webhook handler.
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
 * Stripe
 * ------
 *   StripeWebhookProcessor   — verify signature, deduplicate, dispatch
 *   verifyStripeSignature    — standalone HMAC-SHA256 verification
 *   StripeSignatureError     — thrown on invalid signatures
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
export type { QuotaCheckResult } from "./quota.js";

export { billingPreHandler } from "./middleware.js";

export {
  StripeWebhookProcessor,
  verifyStripeSignature,
  StripeSignatureError,
} from "./stripe-webhook.js";
export type {
  StripeEvent,
  StripeSubscriptionObject,
  WebhookProcessResult,
} from "./stripe-webhook.js";
