// SPDX-License-Identifier: Apache-2.0
/**
 * Shared KVStore singleton for cross-cutting concerns:
 *   - Token budget    (KVTokenBudget in gateway.ts)
 *   - Gateway log     (KVGatewayLog in gateway.ts)
 *   - Session state   (chat-analyst.ts persistent sessions)
 *   - Alert events    (distributed alert fan-out)
 *
 * Backends (priority order):
 *   1. UpstashKVStore  — when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN set.
 *                        Uses Upstash REST API (no ioredis dep, just fetch).
 *                        Cross-pod safe: all instances share the same Redis.
 *   2. MemoryKVStore   — development / CI fallback (per-pod, not cross-pod safe).
 *
 * Production requirement: set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 * (or swap UpstashKVStore for an ioredis-backed adapter when ioredis is available).
 */

import { MemoryKVStore, RedisKVStore, type KVStore, type RedisClientLike } from "@nexus/kv";
import Redis from "ioredis";

import { getSharedKVFromCF } from "./cf-adapter.js";

let _redisClient: RedisLike | null = null;

/**
 * Hard cap for a single KV command (connect + read). Unreachable Redis/Upstash
 * must fail fast so boot-path loads degrade and request paths return errors —
 * never hang. The codebase's own contract is "fails open if Redis is down".
 */
export const KV_COMMAND_TIMEOUT_MS = 3_000;

/**
 * Bounded fetch: races `fetch` against BOTH an AbortSignal (so a cooperative
 * fetch is actually cancelled and its body reads stop) and a hard timeout
 * promise (so even an implementation that ignores the signal cannot hang the
 * caller). A fetch that never settles — unreachable host, dropped SYN, stalled
 * read — rejects within `timeoutMs` with a clear error.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = KV_COMMAND_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(); // best-effort: cancel the real fetch if it cooperates
      reject(new Error(`KV fetch timed out after ${timeoutMs}ms: ${url}`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetch(url, { ...init, signal: controller.signal }),
      timeout,
    ]);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("KV fetch timed out")) throw err;
    if (controller.signal.aborted) {
      throw new Error(`KV fetch timed out after ${timeoutMs}ms: ${url}`);
    }
    throw new Error(`KV fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bound any promise (KV read-modify-write, boot loads) to a hard timeout.
 * Never hangs: a never-settling call rejects after `ms` with a clear error so
 * callers can degrade instead of blocking (e.g. Fastify plugin registration).
 */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/**
 * ioredis's published typings spread commands across merged interfaces that do
 * not resolve under this repo's tsconfig — describe the small surface we use.
 */
type RedisLike = {
  get(key: string): Promise<string | null>;
  set(...args: unknown[]): Promise<unknown>;
  del(...args: unknown[]): Promise<unknown>;
  exists(...args: unknown[]): Promise<number>;
  incr(...args: unknown[]): Promise<number>;
  expire(...args: unknown[]): Promise<unknown>;
  keys(...args: unknown[]): Promise<string[]>;
  on(event: string, cb: (err: Error) => void): void;
  flushall(...args: unknown[]): Promise<unknown>;
  eval(...args: unknown[]): Promise<unknown>;
};

/** Adapt the Redis-like surface to the minimal RedisClientLike shape. */
function toRedisClientLike(client: RedisLike): RedisClientLike {
  return {
    get: (key) => client.get(key),
    set: (key, value, options) =>
      options?.PX !== undefined
        ? Promise.resolve(client.set(key, value, "PX", options.PX))
        : Promise.resolve(client.set(key, value)),
    del: (key) => Promise.resolve(client.del(Array.isArray(key) ? key : [key])) as Promise<number>,
    flushAll: () => Promise.resolve(client.flushall()),
    exists: async (key) => Number(await client.exists(key)),
    incr: (key) => Promise.resolve(client.incr(key)) as Promise<number>,
    expire: (key, seconds) => Promise.resolve(client.expire(key, seconds)),
    keys: (pattern) => Promise.resolve(client.keys(pattern)) as Promise<string[]>,
    eval: (script, options) =>
      Promise.resolve(
        client.eval(script, options.keys.length, ...options.keys, ...options.arguments),
      ) as Promise<unknown>,
  };
}

// ── Upstash REST KVStore ───────────────────────────────────────────────────────
// Implements KVStore using Upstash Redis REST API.
// Compatible with any Redis/Valkey that exposes the Upstash REST protocol.

class UpstashKVStore implements KVStore {
  private readonly url: string;
  private readonly token: string;

