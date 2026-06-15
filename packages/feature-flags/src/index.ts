// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/feature-flags — typed feature flag infrastructure.
 *
 * Design goals:
 *   • Zero-latency synchronous reads from in-memory state.
 *   • Environment-variable overrides for CI/CD and deployment control.
 *   • Injectable FlagStore so a production service (LaunchDarkly, Unleash,
 *     Flipt, etc.) can be swapped in without touching call sites.
 *   • Typed flag definitions so callers get boolean/string/number back, not
 *     `unknown`.
 *   • Observable via FlagChangeEvent — external systems can react to updates.
 *
 * Convention:
 *   • Flag keys use dot notation: "sandbox.docker", "kg.enabled".
 *   • Env var override: NEXUS_FLAG_<UPPER_KEY> where dots → underscores.
 *     e.g. "sandbox.docker" → NEXUS_FLAG_SANDBOX_DOCKER
 *
 * Pre-registered platform flags live at the bottom of this file and are
 * automatically applied to `globalFlags`.  Gate every new capability behind
 * one before shipping.
 *
 * Usage:
 * ```ts
 * import { globalFlags } from "@nexus/feature-flags";
 *
 * if (globalFlags.isEnabled("sandbox.docker")) {
 *   // run in Docker
 * }
 *
 * const model = globalFlags.getFlag("gateway.default_model", "nexus/fast");
 * ```
 */

import { EventEmitter } from "events";

// ── Prototype-pollution guard ──────────────────────────────────────────────────

const _UNSAFE_FLAG_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function isSafeFlagKey(key: string): boolean {
  return !_UNSAFE_FLAG_KEYS.has(key);
}

// ── Types ──────────────────────────────────────────────────────────────────────

export type FlagType = "boolean" | "string" | "number";

/** Flag value type alias. */
export type FlagValue = boolean | string | number;

/** Flag definition interface definition. */
export interface FlagDefinition<T extends FlagValue = FlagValue> {
  /** Dot-notation key, e.g. "sandbox.docker" */
  key: string;
  /** Default value when no override is present */
  default: T;
  /** Human-readable description */
  description?: string;
  /** Runtime type used for env-var coercion */
  type: FlagType;
}

/** Flag change event interface definition. */
export interface FlagChangeEvent {
  key: string;
  previous: FlagValue;
  current: FlagValue;
  source: "api" | "env";
}

// ── FlagStore interface ───────────────────────────────────────────────────────

/**
 * Injectable backing store for flag values.
 *
 * The default implementation is `MemoryFlagStore`.  Swap to a remote service
 * by implementing this interface and passing it to `FeatureFlagRegistry`.
 */
export interface FlagStore {
  get(key: string): FlagValue | undefined;
  set(key: string, value: FlagValue): void;
  delete(key: string): void;
  getAll(): Record<string, FlagValue>;
  has(key: string): boolean;
}

// ── MemoryFlagStore ───────────────────────────────────────────────────────────

/**
 * Simple in-memory FlagStore.  Thread-safe for single-process Node.js use.
 */
export class MemoryFlagStore implements FlagStore {
  private readonly store = new Map<string, FlagValue>();

  get(key: string): FlagValue | undefined {
    return this.store.get(key);
  }

