// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  MemoryFlagStore,
  NullFlagStore,
  PollingFlagStore,
  FileFlagStore,
  FeatureFlagRegistry,
  envKeyName,
  readEnvFlag,
  registerPlatformFlags,
  globalFlags,
  type FlagChangeEvent,
  type FlagValue,
  type FlagReadFileFn,
  type FlagWriteFileFn,
} from "../src/index.js";

// ── MemoryFlagStore ───────────────────────────────────────────────────────────

describe("MemoryFlagStore", () => {
  it("get returns undefined for unknown key", () => {
    expect(new MemoryFlagStore().get("missing")).toBeUndefined();
  });

  it("set then get returns the value", () => {
    const s = new MemoryFlagStore();
    s.set("k", true);
    expect(s.get("k")).toBe(true);
  });

  it("set overwrites existing value", () => {
    const s = new MemoryFlagStore();
    s.set("k", "old");
    s.set("k", "new");
    expect(s.get("k")).toBe("new");
  });

  it("delete removes the value", () => {
    const s = new MemoryFlagStore();
    s.set("k", 42);
    s.delete("k");
    expect(s.get("k")).toBeUndefined();
  });

  it("has returns true for existing key", () => {
    const s = new MemoryFlagStore();
    s.set("k", false);
    expect(s.has("k")).toBe(true);
  });

  it("has returns false for missing key", () => {
    expect(new MemoryFlagStore().has("x")).toBe(false);
  });

  it("getAll returns all stored entries", () => {
    const s = new MemoryFlagStore();
    s.set("a", 1);
    s.set("b", "two");
    const all = s.getAll();
    expect(all).toMatchObject({ a: 1, b: "two" });
  });

  it("getAll returns empty object when empty", () => {
    expect(new MemoryFlagStore().getAll()).toEqual({});
  });
});

// ── NullFlagStore ─────────────────────────────────────────────────────────────

describe("NullFlagStore", () => {
  const s = new NullFlagStore();

  it("get always returns undefined", () => expect(s.get("any")).toBeUndefined());
  it("has always returns false", () => expect(s.has("any")).toBe(false));
  it("getAll always returns {}", () => expect(s.getAll()).toEqual({}));
  it("set is a no-op (no throw)", () => expect(() => s.set("k", 1)).not.toThrow());
  it("delete is a no-op (no throw)", () => expect(() => s.delete("k")).not.toThrow());
});

// ── envKeyName ────────────────────────────────────────────────────────────────

describe("envKeyName", () => {
  it("uppercases and replaces dots with underscores", () => {
    expect(envKeyName("sandbox.docker")).toBe("NEXUS_FLAG_SANDBOX_DOCKER");
  });

  it("replaces hyphens with underscores", () => {
    expect(envKeyName("my-feature.enabled")).toBe("NEXUS_FLAG_MY_FEATURE_ENABLED");
  });

  it("handles multi-level keys", () => {
    expect(envKeyName("a.b.c.d")).toBe("NEXUS_FLAG_A_B_C_D");
  });

  it("handles already-uppercase keys", () => {
    expect(envKeyName("KG.ENABLED")).toBe("NEXUS_FLAG_KG_ENABLED");
  });
});

// ── readEnvFlag ───────────────────────────────────────────────────────────────

