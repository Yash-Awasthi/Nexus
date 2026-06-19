// SPDX-License-Identifier: Apache-2.0
/**
 * Brief routes — intelligence brief builder via @nexus/brief-engine.
 *
 * GET    /api/v1/brief/:domain                      — render the current brief for a domain
 * POST   /api/v1/brief/:domain/events               — push events and rebuild
 * GET    /api/v1/brief/:domain/share/:digest        — verify share URL and return HTML brief
 *
 * Backing store:
 *   PgDigestStore  — when DATABASE_URL is set
 *   DigestStore    — in-memory fallback
 *
 * Signing:
 *   BriefSigner uses BRIEF_SIGNING_KEY env var (falls back to "dev-key").
 */

import {
  BriefEngine,
  BriefSigner,
  DigestStore,
  PgDigestStore,
  type DigestEvent,
} from "@nexus/brief-engine";
import type { FastifyInstance } from "fastify";

import { makeRateLimitPreHandler } from "../lib/rate-limiter.js";
import { requireAuth } from "../middleware/auth.js";

// ── Singleton engine ──────────────────────────────────────────────────────────

const digestStore: DigestStore | PgDigestStore = process.env.DATABASE_URL
  ? new PgDigestStore(process.env.DATABASE_URL)
  : new DigestStore();

const engine = new BriefEngine({
  baseUrl: process.env.NEXUS_API_URL ?? "http://localhost:3000",
  hmacSecret: process.env.BRIEF_SIGNING_KEY,
  store: digestStore instanceof DigestStore ? digestStore : undefined,
});

const signer = new BriefSigner(process.env.BRIEF_SIGNING_KEY);

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function briefRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /brief/:domain
   *
   * Render the most-recent brief for the authenticated user + domain.
   * Returns { html, sections[], totalEvents, shareUrl, generatedAt } or 404
   * when no digest has been pushed yet.
   *
   * Query:
   *   date — YYYY-MM-DD (default: today UTC)
   */
  app.get<{
    Params: { domain: string };
    Querystring: { date?: string; userId?: string };
  }>(
    "/brief/:domain",
    {
      preHandler: [
        requireAuth,
        makeRateLimitPreHandler({ limit: 60, windowMs: 60_000, keyPrefix: "brief-get" }),
      ],
    },
    async (request, reply) => {
      const { domain } = request.params;
      const date = request.query.date ?? new Date().toISOString().slice(0, 10);
      const userId = request.query.userId ?? "default";

      const result = engine.buildBrief(userId, date);
      if (!result) {
        return reply.code(404).send({
          error: "No brief found — push events first via POST /brief/:domain/events",
          domain,
          date,
        });
      }

      return reply.send({
        domain,
        userId,
        date,
        html: result.html,
        sections: result.sections,
        totalEvents: result.totalEvents,
        shareUrl: result.shareUrl,
        generatedAt: result.generatedAt,
      });
    },
  );

  /**
   * POST /brief/:domain/events
   *
   * Push a batch of events for a domain and rebuild the brief.
   * Returns the freshly built BriefResult.
   *
   * Body: { events: DigestEvent[], userId?, date? }
   */
  app.post<{
    Params: { domain: string };
    Body: {
      events: DigestEvent[];
      userId?: string;
      date?: string;
    };
  }>(
    "/brief/:domain/events",
    {
      preHandler: [
        requireAuth,
        makeRateLimitPreHandler({ limit: 30, windowMs: 60_000, keyPrefix: "brief-events" }),
      ],
    },
    async (request, reply) => {
      const { domain } = request.params;
      const {
        events,
        userId = "default",
        date = new Date().toISOString().slice(0, 10),
      } = request.body;

      // Stamp every event with this domain if not already set
      const stamped: DigestEvent[] = events.map((e) => ({
        ...e,
        domain: e.domain ?? domain,
        timestamp: e.timestamp ?? new Date().toISOString(),
      }));

      const result = engine.buildFromEvents(userId, date, stamped);

      return reply.code(201).send({
        domain,
        userId,
        date,
        html: result.html,
        sections: result.sections,
        totalEvents: result.totalEvents,
        shareUrl: result.shareUrl,
        generatedAt: result.generatedAt,
      });
    },
  );

  /**
   * GET /brief/:domain/share/:digest
   *
   * Public share endpoint — verifies the HMAC signature embedded in the URL
   * and returns the rendered HTML brief on success.
   *
   * The full signed URL is expected as the `url` query param so that signer
   * can re-derive the expected HMAC from userId + date.
   *
   * Query: url=<full-signed-share-url>
   */
  app.get<{
    Params: { domain: string; digest: string };
    Querystring: { url?: string; userId?: string; date?: string; sig?: string };
  }>(
    "/brief/:domain/share/:digest",
    {
      preHandler: makeRateLimitPreHandler({
        limit: 30,
        windowMs: 60_000,
        keyPrefix: "brief-share",
      }),
    },
    async (request, reply) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { userId, date, sig, url } = request.query;

      // Reconstruct the full URL to pass to signer.verify()
      const fullUrl =
        url ??
        (request.hostname
          ? `${request.protocol ?? "https"}://${request.hostname}${request.url}`
          : "");

      const { valid, userId: verifiedUserId, date: verifiedDate } = signer.verify(fullUrl);

      if (!valid) {
        return reply.code(403).send({ error: "Invalid or expired share signature" });
      }

      const uid = verifiedUserId ?? userId ?? "default";
      const d = verifiedDate ?? date ?? new Date().toISOString().slice(0, 10);

      const result = engine.buildBrief(uid, d);
      if (!result) {
        return reply.code(404).send({ error: "Brief not found for the given user and date" });
      }

      return reply.header("Content-Type", "text/html; charset=utf-8").send(result.html);
    },
  );
}
