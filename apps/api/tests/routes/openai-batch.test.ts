// SPDX-License-Identifier: Apache-2.0
/**
 * The OpenAI Files and Batch APIs at /v1: upload a JSONL of requests, run it as a batch against
 * a local fake provider, and read the results back as an output file.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:openai-batch";
const SECRET = "openai-batch-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_SECRETS_KEY = "ab".repeat(32);
process.env.NEXUS_DESKTOP = "1";
// The fake provider counts real calls, so a cached answer must not hide one.
process.env.LLM_CACHE_DISABLED = "1";
process.env.NEXUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-batch-"));

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { getPgPool } = await import("../../src/lib/pg-pool.js");
const { buildServer } = await import("../../src/server.js");

function authFor(userId: string) {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return { authorization: `Bearer ${head}.${body}.${sig}` };
}

let app: FastifyInstance;
let upstream: http.Server;
/** Every prompt the fake provider received, in order. */
const asked: string[] = [];
let release: () => void = () => {};
let held = new Promise<void>((r) => (release = r));
const auth = authFor(crypto.randomUUID());
const other = authFor(crypto.randomUUID());

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", async () => {
      const body = JSON.parse(raw) as { messages: { content: string }[] };
      const text = body.messages.at(-1)!.content;
      asked.push(text);
      if (text.startsWith("slow")) await new Promise((r) => setTimeout(r, 700));
      if (text === "hold") await held;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { content: `echo: ${body.messages.at(-1)!.content}` },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
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
    payload: { provider: "harbor", baseUrl: `http://127.0.0.1:${port}/v1`, models: ["tiny"] },
  });
  expect(saved.statusCode, saved.body).toBe(201);
}, 120_000);

afterAll(async () => {
  await app.close();
  upstream.close();
});

function upload(content: string, headers = auth, purpose = "batch") {
  const b = `----nexus${crypto.randomUUID()}`;
  const payload =
    `--${b}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\n${purpose}\r\n` +
    `--${b}\r\nContent-Disposition: form-data; name="file"; filename="in.jsonl"\r\n` +
    `Content-Type: application/jsonl\r\n\r\n${content}\r\n--${b}--\r\n`;
  return app.inject({
    method: "POST",
    url: "/v1/files",
    headers: { ...headers, "content-type": `multipart/form-data; boundary=${b}` },
    payload,
  });
}

const line = (id: string, text: string, url = "/v1/chat/completions") =>
  JSON.stringify({
    custom_id: id,
    method: "POST",
    url,
    body: { model: "harbor/tiny", messages: [{ role: "user", content: text }] },
  });

interface Batch {
  id: string;
  status: string;
  output_file_id: string | null;
  error_file_id: string | null;
  request_counts: { total: number; completed: number; failed: number };
  errors: { data: { code: string; line?: number }[] } | null;
}

const get = (url: string, headers = auth) => app.inject({ method: "GET", url, headers });

