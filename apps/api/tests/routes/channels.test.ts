// SPDX-License-Identifier: Apache-2.0
/**
 * Stream channels: a writer's frames reach every reader, and a reader that
 * joins late or reconnects gets everything written so far first.
 */
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";

import { DriverRegistry } from "@nexus/llm-drivers";
import type { LlmDriver, LlmRequestOptions, StreamHandler } from "@nexus/llm-drivers";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

const SECRET = "channels-secret";
process.env.NEXUS_JWT_SECRET = SECRET;

vi.mock("../../src/lib/provider-keys.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/provider-keys.js")>()),
  buildUserDriverRegistry: async (_u: string | undefined, providers: Iterable<string>) => {
    const registry = new DriverRegistry();
    const reply = async (o: LlmRequestOptions, h: StreamHandler) => {
      const text = `${o.model} says ${crypto.randomUUID()}`;
      await h({ delta: text, done: true });
      return { content: text, model: o.model, usage: {}, finishReason: "stop" };
    };
    for (const p of new Set(providers))
      registry.register(
        {
          provider: p,
          model: "x",
          stream: reply,
          complete: (o: LlmRequestOptions) => reply(o, () => {}),
        } as unknown as LlmDriver,
        p,
      );
    return { registry, missing: [] as string[] };
  },
}));

const { buildServer } = await import("../../src/server.js");

const headers = (() => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: crypto.randomUUID(), role: "agent", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return { authorization: `Bearer ${head}.${body}.${sig}` };
})();

interface Ref {
  channel_id: string;
  access_key: string;
  direction: "read" | "write";
}

let app: FastifyInstance;
let base = "";
beforeAll(async () => {
  app = await buildServer();
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/api`;
});
afterAll(async () => {
  await app.close();
});

const url = (ref: Ref) =>
  `${base}/ws/channels/${ref.channel_id}?key=${encodeURIComponent(ref.access_key)}&dir=${ref.direction}`;

/** Every text frame until the server closes the socket. */
function readAll(ref: Ref): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const got: string[] = [];
    const ws = new WebSocket(url(ref));
    ws.on("message", (d) => got.push(String(d)));
    ws.on("close", () => resolve(got));
    ws.on("error", reject);
  });
}

describe("stream channels", () => {
  it("relays writer frames and replays them to a late reader", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/channels", headers });
    expect(res.statusCode).toBe(201);
    const { writerRef, readerRef } = res.json<{ writerRef: Ref; readerRef: Ref }>();
    expect(readerRef.direction).toBe("read");

    const early = readAll(readerRef);
    const writer = new WebSocket(url(writerRef));
    await new Promise((r) => writer.on("open", r));
    writer.send("one");
    writer.send("two");
    await new Promise((r) => setTimeout(r, 50));
    const late = readAll(readerRef);
    await new Promise((r) => setTimeout(r, 50));
    writer.close();

    expect(await early).toEqual(["one", "two"]);
    expect(await late).toEqual(["one", "two"]);
  });

  it("refuses a wrong key or a reader key used to write", async () => {
    const { writerRef, readerRef } = (
      await app.inject({ method: "POST", url: "/api/v1/channels", headers })
    ).json<{ writerRef: Ref; readerRef: Ref }>();
    const refused = (ref: Ref) =>
      new Promise<boolean>((resolve) => {
        const ws = new WebSocket(url(ref));
        ws.on("open", () => resolve(false));
        ws.on("error", () => resolve(true));
      });
    expect(await refused({ ...readerRef, access_key: "nope" })).toBe(true);
    expect(await refused({ ...readerRef, direction: "write" })).toBe(true);
    expect(await refused({ ...writerRef, channel_id: "missing" })).toBe(true);
  });

  it("a live council stream can be watched, and replayed after it ends", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      headers,
      payload: {
        message: `Tabs or spaces? ${crypto.randomUUID()}`,
        members: [
          { label: "A", provider: "openai", model: "m-a" },
          { label: "B", provider: "openai", model: "m-b" },
        ],
        round: 0,
        rounds: 1,
        threadId: "live",
        live: true,
      },
    });
    const frames = res.payload.split("\n").filter((l) => l.startsWith("data: "));
    const first = JSON.parse(frames[0]!.slice(6)) as { type: string; reader: Ref };
    expect(first.type).toBe("live");
    const replay = await readAll(first.reader);
    expect(replay).toEqual(frames.slice(1).map((l) => l.slice(6)));
    expect(replay.some((f) => f.includes('"verdict"'))).toBe(true);
  });
});
