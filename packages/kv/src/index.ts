// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/kv — Cross-process key/value store, pub/sub, and distributed lock.
 *
 * Three independent abstractions — each has an in-memory implementation and
 * a Redis-backed implementation built on an injectable client interface.
 *
 * KVStore      — get/set/delete/has/keys/clear with optional TTL per entry.
 *               getOrSet() pattern for cache-aside loading.
 *
 * PubSubClient — publish/subscribe over named channels.
 *               subscribe() returns an unsubscribe function.
 *
 * DistributedLock — compare-and-swap token-based locking with TTL.
 *               withLock() is the preferred high-level API.
 *
 * Injectable Redis client
 * ───────────────────────
 * RedisKVStore / RedisPubSub / RedisDistributedLock accept a `RedisClientLike`
 * interface so the package never imports a specific Redis library.  Wire in
 * `node-redis` or `ioredis` at your app entry point:
 *
 * ```ts
 * import { createClient } from "redis";
 * const client = createClient({ url: process.env.REDIS_URL });
 * await client.connect();
 * const kv = new RedisKVStore(client);
 * ```
 */

import { randomUUID } from "node:crypto";

// ── Error ──────────────────────────────────────────────────────────────────────

export class KVError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "KVError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// KVStore
// ─────────────────────────────────────────────────────────────────────────────

export interface KVStore {
  /** Retrieve a value by key. Returns undefined if not found or expired. */
  get<T>(key: string): Promise<T | undefined>;
  /** Persist a value, optionally with a TTL in milliseconds. */
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  /** Remove a key. No-op if absent. */
  delete(key: string): Promise<void>;
  /** Return true if the key exists and has not expired. */
  has(key: string): Promise<boolean>;
  /**
   * Return all keys matching an optional glob-style pattern.
   * Use "*" to match everything (default).
   * Pattern matching is prefix-based for simplicity: "prefix:*" matches
   * any key starting with "prefix:".
   */
  keys(pattern?: string): Promise<string[]>;
  /** Remove all stored entries. */
  clear(): Promise<void>;
  /**
   * Retrieve a value or compute and cache it if missing.
   * The factory is only called on a cache miss.
   */
  getOrSet<T>(key: string, factory: () => Promise<T>, ttlMs?: number): Promise<T>;
}

// ── Internal entry ────────────────────────────────────────────────────────────

interface KVEntry<T> {
  value: T;
  expiresAt?: number; // undefined = no expiry
}

// ── MemoryKVStore ─────────────────────────────────────────────────────────────

/**
 * In-memory KVStore with TTL support.
 *
 * Uses a `now` injection point for deterministic tests.
 * Expired entries are lazily evicted on access.
 */
export class MemoryKVStore implements KVStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly store = new Map<string, KVEntry<any>>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  private _isExpired(entry: KVEntry<unknown>): boolean {
    return entry.expiresAt !== undefined && this.now() >= entry.expiresAt;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key) as KVEntry<T> | undefined;
    if (!entry) return undefined;
    if (this._isExpired(entry)) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const expiresAt = ttlMs !== undefined && ttlMs > 0 ? this.now() + ttlMs : undefined;
    this.store.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== undefined;
  }

  async keys(pattern?: string): Promise<string[]> {
    const result: string[] = [];
    const prefix = pattern?.endsWith("*") ? pattern.slice(0, -1) : undefined;
    for (const [k, entry] of this.store) {
      if (this._isExpired(entry)) {
        this.store.delete(k);
        continue;
      }
      if (prefix !== undefined) {
        if (k.startsWith(prefix)) result.push(k);
      } else if (!pattern || pattern === "*") {
        result.push(k);
      } else {
        if (k === pattern) result.push(k);
      }
    }
    return result;
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  async getOrSet<T>(key: string, factory: () => Promise<T>, ttlMs?: number): Promise<T> {
    const existing = await this.get<T>(key);
    if (existing !== undefined) return existing;
    const value = await factory();
    await this.set(key, value, ttlMs);
    return value;
  }

  /** Number of non-expired entries (for inspection in tests). */
  get size(): number {
    let count = 0;
    const now = this.now();
    for (const entry of this.store.values()) {
      if (entry.expiresAt === undefined || now < entry.expiresAt) count++;
    }
    return count;
  }
}

// ── RedisClientLike — injectable interface ─────────────────────────────────────

/**
 * Minimal Redis client interface.  Wire in `node-redis` or `ioredis`.
 *
 * All methods return Promises; the shape matches `node-redis` v4 commands.
 */
