// SPDX-License-Identifier: Apache-2.0
/**
 * Notifications routes — the HTTP surface for the per-user notification store
 * (lib/notifications-store.ts). Backs the sidebar bell and the dashboard
 * Activity feed.
 *
 *   GET    /api/notifications?limit=N  → { notifications, unreadCount }
 *   GET    /api/notifications/count    → { unreadCount }
 *   POST   /api/notifications          → { type, title, message?, link? } → 201 notif
 *   POST   /api/notifications/bulk     → creates up to 50 at once
 *   POST   /api/notifications/:id/read → { ok }
 *   POST   /api/notifications/:id/dismiss → { ok }
 *   POST   /api/notifications/dismiss-all → { ok, dismissed }
 *   DELETE /api/notifications/:id      → 204 / 404
 *
 * Every route resolves the caller via requireAuthWithTier (JWT sub or
 * api_keys.user_id) so state is strictly per-user. All handlers are thin — the
 * store owns persistence; nothing here reaches into other route state.
 */

import type { FastifyInstance } from "fastify";

import { makeUserRateLimitPreHandler } from "../lib/rate-limiter.js";
import {
  createNotification,
  dismissAllNotifications,
  dismissNotification,
  getUnreadCount,
  listNotifications,
  markNotificationRead,
  userIdFor,
} from "../lib/notifications-store.js";
import { requireAuthWithTier } from "../middleware/auth.js";
import { openSseConnection } from "./sse.js";

const AUTH = { preHandler: requireAuthWithTier };

// Per-user limiter at connection establishment — connections are long-lived,
// the cap is on how often a user may open a new stream.
const notifStreamRL = makeUserRateLimitPreHandler({
  limit: 120,
  windowMs: 60_000,
  keyPrefix: "sse-notif",
});

export async function notificationsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /notifications/stream — live SSE. Emits `notification.new` events the
   * moment any creator (research done, autopilot runs, POST /notifications)
   * persists a notification for this user. Consumed by the UI via fetch+
   * reader (bearer header — browser EventSource cannot send one).
   */
  app.get(
    "/notifications/stream",
    { preHandler: [requireAuthWithTier, notifStreamRL] },
    async (request, reply): Promise<void> => {
      reply.hijack();
      openSseConnection(reply.raw, request.socket, [`notifications:${userIdFor(request.nexusUserId)}`]);
    },
  );
  /** GET /notifications?limit=N — full list, newest first. */
  app.get<{ Querystring: { limit?: string } }>("/notifications", AUTH, async (request, reply) => {
    const limit = Math.min(Math.max(parseInt(request.query.limit ?? "20", 10) || 20, 1), 100);
    return reply.send(await listNotifications(request.nexusUserId, limit));
  });

  /** GET /notifications/count — lightweight unread badge value. */
  app.get("/notifications/count", AUTH, async (request, reply) => {
    return reply.send({ unreadCount: await getUnreadCount(request.nexusUserId) });
  });

  /**
   * POST /notifications — create one. Used by internal event emitters
   * (research done, autopilot runs) and by integrations/tests.
   */
  app.post<{ Body: { type?: string; title: string; message?: string; link?: string } }>(
    "/notifications",
    {
      schema: {
        body: {
          type: "object",
          required: ["title"],
          properties: {
            type: { type: "string", maxLength: 64 },
            title: { type: "string", maxLength: 256 },
            message: { type: "string", maxLength: 1024 },
            link: { type: "string", maxLength: 512 },
          },
        },
      },
      ...AUTH,
    },
    async (request, reply) => {
      const { type, title, message, link } = request.body;
      const notif = await createNotification(request.nexusUserId, {
        type: type?.trim() || "system",
        title: title.trim(),
        message: message?.trim() || undefined,
        link: link?.trim() || undefined,
      });
      return reply.code(201).send(notif);
    },
  );

  /** POST /notifications/bulk — create multiple at once (≤ 50). */
  app.post<{
    Body: { notifications: Array<{ type?: string; title: string; message?: string; link?: string }> };
  }>(
    "/notifications/bulk",
    {
      schema: {
        body: {
          type: "object",
          required: ["notifications"],
          properties: {
            notifications: {
              type: "array",
              maxItems: 50,
              items: {
                type: "object",
                required: ["title"],
                properties: {
                  type: { type: "string" },
                  title: { type: "string" },
                  message: { type: "string" },
                  link: { type: "string" },
                },
              },
            },
          },
        },
      },
      ...AUTH,
    },
    async (request, reply) => {
      const created = [];
      for (const input of request.body.notifications) {
        created.push(
          await createNotification(request.nexusUserId, {
            type: input.type?.trim() || "system",
            title: input.title.trim(),
            message: input.message?.trim() || undefined,
            link: input.link?.trim() || undefined,
          }),
        );
      }
      return reply.code(201).send({ created: created.length, notifications: created });
    },
  );

  /** POST /notifications/:id/read — mark one as read. */
  app.post<{ Params: { id: string } }>("/notifications/:id/read", AUTH, async (request, reply) => {
    const ok = await markNotificationRead(request.nexusUserId, request.params.id);
    return reply.send({ ok });
  });

  /** POST /notifications/:id/dismiss — remove one from the tray. */
  app.post<{ Params: { id: string } }>(
    "/notifications/:id/dismiss",
    AUTH,
    async (request, reply) => {
      const ok = await dismissNotification(request.nexusUserId, request.params.id);
      return reply.send({ ok });
    },
  );

  /** POST /notifications/dismiss-all — clear the tray. */
  app.post("/notifications/dismiss-all", AUTH, async (request, reply) => {
    const dismissed = await dismissAllNotifications(request.nexusUserId);
    return reply.send({ ok: true, dismissed });
  });

  /** DELETE /notifications/:id — permanently remove one. */
  app.delete<{ Params: { id: string } }>("/notifications/:id", AUTH, async (request, reply) => {
    const ok = await dismissNotification(request.nexusUserId, request.params.id);
    if (!ok) return reply.code(404).send({ error: "not_found" });
    return reply.code(204).send();
  });
}
