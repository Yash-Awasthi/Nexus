// SPDX-License-Identifier: Apache-2.0
/**
 * Reactions surface OWNER — extracted from api-bridge.ts.
 *
 * Emoji message reactions and the reactive-agent rules they share a path with
 * (lib/reactions.ts owns the rules and the event log). Summaries run through the
 * bridge's LLM helper, injected so this module never imports the bridge.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import crypto from "node:crypto";

import type { LlmRole } from "@nexus/llm/drivers";
import type { FastifyInstance } from "fastify";

import { PersistentStore } from "../lib/persistent-store.ts";
import { unsafeUrlReason } from "../lib/public-url.ts";
import {
  fireReactionEvent,
  HANDLER_TYPES,
  provideReactionDeps,
  reactionEvents,
  reactionRules,
  type ReactionRule,
} from "../lib/reactions.ts";

const now = (): string => new Date().toISOString();
const userMsg = (content: string) => ({ role: "user" as LlmRole, content });
const systemMsg = (content: string) => ({ role: "system" as LlmRole, content });

interface ReactionsRoutesDeps {
  /** One-shot completion through the default driver. */
  llm(messages: { role: LlmRole; content: string }[], maxTokens?: number): Promise<string>;
}

/** Register /reactions and /reactions/emit. */
export async function reactionsRoutes(
  app: FastifyInstance,
  deps: ReactionsRoutesDeps,
): Promise<void> {
  // ── reactions ──────────────────────────────────────────────────────────────

  const _reactionsStore = new PersistentStore<{
    id: string;
    messageId: string;
    emoji: string;
    userId: string | null;
    createdAt: string;
  }>("reactions");
  _reactionsStore.load().catch(() => {});

  // Reactive-agents rules (apps/ui/app/routes/agents.tsx), owned by
  // lib/reactions.ts. Emoji message-reactions share the path for old clients.
  provideReactionDeps({
    summarize: (text) =>
      deps.llm(
        [
          systemMsg("Summarise this event in one short paragraph a user can act on."),
          userMsg(text),
        ],
        400,
      ),
  });
  const _myRule = (req: { nexusUserId?: string }, id: string) => {
    const rule = reactionRules.get(id);
    return rule && rule.ownerId === (req.nexusUserId ?? null) ? rule : undefined;
  };

  app.post<{ Body: Record<string, unknown> }>("/reactions", async (request, reply) => {
    const body = request.body ?? {};
    if (typeof body.messageId === "string" && typeof body.emoji === "string") {
      const item = {
        id: crypto.randomUUID(),
        messageId: body.messageId,
        emoji: body.emoji.slice(0, 16),
        userId: request.nexusUserId ?? null,
        createdAt: now(),
      };
      _reactionsStore.set(item.id, item);
      return reply.code(201).send(item);
    }
    const eventPattern = String(body.eventPattern ?? "").trim();
    const handlerType = String(body.handlerType ?? "notify");
    if (!eventPattern) return reply.code(400).send({ error: "eventPattern is required" });
    if (!HANDLER_TYPES.includes(handlerType)) {
      return reply
        .code(400)
        .send({ error: `handlerType must be one of: ${HANDLER_TYPES.join(", ")}` });
    }
    const config =
      body.handlerConfig && typeof body.handlerConfig === "object"
        ? (body.handlerConfig as Record<string, unknown>)
        : {};
    if (handlerType === "webhook") {
      const unsafe = unsafeUrlReason(config.url);
      if (unsafe) return reply.code(400).send({ error: `webhook url: ${unsafe}` });
    }
    const rule: ReactionRule = {
      id: crypto.randomUUID(),
      ownerId: request.nexusUserId ?? null,
      eventPattern: eventPattern.slice(0, 128),
      handlerType,
      handlerConfig: config,
      enabled: true,
      triggerCount: 0,
      createdAt: now(),
    };
    reactionRules.set(rule.id, rule);
    return reply.code(201).send(rule);
  });

  app.get<{ Querystring: { messageId?: string } }>("/reactions", async (request, reply) => {
    if (request.query.messageId) {
      return reply.send(
        Array.from(_reactionsStore.values()).filter(
          (r) =>
            r.messageId === request.query.messageId && r.userId === (request.nexusUserId ?? null),
        ),
      );
    }
    return reply.send(
      Array.from(reactionRules.values())
        .filter((r) => r.ownerId === (request.nexusUserId ?? null))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    );
  });

  app.patch<{
    Params: { id: string };
    Body: { enabled?: boolean; handlerConfig?: Record<string, unknown>; eventPattern?: string };
  }>("/reactions/:id", async (request, reply) => {
    const existing = _myRule(request, request.params.id);
    if (!existing) return reply.code(404).send({ error: "rule_not_found" });
    const b = request.body ?? {};
    if (existing.handlerType === "webhook" && b.handlerConfig) {
      const unsafe = unsafeUrlReason(b.handlerConfig.url);
      if (unsafe) return reply.code(400).send({ error: `webhook url: ${unsafe}` });
    }
    const updated: ReactionRule = {
      ...existing,
      ...(typeof b.enabled === "boolean" ? { enabled: b.enabled } : {}),
      ...(b.handlerConfig && typeof b.handlerConfig === "object"
        ? { handlerConfig: b.handlerConfig }
        : {}),
      ...(typeof b.eventPattern === "string" && b.eventPattern.trim()
        ? { eventPattern: b.eventPattern.trim().slice(0, 128) }
        : {}),
    };
    reactionRules.set(updated.id, updated);
    return reply.send(updated);
  });

  app.delete<{ Params: { id: string } }>("/reactions/:id", async (request, reply) => {
    if (_myRule(request, request.params.id)) {
      reactionRules.delete(request.params.id);
      return reply.code(204).send();
    }
    const emoji = _reactionsStore.get(request.params.id);
    if (emoji && emoji.userId === (request.nexusUserId ?? null)) {
      _reactionsStore.delete(request.params.id);
      return reply.code(204).send();
    }
    return reply.code(404).send({ error: "not_found" });
  });

  /** POST /reactions/emit — fire an event now; matching rules run their handlers. */
  app.post<{ Body: { eventType?: string; payload?: Record<string, unknown> } }>(
    "/reactions/emit",
    async (request, reply) => {
      const eventType = request.body?.eventType?.trim() || "message.created";
      const event = await fireReactionEvent(
        request.nexusUserId,
        eventType,
        request.body?.payload ?? {},
      );
      const matchedRules = event.matchedRules
        .map((id) => reactionRules.get(id))
        .filter((r): r is ReactionRule => !!r);
      return reply.send({ event, matchedRules });
    },
  );

  app.get("/reactions/events", async (request, reply) => {
    return reply.send(
      Array.from(reactionEvents.values())
        .filter((e) => e.ownerId === (request.nexusUserId ?? null))
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
    );
  });
}