describe("readEnvFlag", () => {
  it("returns undefined when env var is absent", () => {
    expect(readEnvFlag("my.flag", "boolean", {})).toBeUndefined();
  });

  it("returns undefined for empty string env var", () => {
    expect(readEnvFlag("my.flag", "boolean", { NEXUS_FLAG_MY_FLAG: "" })).toBeUndefined();
  });

  it("parses 'true' as boolean true", () => {
    expect(readEnvFlag("f", "boolean", { NEXUS_FLAG_F: "true" })).toBe(true);
  });

  it("parses '1' as boolean true", () => {
    expect(readEnvFlag("f", "boolean", { NEXUS_FLAG_F: "1" })).toBe(true);
  });

  it("parses 'yes' as boolean true", () => {
    expect(readEnvFlag("f", "boolean", { NEXUS_FLAG_F: "yes" })).toBe(true);
  });

  it("parses 'on' as boolean true", () => {
    expect(readEnvFlag("f", "boolean", { NEXUS_FLAG_F: "on" })).toBe(true);
  });

  it("parses 'false' as boolean false", () => {
    expect(readEnvFlag("f", "boolean", { NEXUS_FLAG_F: "false" })).toBe(false);
  });

  it("parses '0' as boolean false", () => {
    expect(readEnvFlag("f", "boolean", { NEXUS_FLAG_F: "0" })).toBe(false);
  });

  it("parses numeric string as number", () => {
    expect(readEnvFlag("f", "number", { NEXUS_FLAG_F: "42" })).toBe(42);
  });

  it("parses float string as number", () => {
    expect(readEnvFlag("f", "number", { NEXUS_FLAG_F: "3.14" })).toBeCloseTo(3.14);
  });

  it("returns undefined for non-numeric string with number type", () => {
    expect(readEnvFlag("f", "number", { NEXUS_FLAG_F: "abc" })).toBeUndefined();
  });

  it("returns raw string for string type", () => {
    expect(readEnvFlag("f", "string", { NEXUS_FLAG_F: "nexus/smart" })).toBe("nexus/smart");
  });

  it("is case-insensitive for boolean TRUE", () => {
    expect(readEnvFlag("f", "boolean", { NEXUS_FLAG_F: "TRUE" })).toBe(true);
  });
});

// ── FeatureFlagRegistry — basic operations ────────────────────────────────────

describe("FeatureFlagRegistry — basic", () => {
  let reg: FeatureFlagRegistry;

  beforeEach(() => {
    reg = new FeatureFlagRegistry({ env: {} });
  });

  it("getFlag returns caller defaultValue for undefined key", () => {
    expect(reg.getFlag("unknown", false)).toBe(false);
    expect(reg.getFlag("unknown", "hello")).toBe("hello");
    expect(reg.getFlag("unknown", 42)).toBe(42);
  });

  it("define then getFlag returns definition default", () => {
    reg.define({ key: "my.flag", type: "boolean", default: true });
    expect(reg.getFlag("my.flag", false)).toBe(true);
  });

  it("isEnabled returns false for undefined boolean flag", () => {
    expect(reg.isEnabled("never.defined")).toBe(false);
  });

  it("isEnabled returns definition default", () => {
    reg.define({ key: "feat.on", type: "boolean", default: true });
    expect(reg.isEnabled("feat.on")).toBe(true);
  });

  it("setFlag overrides stored value", () => {
    reg.define({ key: "f", type: "boolean", default: false });
    reg.setFlag("f", true);
    expect(reg.isEnabled("f")).toBe(true);
  });

  it("setFlag emits change event", () => {
    reg.define({ key: "f", type: "boolean", default: false });
    const handler = vi.fn();
    reg.on("change", handler);
    reg.setFlag("f", true);
    expect(handler).toHaveBeenCalledTimes(1);
    const evt = handler.mock.calls[0]![0] as FlagChangeEvent;
    expect(evt.key).toBe("f");
    expect(evt.source).toBe("api");
    expect(evt.current).toBe(true);
  });

  it("reset clears API-set values, restoring defaults", () => {
    reg.define({ key: "f", type: "boolean", default: false });
    reg.setFlag("f", true);
    reg.reset();
    expect(reg.isEnabled("f")).toBe(false);
  });

  it("reset does not remove definitions", () => {
    reg.define({ key: "f", type: "boolean", default: false });
    reg.reset();
    expect(reg.listDefinitions()).toHaveLength(1);
  });

  it("undefine removes the definition and stored value", () => {
    reg.define({ key: "f", type: "boolean", default: true });
    reg.setFlag("f", false);
    reg.undefine("f");
    expect(reg.listDefinitions()).toHaveLength(0);
    expect(reg.getFlag("f", true)).toBe(true); // back to caller default
  });

  it("listDefinitions returns all registered definitions", () => {
    reg.define({ key: "a", type: "boolean", default: false });
    reg.define({ key: "b", type: "string", default: "x" });
    expect(reg.listDefinitions()).toHaveLength(2);
  });

  it("define called twice updates the definition", () => {
    reg.define({ key: "f", type: "boolean", default: false });
    reg.define({ key: "f", type: "boolean", default: true });
    expect(reg.getFlag("f", false)).toBe(true);
  });
});

// ── FeatureFlagRegistry — env-var override ────────────────────────────────────