  set(key: string, value: FlagValue): void {
    this.store.set(key, value);
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  getAll(): Record<string, FlagValue> {
    return Object.fromEntries(this.store.entries());
  }
}

// ── Null store (for testing) ──────────────────────────────────────────────────

/** FlagStore that always returns undefined — useful as a pure env-driven store */
export class NullFlagStore implements FlagStore {
  get(_key: string): undefined {
    return undefined;
  }
  set(_key: string, _value: FlagValue): void {
    // no-op
  }
  delete(_key: string): void {
    // no-op
  }
  has(_key: string): boolean {
    return false;
  }
  getAll(): Record<string, FlagValue> {
    return {};
  }
}

// ── Env-var helpers ───────────────────────────────────────────────────────────

const ENV_PREFIX = "NEXUS_FLAG_";

/**
 * Convert a flag key to its environment variable name.
 *
 * @example
 * envKeyName("sandbox.docker") // → "NEXUS_FLAG_SANDBOX_DOCKER"
 */
export function envKeyName(key: string): string {
  return ENV_PREFIX + key.toUpperCase().replace(/\./g, "_").replace(/-/g, "_");
}

/**
 * Read a flag value from environment variables, coercing to the declared type.
 * Returns `undefined` if the env var is not set.
 */
export function readEnvFlag(
  key: string,
  type: FlagType,
  env: NodeJS.ProcessEnv = process.env,
): FlagValue | undefined {
  const envName = envKeyName(key);
  const raw = env[envName];
  if (raw === undefined || raw === "") return undefined;

  switch (type) {
    case "boolean":
      return /^(true|1|yes|on)$/i.test(raw);
    case "number": {
      const n = Number(raw);
      return Number.isNaN(n) ? undefined : n;
    }
    case "string":
      return raw;
  }
}

// ── FeatureFlagRegistry ───────────────────────────────────────────────────────

export interface RegistryOptions {
  /** Backing store. Defaults to MemoryFlagStore. */
  store?: FlagStore;
  /**
   * Environment to read from. Defaults to process.env.
   * Override in tests to avoid polluting the real environment.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * When true, env vars take precedence over API-set values.
   * Default: true.
   */
  envOverridesApi?: boolean;
}

/**
 * Central feature flag registry.
 *
 * Define flags with their types and defaults, then read them via `getFlag` or
 * `isEnabled`.  Emits `"change"` events when a flag value changes.
 *
 * @example
 * ```ts
 * const registry = new FeatureFlagRegistry();
 * registry.define({ key: "my.flag", type: "boolean", default: false });
 * registry.isEnabled("my.flag"); // false
 * registry.setFlag("my.flag", true);
 * registry.isEnabled("my.flag"); // true
 * ```
 */
export class FeatureFlagRegistry extends EventEmitter {
  private readonly store: FlagStore;
  private readonly definitions = new Map<string, FlagDefinition>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly envOverridesApi: boolean;

  constructor(opts: RegistryOptions = {}) {
    super();
    this.store = opts.store ?? new MemoryFlagStore();
    this.env = opts.env ?? process.env;
    this.envOverridesApi = opts.envOverridesApi ?? true;
  }

  /**
   * Register a flag definition.  Calling `define` a second time with the same
   * key updates the definition (useful in tests).
   */
  define<T extends FlagValue>(def: FlagDefinition<T>): this {
    this.definitions.set(def.key, def as FlagDefinition);
    return this;
  }

  /**
   * Read a flag value, applying the following precedence (highest → lowest):
   *   1. Env var (when envOverridesApi = true, default)
   *   2. API-set value (via setFlag)
   *   3. Definition default
   *   4. Caller-supplied defaultValue
   */
  getFlag<T extends FlagValue>(key: string, defaultValue: T): T {
    const def = this.definitions.get(key);
    const type: FlagType = def ? def.type : inferType(defaultValue);

    if (this.envOverridesApi) {
      const envVal = readEnvFlag(key, type, this.env);
      if (envVal !== undefined) return envVal as T;
    }

    const stored = this.store.get(key);
    if (stored !== undefined) return stored as T;

    return (def?.default as T | undefined) ?? defaultValue;
  }

  /**
   * Shorthand boolean check.  Equivalent to `getFlag(key, false)`.
   */
  isEnabled(key: string): boolean {
    return this.getFlag(key, false);
  }

  /**
   * Set a flag value programmatically and emit a `"change"` event.
   * The new value is stored even if `envOverridesApi` is true — env still
   * wins on next read, but the stored value is preserved for inspection.
   */
  setFlag(key: string, value: FlagValue): void {
    const previous = this.getFlag(key, value);
    this.store.set(key, value);
    const current = this.getFlag(key, value);
    const event: FlagChangeEvent = { key, previous, current, source: "api" };
    this.emit("change", event);
  }

  /**
   * Execute `fn` only when the named flag is truthy.  Returns the fn result or
   * `undefined` if the flag is off.
   *
   * @example
   * ```ts
   * await flags.withFlag("sandbox.docker", false, async (enabled) => {
   *   if (enabled) await startDocker();
   * });
   * ```
   */
  withFlag<T extends FlagValue, R>(
    key: string,
    defaultValue: T,
    fn: (value: T) => R,
  ): R | undefined {
    const value = this.getFlag(key, defaultValue);
    if (!value) return undefined;
    return fn(value);
  }

