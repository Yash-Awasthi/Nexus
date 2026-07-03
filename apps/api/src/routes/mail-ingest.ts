// SPDX-License-Identifier: Apache-2.0
/**
 * Mail ingest routes — powered by @nexus/mail-ingest.
 *
 * Gates behind IMAP_HOST env var. When not configured, all routes return 503
 * with a clear message rather than erroring out.
 *
 * IMAP_HOST + IMAP_USER + IMAP_PASSWORD — connect to any IMAP server.
 * IMAP_PORT (default: 993), IMAP_TLS (default: "true").
 *
 * GET  /mail-ingest/status    — ingestor state + connection info
 * POST /mail-ingest/start     — start polling for new emails
 * POST /mail-ingest/stop      — stop polling
 * POST /mail-ingest/poll      — one-shot poll (fetch unseen without continuous loop)
 * GET  /mail-ingest/messages  — list recently ingested messages (in-memory, last 100)
 * DELETE /mail-ingest/messages — clear the ingested message buffer
 *
 * Wire a real IImapClient (imapflow / node-imap) by implementing IImapClient and
 * passing it to MailIngestor. The StubImapClient is used when no IMAP config present.
 */

import {
  MailIngestor,
  StubImapClient,
  type ParsedEmail,
  type IImapClient,
  type ImapMessage,
} from "@nexus/mail-ingest";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── IMAP client factory ───────────────────────────────────────────────────────

const IMAP_CONFIGURED = !!(
  process.env.IMAP_HOST &&
  process.env.IMAP_USER &&
  process.env.IMAP_PASSWORD
);

/**
 * Build a real or stub IMAP client.
 *
 * When IMAP_* env vars are set, attempts a dynamic import of imapflow.
 * Falls back to StubImapClient with a warning if imapflow is not installed.
 * This keeps the package dependency optional — install imapflow to enable real IMAP.
 */
async function buildImapClient(): Promise<IImapClient> {
  if (!IMAP_CONFIGURED) {
    return new StubImapClient({
      messages: [],
      connectError: "IMAP not configured (set IMAP_HOST, IMAP_USER, IMAP_PASSWORD)",
    });
  }

  // Try to use imapflow if installed (optional dep)
  try {
    const { ImapFlow } = await import("imapflow" as string);
    const host = process.env.IMAP_HOST!;
    const port = parseInt(process.env.IMAP_PORT ?? "993", 10);
    const tls = process.env.IMAP_TLS !== "false";

    // Minimal IImapClient adapter over imapflow
    return {
      async connect() {
        // ImapFlow connects lazily on first operation; no-op here
      },
      async disconnect() {
        // No persistent connection to close in this lightweight adapter
      },
      async fetchUnseen(mailbox = "INBOX"): Promise<ImapMessage[]> {
        const client = new ImapFlow({
          host,
          port,
          secure: tls,
          auth: { user: process.env.IMAP_USER!, pass: process.env.IMAP_PASSWORD! },
          logger: false,
        });
        await client.connect();
        const messages: ImapMessage[] = [];
        await client.mailboxOpen(mailbox);
        for await (const msg of client.fetch("1:*", { uid: true, envelope: true, source: true })) {
          if (!msg.flags.has("\\Seen")) {
            messages.push({
              uid: msg.uid,
              raw: msg.source.toString("utf8"),
            });
          }
        }
        await client.logout();
        return messages;
      },
      async markSeen(uids: number[], mailbox = "INBOX"): Promise<void> {
        const client = new ImapFlow({
          host,
          port,
          secure: tls,
          auth: { user: process.env.IMAP_USER!, pass: process.env.IMAP_PASSWORD! },
          logger: false,
        });
        await client.connect();
        await client.mailboxOpen(mailbox);
        await client.messageFlagsAdd({ uid: true, source: uids as unknown as string }, ["\\Seen"]);
        await client.logout();
      },
    };
  } catch {
    // imapflow not installed — use stub with a warning
    process.emitWarning(
      "imapflow not installed — IMAP ingest is using StubImapClient. Run: pnpm add imapflow",
      "NexusMailIngest",
    );
    return new StubImapClient({ messages: [] });
  }
}

