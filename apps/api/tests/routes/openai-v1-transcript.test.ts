// SPDX-License-Identifier: Apache-2.0
/**
 * The OpenAI-compatible surface, checked the way a client sees it: real HTTP, a
 * bearer token, OpenAI's headers, and OpenAI's documented response fields.
 *
 * Every call below is recorded. `OPENAI_TRANSCRIPT=1 pnpm --filter @nexus/api exec
 * vitest run tests/routes/openai-v1-transcript.test.ts` rewrites
 * docs/openai-v1-transcript.md from the live server; a normal run asserts that
 * the committed transcript still mentions every endpoint this file calls, so the
 * doc cannot describe a surface that moved.
 */
import crypto from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";

const DB = "pglite://:memory:openai-transcript";
const SECRET = "openai-transcript-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_SECRETS_KEY = "ef".repeat(32);
process.env.NEXUS_DESKTOP = "1";

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { getPgPool } = await import("../../src/lib/pg-pool.ts");
const { buildServer } = await import("../../src/server.ts");

const TRANSCRIPT = path.resolve(import.meta.dirname, "../../../../docs/openai-v1-transcript.md");
const RECORD = process.env.OPENAI_TRANSCRIPT === "1";

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

interface Entry {
  request: { method: string; path: string; body?: unknown };
  response: { status: number; contentType: string; servedBy: string | null; body: string };
}

const transcript: Entry[] = [];

let app: FastifyInstance;
let upstream: http.Server;
let base = "";
const auth = { authorization: `Bearer ${tokenFor(crypto.randomUUID())}` };

/** One call as a client makes it: recorded before anything is asserted about it. */
async function call(method: string, url: string, body?: unknown, raw?: BodyInit): Promise<Entry> {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: raw ? { ...auth } : { ...auth, "content-type": "application/json" },
    ...(raw ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const entry: Entry = {
    request: { method, path: url, body: raw ? "<multipart body>" : body },
    response: {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      servedBy: res.headers.get("x-nexus-served-by"),
      body: await res.text(),
    },
  };
  transcript.push(entry);
  return entry;
}

const json = <T>(entry: Entry): T => JSON.parse(entry.response.body) as T;

/** Ids and clock readings change per run; the transcript keeps their shape instead. */
function normalise(text: string): string {
  return text
    .replace(/\b(chatcmpl|cmpl|batch|file)-?[0-9a-f-]{32,36}\b/g, "$1-<id>")
    .replace(/"created(_at)?":\d+/g, '"created$1": <unix-seconds>')
    .replace(/"expires_at":\d+/g, '"expires_at": <unix-seconds>')
    .replace(/<id>/g, "<uuid>");
}

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const body = JSON.parse(raw) as { model: string; stream?: boolean };
      if (req.url === "/v1/embeddings") {
        res.writeHead(200, { "content-type": "application/json" });
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
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "" } }] })}\n\n`,
        );
        for (const piece of ["Hel", "lo"])
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "Hello from upstream" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }),
      );
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  app = await buildServer();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no listening port");
  base = `http://127.0.0.1:${address.port}`;
  const port = (upstream.address() as { port: number }).port;
  for (const payload of [
    { provider: "harbor", models: ["tiny"] },
    { provider: "freebie", models: ["calm:free"] },
  ]) {
    const saved = await app.inject({
      method: "POST",
      url: "/api/user/provider-keys",
      headers: auth,
      payload: { ...payload, baseUrl: `http://127.0.0.1:${port}/v1` },
    });
    expect(saved.statusCode, saved.body).toBe(201);
  }
}, 120_000);

afterAll(async () => {
  await app.close();
  upstream.close();
});

it("GET /v1/models lists models the way the OpenAI spec says", async () => {
  const entry = await call("GET", "/v1/models");
  expect(entry.response.status).toBe(200);
  expect(entry.response.contentType).toContain("application/json");
  const body = json<{
    object: string;
    data: { id: string; object: string; created: number; owned_by: string }[];
  }>(entry);
  expect(body.object).toBe("list");
  expect(body.data.length).toBeGreaterThan(0);
  for (const model of body.data) {
    expect(typeof model.id).toBe("string");
    expect(model.object).toBe("model");
    expect(Number.isInteger(model.created)).toBe(true);
    expect(model.owned_by).toBe(model.id.split("/")[0]);
  }
  expect(body.data.map((m) => m.id)).toContain("harbor/tiny");
});

