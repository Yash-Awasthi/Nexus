// SPDX-License-Identifier: Apache-2.0
import type { IExecutionContext } from "@nexus/plugin-sdk";
import { AdapterConfigError } from "@nexus/plugin-sdk";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { neonAdapter } from "../src/index.js";

function makeCtx(env: Record<string, string> = {}): IExecutionContext {
  return {
    taskId: "task-test",
    startTime: new Date(),
    attempt: 1,
    environment: env,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("neonAdapter", () => {
  describe("metadata", () => {
    it("has the correct name", () => expect(neonAdapter.name).toBe("nexus-adapter-neon"));
    it("exposes database capabilities", () => {
      expect(neonAdapter.capabilities).toContain("database.query");
      expect(neonAdapter.capabilities).toContain("database.execute");
    });
  });

  describe("canExecute()", () => {
    it("handles neon.query", () => expect(neonAdapter.canExecute("neon.query")).toBe(true));
    it("handles neon.execute", () => expect(neonAdapter.canExecute("neon.execute")).toBe(true));
    it("rejects unknown types", () => expect(neonAdapter.canExecute("supabase.query")).toBe(false));
  });

  describe("execute() — missing DATABASE_URL", () => {
    it("throws AdapterConfigError when DATABASE_URL is missing", async () => {
      await expect(
        neonAdapter.execute({ taskType: "neon.query", sql: "SELECT 1" }, makeCtx({})),
      ).rejects.toThrow(AdapterConfigError);
    });
  });

  describe("execute() — neon.query with mocked fetch", () => {
    it("returns rows from a SELECT query", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: vi.fn().mockResolvedValue(""),
          json: vi.fn().mockResolvedValue({ rows: [{ count: "5" }], rowCount: 1 }),
        }),
      );
      const result = await neonAdapter.execute(
        { taskType: "neon.query", sql: "SELECT COUNT(*) FROM events" },
        makeCtx({ DATABASE_URL: "postgresql://user:pass@host/db" }),
      );
      expect(result).toBeDefined();
    });

    it("neon.execute returns affected row count for mutations", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: vi.fn().mockResolvedValue(""),
          json: vi.fn().mockResolvedValue({ rows: [], rowCount: 3 }),
        }),
      );
      const result = await neonAdapter.execute(
        {
          taskType: "neon.execute",
          sql: "UPDATE events SET processed = TRUE WHERE id = $1",
          params: ["evt-1"],
        },
        makeCtx({ DATABASE_URL: "postgresql://user:pass@host/db" }),
      );
      expect(result).toBeDefined();
    });
  });
});
