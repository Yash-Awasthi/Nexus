// SPDX-License-Identifier: Apache-2.0
/**
 * Webhooks, tested the way a receiver experiences them: a real HTTP endpoint that records
 * what arrived, a signature that has to verify with the secret the API handed back, a
 * receiver that answers 500 and then has to be retried on the published schedule, and an
 * endpoint that refuses to leave.
 *
 * The last two cases are the ones a naive implementation gets wrong: a delivery with no
 * attempts left must be *dead* (not pending forever), and a subscription URL pointing at
 * loopback must be refused, because this process POSTs to whatever the caller wrote down.
 */
import crypto from "node:crypto";
import http from "node:http";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const DB = "pglite://:memory:webhooks";
const SECRET = "webhooks-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_SECRETS_KEY = "cd".repeat(32);
process.env.NEXUS_DESKTOP = "1";
// The fake receiver is on 127.0.0.1, which the guard refuses by default — for the same
// reason an attacker would want it to. Opt in for this file only.
process.env.NEXUS_WEBHOOKS_ALLOW_PRIVATE = "1";

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { getPgPool } = await import("../../src/lib/pg-pool.ts");
const { buildServer } = await import("../../src/server.ts");
const { verify, RETRY_DELAYS_MS, checkUrl, _resetWebhooksForTests } =
  await import("../../src/lib/webhooks.ts");

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

let app: FastifyInstance;
let receiver: http.Server;
let receiverUrl = "";
let base = "";
let replyWith: number[] = [];
const seen: { headers: http.IncomingHttpHeaders; body: string }[] = [];

const owner = crypto.randomUUID();
const other = crypto.randomUUID();
const auth = { authorization: `Bearer ${tokenFor(owner)}` };
const otherAuth = { authorization: `Bearer ${tokenFor(other)}` };

/**
 * One request. The content type is only set when there is a body: Fastify answers an empty
 * body carrying `content-type: application/json` with a 400 before any route sees it, which
 * is a property of this client rather than of the endpoint.
 */
async function call(method: string, url: string, body?: unknown, as = auth): Promise<Response> {
  return fetch(`${base}${url}`, {
    method,
    headers: body === undefined ? { ...as } : { ...as, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * Delivering is deliberately global — every subscription that asked for the event gets it —
 * so a test that wants its own delivery's result looks it up by id instead of taking the
 * first row a flush happened to return.
 */
async function flushOne(id: string, at?: number) {
  const { flush } = await import("../../src/lib/webhooks.ts");
  const touched = await flush(at, fetch, (delivery) => delivery.id === id);
  return touched.find((delivery) => delivery.id === id);
}

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  receiver = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: raw });
      const status = replyWith.shift() ?? 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/hook`;

  app = await buildServer();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no listening port");
  base = `http://127.0.0.1:${address.port}`;
}, 120_000);

afterAll(async () => {
  await app.close();
  receiver.close();
});

describe("subscriptions", () => {
  it("creates one, returns its secret once, and never lists it", async () => {
    const created = await call("POST", "/api/v1/webhooks", {
      url: receiverUrl,
      events: ["discussion.completed"],
      description: "CI receiver",
    });
    expect(created.status).toBe(201);
    const subscription = (await created.json()) as { id: string; secret: string; url: string };
    expect(subscription.id).toMatch(/^whsub_/);
    expect(subscription.secret).toMatch(/^whsec_/);
    expect(subscription.url).toBe(receiverUrl);

    const list = await call("GET", "/api/v1/webhooks");
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      webhooks: { id: string; secret?: string }[];
      events: string[];
    };
    expect(body.events).toContain("discussion.completed");
    expect(body.webhooks.some((w) => w.id === subscription.id)).toBe(true);
    // A list is what a dashboard shows and a support ticket pastes: no signing keys in it.
    expect(body.webhooks.every((w) => w.secret === undefined)).toBe(true);
  });

  it("refuses a URL that is not http(s), a private address, or an unknown event", async () => {
    // The fake receiver is on 127.0.0.1, so this file opts into private addresses for
    // delivery; the guard is what happens without that opt-in, so remove it here.
    const optedIn = process.env.NEXUS_WEBHOOKS_ALLOW_PRIVATE;
    delete process.env.NEXUS_WEBHOOKS_ALLOW_PRIVATE;
    try {
      for (const [payload, reason] of [
        [{ url: "ftp://example.com/hook" }, /only http and https/],
        [{ url: "http://169.254.169.254/latest/meta-data" }, /private addresses/],
        [{ url: "http://10.0.0.5/hook" }, /private addresses/],
        [{ url: "not a url" }, /not a URL/],
        [{ url: "https://example.com/hook", events: ["nope.happened"] }, /events must be a subset/],
      ] as const) {
        const res = await call("POST", "/api/v1/webhooks", payload);
        expect(res.status, JSON.stringify(payload)).toBe(400);
        expect(((await res.json()) as { message: string }).message).toMatch(reason);
      }
    } finally {
      process.env.NEXUS_WEBHOOKS_ALLOW_PRIVATE = optedIn;
    }
  });

  it("is owner-scoped: another account cannot read, trigger or delete it", async () => {
    const created = await call("POST", "/api/v1/webhooks", { url: receiverUrl });
    const { id } = (await created.json()) as { id: string };
    expect((await call("GET", `/api/v1/webhooks/${id}`, undefined, otherAuth)).status).toBe(404);
    expect((await call("POST", `/api/v1/webhooks/${id}/test`, undefined, otherAuth)).status).toBe(
      404,
    );
    expect((await call("DELETE", `/api/v1/webhooks/${id}`, undefined, otherAuth)).status).toBe(404);
    // …and the owner still can.
    expect((await call("DELETE", `/api/v1/webhooks/${id}`)).status).toBe(204);
    expect((await call("GET", `/api/v1/webhooks/${id}`)).status).toBe(404);
  });
});