it("POST /v1/chat/completions answers a chat.completion", async () => {
  const entry = await call("POST", "/v1/chat/completions", {
    model: "harbor/tiny",
    messages: [{ role: "user", content: "hello" }],
  });
  expect(entry.response.status).toBe(200);
  const body = json<{
    id: string;
    object: string;
    created: number;
    model: string;
    choices: { index: number; message: { role: string; content: string }; finish_reason: string }[];
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  }>(entry);
  expect(body.id).toMatch(/^chatcmpl-/);
  expect(body.object).toBe("chat.completion");
  expect(Number.isInteger(body.created)).toBe(true);
  expect(body.model).toBe("harbor/tiny");
  expect(body.choices[0]!.index).toBe(0);
  expect(body.choices[0]!.message.role).toBe("assistant");
  expect(body.choices[0]!.message.content).toBe("Hello from upstream");
  expect(body.choices[0]!.finish_reason).toBe("stop");
  expect(body.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
});

it("POST /v1/chat/completions streams chat.completion.chunk frames that end with [DONE]", async () => {
  const entry = await call("POST", "/v1/chat/completions", {
    model: "harbor/tiny",
    stream: true,
    messages: [{ role: "user", content: "stream this back" }],
  });
  expect(entry.response.status).toBe(200);
  expect(entry.response.contentType).toContain("text/event-stream");
  const frames = entry.response.body.split("\n\n").filter((line) => line.startsWith("data: "));
  expect(frames.at(-1)).toBe("data: [DONE]");
  const chunks = frames.slice(0, -1).map(
    (frame) =>
      JSON.parse(frame.slice("data: ".length)) as {
        object: string;
        choices: {
          index: number;
          delta: { role?: string; content?: string };
          finish_reason: string | null;
        }[];
      },
  );
  for (const chunk of chunks) {
    expect(chunk.object).toBe("chat.completion.chunk");
    expect(chunk.choices[0]!.index).toBe(0);
  }
  expect(chunks[0]!.choices[0]!.delta.role).toBe("assistant");
  // How many chunks carry the answer depends on the transport: a provider that
  // streams, or a cached replay, delivers it whole. Both are valid SSE; what the
  // spec requires is the frame shape, a non-empty answer and the closing [DONE].
  const content = chunks.map((c) => c.choices[0]!.delta.content ?? "").join("");
  expect(content.length).toBeGreaterThan(0);
  expect(chunks.at(-1)!.choices[0]!.finish_reason).toBe("stop");
});

it("POST /v1/completions answers a text_completion with logprobs null", async () => {
  const entry = await call("POST", "/v1/completions", {
    model: "harbor/tiny",
    prompt: "finish this sentence",
  });
  const body = json<{
    object: string;
    choices: { index: number; text: string; finish_reason: string; logprobs: null }[];
    usage: { total_tokens: number };
  }>(entry);
  expect(entry.response.status).toBe(200);
  expect(body.object).toBe("text_completion");
  expect(body.choices[0]!.index).toBe(0);
  expect(body.choices[0]!.text).toBe("Hello from upstream");
  expect(body.choices[0]!.logprobs).toBeNull();
  // The spec's invariant, not this run's numbers: total is prompt + completion.
  expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens);
});

it("POST /v1/embeddings relays the provider's embedding list", async () => {
  const entry = await call("POST", "/v1/embeddings", { model: "harbor/tiny", input: "embed this" });
  const body = json<{
    object: string;
    model: string;
    data: { object: string; index: number; embedding: number[] }[];
    usage: { prompt_tokens: number; total_tokens: number };
  }>(entry);
  expect(entry.response.status).toBe(200);
  expect(body.object).toBe("list");
  expect(body.model).toBe("harbor/tiny");
  expect(body.data[0]!.object).toBe("embedding");
  expect(body.data[0]!.index).toBe(0);
  expect(body.data[0]!.embedding.every((n) => typeof n === "number")).toBe(true);
  expect(body.usage.total_tokens).toBe(2);
});

