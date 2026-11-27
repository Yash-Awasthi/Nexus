// SPDX-License-Identifier: Apache-2.0
/**
 * Webhooks for work that finishes after the request that started it.
 *
 * A graph build, a research run, a workflow run and a council debate all answer their
 * HTTP call long before they are done. Polling is the alternative, and it is what the UI
 * does; an integrator with a server of their own should not have to. This is the smallest
 * thing that is honest:
 *
 *  - subscribe: one row per account, naming a URL and the events it wants
 *  - sign: `x-nexus-signature: t=<unix>,v1=<hmac-sha256 of "<t>.<body>">`, so a receiver
 *    can reject a replay by the timestamp and a forgery by the digest (Stripe's scheme,
 *    because it is the one every receiver already knows how to verify)
 *  - retry: five attempts on a fixed, published backoff, then dead-letter — a delivery
 *    that will never be tried again says so instead of pretending to be pending
 *  - dead-letter: kept, listed, and re-sendable by hand
 *
 * Delivery state lives in `nexus_kv` (`webhook_subscriptions`, `webhook_deliveries`), so a
 * restart resumes the schedule rather than dropping it.
 *
 * Outbound URLs are checked before every send: `http`/`https` only, and no loopback,
 * link-local or private address unless `NEXUS_WEBHOOKS_ALLOW_PRIVATE=1`. A webhook URL is
 * user input that this process will POST to, which is the shape of an SSRF bug otherwise.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { PersistentStore } from "./persistent-store.ts";

/**
 * The events a caller can subscribe to. Each one is a job that answers its HTTP call long
 * before it is done, which is the whole reason to have a webhook. The names match the ones
 * the reaction bus already uses where a job emits one.
 *
 * `webhook.test` is the exception: `POST /webhooks/:id/test` sends it, so a receiver can
 * prove its verification path works on day one. Subscribing to it alone is legal.
 */
export const WEBHOOK_EVENTS = [
  "mission.completed",
  "research.completed",
  "workflow.completed",
  "discussion.completed",
  "webhook.test",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface WebhookSubscription {
  id: string;
  ownerId: string;
  url: string;
  /** `"*"` subscribes to everything, including events added after the subscription. */
  events: WebhookEvent[] | "*";
  /** Returned once on creation and by `GET /webhooks/:id`; receivers verify with it. */
  secret: string;
  description?: string;
  createdAt: number;
  active: boolean;
}

export type DeliveryStatus = "pending" | "delivered" | "failed" | "dead";

export interface WebhookDelivery {
  id: string;
  subscriptionId: string;
  ownerId: string;
  event: WebhookEvent;
  payload: Record<string, unknown>;
  attempts: number;
  status: DeliveryStatus;
  /** Wall time of the next attempt, for a pending delivery. */
  nextAttemptAt: number;
  lastStatusCode?: number;
  lastError?: string;
  createdAt: number;
  deliveredAt?: number;
}

/** Five attempts. A receiver that is down for an hour still gets one more chance. */
export const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000] as const;

/** How long a delivery record is kept — enough to debug a receiver, not a history. */
export const DELIVERY_TTL_MS = 30 * 24 * 3600_000;

/** A send that has not answered by this is a failure, not a hang. */
export const DELIVERY_TIMEOUT_MS = 10_000;

const subscriptions = new PersistentStore<WebhookSubscription>("webhook_subscriptions");
const deliveries = new PersistentStore<WebhookDelivery>("webhook_deliveries");

let _loaded: Promise<void> | null = null;
/**
 * Read both collections once per process. Old deliveries are dropped rather than kept:
 * a receiver debugged from a month-old dead letter learns nothing.
 */
export function loadWebhooks(): Promise<void> {
  _loaded ??= (async () => {
    await Promise.all([subscriptions.load(), deliveries.load()]);
    const cutoff = Date.now() - DELIVERY_TTL_MS;
    for (const [id, record] of deliveries.entries()) {
      if (record.createdAt < cutoff) deliveries.delete(id);
    }
    for (const [id, record] of subscriptions.entries()) {
      if (!record.active && record.createdAt < cutoff) subscriptions.delete(id);
    }
  })();
  return _loaded;
}

/** Test seam: forget the loaded flag so a re-import reads the store again. */
export function _resetWebhooksForTests(): void {
  _loaded = null;
}

// ── URLs ─────────────────────────────────────────────────────────────────────

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
];

/**
 * Refuse a URL this process should not POST to.
 *
 * The check is on the literal host: it catches `http://localhost:3000/hook`,
 * `http://169.254.169.254/latest/meta-data` and a private IPv4, which is what a
 * misconfigured (or maliciously configured) subscription would name. It deliberately does
 * not resolve DNS — a name that resolves to a private address is a different, slower
 * check, and `docs/security/threat-model.md` records that as the residual risk.
 */