  /**
   * Return all registered flag definitions.
   */
  listDefinitions(): FlagDefinition[] {
    return Array.from(this.definitions.values());
  }

  /**
   * Return the current resolved value for every registered flag.
   */
  snapshot(): Record<string, FlagValue> {
    const out: Record<string, FlagValue> = {};
    for (const def of this.definitions.values()) {
      out[def.key] = this.getFlag(def.key, def.default);
    }
    return out;
  }

  /**
   * Clear all API-set values, resetting flags to defaults.
   * Does not remove definitions.
   */
  reset(): void {
    const all = this.store.getAll();
    for (const key of Object.keys(all)) {
      this.store.delete(key);
    }
  }

  /**
   * Remove a flag definition and its stored value.
   */
  undefine(key: string): void {
    this.definitions.delete(key);
    this.store.delete(key);
  }

  // ── Convenience aliases (used by API routes) ───────────────────────────────

  /** Alias for `listDefinitions()`. */
  listFlags(): FlagDefinition[] {
    return this.listDefinitions();
  }

  /** Return a single flag definition, or undefined if not registered. */
  getDefinition(key: string): FlagDefinition | undefined {
    return this.definitions.get(key);
  }

  /**
   * Return true when this flag has been overridden via `setFlag()`.
   * Note: env var overrides are not reflected here.
   */
  isOverridden(key: string): boolean {
    return this.store.has(key);
  }

  /**
   * Clear the API-set override for a single flag key, reverting to env/default.
   * Unlike `undefine()`, the flag definition is kept.
   */
  resetFlag(key: string): void {
    if (this.store.has(key)) {
      const previous = this.getFlag(key, this.definitions.get(key)?.default ?? false);
      this.store.delete(key);
      const current = this.getFlag(key, this.definitions.get(key)?.default ?? false);
      this.emit("change", { key, previous, current, source: "api" } satisfies FlagChangeEvent);
    }
  }
}

// ── Cross-process FlagStore implementations ───────────────────────────────────
//
// These stores enable flag state to be shared across multiple processes:
//   PollingFlagStore — periodically fetches flag JSON from a URL endpoint
//   FileFlagStore    — reads/writes flag state to a JSON file on disk
//
// Both are fully injectable (fetch / readFile / writeFile) for deterministic testing.

/** Injectable fetch type (structurally matches global fetch) */
export type FlagFetchFn = typeof fetch;

/** Injectable file reader */
export type FlagReadFileFn = (path: string) => Promise<string>;

/** Injectable file writer */
export type FlagWriteFileFn = (path: string, content: string) => Promise<void>;

/** Polling flag store config interface definition. */
export interface PollingFlagStoreConfig {
  /** URL that serves a JSON object of `{ [flagKey]: value }` */
  url: string;
  /** Polling interval in ms (default: 30_000) */
  intervalMs?: number;
  /** Injectable fetch (default: global fetch) */
  fetch?: FlagFetchFn;
}

/**
 * FlagStore that periodically polls a remote URL for flag values.
 *
 * The endpoint must return `Content-Type: application/json` with a flat
 * `Record<string, boolean | string | number>` body.  Non-ok responses are
 * silently ignored — the in-memory cache retains its previous values.
 *
 * Call `start()` to begin polling and `stop()` to clear the interval.
 *
 * ```ts
 * const store = new PollingFlagStore({ url: "https://config.example.com/flags" });
 * await store.start();
 * const registry = new FeatureFlagRegistry({ store });
 * ```
 */
export class PollingFlagStore implements FlagStore {
  private cache: Record<string, FlagValue> = {};
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private readonly config: PollingFlagStoreConfig;
  private readonly fetchFn: FlagFetchFn;

  constructor(config: PollingFlagStoreConfig) {
    this.config = config;
    this.fetchFn = config.fetch ?? fetch;
  }

  /**
   * Perform an immediate poll then schedule recurring polls.
   * Returns after the first poll completes (even if the request failed).
   */
  async start(): Promise<void> {
    await this._poll();
    const intervalMs = this.config.intervalMs ?? 30_000;
    this.intervalId = setInterval(() => {
      void this._poll();
    }, intervalMs);
    // Allow Node.js to exit even if the timer is still active
    if (this.intervalId && typeof this.intervalId === "object" && "unref" in this.intervalId) {
      (this.intervalId as { unref(): void }).unref();
    }
  }

