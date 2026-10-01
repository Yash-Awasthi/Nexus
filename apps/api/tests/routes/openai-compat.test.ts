// SPDX-License-Identifier: Apache-2.0
/**
 * Nexus answers the OpenAI API at /v1, so any OpenAI client works by pointing its base URL here:
 * models listed from the caller's own keys, chat completions as JSON or SSE, tool calls both ways.
 */
import crypto from "node:crypto";
import http from "node:http";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:openai-compat";
const SECRET = "openai-compat-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_SECRETS_KEY = "ef".repeat(32);
process.env.NEXUS_DESKTOP = "1";

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { getPgPool } = await import("../../src/lib/pg-pool.js");
const { buildServer } = await import("../../src/server.js");

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

let app: FastifyInstance;
let upstream: http.Server;
const seen: { model: string; tools?: unknown[]; stream?: boolean }[] = [];
const auth = { authorization: `Bearer ${tokenFor(crypto.randomUUID())}` };

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const body = JSON.parse(raw) as { model: string; tools?: unknown[]; stream?: boolean };
      seen.push(body);
      if (body.model === "busy:free") {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Rate limit reached, try again in 20m" } }));
        return;
      }
      if (req.url === "/v1/embeddings") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
            model: body.model,
            usage: { prompt_tokens: 2, total_tokens: 2 },
          }),
        );
        return;
      }
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const piece of ["Hel", "lo"])
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      const message = body.tools
        ? {
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_time", arguments: '{"zone":"UTC"}' },
              },
            ],
          }
        : { content: "Hello from upstream" };
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message, finish_reason: body.tools ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }),
      );
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  app = await buildServer();
  await app.ready();
  const port = (upstream.address() as { port: number }).port;
  const saved = await app.inject({
    method: "POST",
    url: "/api/user/provider-keys",
    headers: auth,
    payload: {
      provider: "harbor",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      models: ["tiny", "big"],
    },
  });
  expect(saved.statusCode, saved.body).toBe(201);
  const free = await app.inject({
    method: "POST",
    url: "/api/user/provider-keys",
    headers: auth,
    payload: {
      provider: "freebie",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      models: ["paid-model", "busy:free", "calm:free"],
    },
  });
  expect(free.statusCode, free.body).toBe(201);
}, 120_000);

afterAll(async () => {
  await app.close();
  upstream.close();
});

it("lists the caller's models the way OpenAI does", async () => {
  const r = await app.inject({ method: "GET", url: "/v1/models", headers: auth });
  expect(r.statusCode, r.body).toBe(200);
  const ids = r.json<{ object: string; data: { id: string; object: string }[] }>();
  expect(ids.object).toBe("list");
  expect(ids.data.map((m) => m.id)).toEqual(expect.arrayContaining(["harbor/tiny", "harbor/big"]));
});

it("answers a chat completion on the named provider and model", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: auth,
    payload: { model: "harbor/big", messages: [{ role: "user", content: "hi" }] },
  });
  expect(r.statusCode, r.body).toBe(200);
  const body = r.json<{
    object: string;
    model: string;
    choices: { message: { role: string; content: string }; finish_reason: string }[];
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  }>();
  expect(body.object).toBe("chat.completion");
  expect(body.choices[0]!.message).toEqual({ role: "assistant", content: "Hello from upstream" });
  expect(body.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  expect(seen.at(-1)!.model).toBe("big");
  expect(r.headers["x-nexus-served-by"]).toBe("user:harbor");
});

it("streams chunks as server-sent events and ends with [DONE]", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: auth,
    payload: { model: "harbor/tiny", stream: true, messages: [{ role: "user", content: "hi" }] },
  });
  expect(r.statusCode).toBe(200);
  expect(r.headers["content-type"]).toContain("text/event-stream");
  const events = r.body
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6));
  expect(events.at(-1)).toBe("[DONE]");
  const text = events
    .slice(0, -1)
    .map((e) => (JSON.parse(e) as { choices: { delta: { content?: string } }[] }).choices[0])
    .map((c) => c!.delta.content ?? "")
    .join("");
  expect(text).toBe("Hello");
});

it("passes tools down and returns the model's tool calls", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: auth,
    payload: {
      model: "harbor/tiny",
      messages: [{ role: "user", content: "time?" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_time",
            description: "Current time",
            parameters: { type: "object", properties: { zone: { type: "string" } } },
          },
        },
      ],
    },
  });
  expect(r.statusCode, r.body).toBe(200);
  const choice = r.json<{
    choices: {
      finish_reason: string;
      message: {
        tool_calls: { id: string; type: string; function: { name: string; arguments: string } }[];
      };
    }[];
  }>().choices[0]!;
  expect(choice.finish_reason).toBe("tool_calls");
  expect(choice.message.tool_calls[0]).toEqual({
    id: "call_1",
    type: "function",
    function: { name: "get_time", arguments: '{"zone":"UTC"}' },
  });
  expect(seen.at(-1)!.tools).toHaveLength(1);
});

