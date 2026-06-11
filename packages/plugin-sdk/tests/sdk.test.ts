// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import {
  defineAdapter,
  AdapterRegistry,
  NexusAdapterError,
  AdapterConfigError,
  AdapterTimeoutError,
  requireEnv,
  withTimeout,
  type IExecutionAdapter,
} from "../src/index.js";
import {
  createMockContext,
  createMockLogger,
  createTestAdapter,
  createStubAdapter,
} from "../src/testing.js";

// ── defineAdapter ─────────────────────────────────────────────────────────────

describe("defineAdapter", () => {
  it("creates an adapter with correct metadata", () => {
    const adapter = defineAdapter({
      name: "test-adapter",
      version: "1.2.3",
      capabilities: ["llm.inference"],
      taskTypes: ["test.run", "test.check"],
      execute: async () => ({ ok: true }),
    });

    expect(adapter.name).toBe("test-adapter");
    expect(adapter.version).toBe("1.2.3");
    expect(adapter.capabilities).toContain("llm.inference");
  });

  it("canExecute returns true for registered task types", () => {
    const adapter = defineAdapter({
      name: "a",
      version: "0.0.0",
      capabilities: [],
      taskTypes: ["foo.bar", "foo.baz"],
      execute: async () => null,
    });

    expect(adapter.canExecute("foo.bar")).toBe(true);
    expect(adapter.canExecute("foo.baz")).toBe(true);
    expect(adapter.canExecute("foo.unknown")).toBe(false);
  });

  it("execute passes task and context to definition", async () => {
    const executeFn = vi.fn(async (task: unknown) => ({ received: task }));

    const adapter = defineAdapter({
      name: "b",
      version: "0.0.0",
      capabilities: [],
      taskTypes: ["b.run"],
      execute: executeFn,
    });

    const ctx = createMockContext();
    const result = await adapter.execute({ input: 42 }, ctx);

    expect(executeFn).toHaveBeenCalledOnce();
    expect(result).toEqual({ received: { input: 42 } });
  });
});

// ── AdapterRegistry ───────────────────────────────────────────────────────────

describe("AdapterRegistry", () => {
  it("registers and resolves adapters by task type", () => {
    const registry = new AdapterRegistry();
    const adapter = createStubAdapter("stub", ["x.run"]);

    registry.register(adapter);
    expect(registry.resolve("x.run")).toBe(adapter);
    expect(registry.resolve("x.missing")).toBeUndefined();
  });

  it("throws on duplicate registration", () => {
    const registry = new AdapterRegistry();
    const a = createStubAdapter("dup", ["a.run"]);
    registry.register(a);

    expect(() => registry.register(a)).toThrowError(NexusAdapterError);
  });

  it("list returns all registered adapters", () => {
    const registry = new AdapterRegistry();
    registry.register(createStubAdapter("one", ["one.run"]));
    registry.register(createStubAdapter("two", ["two.run"]));

    expect(registry.list()).toHaveLength(2);
  });
});

// ── requireEnv ────────────────────────────────────────────────────────────────

describe("requireEnv", () => {
  it("returns the value when present", () => {
    const ctx = createMockContext({ environment: { MY_KEY: "hello" } });
    expect(requireEnv(ctx, "MY_KEY")).toBe("hello");
  });

  it("throws AdapterConfigError when absent", () => {
    const ctx = createMockContext({ environment: {} });
    expect(() => requireEnv(ctx, "MISSING_KEY")).toThrowError(AdapterConfigError);
  });

  it("throws AdapterConfigError for empty string", () => {
    const ctx = createMockContext({ environment: { EMPTY: "" } });
    expect(() => requireEnv(ctx, "EMPTY")).toThrowError(AdapterConfigError);
  });
});

// ── withTimeout ───────────────────────────────────────────────────────────────

describe("withTimeout", () => {
  it("resolves when promise completes within timeout", async () => {
    const result = await withTimeout(
      Promise.resolve("done"),
      1000,
      "test",
      "test.run",
    );
    expect(result).toBe("done");
  });

  it("rejects with AdapterTimeoutError when promise takes too long", async () => {
    const slow = new Promise<never>(() => {
      /* never resolves */
    });

    await expect(withTimeout(slow, 10, "slow-adapter", "slow.run")).rejects.toThrowError(
      AdapterTimeoutError,
    );
  });
});

// ── createMockLogger ──────────────────────────────────────────────────────────

describe("createMockLogger", () => {
  it("records log entries at the correct level", () => {
    const logger = createMockLogger();

    logger.info("hello", { x: 1 });
    logger.warn("uh oh");
    logger.error("boom");
    logger.debug("verbose");

    expect(logger.entries).toHaveLength(4);
    expect(logger.entries[0]).toMatchObject({ level: "info", message: "hello" });
    expect(logger.entries[1]).toMatchObject({ level: "warn", message: "uh oh" });
  });

  it("clear() empties entries", () => {
    const logger = createMockLogger();
    logger.info("x");
    logger.clear();
    expect(logger.entries).toHaveLength(0);
  });
});

// ── createTestAdapter ─────────────────────────────────────────────────────────

describe("createTestAdapter", () => {
  it("records successful calls", async () => {
    const base = createStubAdapter("base", ["base.run"], { value: 42 });
    const spy = createTestAdapter(base);
    const ctx = createMockContext();

    const result = await spy.execute({ input: "x" }, ctx);

    expect(result).toEqual({ value: 42 });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.error).toBeUndefined();
    expect(spy.calls[0]?.result).toEqual({ value: 42 });
  });

  it("records failed calls and re-throws", async () => {
    const failing = defineAdapter({
      name: "failing",
      version: "0.0.0",
      capabilities: [],
      taskTypes: ["fail.run"],
      execute: async () => {
        throw new NexusAdapterError("boom", "TEST_ERROR");
      },
    });

    const spy = createTestAdapter(failing);
    const ctx = createMockContext();

    await expect(spy.execute({}, ctx)).rejects.toThrowError(NexusAdapterError);
    expect(spy.calls[0]?.error).toBeInstanceOf(NexusAdapterError);
  });

  it("reset() clears recorded calls", async () => {
    const base = createStubAdapter("s", ["s.run"]);
    const spy = createTestAdapter(base);
    const ctx = createMockContext();

    await spy.execute({}, ctx);
    spy.reset();
    expect(spy.calls).toHaveLength(0);
  });
});

// ── Error hierarchy ───────────────────────────────────────────────────────────

describe("Error classes", () => {
  it("NexusAdapterError carries code and context", () => {
    const err = new NexusAdapterError("msg", "ERR_CODE", { detail: true });
    expect(err.code).toBe("ERR_CODE");
    expect(err.context).toMatchObject({ detail: true });
    expect(err).toBeInstanceOf(Error);
  });

  it("AdapterTimeoutError is a NexusAdapterError", () => {
    const err = new AdapterTimeoutError("my-adapter", "my.task", 5000);
    expect(err).toBeInstanceOf(NexusAdapterError);
    expect(err.code).toBe("ADAPTER_TIMEOUT");
    expect(err.message).toContain("5000ms");
  });

  it("AdapterConfigError identifies the missing key", () => {
    const err = new AdapterConfigError("my-adapter", "GROQ_API_KEY");
    expect(err.context?.missingKey).toBe("GROQ_API_KEY");
  });
});