async function settle(id: string): Promise<Batch> {
  for (let i = 0; i < 100; i++) {
    const b = (await get(`/v1/batches/${id}`)).json<Batch>();
    if (["completed", "failed", "cancelled"].includes(b.status)) return b;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("batch never settled");
}

const createBatch = (input_file_id: string, headers = auth, endpoint = "/v1/chat/completions") =>
  app.inject({
    method: "POST",
    url: "/v1/batches",
    headers,
    payload: { input_file_id, endpoint, completion_window: "24h" },
  });

it("stores an uploaded file and serves it back only to its owner", async () => {
  const content = `${line("a", "hi")}\n`;
  const up = await upload(content);
  expect(up.statusCode, up.body).toBe(200);
  const file = up.json<{ id: string }>();
  expect(file).toMatchObject({
    object: "file",
    bytes: Buffer.byteLength(content),
    purpose: "batch",
    filename: "in.jsonl",
  });

  const listed = (await get("/v1/files")).json<{ data: { id: string }[] }>();
  expect(listed.data.map((f) => f.id)).toContain(file.id);
  expect((await get(`/v1/files/${file.id}/content`)).body).toBe(content);
  expect((await get(`/v1/files/${file.id}`, other)).statusCode).toBe(404);

  const del = await app.inject({ method: "DELETE", url: `/v1/files/${file.id}`, headers: auth });
  expect(del.json()).toEqual({ id: file.id, object: "file", deleted: true });
  expect((await get(`/v1/files/${file.id}`)).statusCode).toBe(404);
});

it("runs a batch of chat completions and writes each answer to the output file", async () => {
  const input = (await upload([line("first", "one"), line("second", "two")].join("\n"))).json<{
    id: string;
  }>();
  const created = await createBatch(input.id);
  expect(created.statusCode, created.body).toBe(200);
  expect(created.json<{ object: string }>().object).toBe("batch");

  const done = await settle(created.json<Batch>().id);
  expect(done.status).toBe("completed");
  expect(done.request_counts).toEqual({ total: 2, completed: 2, failed: 0 });
  const rows = (await get(`/v1/files/${done.output_file_id}/content`)).body
    .trim()
    .split("\n")
    .map(
      (l) =>
        JSON.parse(l) as {
          custom_id: string;
          response: { status_code: number; body: { choices: { message: { content: string } }[] } };
        },
    );
  expect(
    rows.map((r) => [
      r.custom_id,
      r.response.status_code,
      r.response.body.choices[0]!.message.content,
    ]),
  ).toEqual([
    ["first", 200, "echo: one"],
    ["second", 200, "echo: two"],
  ]);
  expect((await get(`/v1/batches/${done.id}`, other)).statusCode).toBe(404);
  const list = (await get("/v1/batches")).json<{ data: { id: string }[] }>();
  expect(list.data.map((b) => b.id)).toContain(done.id);
});

it("fails a batch whose lines do not match its endpoint, naming the line", async () => {
  const input = (
    await upload([line("ok", "x"), line("bad", "y", "/v1/embeddings")].join("\n"))
  ).json<{ id: string }>();
  const done = await settle((await createBatch(input.id)).json<Batch>().id);
  expect(done.status).toBe("failed");
  expect(done.errors!.data[0]).toMatchObject({ code: "invalid_url", line: 2 });
});

it("refuses a batch on a file the caller does not own or an endpoint it cannot run", async () => {
  const input = (await upload(line("a", "b"))).json<{ id: string }>();
  expect((await createBatch(input.id, other)).statusCode).toBe(404);
  expect((await createBatch(input.id, auth, "/v1/responses")).statusCode).toBe(400);
});

function shortLived(userId: string, seconds: number) {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + seconds });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return { authorization: `Bearer ${head}.${body}.${sig}` };
}

it("keeps running after the caller's token expires", async () => {
  const sub = JSON.parse(
    Buffer.from(auth.authorization.split(".")[1]!, "base64url").toString(),
  ) as { sub: string };
  const brief = shortLived(sub.sub, 2);
  const input = (
    await upload(
      [
        line("s1", "slow one"),
        line("s2", "slow two"),
        line("s3", "slow three"),
        line("s4", "slow four"),
      ].join("\n"),
      brief,
    )
  ).json<{ id: string }>();
  const created = await createBatch(input.id, brief);
  expect(created.statusCode, created.body).toBe(200);
  let done: Batch | undefined;
  for (let i = 0; i < 200 && !done; i++) {
    const b = (await get(`/v1/batches/${created.json<Batch>().id}`)).json<Batch>();
    if (["completed", "failed", "cancelled"].includes(b.status)) done = b;
    else await new Promise((r) => setTimeout(r, 100));
  }
  expect(done?.request_counts).toEqual({ total: 4, completed: 4, failed: 0 });
}, 30_000);

it("picks a batch back up after a restart without asking again for lines already answered", async () => {
  const input = (
    await upload(
      [line("r1", "before restart"), line("r2", "hold"), line("r3", "after restart")].join("\n"),
    )
  ).json<{ id: string }>();
  const id = (await createBatch(input.id)).json<Batch>().id;
  for (let i = 0; i < 100 && !asked.includes("hold"); i++)
    await new Promise((r) => setTimeout(r, 50));
  await app.close();
  release();
  held = Promise.resolve();
  const before = asked.length;
  app = await buildServer();
  await app.ready();

  const done = await settle(id);
  expect(done.status).toBe("completed");
  expect(done.request_counts).toEqual({ total: 3, completed: 3, failed: 0 });
  expect(asked.slice(before)).toEqual(["hold", "after restart"]);
  const rows = (await get(`/v1/files/${done.output_file_id}/content`)).body.trim().split("\n");
  expect(rows.map((r) => (JSON.parse(r) as { custom_id: string }).custom_id)).toEqual([
    "r1",
    "r2",
    "r3",
  ]);
}, 60_000);