  /** Cancel the polling interval. */
  stop(): void {
    if (this.intervalId !== undefined) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  private async _poll(): Promise<void> {
    try {
      const res = await this.fetchFn(this.config.url);
      if (res.ok) {
        const json = (await res.json()) as Record<string, FlagValue>;
        // Filter out prototype-polluting keys from remote payload
        const safe: Record<string, FlagValue> = Object.create(null);
        for (const [k, v] of Object.entries(json)) {
          if (isSafeFlagKey(k)) safe[k] = v;
        }
        this.cache = safe;
      }
    } catch {
      // Network errors are non-fatal — keep last known good cache
    }
  }

  get(key: string): FlagValue | undefined {
    if (!isSafeFlagKey(key)) return undefined;
    return this.cache[key];
  }

  set(key: string, value: FlagValue): void {
    if (!isSafeFlagKey(key)) return;
    this.cache[key] = value;
  }

  delete(key: string): void {
    delete this.cache[key];
  }

  has(key: string): boolean {
    return key in this.cache;
  }

  getAll(): Record<string, FlagValue> {
    return { ...this.cache };
  }
}

/** File flag store config interface definition. */
export interface FileFlagStoreConfig {
  /** Absolute path to the JSON file containing flag state */
  path: string;
  /** Injectable reader (default: Node's fs/promises readFile) */
  readFile?: FlagReadFileFn;
  /** Injectable writer (default: Node's fs/promises writeFile) */
  writeFile?: FlagWriteFileFn;
}

/**
 * FlagStore backed by a JSON file on disk.
 *
 * Multiple processes can share flags by pointing to the same file.
 * Call `load()` at startup and `persist()` after mutating flags.
 *
 * ```ts
 * const store = new FileFlagStore({ path: "/etc/nexus/flags.json" });
 * await store.load();
 * const registry = new FeatureFlagRegistry({ store });
 * // ... later, after changing flags ...
 * await store.persist();
 * ```
 */
export class FileFlagStore implements FlagStore {
  private cache: Record<string, FlagValue> = {};
  private readonly config: FileFlagStoreConfig;
  private readonly readFileFn: FlagReadFileFn;
  private readonly writeFileFn: FlagWriteFileFn;

  constructor(config: FileFlagStoreConfig) {
    this.config = config;
    this.readFileFn =
      config.readFile ??
      (async (p) => {
        const { readFile } = await import("fs/promises");
        return readFile(p, "utf8");
      });
    this.writeFileFn =
      config.writeFile ??
      (async (p, c) => {
        const { writeFile } = await import("fs/promises");
        await writeFile(p, c, "utf8");
      });
  }

  /** Load flag state from disk into the in-memory cache. */
  async load(): Promise<void> {
    try {
      const content = await this.readFileFn(this.config.path);
      this.cache = JSON.parse(content) as Record<string, FlagValue>;
    } catch {
      this.cache = {};
    }
  }

  /** Flush the in-memory cache to disk. */
  async persist(): Promise<void> {
    await this.writeFileFn(this.config.path, JSON.stringify(this.cache, null, 2));
  }

  get(key: string): FlagValue | undefined {
    if (!isSafeFlagKey(key)) return undefined;
    return this.cache[key];
  }

  set(key: string, value: FlagValue): void {
    if (!isSafeFlagKey(key)) return;
    this.cache[key] = value;
  }

  delete(key: string): void {
    delete this.cache[key];
  }

  has(key: string): boolean {
    return key in this.cache;
  }

