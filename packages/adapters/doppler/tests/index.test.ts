// SPDX-License-Identifier: Apache-2.0
import type { IExecutionContext } from "@nexus/plugin-sdk";
import { AdapterConfigError, AdapterHttpError } from "@nexus/plugin-sdk";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { dopplerAdapter } from "../src/index.js";

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

const ENV = { DOPPLER_TOKEN: "dp.st.test" };

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("dopplerAdapter", () => {
  describe("metadata", () => {
    it("has the correct name", () => expect(dopplerAdapter.name).toBe("nexus-adapter-doppler"));
    it("exposes secrets.read capability", () => {
      expect(dopplerAdapter.capabilities).toContain("secrets.read");
    });
  });

  describe("canExecute()", () => {
    it("handles doppler.get-secret", () =>
      expect(dopplerAdapter.canExecute("doppler.get-secret")).toBe(true));
    it("handles doppler.list-secrets", () =>
      expect(dopplerAdapter.canExecute("doppler.list-secrets")).toBe(true));
    it("rejects unknown types", () => expect(dopplerAdapter.canExecute("neon.query")).toBe(false));
  });

  describe("execute() — doppler.get-secret", () => {
    it("fetches a single secret value", async () => {
      mockFetch(200, {
        secret: {
          name: "DB_URL",
          value: { raw: "super-secret-value", computed: "super-secret-value" },
        },
      });
      const result = await dopplerAdapter.execute(
        { taskType: "doppler.get-secret", project: "nexus", config: "prd", name: "DB_URL" },
        makeCtx(ENV),
      );
      expect(result).toBeDefined();
    });

    it("throws AdapterConfigError when DOPPLER_TOKEN is missing", async () => {
      await expect(
        dopplerAdapter.execute(
          { taskType: "doppler.get-secret", project: "nexus", config: "prd", name: "DB_URL" },
          makeCtx({}),
        ),
      ).rejects.toThrow(AdapterConfigError);
    });

    it("throws AdapterHttpError on HTTP failure", async () => {
      mockFetch(403, "Forbidden");
      await expect(
        dopplerAdapter.execute(
          { taskType: "doppler.get-secret", project: "nexus", config: "prd", name: "DB_URL" },
          makeCtx(ENV),
        ),
      ).rejects.toThrow(AdapterHttpError);
    });
  });

  describe("execute() — doppler.list-secrets", () => {
    it("fetches the list of secret names", async () => {
      mockFetch(200, { secrets: { DB_URL: {}, API_KEY: {} } });
      const result = await dopplerAdapter.execute(
        { taskType: "doppler.list-secrets", project: "nexus", config: "prd" },
        makeCtx(ENV),
      );
      expect(result).toBeDefined();
    });
  });
});
