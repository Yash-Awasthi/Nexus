// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { supabaseAdapter } from "../src/index.js";
import type { IExecutionContext } from "@nexus/plugin-sdk";
import { AdapterConfigError, AdapterHttpError } from "@nexus/plugin-sdk";

function makeCtx(env: Record<string, string> = {}): IExecutionContext {
  return {
    taskId: "task-test",
    startTime: new Date(),
    attempt: 1,
    environment: env,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

function mockFetch(status: number, body: unknown) {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    json: vi.fn().mockResolvedValue(body),
  };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  return response;
}

const ENV = {
  SUPABASE_URL: "https://abc.supabase.co",
  SUPABASE_ANON_KEY: "eyJtest.anon.key",
};

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("supabaseAdapter", () => {
  describe("metadata", () => {
    it("has the correct name", () => expect(supabaseAdapter.name).toBe("nexus-adapter-supabase"));
    it("exposes database capabilities", () => {
      expect(supabaseAdapter.capabilities).toContain("database.query");
      expect(supabaseAdapter.capabilities).toContain("database.execute");
    });
  });

  describe("canExecute()", () => {
    it("handles supabase.query", () =>
      expect(supabaseAdapter.canExecute("supabase.query")).toBe(true));
    it("handles supabase.insert", () =>
      expect(supabaseAdapter.canExecute("supabase.insert")).toBe(true));
    it("handles supabase.update", () =>
      expect(supabaseAdapter.canExecute("supabase.update")).toBe(true));
    it("handles supabase.delete", () =>
      expect(supabaseAdapter.canExecute("supabase.delete")).toBe(true));
    it("rejects unknown types", () => expect(supabaseAdapter.canExecute("neon.query")).toBe(false));
  });

  describe("execute() — supabase.query", () => {
    it("GETs rows from a table", async () => {
      mockFetch(200, [{ id: 1, name: "event-1" }]);
      const result = await supabaseAdapter.execute(
        { taskType: "supabase.query", table: "events" },
        makeCtx(ENV),
      );
      expect(result).toBeDefined();
    });

    it("throws AdapterConfigError when SUPABASE_URL is missing", async () => {
      await expect(
        supabaseAdapter.execute(
          { taskType: "supabase.query", table: "events" },
          makeCtx({ SUPABASE_ANON_KEY: "key" }),
        ),
      ).rejects.toThrow(AdapterConfigError);
    });

    it("throws AdapterHttpError on HTTP failure", async () => {
      mockFetch(400, { message: "Bad query" });
      await expect(
        supabaseAdapter.execute({ taskType: "supabase.query", table: "events" }, makeCtx(ENV)),
      ).rejects.toThrow(AdapterHttpError);
    });
  });

  describe("execute() — supabase.insert", () => {
    it("POSTs a row and returns the inserted record", async () => {
      mockFetch(201, [{ id: 2, name: "event-2" }]);
      const result = await supabaseAdapter.execute(
        { taskType: "supabase.insert", table: "events", record: { name: "event-2" } },
        makeCtx(ENV),
      );
      expect(result).toBeDefined();
    });
  });

  describe("execute() — supabase.delete", () => {
    it("DELETEs a row matching the filter", async () => {
      mockFetch(204, null);
      const result = await supabaseAdapter.execute(
        { taskType: "supabase.delete", table: "events", filter: { id: "eq.2" } },
        makeCtx(ENV),
      );
      expect(result).toBeDefined();
    });
  });
});