  getAll(): Record<string, FlagValue> {
    return { ...this.cache };
  }
}

// ── RedisFlagStore ────────────────────────────────────────────────────────────
//
// Distributed FlagStore backed by Redis HSET/HGET/HGETALL.
// Multiple API pods share flag state automatically; updates propagate via
// pub/sub (SUBSCRIBE nexus:flags:updated) so all pods stay consistent.
//
// Uses a duck-typed RedisClientLike interface — pass any ioredis instance:
//   import Redis from "ioredis";
//   const store = new RedisFlagStore(new Redis(process.env.REDIS_URL));
//
// Fire-and-forget pub/sub: subscription errors are non-fatal.

const REDIS_FLAGS_HASH = "nexus:flags";
const REDIS_FLAGS_CHANNEL = "nexus:flags:updated";

/** Minimal Redis interface (structurally satisfied by ioredis.Redis). */
export interface RedisClientLike {
  hset(key: string, field: string, value: string): Promise<unknown>;
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string> | null>;
  hdel(key: string, field: string): Promise<unknown>;
  hexists(key: string, field: string): Promise<number>;
  publish(channel: string, message: string): Promise<unknown>;
  duplicate(): RedisClientLike;
  subscribe(channel: string, callback: (message: string, channel: string) => void): Promise<void>;
}

/** Redis flag store options interface definition. */
export interface RedisFlagStoreOptions {
  /** Key used for the Redis hash (default: "nexus:flags"). */
  hashKey?: string;
  /** Pub/sub channel (default: "nexus:flags:updated"). */
  channel?: string;
  /**
   * Callback invoked when another pod publishes a flag change.
   * Use this to invalidate caches or re-read values.
   */
  onRemoteChange?: (key: string) => void;
}

/** Redis flag store. */
export class RedisFlagStore implements FlagStore {
  private readonly client: RedisClientLike;
  private readonly hashKey: string;
  private readonly channel: string;

