// SPDX-License-Identifier: Apache-2.0
/**
 * Webhook subscriptions for long jobs — the HTTP surface over `lib/webhooks.ts`.
 *
 *   POST   /webhooks                        → 201 {id, url, events, secret}
 *   GET    /webhooks                        → { webhooks, deliveries? } for the caller
 *   GET    /webhooks/:id                    → one subscription and its last 50 attempts
 *   DELETE /webhooks/:id                    → 204; pending deliveries are cancelled
 *   POST   /webhooks/:id/test               → sends `webhook.test` now and reports the status
 *   POST   /webhooks/:id/deliveries/:deliveryId/retry → re-sends one attempt now
 *
 * Every route is owner-scoped through `PersistentStore.for()`, so one account cannot read,
 * delete or trigger another's endpoint, and a subscription id from another account answers
 * 404 rather than 403 — the existence of somebody else's webhook is not information this
 * surface gives away.
 *
 * The secret is returned on creation and by GET: the caller has to be able to verify
 * signatures, and it is their own signing key. It is never included in a list response, so
 * a screenshot of the settings page does not leak it.
 */
import type { FastifyInstance } from "fastify";

import { ownerIdFor } from "../lib/owner.ts";
import { makeUserRateLimitPreHandler } from "../lib/rate-limiter.ts";
import { fail } from "../lib/reply-errors.ts";
import {
  createSubscription,
  subscriptionsFor,
  deliveriesFor,
  deliverNow,
  WEBHOOK_EVENTS,
  type WebhookDelivery,
  type WebhookSubscription,
} from "../lib/webhooks.ts";
import { requireAuthWithTier } from "../middleware/auth.ts";

const AUTH = { preHandler: requireAuthWithTier };

/** Creating endpoints is cheap to abuse and each one costs an outbound POST. */
const createRL = makeUserRateLimitPreHandler({
  limit: 20,
  windowMs: 60_000,
  keyPrefix: "webhooks-create",
});

/** A test delivery is a request this server makes on the caller's behalf. */
const testRL = makeUserRateLimitPreHandler({
  limit: 10,
  windowMs: 60_000,
  keyPrefix: "webhooks-test",
});

/** The list a caller sees: no secret, so a list can be logged or screenshotted. */
function publicView(subscription: WebhookSubscription) {
  const { secret: _secret, ...rest } = subscription;
  return rest;
}

function deliveryView(delivery: WebhookDelivery) {
  return {
    id: delivery.id,
    event: delivery.event,
    status: delivery.status,
    attempts: delivery.attempts,
    createdAt: delivery.createdAt,
    nextAttemptAt: delivery.nextAttemptAt || null,
    lastStatusCode: delivery.lastStatusCode ?? null,
    lastError: delivery.lastError ?? null,
    deliveredAt: delivery.deliveredAt ?? null,
  };
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.get("/webhooks", AUTH, async (request) => {
    const store = subscriptionsFor(request);
    return {
      object: "list",
      events: WEBHOOK_EVENTS,
      webhooks: [...store.values()].map(publicView),
    };
  });

  app.post<{ Body: { url?: unknown; events?: unknown; description?: unknown } }>(
    "/webhooks",
    { preHandler: [requireAuthWithTier, createRL] },
    async (request, reply) => {
      const body = request.body ?? {};
      if (typeof body.url !== "string" || !body.url.trim()) {
        return fail(reply, 400, "invalid_request", { message: "url is required" });
      }
      const created = createSubscription(ownerIdFor(request), {
        url: body.url.trim(),
        events: body.events,
        description: body.description,
      });
      if (!created.ok) return fail(reply, 400, "invalid_request", { message: created.reason });
      return reply.code(201).send(created.subscription);
    },
  );

  app.get<{ Params: { id: string } }>("/webhooks/:id", AUTH, async (request, reply) => {
    const subscription = subscriptionsFor(request).get(request.params.id);
    if (!subscription) return fail(reply, 404, "not_found");
    return {
      ...subscription,
      deliveries: deliveriesFor(subscription.ownerId, subscription.id)
        .slice(0, 50)
        .map(deliveryView),
    };
  });

  app.delete<{ Params: { id: string } }>("/webhooks/:id", AUTH, async (request, reply) => {
    const store = subscriptionsFor(request);
    if (!store.has(request.params.id)) return fail(reply, 404, "not_found");
    store.delete(request.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>(
    "/webhooks/:id/test",
    { preHandler: [requireAuthWithTier, testRL] },
    async (request, reply) => {
      const subscription = subscriptionsFor(request).get(request.params.id);
      if (!subscription) return fail(reply, 404, "not_found");
      const delivery: WebhookDelivery = {
        id: `whdel_${Date.now().toString(36)}test`,
        subscriptionId: subscription.id,
        ownerId: subscription.ownerId,
        // A test is not a real job, but it is signed and shaped like one, which is the
        // only way a receiver can exercise its verification path before the first run.
        event: "webhook.test",
        payload: { test: true, message: "Nexus webhook test" },
        attempts: 0,
        status: "pending",
        nextAttemptAt: Date.now(),
        createdAt: Date.now(),
      };
      const sent = await deliverNow(delivery);
      return { delivery: deliveryView(sent), ok: sent.status === "delivered" };
    },
  );

  app.post<{ Params: { id: string; deliveryId: string } }>(
    "/webhooks/:id/deliveries/:deliveryId/retry",
    { preHandler: [requireAuthWithTier, testRL] },
    async (request, reply) => {
      const subscription = subscriptionsFor(request).get(request.params.id);
      if (!subscription) return fail(reply, 404, "not_found");
      const previous = deliveriesFor(subscription.ownerId, subscription.id).find(
        (delivery) => delivery.id === request.params.deliveryId,
      );
      if (!previous) return fail(reply, 404, "not_found");
      // A retry is a new attempt on the same delivery: the attempt counter goes up, so a
      // receiver can tell a replay from a first send, and the schedule continues from there.
      const sent = await deliverNow({ ...previous, nextAttemptAt: Date.now() });
      return { delivery: deliveryView(sent), ok: sent.status === "delivered" };
    },
  );
}