it("accepts a personal access token as the API key", async () => {
  const minted = await app.inject({
    method: "POST",
    url: "/api/tokens",
    headers: auth,
    payload: { name: "openai-client" },
  });
  expect(minted.statusCode, minted.body).toBe(201);
  const pat = { authorization: `Bearer ${minted.json<{ token: string }>().token}` };
  const r = await app.inject({ method: "GET", url: "/v1/models", headers: pat });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json<{ data: { id: string }[] }>().data.map((m) => m.id)).toContain("harbor/tiny");
});

it("refuses a caller without a token, in OpenAI's error shape for a bad request", async () => {
  expect((await app.inject({ method: "GET", url: "/v1/models" })).statusCode).toBe(401);
  const bad = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: auth,
    payload: { model: "harbor/tiny" },
  });
  expect(bad.statusCode).toBe(400);
  expect(bad.json<{ error: { type: string } }>().error.type).toBe("invalid_request_error");
});

it("answers a legacy text completion from its prompt", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/v1/completions",
    headers: auth,
    payload: { model: "harbor/big", prompt: "Say hi" },
  });
  expect(r.statusCode, r.body).toBe(200);
  const body = r.json<{ object: string; choices: { text: string; finish_reason: string }[] }>();
  expect(body.object).toBe("text_completion");
  expect(body.choices[0]).toMatchObject({ text: "Hello from upstream", finish_reason: "stop" });
});

it("embeds text on the named provider", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/v1/embeddings",
    headers: auth,
    payload: { model: "harbor/embed-small", input: "hello" },
  });
  expect(r.statusCode, r.body).toBe(200);
  const body = r.json<{ data: { embedding: number[] }[]; model: string }>();
  expect(body.data[0]!.embedding).toEqual([0.1, 0.2]);
  expect(body.model).toBe("harbor/embed-small");
  expect(seen.at(-1)!.model).toBe("embed-small");
  const unknown = await app.inject({
    method: "POST",
    url: "/v1/embeddings",
    headers: auth,
    payload: { model: "nowhere/x", input: "hello" },
  });
  expect(unknown.statusCode).toBe(404);
});

it("routes nexus/free across only the free models, past a rate-limited one", async () => {
  const listed = await app.inject({ method: "GET", url: "/v1/models", headers: auth });
  expect(listed.json<{ data: { id: string }[] }>().data.map((m) => m.id)).toEqual(
    expect.arrayContaining(["nexus/auto", "nexus/free"]),
  );
  const r = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: auth,
    payload: { model: "nexus/free", messages: [{ role: "user", content: "hi" }] },
  });
  expect(r.statusCode, r.body).toBe(200);
  const models = seen.slice(-2).map((b) => b.model);
  expect(models).toEqual(["busy:free", "calm:free"]);
  expect(r.headers["x-nexus-served-by"]).toBe("user:freebie");
});

it("shows the caller's chain with the rate-limited model benched", async () => {
  const r = await app.inject({ method: "GET", url: "/api/v1/gateway/chain", headers: auth });
  expect(r.statusCode, r.body).toBe(200);
  const body = r.json<{
    chain: { id: string; model: string; restingMs: number }[];
    free: { id: string; model: string; restingMs: number }[];
    cache: { hits: number };
  }>();
  expect(body.chain.map((e) => e.id)).toEqual(
    expect.arrayContaining(["user:harbor", "user:freebie"]),
  );
  const busy = body.free.find((e) => e.model === "busy:free")!;
  expect(busy.restingMs).toBeGreaterThan(60_000);
  expect(body.free.find((e) => e.model === "calm:free")!.restingMs).toBe(0);
  expect(typeof body.cache.hits).toBe("number");
});

it("answers a close repeat from the semantic cache when the call asks for it", async () => {
  const ask = (content: string, cache = true) =>
    app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...auth, ...(cache ? { "x-nexus-semantic-cache": "on" } : {}) },
      payload: { model: "harbor/big", messages: [{ role: "user", content }] },
    });
  const first = await ask("What does the semantic cache test answer?");
  expect(first.headers["x-nexus-semantic-cache"]).toBe("miss");
  const calls = seen.length;

  const again = await ask("what does the semantic cache test answer");
  expect(again.headers["x-nexus-semantic-cache"]).toMatch(/^hit/);
  expect(
    again.json<{ choices: { message: { content: string } }[] }>().choices[0]!.message.content,
  ).toBe("Hello from upstream");
  expect(seen.length).toBe(calls);

  await ask("what does the semantic cache test answer", false);
  expect(seen.length).toBe(calls + 1);
});
