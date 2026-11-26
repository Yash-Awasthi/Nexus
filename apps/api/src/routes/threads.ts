// SPDX-License-Identifier: Apache-2.0
/**
 * Threads routes — the HTTP surface for the per-user deliberation thread store
 * (lib/threads-store.ts). Backs the dashboard "Recent Deliberations" card, the
 * chat sidebar, and message history.
 *
 *   GET    /api/threads?limit=N&q= → { threads } (newest-updated first; q keeps the ones whose
 *                                    title or messages contain it, with a snippet)
 *   POST   /api/threads            → { id?, title?, mode? } → 201 thread
 *   PATCH  /api/threads/:id        → { title?, mode? } → thread | 404
 *   DELETE /api/threads/:id        → 204 | 404
 *   GET    /api/threads/:id/messages → { messages, threadId } | 404
 *   POST   /api/threads/:id/messages → { messages: [...] } → { stored }
 *
 * Every route resolves the caller via requireAuthWithTier (JWT sub or
 * api_keys.user_id) so state is strictly per-user. Handlers are thin — the
 * store owns persistence; nothing here reaches into other route state.
 */

import type { FastifyInstance } from "fastify";

import { emitReaction } from "../lib/reactions.ts";
import {
  buildBundle,
  bundleFilename,
  MAX_BUNDLE_BYTES,
  validateBundle,
} from "../lib/session-bundle.ts";
import { appendGraphEvent } from "../lib/session-graph.ts";
import {
  appendMessages,
  createThread,
  deleteThread,
  getThread,
  listMessages,
  listThreads,
  searchThreads,
  updateThread,
  type ThreadMessage,
} from "../lib/threads-store.ts";
import { requireAuthWithTier } from "../middleware/auth.ts";

const AUTH = { preHandler: requireAuthWithTier };

const msgRole = (r: string): ThreadMessage["role"] =>
  r === "user" || r === "opinion" || r === "verdict" || r === "system" ? r : "opinion";

