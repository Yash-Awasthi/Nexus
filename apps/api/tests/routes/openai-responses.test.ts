// SPDX-License-Identifier: Apache-2.0
/**
 * `POST /v1/responses`, the endpoint current OpenAI SDKs call first, checked the way a
 * client sees it: real HTTP, a bearer token, and the fields the SDK reads (`object`,
 * `output[].type`, `output_text`, `usage.input_tokens`).
 *
 * The fake upstream is the other half of every assertion: these tests ask it what it
 * actually received, so "instructions became the system prompt" and "a function_call_output
 * became a tool turn" are measured rather than assumed from the shape of the reply.
 *
 * The last case belongs to `/v1/chat/completions` on purpose: partial tool-call arguments
 * are one feature across two endpoints, and the chat surface had been sending the whole call
 * at the end of the turn, which is why a client could not show the call being written.
 */
import crypto from "node:crypto";
import http from "node:http";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";

const DB = "pglite://:memory:openai-responses";
const SECRET = "openai-responses-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_SECRETS_KEY = "ab".repeat(32);
process.env.NEXUS_DESKTOP = "1";

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { getPgPool } = await import("../../src/lib/pg-pool.ts");
const { buildServer } = await import("../../src/server.ts");

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

interface UpstreamRequest {
  url?: string;
  body: Record<string, unknown>;
}

let app: FastifyInstance;
let upstream: http.Server;
let base = "";
/** Every request the fake provider received, in order, so the mapping can be inspected. */
const received: UpstreamRequest[] = [];

const auth = { authorization: `Bearer ${tokenFor(crypto.randomUUID())}` };

async function call(method: string, url: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${url}`, {
    method,
    headers: { ...auth, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Read an SSE body into `{ event, data }` pairs, ignoring the `[DONE]` sentinel. */
async function events(
  res: Response,
): Promise<{ event: string | null; data: Record<string, unknown> }[]> {
  const text = await res.text();
  const out: { event: string | null; data: Record<string, unknown> }[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim() || block.includes("[DONE]")) continue;
    let event: string | null = null;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) data.push(line.slice(6));
    }
    if (data.length)
      out.push({ event, data: JSON.parse(data.join("\n")) as Record<string, unknown> });
  }
  return out;
}

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as {
        stream?: boolean;
        messages?: unknown[];
        tools?: unknown[];
      };
      received.push({ url: req.url, body: body as Record<string, unknown> });

      if (body.stream && !body.tools?.length) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const piece of ["Answer ", "from upstream"])
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }

      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        // Two fragments for one call, which is how a provider streams arguments.
        for (const frame of [
          { choices: [{ delta: { role: "assistant", content: "" } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_abc",
                      type: "function",
                      function: { name: "search", arguments: '{"q":' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: '"nexus"}' } }] } },
            ],
          },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ])
          res.write(`data: ${JSON.stringify(frame)}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "Answer from upstream" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
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
  const saved = await app.inject({
    method: "POST",
    url: "/api/user/provider-keys",
    headers: auth,
    payload: { provider: "harbor", models: ["tiny"], baseUrl: `http://127.0.0.1:${port}/v1` },
  });
  expect(saved.statusCode, saved.body).toBe(201);
}, 120_000);

afterAll(async () => {
  await app.close();
  upstream.close();
});

