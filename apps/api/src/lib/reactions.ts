// SPDX-License-Identifier: Apache-2.0
/**
 * Reactive agents: a user's rules ("when <event>, do <handler>") and the event
 * log. Subsystems call `fireReactionEvent` when something happens; every
 * enabled rule of that user whose pattern matches runs its handler.
 *
 * Handlers: notify (bell notification), webhook (POST the event), summarize
 * (a model's one-paragraph summary, as a notification), tag (labels on the
 * logged event). run_workflow is supplied by the workflows module at boot;
 * send_email needs a mail transport, which this deployment does not have.
 */

import crypto from "node:crypto";

import { pinnedFetch } from "@nexus/runtime";

import { createNotification } from "./notifications-store.js";
import { PersistentStore } from "./persistent-store.js";
import { unsafeUrlReason } from "./public-url.js";

export interface ReactionRule {
  id: string;
  ownerId: string | null;
  eventPattern: string;
  handlerType: string;
  handlerConfig: Record<string, unknown>;
  enabled: boolean;
  lastTriggered?: string;
  lastResult?: string;
  triggerCount: number;
  createdAt: string;
}

interface ReactionEvent {
  id: string;
  ownerId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  matchedRules: string[];
  results: Record<string, string>;
  tags?: string[];
  timestamp: string;
}

export const reactionRules = new PersistentStore<ReactionRule>("reaction_rules_v2");
export const reactionEvents = new PersistentStore<ReactionEvent>("reaction_events_v2");
const _ready = Promise.all([reactionRules.load(), reactionEvents.load()]).catch(() => undefined);
const EVENT_CAP = 200;

type Handler = (rule: ReactionRule, event: ReactionEvent) => Promise<string>;
const deps: {
  summarize?: (text: string) => Promise<string>;
  runWorkflow?: (ownerId: string | null, workflowId: string, input: string) => Promise<string>;
} = {};

/** Late-bound capabilities that live in route modules (LLM, workflow runner). */
export function provideReactionDeps(d: typeof deps): void {
  Object.assign(deps, d);
}

const describe = (e: ReactionEvent) =>
  `${e.eventType}: ${JSON.stringify(e.payload).slice(0, 2000)}`;

const HANDLERS: Record<string, Handler> = {
  notify: async (rule, e) => {
    await createNotification(rule.ownerId ?? undefined, {
      type: "system",
      title: String(rule.handlerConfig.title ?? `Reaction: ${e.eventType}`),
      message: String(rule.handlerConfig.message ?? describe(e)).slice(0, 500),
    });
    return "notified";
  },
  webhook: async (rule, e) => {
    const url = rule.handlerConfig.url;
    const unsafe = unsafeUrlReason(url);
    if (unsafe) throw new Error(unsafe);
    const res = await pinnedFetch(String(url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: e.eventType, payload: e.payload, timestamp: e.timestamp }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`webhook answered ${res.status}`);
    return `webhook ${res.status}`;
  },
  summarize: async (rule, e) => {
    if (!deps.summarize) throw new Error("No model available to summarize");
    const summary = await deps.summarize(describe(e));
    await createNotification(rule.ownerId ?? undefined, {
      type: "system",
      title: `Summary: ${e.eventType}`,
      message: summary.slice(0, 500),
    });
    return "summarized";
  },
  tag: async (rule, e) => {
    const tags = String(rule.handlerConfig.tags ?? rule.handlerConfig.tag ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (!tags.length) throw new Error('handlerConfig needs "tags"');
    e.tags = [...new Set([...(e.tags ?? []), ...tags])];
    return `tagged ${tags.join(", ")}`;
  },
  run_workflow: async (rule, e) => {
    const id = rule.handlerConfig.workflowId;
    if (typeof id !== "string" || !id) throw new Error('handlerConfig needs "workflowId"');
    if (!deps.runWorkflow) throw new Error("Workflow runner unavailable");
    return deps.runWorkflow(rule.ownerId, id, describe(e));
  },
  send_email: async () => {
    throw new Error("No mail transport is configured on this server");
  },
};

export const HANDLER_TYPES = Object.keys(HANDLERS);

const matches = (pattern: string, type: string) =>
  pattern === "*" ||
  pattern === type ||
  (pattern.endsWith(".*") && type.startsWith(pattern.slice(0, -1)));

/**
 * Record an event for a user and run every matching enabled rule. Never
 * throws: a failing handler is recorded on the event and the rule.
 */
export async function fireReactionEvent(
  userId: string | undefined | null,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<ReactionEvent> {
  await _ready;
  const ownerId = userId ?? null;
  const rules = [...reactionRules.values()].filter(
    (r) => r.ownerId === ownerId && r.enabled && matches(r.eventPattern, eventType),
  );
  const event: ReactionEvent = {
    id: crypto.randomUUID(),
    ownerId,
    eventType,
    payload,
    matchedRules: rules.map((r) => r.id),
    results: {},
    timestamp: new Date().toISOString(),
  };
  for (const rule of rules) {
    let result: string;
    try {
      const handler = HANDLERS[rule.handlerType];
      if (!handler) throw new Error(`Unknown handler "${rule.handlerType}"`);
      result = await handler(rule, event);
    } catch (err) {
      result = `failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    event.results[rule.id] = result;
    reactionRules.set(rule.id, {
      ...rule,
      lastTriggered: event.timestamp,
      lastResult: result,
      triggerCount: (rule.triggerCount ?? 0) + 1,
    });
  }
  reactionEvents.set(event.id, event);
  const mine = [...reactionEvents.values()]
    .filter((e) => e.ownerId === ownerId)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  for (const old of mine.slice(EVENT_CAP)) reactionEvents.delete(old.id);
  return event;
}

/** Fire-and-forget form for subsystems that must not wait on a handler. */
export function emitReaction(
  userId: string | undefined | null,
  eventType: string,
  payload: Record<string, unknown>,
): void {
  void fireReactionEvent(userId, eventType, payload);
}