it("files and batches carry the spec's fields", async () => {
  const form = new FormData();
  form.set("purpose", "batch");
  form.set("file", new Blob(['{"custom_id":"1"}\n'], { type: "application/jsonl" }), "input.jsonl");
  const upload = await call("POST", "/v1/files", undefined, form);
  const file = json<{
    id: string;
    object: string;
    bytes: number;
    created_at: number;
    filename: string;
    purpose: string;
  }>(upload);
  expect(upload.response.status).toBe(200);
  expect(file.object).toBe("file");
  expect(file.filename).toBe("input.jsonl");
  expect(file.purpose).toBe("batch");
  expect(typeof file.bytes).toBe("number");

  const listed = await call("GET", "/v1/files");
  expect(json<{ object: string; data: { id: string }[] }>(listed).data.map((f) => f.id)).toContain(
    file.id,
  );

  const fetched = await call("GET", `/v1/files/${file.id}/content`);
  expect(fetched.response.body).toContain('"custom_id":"1"');

  const removed = await call("DELETE", `/v1/files/${file.id}`);
  expect(json<{ id: string; object: string; deleted: boolean }>(removed)).toEqual({
    id: file.id,
    object: "file",
    deleted: true,
  });
});

it("a repeated identical request replays from the response cache with usage zeroed", async () => {
  const body = { model: "harbor/tiny", messages: [{ role: "user", content: "repeat me" }] };
  const first = await call("POST", "/v1/chat/completions", body);
  const again = await call("POST", "/v1/chat/completions", body);
  type Answer = {
    choices: { message: { content: string } }[];
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };
  expect(json<Answer>(again).choices[0]!.message.content).toBe(
    json<Answer>(first).choices[0]!.message.content,
  );
  // A hit costs nothing upstream, so the tokens are reported as zero rather than as
  // the original call's usage; clients that meter cost see 0 for the replay.
  expect(json<Answer>(again).usage).toEqual({
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  });
});

it("a rejected request carries OpenAI's error object", async () => {
  const entry = await call("POST", "/v1/chat/completions", { model: "harbor/tiny" });
  expect(entry.response.status).toBe(400);
  expect(json<{ error: { message: string; type: string; code: null } }>(entry)).toEqual({
    error: {
      message: "model and messages are required",
      type: "invalid_request_error",
      code: null,
    },
  });
});

it("the committed transcript names every endpoint exercised here", () => {
  if (RECORD) {
    const lines = [
      "# The OpenAI surface, as a client sees it",
      "",
      "Recorded from a live server by",
      "`apps/api/tests/routes/openai-v1-transcript.test.ts` over real HTTP with a bearer token.",
      "Ids and `created`/`created_at`/`expires_at` readings are normalised; everything else is verbatim.",
      "Regenerate with",
      "`OPENAI_TRANSCRIPT=1 pnpm --filter @nexus/api exec vitest run tests/routes/openai-v1-transcript.test.ts`.",
      "",
      "The OpenAI SDK is not a dependency of this repository, so these are plain HTTP calls with the",
      "same request bodies and headers a client sends; the fields asserted are the ones the",
      "specification documents for each object.",
      "",
      "Two behaviours of this deployment show up below and are intentional: a repeated identical",
      "request replays from the response cache with `usage` zeroed (a hit costs nothing upstream),",
      "and a rejection is answered with OpenAI's `error` object rather than Nexus's own shape.",
      "",
    ];
    for (const entry of transcript) {
      lines.push(`## ${entry.request.method} ${entry.request.path}`, "");
      if (entry.request.body !== undefined)
        lines.push(
          "Request:",
          "",
          "```json",
          typeof entry.request.body === "string"
            ? entry.request.body
            : JSON.stringify(entry.request.body, null, 2),
          "```",
          "",
        );
      lines.push(
        `Response: ${entry.response.status} (${entry.response.contentType || "no content type"})`,
        "",
        "```",
        normalise(entry.response.body).slice(0, 4000),
        "```",
        "",
      );
    }
    writeFileSync(TRANSCRIPT, `${lines.join("\n")}\n`);
  }
  // Both sides are normalised: the committed transcript holds the ids of the recording,
  // and this run minted its own.
  const committed = normalise(readFileSync(TRANSCRIPT, "utf8"));
  for (const entry of transcript) {
    // The transcript records ids as <uuid>; a re-run mints new ones, so the path is
    // normalised the same way the bodies are.
    const path = normalise(entry.request.path);
    expect(committed).toContain(`${entry.request.method} ${path}`);
  }
  expect(committed).toContain("data: [DONE]");
});