describe("FeatureFlagRegistry — env override", () => {
  it("env var takes precedence over definition default", () => {
    const reg = new FeatureFlagRegistry({
      env: { NEXUS_FLAG_SANDBOX_DOCKER: "true" },
    });
    reg.define({ key: "sandbox.docker", type: "boolean", default: false });
    expect(reg.isEnabled("sandbox.docker")).toBe(true);
  });

  it("env var takes precedence over API-set value when envOverridesApi=true", () => {
    const reg = new FeatureFlagRegistry({
      env: { NEXUS_FLAG_MY_FLAG: "false" },
      envOverridesApi: true,
    });
    reg.define({ key: "my.flag", type: "boolean", default: true });
    reg.setFlag("my.flag", true);
    expect(reg.isEnabled("my.flag")).toBe(false);
  });

  it("API-set value wins when envOverridesApi=false", () => {
    const reg = new FeatureFlagRegistry({
      env: { NEXUS_FLAG_MY_FLAG: "false" },
      envOverridesApi: false,
    });
    reg.define({ key: "my.flag", type: "boolean", default: false });
    reg.setFlag("my.flag", true);
    expect(reg.isEnabled("my.flag")).toBe(true);
  });

  it("string flag read from env", () => {
    const reg = new FeatureFlagRegistry({
      env: { NEXUS_FLAG_GATEWAY_DEFAULT_MODEL: "nexus/smart" },
    });
    reg.define({ key: "gateway.default_model", type: "string", default: "nexus/fast" });
    expect(reg.getFlag("gateway.default_model", "nexus/fast")).toBe("nexus/smart");
  });

  it("number flag read from env", () => {
    const reg = new FeatureFlagRegistry({
      env: { NEXUS_FLAG_ALERTS_COST_THRESHOLD_USD: "50" },
    });
    reg.define({ key: "alerts.cost_threshold_usd", type: "number", default: 10 });
    expect(reg.getFlag("alerts.cost_threshold_usd", 10)).toBe(50);
  });
});

// ── FeatureFlagRegistry — withFlag ────────────────────────────────────────────