export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { PX?: number; NX?: boolean }): Promise<unknown>;
  del(key: string | string[]): Promise<number>;
  exists(key: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  flushAll(): Promise<unknown>;
  /** eval / evalsha for atomic Lua scripts */
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

// ── RedisKVStore ──────────────────────────────────────────────────────────────

/** Redis-backed KVStore. Values are JSON-serialised before storage. */
export class RedisKVStore implements KVStore {
  constructor(
    private readonly client: RedisClientLike,
    private readonly opts: { keyPrefix?: string } = {},
  ) {}

  private _k(key: string): string {
    return this.opts.keyPrefix ? `${this.opts.keyPrefix}:${key}` : key;
  }

  private _unk(redisKey: string): string {
    const prefix = this.opts.keyPrefix ? `${this.opts.keyPrefix}:` : "";
    return prefix ? redisKey.slice(prefix.length) : redisKey;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.client.get(this._k(key));
    if (raw === null) return undefined;
    return JSON.parse(raw) as T;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const serialised = JSON.stringify(value);
    await this.client.set(this._k(key), serialised, ttlMs && ttlMs > 0 ? { PX: ttlMs } : undefined);
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this._k(key));
  }

  async has(key: string): Promise<boolean> {
    return (await this.client.exists(this._k(key))) > 0;
  }

  async keys(pattern?: string): Promise<string[]> {
    const redisPattern = this._k(pattern ?? "*");
    const raw = await this.client.keys(redisPattern);
    return raw.map((k) => this._unk(k));
  }

  async clear(): Promise<void> {
    await this.client.flushAll();
  }

  async getOrSet<T>(key: string, factory: () => Promise<T>, ttlMs?: number): Promise<T> {
    const existing = await this.get<T>(key);
    if (existing !== undefined) return existing;
    const value = await factory();
    await this.set(key, value, ttlMs);
    return value;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PubSubClient
// ─────────────────────────────────────────────────────────────────────────────

export type PubSubHandler = (data: unknown, channel: string) => void;

/** Pub sub client interface definition. */
export interface PubSubClient {
  /** Publish a message to a channel. */
  publish(channel: string, data: unknown): Promise<void>;
  /**
   * Subscribe to a channel.  Returns an unsubscribe function.
   * The handler is called with the parsed message and channel name.
   */
  subscribe(channel: string, handler: PubSubHandler): () => void;
}

// ── MemoryPubSub ──────────────────────────────────────────────────────────────

/** In-process pub/sub — same process only. Useful for testing and single-node deployments. */
export class MemoryPubSub implements PubSubClient {
  private readonly channels = new Map<string, Set<PubSubHandler>>();

  async publish(channel: string, data: unknown): Promise<void> {
    const handlers = this.channels.get(channel);
    if (!handlers) return;
    for (const handler of handlers) {
      handler(data, channel);
    }
  }

  subscribe(channel: string, handler: PubSubHandler): () => void {
    if (!this.channels.has(channel)) {
      this.channels.set(channel, new Set());
    }
    this.channels.get(channel)!.add(handler);
    return () => {
      this.channels.get(channel)?.delete(handler);
    };
  }

  /** Number of subscribers across all channels. */
  get subscriberCount(): number {
    let count = 0;
    for (const set of this.channels.values()) count += set.size;
    return count;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DistributedLock
// ─────────────────────────────────────────────────────────────────────────────

export interface LockAcquireResult {
  /** Opaque token required to release this lock. */
  token: string;
}

/** Distributed lock interface definition. */
export interface DistributedLock {
  /**
   * Try to acquire the lock for `key` with the given TTL.
   * Returns a token if acquired, or undefined if the lock is held.
   */
  acquire(key: string, ttlMs: number): Promise<LockAcquireResult | undefined>;
  /**
   * Release the lock for `key`.  The caller must supply the token
   * originally returned by `acquire()`.
   * Returns true if successfully released, false if token mismatch.
   */
  release(key: string, token: string): Promise<boolean>;
  /**
   * Acquire the lock, run `fn`, then release it.
   * Returns undefined if the lock could not be acquired (already held).
   * The lock is always released — even if `fn` throws.
   */
  withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T | undefined>;
}

// ── MemoryDistributedLock ─────────────────────────────────────────────────────

interface LockEntry {
  token: string;
  expiresAt: number;
}

/** In-process distributed lock (for single-process use and testing). */
export class MemoryDistributedLock implements DistributedLock {
  private readonly locks = new Map<string, LockEntry>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  async acquire(key: string, ttlMs: number): Promise<LockAcquireResult | undefined> {
    const existing = this.locks.get(key);
    if (existing && this.now() < existing.expiresAt) {
      return undefined; // lock held
    }
    const token = randomUUID();
    this.locks.set(key, { token, expiresAt: this.now() + ttlMs });
    return { token };
  }

  async release(key: string, token: string): Promise<boolean> {
    const existing = this.locks.get(key);
    if (!existing || existing.token !== token) return false;
    this.locks.delete(key);
    return true;
  }

  async withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T | undefined> {
    const result = await this.acquire(key, ttlMs);
    if (!result) return undefined;
    try {
      return await fn();
    } finally {
      await this.release(key, result.token);
    }
  }
}

// ── RedisDistributedLock ──────────────────────────────────────────────────────

/**
 * Redis-backed distributed lock using Lua SET NX + token comparison.
 *
 * Uses the standard Redlock algorithm (single-node variant) via two Lua scripts:
 *   acquire: SET key token NX PX ttlMs
 *   release: compare-and-delete if token matches
 */
export class RedisDistributedLock implements DistributedLock {
  private static readonly RELEASE_SCRIPT = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  constructor(
    private readonly client: RedisClientLike,
    private readonly opts: { keyPrefix?: string } = {},
  ) {}

  private _k(key: string): string {
    return this.opts.keyPrefix ? `${this.opts.keyPrefix}:lock:${key}` : `lock:${key}`;
  }

  async acquire(key: string, ttlMs: number): Promise<LockAcquireResult | undefined> {
    const token = randomUUID();
    // SET key token NX PX ttlMs — only sets if key doesn't exist
    const result = await this.client.set(this._k(key), token, { PX: ttlMs, NX: true });
    // node-redis returns "OK" on success, null if NX condition was not met
    if (!result) return undefined;
    return { token };
  }

  async release(key: string, token: string): Promise<boolean> {
    const result = await this.client.eval(RedisDistributedLock.RELEASE_SCRIPT, {
      keys: [this._k(key)],
      arguments: [token],
    });
    return result === 1;
  }

  async withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T | undefined> {
    const result = await this.acquire(key, ttlMs);
    if (!result) return undefined;
    try {
      return await fn();
    } finally {
      await this.release(key, result.token);
    }
  }
}