export async function threadsRoutes(app: FastifyInstance): Promise<void> {
  /** GET /threads?limit=N — recent deliberations, newest-updated first. */
  app.get<{ Querystring: { limit?: string; q?: string } }>(
    "/threads",
    AUTH,
    async (request, reply) => {
      const limit = Math.min(Math.max(parseInt(request.query.limit ?? "50", 10) || 50, 1), 1000);
      const q = request.query.q?.trim().slice(0, 200);
      return reply.send({
        threads: q
          ? await searchThreads(request.nexusUserId, q, limit)
          : await listThreads(request.nexusUserId, limit),
      });
    },
  );

  /** POST /threads — create (client id accepted so UI UUIDs survive). */
  app.post<{ Body: { id?: string; title?: string; mode?: string } }>(
    "/threads",
    AUTH,
    async (request, reply) => {
      const { id, title, mode } = request.body ?? {};
      const thread = await createThread(request.nexusUserId, {
        id: id?.trim() || undefined,
        title: title?.trim() || undefined,
        mode: mode?.trim() || undefined,
      });
      // Zero-cost session spider-graph: structural capture from events that
      // already flow here (no LLM call to write memory).
      void appendGraphEvent(request.nexusUserId, `thread:${thread.id}`, "deliberation", {
        title: thread.title,
        node: {
          id: "thread",
          kind: "thread",
          label: thread.title,
          link: `/chat/${thread.id}`,
        },
      });
      return reply.code(201).send(thread);
    },
  );

  /** PATCH /threads/:id — retitle / set mode; bumps updatedAt. */
  app.patch<{ Params: { id: string }; Body: { title?: string; mode?: string } }>(
    "/threads/:id",
    AUTH,
    async (request, reply) => {
      const { title, mode } = request.body ?? {};
      const thread = await updateThread(request.nexusUserId, request.params.id, {
        title: title?.trim() || undefined,
        mode: mode?.trim() || undefined,
      });
      if (!thread) return reply.code(404).send({ error: "not_found" });
      return reply.send(thread);
    },
  );

  /** DELETE /threads/:id — remove the thread and its messages. */
  app.delete<{ Params: { id: string } }>("/threads/:id", AUTH, async (request, reply) => {
    const ok = await deleteThread(request.nexusUserId, request.params.id);
    if (!ok) return reply.code(404).send({ error: "not_found" });
    return reply.code(204).send();
  });

  /** GET /threads/:id/messages — full history in append order. */
  app.get<{ Params: { id: string } }>("/threads/:id/messages", AUTH, async (request, reply) => {
    const thread = await getThread(request.nexusUserId, request.params.id);
    if (!thread) return reply.code(404).send({ error: "not_found" });
    const messages = await listMessages(request.nexusUserId, request.params.id);
    return reply.send({ messages, threadId: request.params.id });
  });

  /** POST /threads/:id/messages — upsert a batch of messages (id-keyed). */
  app.post<{ Params: { id: string }; Body: { messages?: unknown[] } }>(
    "/threads/:id/messages",
    AUTH,
    async (request, reply) => {
      const thread = await getThread(request.nexusUserId, request.params.id);
      if (!thread) return reply.code(404).send({ error: "not_found" });
      const raw = Array.isArray(request.body?.messages) ? request.body.messages : [];
      const messages: ThreadMessage[] = raw
        .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === "object")
        .map((m) => ({
          id: String(m.id ?? crypto.randomUUID()).slice(0, 200),
          role: msgRole(String(m.role ?? "opinion")),
          member: m.member == null ? null : String(m.member).slice(0, 200),
          ...(typeof m.archetype === "string" && m.archetype
            ? { archetype: m.archetype.slice(0, 200) }
            : {}),
          content: String(m.content ?? "").slice(0, 200_000),
          round: Number(m.round) || 0,
          createdAt: String(m.createdAt ?? new Date().toISOString()),
        }))
        .filter((m) => m.content.length > 0);
      const stored = await appendMessages(request.nexusUserId, request.params.id, messages);
      if (messages.length > 0) {
        emitReaction(request.nexusUserId, "message.created", {
          threadId: request.params.id,
          count: messages.length,
          preview: messages.at(-1)?.content.slice(0, 200),
        });
      }
      // Zero-cost spider-graph: one node per round of opinions, chained to the
      // previous node. Fire-and-forget — never delays the write.
      for (const m of messages) {
        void appendGraphEvent(request.nexusUserId, `thread:${request.params.id}`, "deliberation", {
          node: {
            id: `msg:${m.id}`,
            kind: "message",
            label: m.member ?? m.role,
            detail: m.content.slice(0, 300),
            link: `/chat/${request.params.id}`,
          },
          edge: { from: "last", to: `msg:${m.id}` },
        });
      }
      return reply.send({ stored });
    },
  );

  /**
   * GET /threads/:id/export — the whole deliberation as one JSON file.
   *
   * Sent as an attachment with a readable filename, because the point of an export is to
   * leave the browser: a support ticket, a second machine, an account that is not this one.
   * It carries every message in append order — the bundle is the transcript, not a summary.
   */
  app.get<{ Params: { id: string } }>("/threads/:id/export", AUTH, async (request, reply) => {
    const thread = await getThread(request.nexusUserId, request.params.id);
    if (!thread) return reply.code(404).send({ error: "not_found" });
    const messages = await listMessages(request.nexusUserId, request.params.id);
    const bundle = buildBundle(thread, messages);
    return reply
      .header("content-type", "application/json; charset=utf-8")
      .header(
        "content-disposition",
        `attachment; filename="${bundleFilename(thread.title, thread.createdAt)}"`,
      )
      .send(bundle);
  });

  /**
   * POST /threads/import — accept a bundle as a new thread.
   *
   * Always a new thread id, even when the bundle names one that exists: importing is a copy,
   * so it can neither overwrite somebody's session nor fail because a copy was already made.
   * The bundle is validated whole before anything is written — a half-imported session would
   * be worse than a refused one.
   */
  app.post<{ Body: unknown }>("/threads/import", AUTH, async (request, reply) => {
    const raw = request.body;
    const checked = validateBundle(raw);
    if (!checked.ok) {
      return reply.code(400).send({ error: "invalid_bundle", message: checked.reason });
    }
    const { bundle } = checked;
    const encoded = Buffer.byteLength(JSON.stringify(bundle));
    if (encoded > MAX_BUNDLE_BYTES) {
      return reply
        .code(413)
        .send({ error: "bundle_too_large", message: `limit is ${MAX_BUNDLE_BYTES} bytes` });
    }

    const thread = await createThread(request.nexusUserId, {
      title: bundle.thread.title,
      mode: bundle.thread.mode ?? "imported",
    });
    const stored = await appendMessages(request.nexusUserId, thread.id, bundle.messages);
    void appendGraphEvent(request.nexusUserId, `thread:${thread.id}`, "deliberation", {
      title: thread.title,
      node: { id: "thread", kind: "thread", label: thread.title, link: `/chat/${thread.id}` },
    });
    return reply.code(201).send({
      thread,
      imported: { messages: bundle.messages.length, stored, sourceThreadId: bundle.thread.id },
    });
  });
}