describe("FeatureFlagRegistry — withFlag", () => {
  let reg: FeatureFlagRegistry;

  beforeEach(() => {
    reg = new FeatureFlagRegistry({ env: {} });
  });

  it("executes fn when flag is true", () => {
    reg.define({ key: "f", type: "boolean", default: true });
    const result = reg.withFlag("f", false, (v) => `got ${String(v)}`);
    expect(result).toBe("got true");
  });

  it("returns undefined when flag is false", () => {
    reg.define({ key: "f", type: "boolean", default: false });
    const result = reg.withFlag("f", false, () => "should not run");
    expect(result).toBeUndefined();
  });

  it("passes the resolved flag value to fn", () => {
    reg.define({ key: "model", type: "string", default: "nexus/smart" });
    const fn = vi.fn().mockReturnValue("ok");
    reg.withFlag("model", "", fn);
    expect(fn).toHaveBeenCalledWith("nexus/smart");
  });

  it("does not call fn when flag is empty string", () => {
    reg.define({ key: "model", type: "string", default: "" });
    const fn = vi.fn();
    reg.withFlag("model", "", fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it("does not call fn when flag is 0", () => {
    reg.define({ key: "count", type: "number", default: 0 });
    const fn = vi.fn();
    reg.withFlag("count", 0, fn);
    expect(fn).not.toHaveBeenCalled();
  });
});

// ── FeatureFlagRegistry — snapshot ───────────────────────────────────────────

describe("FeatureFlagRegistry — snapshot", () => {
  it("returns resolved values for all defined flags", () => {
    const reg = new FeatureFlagRegistry({ env: {} });
    reg.define({ key: "a", type: "boolean", default: false });
    reg.define({ key: "b", type: "string", default: "x" });
    reg.setFlag("a", true);
    const snap = reg.snapshot();
    expect(snap["a"]).toBe(true);
    expect(snap["b"]).toBe("x");
  });

  it("returns empty object when no flags defined", () => {
    const reg = new FeatureFlagRegistry({ env: {} });
    expect(reg.snapshot()).toEqual({});
  });
});

// ── Platform flags ────────────────────────────────────────────────────────────

describe("registerPlatformFlags", () => {
  let reg: FeatureFlagRegistry;

  beforeEach(() => {
    reg = new FeatureFlagRegistry({ env: {} });
    registerPlatformFlags(reg);
  });

  it("registers sandbox.docker as boolean default false", () => {
    expect(reg.isEnabled("sandbox.docker")).toBe(false);
  });

  it("registers gateway.streaming as boolean default false", () => {
    expect(reg.isEnabled("gateway.streaming")).toBe(false);
  });

  it("registers gateway.default_model as string 'nexus/fast'", () => {
    expect(reg.getFlag("gateway.default_model", "")).toBe("nexus/fast");
  });

  it("registers kg.enabled as boolean default false", () => {
    expect(reg.isEnabled("kg.enabled")).toBe(false);
  });

  it("registers kg.auto_extract as boolean default false", () => {
    expect(reg.isEnabled("kg.auto_extract")).toBe(false);
  });

  it("registers embeddings.real as boolean default false", () => {
    expect(reg.isEnabled("embeddings.real")).toBe(false);
  });

  it("registers embeddings.dimensions as number 1536", () => {
    expect(reg.getFlag("embeddings.dimensions", 0)).toBe(1536);
  });

  it("registers bots.slack as boolean default false", () => {
    expect(reg.isEnabled("bots.slack")).toBe(false);
  });

  it("registers bots.teams as boolean default false", () => {
    expect(reg.isEnabled("bots.teams")).toBe(false);
  });

  it("registers voice.enabled as boolean default false", () => {
    expect(reg.isEnabled("voice.enabled")).toBe(false);
  });

  it("registers agents.librarian as boolean default false", () => {
    expect(reg.isEnabled("agents.librarian")).toBe(false);
  });

  it("registers agents.researcher as boolean default false", () => {
    expect(reg.isEnabled("agents.researcher")).toBe(false);
  });

  it("registers agents.file_explorer as boolean default false", () => {
    expect(reg.isEnabled("agents.file_explorer")).toBe(false);
  });

  it("registers alerts.enabled as boolean default false", () => {
    expect(reg.isEnabled("alerts.enabled")).toBe(false);
  });

  it("registers alerts.cost_threshold_usd as number 10", () => {
    expect(reg.getFlag("alerts.cost_threshold_usd", 0)).toBe(10);
  });

  it("registers loadtest.enabled as boolean default false", () => {
    expect(reg.isEnabled("loadtest.enabled")).toBe(false);
  });

  it("all platform flags default to false for boolean flags", () => {
    const defs = reg.listDefinitions().filter((d) => d.type === "boolean");
    for (const def of defs) {
      expect(def.default).toBe(false);
    }
  });

  it("all flags have a description", () => {
    for (const def of reg.listDefinitions()) {
      expect(def.description).toBeTruthy();
    }
  });
});

// ── globalFlags ───────────────────────────────────────────────────────────────

describe("globalFlags", () => {
  it("is a FeatureFlagRegistry instance", () => {
    expect(globalFlags).toBeInstanceOf(FeatureFlagRegistry);
  });

  it("has platform flags pre-registered", () => {
    expect(globalFlags.listDefinitions().length).toBeGreaterThan(0);
  });

  it("sandbox.docker defaults to false", () => {
    expect(globalFlags.isEnabled("sandbox.docker")).toBe(false);
  });
});

// ── PollingFlagStore ──────────────────────────────────────────────────────────

/** Build a minimal Response-like object for the injected fetch mock */
function mockResponse(body: Record<string, FlagValue>, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("PollingFlagStore — cache operations", () => {
  it("starts with an empty cache", () => {
    const store = new PollingFlagStore({ url: "http://localhost/flags", fetch: vi.fn() });
    expect(store.getAll()).toEqual({});
  });

  it("get returns undefined for unknown key before any poll", () => {
    const store = new PollingFlagStore({ url: "http://localhost/flags", fetch: vi.fn() });
    expect(store.get("my.flag")).toBeUndefined();
  });

  it("has returns false for unknown key before any poll", () => {
    const store = new PollingFlagStore({ url: "http://localhost/flags", fetch: vi.fn() });
    expect(store.has("my.flag")).toBe(false);
  });

  it("set/get/has/delete work against the in-memory cache", () => {
    const store = new PollingFlagStore({ url: "http://localhost/flags", fetch: vi.fn() });
    store.set("feat.a", true);
    expect(store.has("feat.a")).toBe(true);
    expect(store.get("feat.a")).toBe(true);
    store.delete("feat.a");
    expect(store.has("feat.a")).toBe(false);
    expect(store.get("feat.a")).toBeUndefined();
  });

  it("getAll returns a shallow copy of the cache", () => {
    const store = new PollingFlagStore({ url: "http://localhost/flags", fetch: vi.fn() });
    store.set("x", 42);
    const all = store.getAll();
    expect(all["x"]).toBe(42);
    // mutating the returned object must not affect the store
    all["x"] = 99;
    expect(store.get("x")).toBe(42);
  });
});

describe("PollingFlagStore — start()", () => {
  it("polls the URL on start() and populates cache", async () => {
    const fetchFn = vi.fn().mockResolvedValue(mockResponse({ "my.flag": true, "count": 5 }));
    const store = new PollingFlagStore({ url: "http://localhost/flags", fetch: fetchFn });
    await store.start();
    store.stop();
    expect(fetchFn).toHaveBeenCalledWith("http://localhost/flags");
    expect(store.get("my.flag")).toBe(true);
    expect(store.get("count")).toBe(5);
    expect(store.has("my.flag")).toBe(true);
  });

  it("silently ignores non-ok responses (cache stays empty)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(mockResponse({}, false));
    const store = new PollingFlagStore({ url: "http://localhost/flags", fetch: fetchFn });
    await store.start();
    store.stop();
    expect(store.getAll()).toEqual({});
  });

  it("silently ignores network errors (cache stays empty)", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("Network failure"));
    const store = new PollingFlagStore({ url: "http://localhost/flags", fetch: fetchFn });
    await store.start();
    store.stop();
    expect(store.getAll()).toEqual({});
  });

  it("retains last good cache when a subsequent poll fails", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ "stable.flag": true }))
      .mockRejectedValueOnce(new Error("transient"));
    const store = new PollingFlagStore({ url: "http://localhost/flags", fetch: fetchFn });
    await store.start();
    store.stop();
    // Simulate a manual second poll
    await (store as unknown as { _poll(): Promise<void> })._poll();
    expect(store.get("stable.flag")).toBe(true); // cache preserved
  });

  it("replaces entire cache on each successful poll", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ "flag.a": true, "flag.b": false }))
      .mockResolvedValueOnce(mockResponse({ "flag.a": false })); // flag.b gone
    const store = new PollingFlagStore({ url: "http://localhost/flags", fetch: fetchFn });
    await store.start();
    store.stop();
    await (store as unknown as { _poll(): Promise<void> })._poll();
    expect(store.get("flag.a")).toBe(false);
    expect(store.has("flag.b")).toBe(false); // removed in second poll
  });
});