it("POST /v1/responses answers a response object with output_text and usage", async () => {
  const res = await call("POST", "/v1/responses", { model: "harbor/tiny", input: "hello" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.object).toBe("response");
  expect(body.status).toBe("completed");
  expect(String(body.id)).toMatch(/^resp_/);
  expect(Number.isInteger(body.created_at)).toBe(true);
  expect(body.model).toBe("harbor/tiny");
  expect(body.output_text).toBe("Answer from upstream");
  const output = body.output as {
    type: string;
    role: string;
    content: { type: string; text: string }[];
  }[];
  expect(output[0]!.type).toBe("message");
  expect(output[0]!.role).toBe("assistant");
  expect(output[0]!.content[0]!.type).toBe("output_text");
  expect(output[0]!.content[0]!.text).toBe("Answer from upstream");
  expect(body.usage).toMatchObject({ input_tokens: 5, output_tokens: 2, total_tokens: 7 });
});

it("instructions become the system prompt and message items keep their order", async () => {
  received.length = 0;
  const res = await call("POST", "/v1/responses", {
    model: "harbor/tiny",
    instructions: "Be terse.",
    input: [
      { role: "user", content: [{ type: "input_text", text: "first" }] },
      { role: "assistant", content: [{ type: "output_text", text: "ack" }] },
      { role: "user", content: "second" },
    ],
  });
  expect(res.status).toBe(200);
  const sent = received.at(-1)!.body as { messages: { role: string; content: string }[] };
  // The driver puts `systemPrompt` at the head of the turn it sends, which is the proof
  // that `instructions` arrived as instructions rather than as a user message.
  expect(sent.messages.map((m) => [m.role, m.content])).toEqual([
    ["system", "Be terse."],
    ["user", "first"],
    ["assistant", "ack"],
    ["user", "second"],
  ]);
});

it("a function_call_output item reaches the provider as a tool turn", async () => {
  received.length = 0;
  const res = await call("POST", "/v1/responses", {
    model: "harbor/tiny",
    input: [
      { role: "user", content: "what is the weather?" },
      { type: "function_call", call_id: "call_1", name: "weather", arguments: '{"city":"Pune"}' },
      { type: "function_call_output", call_id: "call_1", output: '{"temp":31}' },
    ],
  });
  expect(res.status).toBe(200);
  const sent = received.at(-1)!.body as {
    messages: { role: string; content: string; tool_call_id?: string }[];
  };
  expect(sent.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  expect(sent.messages[2]).toMatchObject({
    role: "tool",
    content: '{"temp":31}',
    tool_call_id: "call_1",
  });
});

it("flat Responses tools are handed to the provider as tool definitions", async () => {
  received.length = 0;
  const res = await call("POST", "/v1/responses", {
    model: "harbor/tiny",
    input: "search something",
    tools: [
      {
        type: "function",
        name: "search",
        description: "Search the web",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    ],
  });
  expect(res.status).toBe(200);
  const sent = received.at(-1)!.body as {
    tools?: { function?: { name?: string }; name?: string }[];
  };
  expect(sent.tools?.[0]).toMatchObject({
    function: { name: "search", description: "Search the web" },
  });
});

it("previous_response_id continues the stored conversation instead of restarting it", async () => {
  const first = await call("POST", "/v1/responses", {
    model: "harbor/tiny",
    input: "remember the number 41",
  });
  const firstBody = (await first.json()) as { id: string };
  expect(firstBody.id).toMatch(/^resp_/);

  received.length = 0;
  const second = await call("POST", "/v1/responses", {
    model: "harbor/tiny",
    input: "add one",
    previous_response_id: firstBody.id,
  });
  expect(second.status).toBe(200);
  const sent = received.at(-1)!.body as { messages: { role: string; content: string }[] };
  expect(sent.messages.map((m) => [m.role, m.content])).toEqual([
    ["user", "remember the number 41"],
    ["assistant", "Answer from upstream"],
    ["user", "add one"],
  ]);

  // The stored turn is readable, and deletable, like any other resource.
  const read = await call("GET", `/v1/responses/${firstBody.id}`);
  expect(read.status).toBe(200);
  expect(((await read.json()) as { output_text: string }).output_text).toBe("Answer from upstream");
});

it("an unknown previous_response_id is a 404 that names the reason", async () => {
  const res = await call("POST", "/v1/responses", {
    model: "harbor/tiny",
    input: "continue",
    previous_response_id: "resp_does_not_exist",
  });
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: { code?: string; param?: string } };
  expect(body.error.code).toBe("previous_response_not_found");
  expect(body.error.param).toBe("previous_response_id");
});

it("store: false keeps no record, and delete removes one that was kept", async () => {
  const res = await call("POST", "/v1/responses", {
    model: "harbor/tiny",
    input: "do not keep this",
    store: false,
  });
  const body = (await res.json()) as { id: string };
  expect((await call("GET", `/v1/responses/${body.id}`)).status).toBe(404);

  const kept = await call("POST", "/v1/responses", { model: "harbor/tiny", input: "keep this" });
  const keptBody = (await kept.json()) as { id: string };
  expect((await call("DELETE", `/v1/responses/${keptBody.id}`)).status).toBe(200);
  expect((await call("GET", `/v1/responses/${keptBody.id}`)).status).toBe(404);
});

it("a parameter this endpoint cannot honour is refused, not silently ignored", async () => {
  for (const param of ["background", "include", "reasoning", "truncation"]) {
    const res = await call("POST", "/v1/responses", {
      model: "harbor/tiny",
      input: "hi",
      [param]: param === "include" ? ["file_search_call.results"] : true,
    });
    expect(res.status, param).toBe(400);
    const body = (await res.json()) as {
      error: { code?: string; param?: string; message?: string };
    };
    expect(body.error.code).toBe("unsupported_parameter");
    expect(body.error.param).toBe(param);
    expect(body.error.message).toContain(param);
  }
});

it("a streamed response emits the documented event sequence and ends with [DONE]", async () => {
  const res = await call("POST", "/v1/responses", {
    model: "harbor/tiny",
    input: "stream this",
    stream: true,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const frames = await events(res);
  const names = frames.map((f) => f.event);
  expect(names[0]).toBe("response.created");
  expect(names[1]).toBe("response.in_progress");
  expect(names).toContain("response.output_text.delta");
  expect(names).toContain("response.output_text.done");
  expect(names).toContain("response.output_item.done");
  expect(names.at(-1)).toBe("response.completed");
  // sequence_number is what an SDK uses to order frames it received out of order.
  expect(frames.map((f) => f.data.sequence_number)).toEqual(frames.map((_, i) => i));
  const deltas = frames.filter((f) => f.event === "response.output_text.delta");
  expect(deltas.map((f) => f.data.delta).join("")).toBe("Answer from upstream");
  const completed = frames.at(-1)!.data.response as { status: string; output_text: string };
  expect(completed.status).toBe("completed");
  expect(completed.output_text).toBe("Answer from upstream");
});

it("/v1/chat/completions streams tool calls as partial arguments, not one block at the end", async () => {
  const res = await call("POST", "/v1/chat/completions", {
    model: "harbor/tiny",
    stream: true,
    messages: [{ role: "user", content: "search for nexus" }],
    // The fake provider streams tool arguments only when it was offered a tool.
    tools: [{ type: "function", function: { name: "search", parameters: { type: "object" } } }],
  });
  const frames = await events(res);
  const fragments = frames
    .flatMap((frame) => {
      const choices = frame.data.choices as
        | {
            delta?: {
              tool_calls?: {
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }[];
            };
          }[]
        | undefined;
      return choices?.[0]?.delta?.tool_calls ?? [];
    })
    .filter((fragment) => fragment.id || fragment.function?.arguments);
  // One fragment per upstream frame: the id and name first, then the arguments in pieces.
  expect(fragments.length).toBeGreaterThanOrEqual(2);
  expect(fragments[0]).toMatchObject({ index: 0, id: "call_abc", function: { name: "search" } });
  const argumentsSoFar = fragments.map((f) => f.function?.arguments ?? "").join("");
  expect(JSON.parse(argumentsSoFar)).toEqual({ q: "nexus" });
  // The turn still ends with the reason, so a client that ignored the fragments is not stuck.
  const last = frames.at(-1)!.data.choices as { finish_reason: string | null }[];
  expect(last[0]!.finish_reason).toBe("tool_calls");
});
