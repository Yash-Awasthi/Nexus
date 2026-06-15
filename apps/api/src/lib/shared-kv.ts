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

import { MemoryKVStore, type KVStore } from "@nexus/kv";
import { getSharedKVFromCF } from "./cf-adapter.js";

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
    const res = await fetch(`${this.url}/pipeline`, {
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
    const json = (await res.json()) as Array<{ result: T; error?: string }>;
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

  async keys(pattern?: string): Promise<string[]> {
    return this._cmd<string[]>(["KEYS", pattern ?? "*"]);
  }

  async clear(): Promise<void> {
    await this._cmd(["FLUSHDB"]);
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

  // 2. Upstash Redis REST (cross-pod, recommended for K8s)
  const upstashUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (upstashUrl && upstashToken) {
    _sharedKv = new UpstashKVStore(upstashUrl, upstashToken);
  } else {
    // 3. In-process fallback — not cross-pod safe.
    // Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN for production.
    _sharedKv = new MemoryKVStore();
  }

  return _sharedKv;
}

/** Reset singleton — useful in tests. */
export function _resetSharedKV(): void {
  _sharedKv = null;
}