describe("PollingFlagStore — stop()", () => {
  it("stop() can be called before start() without throwing", () => {
    const store = new PollingFlagStore({ url: "http://localhost/flags", fetch: vi.fn() });
    expect(() => store.stop()).not.toThrow();
  });

  it("stop() can be called multiple times without throwing", async () => {
    const fetchFn = vi.fn().mockResolvedValue(mockResponse({}));
    const store = new PollingFlagStore({ url: "http://localhost/flags", fetch: fetchFn });
    await store.start();
    expect(() => {
      store.stop();
      store.stop();
    }).not.toThrow();
  });
});

describe("PollingFlagStore — FeatureFlagRegistry integration", () => {
  it("registry reads values loaded by PollingFlagStore", async () => {
    const fetchFn = vi.fn().mockResolvedValue(mockResponse({ "sandbox.docker": true }));
    const store = new PollingFlagStore({ url: "http://localhost/flags", fetch: fetchFn });
    await store.start();
    store.stop();
    const reg = new FeatureFlagRegistry({ store, env: {} });
    reg.define({ key: "sandbox.docker", type: "boolean", default: false });
    expect(reg.isEnabled("sandbox.docker")).toBe(true);
  });
});

// ── FileFlagStore ─────────────────────────────────────────────────────────────

describe("FileFlagStore — load()", () => {
  it("populates cache from valid JSON file", async () => {
    const readFile: FlagReadFileFn = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ "feat.on": true, "count": 7 }));
    const store = new FileFlagStore({ path: "/flags.json", readFile });
    await store.load();
    expect(store.get("feat.on")).toBe(true);
    expect(store.get("count")).toBe(7);
  });

  it("silently returns empty cache on ENOENT / read error", async () => {
    const readFile: FlagReadFileFn = vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const store = new FileFlagStore({ path: "/missing.json", readFile });
    await store.load();
    expect(store.getAll()).toEqual({});
  });

  it("silently returns empty cache on invalid JSON", async () => {
    const readFile: FlagReadFileFn = vi.fn().mockResolvedValue("not-json{{{");
    const store = new FileFlagStore({ path: "/bad.json", readFile });
    await store.load();
    expect(store.getAll()).toEqual({});
  });

  it("replaces previous cache on second load()", async () => {
    const readFile: FlagReadFileFn = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ "flag.a": true }))
      .mockResolvedValueOnce(JSON.stringify({ "flag.b": false }));
    const store = new FileFlagStore({ path: "/flags.json", readFile });
    await store.load();
    expect(store.has("flag.a")).toBe(true);
    await store.load();
    expect(store.has("flag.a")).toBe(false); // replaced
    expect(store.get("flag.b")).toBe(false);
  });
});