  constructor(url: string, token: string) {
    this.url = url.replace(/\/$/, "");
    this.token = token;
  }

  private async _cmd<T>(args: (string | number)[]): Promise<T> {
    const res = await fetchWithTimeout(`${this.url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([args]),
    });
    if (!res.ok) {
      throw new Error(`Upstash error: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { result: T; error?: string }[];
    if (json[0]?.error) throw new Error(`Upstash cmd error: ${json[0].error}`);
    return json[0]!.result;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const result = await this._cmd<string | null>(["GET", key]);
    if (result === null) return undefined;
    try {
      return JSON.parse(result) as T;
    } catch {
      return result as unknown as T;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (ttlMs !== undefined && ttlMs > 0) {
      const ttlSec = Math.ceil(ttlMs / 1000);
      await this._cmd(["SET", key, serialized, "EX", ttlSec]);
    } else {
      await this._cmd(["SET", key, serialized]);
    }
  }

  async delete(key: string): Promise<void> {
    await this._cmd(["DEL", key]);
  }

  /**
   * Atomic INCR; EXPIRE is issued only when this call created the key
   * (result 1) — in-window increments never refresh the expiry. A failed
   * EXPIRE is tolerated (the counter just lacks a TTL) so a transient
   * error can't double-count through a caller-side fallback.
   */
  async incr(key: string, ttlMs?: number): Promise<number> {
    const count = await this._cmd<number>(["INCR", key]);
    if (count === 1 && ttlMs !== undefined && ttlMs > 0) {
      try {
        await this._cmd(["EXPIRE", key, Math.ceil(ttlMs / 1000)]);
      } catch {
        /* tolerated — see above */
      }
    }
    return count;
  }

  async has(key: string): Promise<boolean> {
    const result = await this._cmd<number>(["EXISTS", key]);
    return result === 1;
  }

  async keys(pattern?: string): Promise<string[]> {
    return this._cmd<string[]>(["KEYS", pattern ?? "*"]);
  }

  async clear(): Promise<void> {
    await this._cmd(["FLUSHDB"]);
  }

  async getOrSet<T>(key: string, factory: () => Promise<T>, ttlMs?: number): Promise<T> {
    const existing = await this.get<T>(key);
    if (existing !== undefined) return existing;
    const value = await factory();
    await this.set(key, value, ttlMs);
    return value;
  }
}

// ── Singleton factory ─────────────────────────────────────────────────────────

let _sharedKv: KVStore | null = null;

/**
 * Returns the shared KVStore singleton.
 * Thread-safe: multiple calls return the same instance.
 */
export function getSharedKV(): KVStore {
  if (_sharedKv) return _sharedKv;

  // 1. Cloudflare Workers KV (when running on CF Workers edge)
  const cfKV = getSharedKVFromCF();
  if (cfKV) {
    _sharedKv = cfKV;
    return _sharedKv;
  }

  // 2. Redis (BullMQ-compatible REDIS_URL — cross-pod safe). Preferred over
  //    Upstash because the same Redis instance already backs the queues.
  if (process.env.REDIS_URL) {
    _redisClient ??= new Redis(process.env.REDIS_URL, {
      // Fail fast on unreachable Redis instead of queuing commands forever:
      // the default ioredis retryStrategy reconnects indefinitely, so a bare
      // `keys()` at boot would hang the plugin and fatal the server. Bounded
      // connect + per-command timeouts and a finite retry budget make every
      // KV call reject within a few seconds when Redis is down.
      connectTimeout: KV_COMMAND_TIMEOUT_MS,
      commandTimeout: KV_COMMAND_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
      retryStrategy: (times: number) => (times > 3 ? null : Math.min(200 * times, 1_000)),
    }) as unknown as RedisLike;
    _redisClient.on("error", (err: Error) => {
      console.error(
        JSON.stringify({ level: "error", event: "shared-kv.redis-error", error: err.message }),
      );
    });
    _sharedKv = new RedisKVStore(toRedisClientLike(_redisClient));
  } else if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    // 3. Upstash Redis REST (cross-pod, recommended for K8s when no REDIS_URL)
    _sharedKv = new UpstashKVStore(
      process.env.UPSTASH_REDIS_REST_URL,
      process.env.UPSTASH_REDIS_REST_TOKEN,
    );
  } else {
    // 4. In-process fallback — not cross-pod safe.
    _sharedKv = new MemoryKVStore();
  }

  return _sharedKv!;
}