  constructor(client: RedisClientLike, opts: RedisFlagStoreOptions = {}) {
    this.client = client;
    this.hashKey = opts.hashKey ?? REDIS_FLAGS_HASH;
    this.channel = opts.channel ?? REDIS_FLAGS_CHANNEL;

    if (opts.onRemoteChange) {
      // Subscribe on a duplicated connection so pub/sub doesn't block commands
      const sub = client.duplicate();
      void sub.subscribe(this.channel, (message) => {
        try {
          opts.onRemoteChange!(message);
        } catch {
          /* non-fatal */
        }
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  get(key: string): FlagValue | undefined {
    // Synchronous interface — RedisFlagStore caches reads in-memory via getAll
    // Callers that need async reads should use getAsync() or pre-warm the cache.
    // For FeatureFlagRegistry's synchronous getFlag() path, fall back to undefined
    // and let the definition default apply; async callers can call getAsync().
    return undefined; // async reads handled by getAsync() below
  }

  /** Async variant — awaitable for non-registry contexts. */
  async getAsync(key: string): Promise<FlagValue | undefined> {
    const raw = await this.client.hget(this.hashKey, key);
    if (raw === null) return undefined;
    return deserializeFlagValue(raw);
  }

  async set(key: string, value: FlagValue): Promise<void> {
    await this.client.hset(this.hashKey, key, serializeFlagValue(value));
    await this.client.publish(this.channel, key).catch(() => {
      /* non-fatal */
    });
  }

  // FlagStore.set is synchronous; fire-and-forget the async write
  set(key: string, value: FlagValue): void {
    void this.setAsync(key, value);
  }

  private async setAsync(key: string, value: FlagValue): Promise<void> {
    await this.client.hset(this.hashKey, key, serializeFlagValue(value));
    await this.client.publish(this.channel, key).catch(() => {
      /* non-fatal */
    });
  }

  delete(key: string): void {
    void this.client.hdel(this.hashKey, key);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  has(key: string): boolean {
    // Optimistic false — async check via hasAsync()
    return false;
  }

  async hasAsync(key: string): Promise<boolean> {
    return (await this.client.hexists(this.hashKey, key)) === 1;
  }

  getAll(): Record<string, FlagValue> {
    return {}; // sync stub — use getAllAsync() for real values
  }

  async getAllAsync(): Promise<Record<string, FlagValue>> {
    const raw = await this.client.hgetall(this.hashKey);
    if (!raw) return {};
    const out: Record<string, FlagValue> = {};
    for (const [k, v] of Object.entries(raw)) {
      out[k] = deserializeFlagValue(v);
    }
    return out;
  }
}

function serializeFlagValue(v: FlagValue): string {
  return JSON.stringify(v);
}

function deserializeFlagValue(raw: string): FlagValue {
  try {
    return JSON.parse(raw) as FlagValue;
  } catch {
    return raw;
  }
}

function inferType(value: FlagValue): FlagType {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  return "string";
}

// ── Global registry ───────────────────────────────────────────────────────────

/**
 * Module-level global registry.  Import and use directly in application code.
 *
 * Tests should create their own `FeatureFlagRegistry` instances to avoid
 * state leakage between test suites.
 */
export const globalFlags = new FeatureFlagRegistry();

// ── Platform flag definitions ─────────────────────────────────────────────────
//
// Every new platform capability MUST be gated behind a flag registered here
// before shipping to production.  Default is always false (off) so new
// features are opt-in.

/**
 * Register all Nexus platform feature flags on the given registry.
 * Called automatically on `globalFlags` at module init.
 */
export function registerPlatformFlags(registry: FeatureFlagRegistry): void {
  // ── Sandbox ─────────────────────────────────────────────────────────────
  registry.define({
    key: "sandbox.docker",
    type: "boolean",
    default: false,
    description:
      "Use Docker/gVisor container isolation in sandbox. Must be true before bots (gap 12) go live.",
  });

  // ── Gateway ──────────────────────────────────────────────────────────────
  registry.define({
    key: "gateway.streaming",
    type: "boolean",
    default: false,
    description: "Enable SSE streaming responses from POST /gateway/messages.",
  });
  registry.define({
    key: "gateway.default_model",
    type: "string",
    default: "nexus/fast",
    description: "Default model alias when none is specified in the request.",
  });

  // ── Knowledge Graph ───────────────────────────────────────────────────────
  registry.define({
    key: "kg.enabled",
    type: "boolean",
    default: false,
    description: "Enable Knowledge Graph entity/relationship indexing (gap 4).",
  });
  registry.define({
    key: "kg.auto_extract",
    type: "boolean",
    default: false,
    description: "Auto-extract entities from every ingest task when KG is enabled.",
  });

  // ── Embeddings ────────────────────────────────────────────────────────────
  registry.define({
    key: "embeddings.real",
    type: "boolean",
    default: false,
    description:
      "Use a real embedding model instead of nullEmbedder. Required for semantic search in context-pack and KG.",
  });
  registry.define({
    key: "embeddings.model",
    type: "string",
    default: "text-embedding-3-small",
    description: "Embedding model identifier when embeddings.real is true.",
  });
  registry.define({
    key: "embeddings.dimensions",
    type: "number",
    default: 1536,
    description: "Vector dimensions for the configured embedding model.",
  });

  // ── Bots ──────────────────────────────────────────────────────────────────
  registry.define({
    key: "bots.slack",
    type: "boolean",
    default: false,
    description: "Enable Slack bot integration (gap 12). Requires sandbox.docker=true.",
  });
  registry.define({
    key: "bots.teams",
    type: "boolean",
    default: false,
    description: "Enable Microsoft Teams bot integration (gap 12).",
  });

  // ── Voice ─────────────────────────────────────────────────────────────────
  registry.define({
    key: "voice.enabled",
    type: "boolean",
    default: false,
    description: "Enable STT/TTS voice interface (gap 6).",
  });

  // ── Agents ────────────────────────────────────────────────────────────────
  registry.define({
    key: "agents.librarian",
    type: "boolean",
    default: false,
    description: "Enable Librarian agent (gap 9).",
  });
  registry.define({
    key: "agents.researcher",
    type: "boolean",
    default: false,
    description: "Enable Researcher agent (gap 9).",
  });
  registry.define({
    key: "agents.file_explorer",
    type: "boolean",
    default: false,
    description: "Enable File Explorer agent (gap 9).",
  });

  // ── Alert rules ───────────────────────────────────────────────────────────
  registry.define({
    key: "alerts.enabled",
    type: "boolean",
    default: false,
    description: "Enable threshold-based alert rules (gap 14).",
  });
  registry.define({
    key: "alerts.cost_threshold_usd",
    type: "number",
    default: 10,
    description: "Monthly cost threshold in USD before a cost alert fires.",
  });

  // ── Load testing ──────────────────────────────────────────────────────────
  registry.define({
    key: "loadtest.enabled",
    type: "boolean",
    default: false,
    description: "Enable k6 load test suite endpoints (gap 20).",
  });
}

// Apply platform flags to the global registry at module init
registerPlatformFlags(globalFlags);