describe("FileFlagStore — persist()", () => {
  it("writes current cache as pretty JSON", async () => {
    const written: string[] = [];
    const writeFile: FlagWriteFileFn = vi.fn().mockImplementation((_p, c) => {
      written.push(c);
      return Promise.resolve();
    });
    const store = new FileFlagStore({ path: "/flags.json", writeFile });
    store.set("feat.a", true);
    store.set("count", 3);
    await store.persist();
    expect(writeFile).toHaveBeenCalledOnce();
    const saved = JSON.parse(written[0]!) as Record<string, FlagValue>;
    expect(saved["feat.a"]).toBe(true);
    expect(saved["count"]).toBe(3);
  });

  it("writes empty object when cache is empty", async () => {
    const writeFile: FlagWriteFileFn = vi.fn().mockResolvedValue(undefined);
    const store = new FileFlagStore({ path: "/flags.json", writeFile });
    await store.persist();
    expect(writeFile).toHaveBeenCalledWith("/flags.json", JSON.stringify({}, null, 2));
  });
});

describe("FileFlagStore — cache operations", () => {
  it("set/get/has/delete work before any load()", () => {
    const store = new FileFlagStore({ path: "/flags.json" });
    store.set("k", "hello");
    expect(store.has("k")).toBe(true);
    expect(store.get("k")).toBe("hello");
    store.delete("k");
    expect(store.has("k")).toBe(false);
  });

  it("getAll returns a shallow copy", () => {
    const store = new FileFlagStore({ path: "/flags.json" });
    store.set("a", 1);
    const all = store.getAll();
    all["a"] = 999;
    expect(store.get("a")).toBe(1);
  });
});

describe("FileFlagStore — round-trip", () => {
  it("persist then load restores all flags", async () => {
    const disk: Record<string, string> = {};
    const readFile: FlagReadFileFn = vi.fn().mockImplementation((p) =>
      p in disk ? Promise.resolve(disk[p]!) : Promise.reject(new Error("ENOENT")),
    );
    const writeFile: FlagWriteFileFn = vi.fn().mockImplementation((p, c) => {
      disk[p] = c;
      return Promise.resolve();
    });

    // Write
    const storeA = new FileFlagStore({ path: "/flags.json", readFile, writeFile });
    storeA.set("sandbox.docker", true);
    storeA.set("gateway.default_model", "nexus/smart");
    storeA.set("limit", 50);
    await storeA.persist();

    // Read in a fresh instance
    const storeB = new FileFlagStore({ path: "/flags.json", readFile, writeFile });
    await storeB.load();
    expect(storeB.get("sandbox.docker")).toBe(true);
    expect(storeB.get("gateway.default_model")).toBe("nexus/smart");
    expect(storeB.get("limit")).toBe(50);
  });

  it("FileFlagStore integrates with FeatureFlagRegistry after load()", async () => {
    const readFile: FlagReadFileFn = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ "kg.enabled": true }));
    const store = new FileFlagStore({ path: "/flags.json", readFile });
    await store.load();
    const reg = new FeatureFlagRegistry({ store, env: {} });
    reg.define({ key: "kg.enabled", type: "boolean", default: false });
    expect(reg.isEnabled("kg.enabled")).toBe(true);
  });
});