describe("delivery", () => {
  it("sends a signed POST a receiver can verify with the secret it was given", async () => {
    seen.length = 0;
    replyWith = [];
    const created = await call("POST", "/api/v1/webhooks", {
      url: receiverUrl,
      events: ["webhook.test"],
    });
    const { id, secret } = (await created.json()) as { id: string; secret: string };

    const sent = await call("POST", `/api/v1/webhooks/${id}/test`);
    expect(sent.status).toBe(200);
    const result = (await sent.json()) as {
      ok: boolean;
      delivery: { status: string; attempts: number };
    };
    expect(result.ok).toBe(true);
    expect(result.delivery.status).toBe("delivered");
    expect(result.delivery.attempts).toBe(1);

    expect(seen).toHaveLength(1);
    const received = seen[0]!;
    expect(received.headers["x-nexus-event"]).toBe("webhook.test");
    expect(received.headers["x-nexus-attempt"]).toBe("1");
    expect(received.headers["x-nexus-delivery"]).toBeTruthy();
    const signature = String(received.headers["x-nexus-signature"]);
    expect(verify(secret, signature, received.body)).toBe(true);
    // The same body with one byte changed is not the same request.
    expect(verify(secret, signature, `${received.body} `)).toBe(false);
    // Neither is a signature from a different secret.
    expect(verify(`whsec_${"0".repeat(32)}`, signature, received.body)).toBe(false);
    // The envelope names the event and carries the payload.
    const body = JSON.parse(received.body) as { event: string; data: { test?: boolean } };
    expect(body.event).toBe("webhook.test");
    expect(body.data.test).toBe(true);

    const detail = (await (await call("GET", `/api/v1/webhooks/${id}`)).json()) as {
      deliveries: { id: string; status: string }[];
    };
    expect(detail.deliveries[0]!.status).toBe("delivered");
  });

  it("retries a 500 on the published schedule and dead-letters when attempts run out", async () => {
    const { flush, publish } = await import("../../src/lib/webhooks.ts");
    const created = await call("POST", "/api/v1/webhooks", {
      url: receiverUrl,
      events: ["workflow.completed"],
    });
    const { id } = (await created.json()) as { id: string };

    replyWith = [500, 500, 500, 500, 500, 500];
    const [queued] = publish("workflow.completed", { runId: "run_1" }, owner);
    expect(queued).toBeDefined();

    // First attempt fails: pending, with the first backoff delay, not a silent drop.
    const first = await flushOne(queued!.id);
    expect(first!.status).toBe("pending");
    expect(first!.attempts).toBe(1);
    expect(first!.lastStatusCode).toBe(500);
    expect(first!.nextAttemptAt).toBeGreaterThan(Date.now());
    // It is not due again yet, so a tick that happens early sends nothing for it.
    expect(await flushOne(queued!.id)).toBeUndefined();
    void flush;

    // Five failures later the delivery is dead, and it says why.
    let current = first!;
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      const next = await flushOne(queued!.id, current.nextAttemptAt + 1);
      expect(next, `attempt ${attempt + 2}`).toBeDefined();
      current = next!;
    }
    expect(current.status).toBe("dead");
    expect(current.attempts).toBe(RETRY_DELAYS_MS.length + 1);
    expect(current.lastError).toMatch(/no attempts left/);
    expect(await flushOne(queued!.id, current.nextAttemptAt + 1)).toBeUndefined();

    // The dead letter is listed, and an operator can re-send it by hand.
    replyWith = [];
    seen.length = 0;
    const retried = await call("POST", `/api/v1/webhooks/${id}/deliveries/${current.id}/retry`);
    expect(retried.status).toBe(200);
    expect(((await retried.json()) as { ok: boolean }).ok).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it("sends nothing to a subscription whose event list does not include the event", async () => {
    const { publish } = await import("../../src/lib/webhooks.ts");
    const created = await call("POST", "/api/v1/webhooks", {
      url: receiverUrl,
      events: ["research.completed"],
    });
    const { id } = (await created.json()) as { id: string };
    const created2 = publish("workflow.completed", { ignored: true }, owner);
    expect(created2.some((d) => d.subscriptionId === id)).toBe(false);
    const created3 = publish("research.completed", { kept: true }, owner);
    expect(created3.some((d) => d.subscriptionId === id)).toBe(true);
  });

  it("disables a subscription whose receiver answered 410 Gone", async () => {
    const { publish } = await import("../../src/lib/webhooks.ts");
    const created = await call("POST", "/api/v1/webhooks", {
      url: receiverUrl,
      events: ["workflow.completed"],
    });
    const { id } = (await created.json()) as { id: string };
    replyWith = [410];
    // Publishing fans out to every subscription that asked for the event, and this file
    // has several, so the delivery under test is picked by subscription, not by order.
    const queued = publish("workflow.completed", { gone: true }, owner).find(
      (delivery) => delivery.subscriptionId === id,
    );
    const result = await flushOne(queued!.id);
    expect(result!.id).toBe(queued!.id);
    expect(result!.status).toBe("failed");
    expect(result!.lastError).toMatch(/410 Gone/);
    const detail = (await (await call("GET", `/api/v1/webhooks/${id}`)).json()) as {
      active: boolean;
    };
    expect(detail.active).toBe(false);
    // Nothing more is queued for it.
    expect(
      publish("workflow.completed", { again: true }, owner).some((d) => d.subscriptionId === id),
    ).toBe(false);
  });
});

describe("survives a restart", () => {
  it("reads pending deliveries back after the process that wrote them is gone", async () => {
    const created = await call("POST", "/api/v1/webhooks", {
      url: receiverUrl,
      events: ["discussion.completed"],
    });
    const { id } = (await created.json()) as { id: string };
    replyWith = [500];
    const { publish } = await import("../../src/lib/webhooks.ts");
    const queued = publish("discussion.completed", { keptAcrossRestart: true }, owner).find(
      (delivery) => delivery.subscriptionId === id,
    );
    const pending = await flushOne(queued!.id);
    expect(pending!.status).toBe("pending");

    // Writes are fire-and-forget, so wait for the row itself to land before restarting:
    // that is also the property being tested — a pending delivery is *durable*, not just
    // in memory until the process happens to exit gracefully.
    const { getPgPool } = await import("../../src/lib/pg-pool.ts");
    const pool = getPgPool(DB)!;
    const deadline = Date.now() + 5_000;
    let rows = 0;
    while (Date.now() < deadline) {
      const result = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM nexus_kv WHERE collection = 'webhook_deliveries' AND id = $1",
        [`${owner}::${pending!.id}`],
      );
      rows = Number(result.rows[0]?.count ?? 0);
      if (rows === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(rows).toBe(1);

    // A restart: the module forgets what it hydrated and reads the store again.
    _resetWebhooksForTests();
    await app.close();
    app = await buildServer();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;

    const detail = (await (await call("GET", `/api/v1/webhooks/${id}`)).json()) as {
      deliveries: { id: string; status: string; event: string }[];
    };
    const restored = detail.deliveries.find((d) => d.id === pending!.id);
    expect(restored?.status).toBe("pending");
    expect(restored?.event).toBe("discussion.completed");
  });
});

describe("the URL guard itself", () => {
  it("accepts a public host and refuses the addresses an SSRF attempt would use", () => {
    // This file opts into private addresses so the fake receiver on 127.0.0.1 can be
    // delivered to; the guard is what happens without that opt-in, so remove it here.
    const optedIn = process.env.NEXUS_WEBHOOKS_ALLOW_PRIVATE;
    delete process.env.NEXUS_WEBHOOKS_ALLOW_PRIVATE;
    try {
      expect(checkUrl("https://example.com/hook").ok).toBe(true);
      for (const url of [
        "http://localhost:3000/hook",
        "http://127.0.0.1/hook",
        "http://[::1]/hook",
        "http://192.168.1.10/hook",
        "http://172.16.0.1/hook",
        "http://169.254.169.254/latest/meta-data",
        "http://0.0.0.0/hook",
        "file:///etc/passwd",
      ]) {
        const verdict = checkUrl(url);
        expect(verdict.ok, url).toBe(false);
      }
    } finally {
      process.env.NEXUS_WEBHOOKS_ALLOW_PRIVATE = optedIn;
    }
  });
});
