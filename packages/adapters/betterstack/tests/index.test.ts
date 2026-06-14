// SPDX-License-Identifier: Apache-2.0
import type { IExecutionContext } from "@nexus/plugin-sdk";
import { AdapterConfigError, AdapterHttpError } from "@nexus/plugin-sdk";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { betterstackAdapter } from "../src/index.js";

function makeCtx(env: Record<string, string> = {}): IExecutionContext {
  return {
    taskId: "task-test",
    startTime: new Date(),
    attempt: 1,
    environment: env,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
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

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("betterstackAdapter", () => {
  describe("metadata", () => {
    it("has the correct name", () => {
      expect(betterstackAdapter.name).toBe("nexus-adapter-betterstack");
    });

    it("has version 0.1.0", () => {
      expect(betterstackAdapter.version).toBe("0.1.0");
    });

    it("exposes monitoring capabilities", () => {
      expect(betterstackAdapter.capabilities).toContain("monitoring.log");
      expect(betterstackAdapter.capabilities).toContain("monitoring.alert");
    });
  });

  describe("canExecute()", () => {
    it("returns true for betterstack.log", () => {
      expect(betterstackAdapter.canExecute("betterstack.log")).toBe(true);
    });

    it("returns true for betterstack.create-alert", () => {
      expect(betterstackAdapter.canExecute("betterstack.create-alert")).toBe(true);
    });

    it("returns true for betterstack.check-uptime", () => {
      expect(betterstackAdapter.canExecute("betterstack.check-uptime")).toBe(true);
    });

    it("returns false for unknown task types", () => {
      expect(betterstackAdapter.canExecute("slack.post-message")).toBe(false);
      expect(betterstackAdapter.canExecute("")).toBe(false);
    });
  });

  describe("execute() — betterstack.log", () => {
    it("POSTs a log entry and returns ok:true", async () => {
      mockFetch(202, {});
      const ctx = makeCtx({ BETTERSTACK_SOURCE_TOKEN: "tok-log" });
      const result = await betterstackAdapter.execute(
        { taskType: "betterstack.log", message: "hello", level: "info" },
        ctx,
      );
      expect(result).toMatchObject({ ok: true });
      expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
    });

    it("throws AdapterConfigError when BETTERSTACK_SOURCE_TOKEN is missing", async () => {
      const ctx = makeCtx({});
      await expect(
        betterstackAdapter.execute({ taskType: "betterstack.log", message: "test" }, ctx),
      ).rejects.toThrow(AdapterConfigError);
    });

    it("throws AdapterHttpError on non-2xx response", async () => {
      mockFetch(500, "Internal Server Error");
      const ctx = makeCtx({ BETTERSTACK_SOURCE_TOKEN: "tok-log" });
      await expect(
        betterstackAdapter.execute({ taskType: "betterstack.log", message: "fail" }, ctx),
      ).rejects.toThrow(AdapterHttpError);
    });
  });

  describe("execute() — betterstack.check-uptime", () => {
    it("GETs monitor status and returns structured result", async () => {
      mockFetch(200, {
        data: {
          id: "mon-1",
          attributes: { url: "https://example.com", status: "up", availability: 99.9 },
        },
      });
      const ctx = makeCtx({ BETTERSTACK_UPTIME_API_TOKEN: "tok-uptime" });
      const result = await betterstackAdapter.execute(
        { taskType: "betterstack.check-uptime", monitorId: "mon-1" },
        ctx,
      );
      expect(result).toMatchObject({ id: "mon-1", status: "up", availability: 99.9 });
    });
  });
});