export function checkUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "only http and https are delivered to" };
  }
  if (process.env.NEXUS_WEBHOOKS_ALLOW_PRIVATE === "1") return { ok: true, url };
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || host === "::1") {
    return { ok: false, reason: "loopback addresses are not delivered to" };
  }
  if (isIP(host) === 4 && PRIVATE_V4.some((re) => re.test(host))) {
    return { ok: false, reason: "private addresses are not delivered to" };
  }
  if (isIP(host) === 6 || host.startsWith("[")) {
    // Only global unicast is routable; fe80:: (link-local), fc00::/7 (unique-local) and
    // ::1 are not, and those are the three an SSRF attempt would use.
    const bare = host.replace(/^\[|\]$/g, "");
    if (/^fe80:/i.test(bare) || /^f[cd][0-9a-f]{2}:/i.test(bare) || bare === "::1") {
      return { ok: false, reason: "private addresses are not delivered to" };
    }
  }
  return { ok: true, url };
}

// ── Signing ──────────────────────────────────────────────────────────────────

/** `t=<unix>,v1=<hex>` over `<t>.<raw body>`. The timestamp is inside the digest, so it cannot be replayed late. */
export function sign(secret: string, timestamp: number, body: string): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

/** What a receiver does; exported so the tests verify exactly what the docs tell them to. */
export function verify(secret: string, header: string, body: string, now = Date.now()): boolean {
  const parts = Object.fromEntries(
    header.split(",").map((piece) => piece.split("=", 2) as [string, string]),
  );
  const timestamp = Number(parts.t);
  const given = parts.v1;
  if (!Number.isFinite(timestamp) || !given) return false;
  // Five minutes either way: our clock skew, not their patience.
  if (Math.abs(now / 1000 - timestamp) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(given, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Subscriptions ────────────────────────────────────────────────────────────

/** One bucket for callers with no identity, whichever spelling they arrived with. */
export function normaliseOwner(ownerId: string): string {
  return ownerId === "__anon__" ? "anonymous" : ownerId;
}

/** An account's subscriptions, its own only: the key prefix is the account id. */
export function subscriptionsFor(request: { nexusUserId?: string }) {
  return subscriptions.for({ nexusUserId: normaliseOwner(request.nexusUserId ?? "anonymous") });
}

export function createSubscription(
  ownerId: string,
  input: { url: string; events?: unknown; description?: unknown },
): { ok: true; subscription: WebhookSubscription } | { ok: false; reason: string } {
  const checked = checkUrl(input.url);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  const events = normaliseEvents(input.events);
  if (events === null)
    return { ok: false, reason: `events must be a subset of ${WEBHOOK_EVENTS.join(", ")}` };
  const subscription: WebhookSubscription = {
    id: `whsub_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
    ownerId: normaliseOwner(ownerId),
    url: checked.url.toString(),
    events,
    secret: `whsec_${randomUUID().replace(/-/g, "")}`,
    ...(typeof input.description === "string" && input.description.trim()
      ? { description: input.description.trim().slice(0, 200) }
      : {}),
    createdAt: Date.now(),
    active: true,
  };
  subscriptions.set(`${ownerId}::${subscription.id}`, subscription);
  return { ok: true, subscription };
}

/** `"*"`, or a list of known events. Anything else is refused rather than silently dropped. */
export function normaliseEvents(raw: unknown): WebhookEvent[] | "*" | null {
  if (raw === undefined || raw === null) return "*";
  if (raw === "*") return "*";
  if (!Array.isArray(raw) || !raw.length) return null;
  const out: WebhookEvent[] = [];
  for (const value of raw) {
    if (typeof value !== "string") return null;
    if (value === "*") return "*";
    const match = WEBHOOK_EVENTS.find((event) => event === value);
    if (!match) return null;
    if (!out.includes(match)) out.push(match);
  }
  return out;
}

// ── Publishing ───────────────────────────────────────────────────────────────

/**
 * Queue one event for every subscription that asked for it.
 *
 * Returns the deliveries it created, which is what the tests (and a caller that wants to
 * report "sent to 2 endpoints") need. Delivery itself is the scheduler's job; `flush` and
 * `deliverNow` are how the tests drive it without waiting on a timer.
 */
export function publish(
  event: WebhookEvent,
  payload: Record<string, unknown>,
  ownerId?: string,
): WebhookDelivery[] {
  const owner = ownerId === undefined ? undefined : normaliseOwner(ownerId);
  const created: WebhookDelivery[] = [];
  for (const subscription of subscriptions.values()) {
    if (!subscription.active) continue;
    if (owner && subscription.ownerId !== owner) continue;
    if (subscription.events !== "*" && !subscription.events.includes(event)) continue;
    const delivery: WebhookDelivery = {
      id: `whdel_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      subscriptionId: subscription.id,
      ownerId: subscription.ownerId,
      event,
      payload,
      attempts: 0,
      status: "pending",
      nextAttemptAt: Date.now(),
      createdAt: Date.now(),
    };
    deliveries.set(`${subscription.ownerId}::${delivery.id}`, delivery);
    created.push(delivery);
  }
  return created;
}

/** The body a receiver gets. Stable field names, one envelope for every event. */
export function envelope(delivery: WebhookDelivery): {
  json: string;
  headers: Record<string, string>;
} {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    id: delivery.id,
    event: delivery.event,
    created: timestamp,
    attempt: delivery.attempts + 1,
    data: delivery.payload,
  });
  const subscription = subscriptionById(delivery.subscriptionId, delivery.ownerId);
  const secret = subscription?.secret ?? "";
  return {
    json: body,
    headers: {
      "content-type": "application/json",
      "user-agent": "Nexus-Webhooks/1",
      "x-nexus-event": delivery.event,
      "x-nexus-delivery": delivery.id,
      "x-nexus-attempt": String(delivery.attempts + 1),
      "x-nexus-signature": sign(secret, timestamp, body),
    },
  };
}

