// SPDX-License-Identifier: Apache-2.0
/**
 * "Boots with an empty Redis" is a claim about a cold store: every KV-backed read
 * has to answer with an empty list or a default instead of throwing, because the
 * first request after a flush (or on a fresh pod with a fresh cache) lands on
 * exactly that state.
 *
 * The Redis here is a real one on a real socket — a minimal RESP server that knows
 * an empty keyspace and nothing else. That is enough to prove the path through the
 * actual ioredis client and the actual `RedisKVStore`, which a stub KV would not:
 * a missing key, an empty KEYS/SCAN, a null EVAL, and the server's own startup.
 */
import net from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

/** The smallest Redis that can be empty: RESP2 in, a working keyspace out. */
function emptyRedis(): Promise<{ url: string; close: () => Promise<void>; commands: string[] }> {
  const commands: string[] = [];
  // A real keyspace, so the store behaves as it does in production *after* a flush:
  // SET then GET round-trips, and everything else is absent.
  const data = new Map<string, string>();
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const parsed = parseCommand(buffered);
        if (!parsed) break;
        buffered = buffered.subarray(parsed.bytes);
        commands.push(parsed.args[0]?.toUpperCase() ?? "");
        socket.write(reply(parsed.args, data));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        url: `redis://127.0.0.1:${port}`,
        commands,
        // A client keeps its connection open, and `server.close()` waits for open
        // connections: destroy them, or the test file outlives its last assertion.
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

/** One RESP array of bulk strings, or null when the buffer does not hold a whole one. */
function parseCommand(buffer: Buffer): { args: string[]; bytes: number } | null {
  if (buffer[0] !== 0x2a /* '*' */) return null;
  const header = buffer.indexOf("\r\n");
  if (header === -1) return null;
  const count = Number(buffer.subarray(1, header).toString());
  const args: string[] = [];
  let offset = header + 2;
  for (let i = 0; i < count; i++) {
    if (buffer[offset] !== 0x24 /* '$' */) return null;
    const lengthEnd = buffer.indexOf("\r\n", offset);
    if (lengthEnd === -1) return null;
    const length = Number(buffer.subarray(offset + 1, lengthEnd).toString());
    const start = lengthEnd + 2;
    const end = start + length;
    if (buffer.length < end + 2) return null;
    args.push(buffer.subarray(start, end).toString());
    offset = end + 2;
  }
  return { args, bytes: offset };
}

function bulk(value: string | undefined): string {
  return value === undefined ? "$-1\r\n" : `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

function reply(args: string[], data: Map<string, string>): string {
  const command = (args[0] ?? "").toUpperCase();
  const key = args[1] ?? "";
  const OK = "+OK\r\n";
  switch (command) {
    // An empty keyspace: nothing is there, and nothing is wrong.
    case "GET":
      return bulk(data.get(key));
    case "SET":
      data.set(key, args[2] ?? "");
      return OK;
    case "DEL":
    case "UNLINK": {
      const hits = args.slice(1).filter((k) => data.delete(k)).length;
      return `:${hits}\r\n`;
    }
    case "EXISTS":
      return `:${args.slice(1).filter((k) => data.has(k)).length}\r\n`;
    case "HGET":
    case "EVAL":
    case "EVALSHA":
      return bulk(undefined);
    case "MGET":
      return `*${args.length - 1}\r\n${args
        .slice(1)
        .map((k) => bulk(data.get(k)))
        .join("")}`;
    case "KEYS":
      return glob(args[1] ?? "*", data);
    case "SCAN":
      return `*2\r\n$1\r\n0\r\n${glob(args[3] ?? "*", data)}`;
    case "TTL":
    case "PTTL":
      return ":-1\r\n";
    case "INCR":
    case "INCRBY": {
      const next = Number(data.get(key) ?? 0) + (command === "INCR" ? 1 : Number(args[2] ?? 1));
      data.set(key, String(next));
      return `:${next}\r\n`;
    }
    case "PING":
      return "+PONG\r\n";
    case "DBSIZE":
      return `:${data.size}\r\n`;
    case "INFO":
      return bulk("");
    default:
      return OK;
  }
}

/** Just enough glob for `prefix:*`, which is the only pattern the stores use. */
function glob(pattern: string, data: Map<string, string>): string {
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`);
  const hits = [...data.keys()].filter((k) => regex.test(k));
  return `*${hits.length}\r\n${hits.map((k) => bulk(k)).join("")}`;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let redis: Awaited<ReturnType<typeof emptyRedis>>;
const prev = { url: process.env.REDIS_URL, db: process.env.DATABASE_URL };

beforeAll(async () => {
  redis = await emptyRedis();
  process.env.REDIS_URL = redis.url;
  // An embedded database keeps the readiness probe honest and fast: the only cold
  // store under test here is the KV one.
  process.env.DATABASE_URL = "pglite://:memory:";
});

afterAll(async () => {
  for (const [key, value] of [
    ["REDIS_URL", prev.url],
    ["DATABASE_URL", prev.db],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await redis.close();
});

describe("booting against an empty Redis", () => {
  it("uses Redis, not the in-process fallback", async () => {
    vi.resetModules();
    const { getSharedKV } = await import("../../src/lib/shared-kv.ts");
    expect(getSharedKV().constructor.name).toBe("RedisKVStore");
  });

  it("answers every KV read with an empty value instead of throwing", async () => {
    vi.resetModules();
    const { getSharedKV } = await import("../../src/lib/shared-kv.ts");
    const kv = getSharedKV();
    expect(await kv.get("thread:list:nobody")).toBeUndefined();
    expect(await kv.keys("thread:*")).toEqual([]);
    expect(await kv.has("notif:list:nobody")).toBe(false);
    // A delete of something that is not there is a no-op, not an error.
    await expect(kv.delete("costlog:day:1970-01-01")).resolves.toBeUndefined();
    // And the store still works: a cold cache fills from the factory.
    expect(await kv.getOrSet("cold:key", async () => "computed", 1_000)).toBe("computed");
    expect(redis.commands).toContain("GET");
  });

  it("serves its first request from a cold store", async () => {
    vi.resetModules();
    const { buildServer } = await import("../../src/server.ts");
    const app = await buildServer();
    await app.ready();

    const health = await app.inject({ method: "GET", url: "/health/ready" });
    // 503 is allowed only for a missing Postgres; a cold store is not a fault.
    expect(health.statusCode).not.toBe(500);
    const body = health.json() as {
      checks?: Record<string, string>;
      messages?: Record<string, string>;
    };
    expect(body.checks?.kv, JSON.stringify(body.messages?.kv)).toBe("ok");

    // The KV-backed reads a dashboard hits on first load: empty, never 5xx.
    for (const url of ["/api/notifications", "/api/threads", "/api/missions"]) {
      const res = await app.inject({ method: "GET", url });
      expect([200, 401], `${url} answered ${res.statusCode}`).toContain(res.statusCode);
      expect(res.statusCode, `${url} must not fail on a cold store`).not.toBe(500);
    }

    await app.close();
  }, 30_000);
});