// ── Ingestor singleton ────────────────────────────────────────────────────────

const _inbox: ParsedEmail[] = [];
const MAX_INBOX = 100;

let _ingestor: MailIngestor | null = null;
let _running = false;
let _lastPoll: string | null = null;
let _totalIngested = 0;

async function getIngestor(): Promise<MailIngestor> {
  if (!_ingestor) {
    const imap = await buildImapClient();
    _ingestor = new MailIngestor({
      imap,
      handler: async (email) => {
        if (_inbox.length >= MAX_INBOX) _inbox.shift();
        _inbox.push(email);
        _totalIngested++;
        _lastPoll = new Date().toISOString();
      },
    });
  }
  return _ingestor;
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function mailIngestRoutes(app: FastifyInstance): Promise<void> {
  /** GET /mail-ingest/status */
  app.get("/mail-ingest/status", { preHandler: requireAuth }, async (_req, reply) => {
    return reply.send({
      configured: IMAP_CONFIGURED,
      running: _running,
      lastPoll: _lastPoll,
      totalIngested: _totalIngested,
      inboxSize: _inbox.length,
      server: IMAP_CONFIGURED
        ? { host: process.env.IMAP_HOST, port: process.env.IMAP_PORT ?? "993" }
        : null,
      note: IMAP_CONFIGURED
        ? null
        : "Set IMAP_HOST, IMAP_USER, IMAP_PASSWORD to enable real mail ingestion.",
    });
  });

  /** POST /mail-ingest/start */
  app.post("/mail-ingest/start", { preHandler: requireAuth }, async (_req, reply) => {
    if (_running) return reply.send({ ok: true, message: "Already running" });
    const ingestor = await getIngestor();
    await ingestor.start();
    _running = true;
    return reply.send({ ok: true, message: "Mail ingestor started" });
  });

  /** POST /mail-ingest/stop */
  app.post("/mail-ingest/stop", { preHandler: requireAuth }, async (_req, reply) => {
    if (!_running || !_ingestor) return reply.send({ ok: true, message: "Not running" });
    await _ingestor.stop();
    _running = false;
    return reply.send({ ok: true, message: "Mail ingestor stopped" });
  });

  /**
   * POST /mail-ingest/poll — one-shot fetch without starting continuous loop.
   * Useful for on-demand sync from a UI trigger.
   */
  app.post("/mail-ingest/poll", { preHandler: requireAuth }, async (_req, reply) => {
    if (!IMAP_CONFIGURED) {
      return reply.code(503).send({
        error: "not_configured",
        message: "Set IMAP_HOST, IMAP_USER, IMAP_PASSWORD to enable IMAP ingestion.",
      });
    }
    try {
      const ingestor = await getIngestor();
      await ingestor.poll();
      return reply.send({ ok: true, totalIngested: _totalIngested, lastPoll: _lastPoll });
    } catch (err) {
      return reply.code(502).send({ error: "poll_failed", message: String(err) });
    }
  });

  /** GET /mail-ingest/messages?limit=20 */
  app.get<{ Querystring: { limit?: string } }>(
    "/mail-ingest/messages",
    { preHandler: requireAuth },
    async (request, reply) => {
      const limit = Math.min(parseInt(request.query.limit ?? "20", 10) || 20, 100);
      const messages = _inbox
        .slice(-limit)
        .reverse()
        .map((m) => ({
          id: m.id,
          from: m.from,
          to: m.to,
          subject: m.subject,
          date: m.date,
          hasAttachments: m.attachments.length > 0,
          bodyPreview: m.bodyText.slice(0, 200),
        }));
      return reply.send({ messages, total: _inbox.length });
    },
  );

  /** DELETE /mail-ingest/messages — clear buffer */
  app.delete("/mail-ingest/messages", { preHandler: requireAuth }, async (_req, reply) => {
    const cleared = _inbox.length;
    _inbox.length = 0;
    return reply.send({ ok: true, cleared });
  });
}