function subscriptionById(id: string, ownerId: string): WebhookSubscription | undefined {
  return subscriptions.get(`${ownerId}::${id}`);
}

/** Record one attempt. 2xx delivers, 410 cancels the subscription, anything else retries. */
function record(
  delivery: WebhookDelivery,
  status: DeliveryStatus,
  extra: Partial<WebhookDelivery> = {},
) {
  const next: WebhookDelivery = { ...delivery, ...extra, status, attempts: delivery.attempts + 1 };
  deliveries.set(`${delivery.ownerId}::${delivery.id}`, next);
  return next;
}

/**
 * Send one delivery now, and decide what happens next.
 *
 * Exported so a test can send without a scheduler, and so an operator can force a retry
 * of a dead letter.
 */
export async function deliverNow(
  delivery: WebhookDelivery,
  fetchImpl: typeof fetch = fetch,
): Promise<WebhookDelivery> {
  const subscription = subscriptionById(delivery.subscriptionId, delivery.ownerId);
  if (!subscription || !subscription.active) {
    return record(delivery, "failed", { lastError: "subscription is gone or inactive" });
  }
  const { json, headers } = envelope(delivery);
  try {
    const res = await fetchImpl(subscription.url, {
      method: "POST",
      headers,
      body: json,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (res.ok) {
      return record(delivery, "delivered", {
        lastStatusCode: res.status,
        deliveredAt: Date.now(),
        nextAttemptAt: 0,
        lastError: undefined,
      });
    }
    if (res.status === 410) {
      // "Gone" is the receiver telling us to stop, and it is the one answer we obey.
      subscriptions.set(`${subscription.ownerId}::${subscription.id}`, {
        ...subscription,
        active: false,
      });
      return record(delivery, "failed", {
        lastStatusCode: res.status,
        lastError: "receiver answered 410 Gone; the subscription was disabled",
        nextAttemptAt: 0,
      });
    }
    return retryOrDeadLetter(delivery, `receiver answered ${res.status}`, res.status);
  } catch (error) {
    return retryOrDeadLetter(delivery, error instanceof Error ? error.message : String(error));
  }
}

function retryOrDeadLetter(delivery: WebhookDelivery, reason: string, status?: number) {
  const delay = RETRY_DELAYS_MS[delivery.attempts];
  if (delay === undefined) {
    return record(delivery, "dead", {
      lastError: `${reason} (no attempts left)`,
      ...(status !== undefined ? { lastStatusCode: status } : {}),
      nextAttemptAt: 0,
    });
  }
  return record(delivery, "pending", {
    lastError: reason,
    ...(status !== undefined ? { lastStatusCode: status } : {}),
    nextAttemptAt: Date.now() + delay,
  });
}

/** Every delivery that is due, oldest first. One scheduler tick. */
export function dueDeliveries(now = Date.now()): WebhookDelivery[] {
  return [...deliveries.values()]
    .filter((d) => d.status === "pending" && d.nextAttemptAt <= now)
    .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
}

/** Send everything that is due. Returns what it touched, for a test or an operator. */
export async function flush(
  now = Date.now(),
  fetchImpl: typeof fetch = fetch,
  only?: (delivery: WebhookDelivery) => boolean,
): Promise<WebhookDelivery[]> {
  const touched: WebhookDelivery[] = [];
  for (const delivery of dueDeliveries(now)) {
    if (only && !only(delivery)) continue;
    touched.push(await deliverNow(delivery, fetchImpl));
  }
  return touched;
}

let _timer: ReturnType<typeof setInterval> | null = null;

/** The scheduler. Off in tests unless a test asks for it: a timer in a test is a race. */
export function startDispatcher(intervalMs = 5_000): void {
  if (_timer) return;
  _timer = setInterval(() => {
    void flush().catch(() => undefined);
  }, intervalMs);
  // Do not hold the process open for a webhook: the API server is what owns the loop.
  _timer.unref?.();
}

export function stopDispatcher(): void {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

/** Deliveries for one subscription, newest first — the list `GET /webhooks/:id` returns. */
export function deliveriesFor(ownerId: string, subscriptionId: string): WebhookDelivery[] {
  return [...deliveries.values()]
    .filter((d) => d.ownerId === ownerId && d.subscriptionId === subscriptionId)
    .sort((a, b) => b.createdAt - a.createdAt);
}
