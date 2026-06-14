// SPDX-License-Identifier: Apache-2.0
import type { IExecutionContext } from "@nexus/plugin-sdk";
import { AdapterConfigError, AdapterHttpError } from "@nexus/plugin-sdk";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { cloudflareAdapter } from "../src/index.js";

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

const ENV = { CLOUDFLARE_API_TOKEN: "cf-test-token" };

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("cloudflareAdapter", () => {
  describe("metadata", () => {
    it("has the correct name", () =>
      expect(cloudflareAdapter.name).toBe("nexus-adapter-cloudflare"));
    it("exposes deploy.trigger capability", () => {
      expect(cloudflareAdapter.capabilities).toContain("deploy.trigger");
    });
  });

  describe("canExecute()", () => {
    it("handles cloudflare.deploy-pages", () =>
      expect(cloudflareAdapter.canExecute("cloudflare.deploy-pages")).toBe(true));
    it("handles cloudflare.r2-put", () =>
      expect(cloudflareAdapter.canExecute("cloudflare.r2-put")).toBe(true));
    it("handles cloudflare.r2-get", () =>
      expect(cloudflareAdapter.canExecute("cloudflare.r2-get")).toBe(true));
    it("handles cloudflare.purge-cache", () =>
      expect(cloudflareAdapter.canExecute("cloudflare.purge-cache")).toBe(true));
    it("rejects unknown types", () =>
      expect(cloudflareAdapter.canExecute("vercel.deploy")).toBe(false));
  });

  describe("execute() — cloudflare.deploy-pages", () => {
    it("triggers a Pages deployment", async () => {
      mockFetch(200, { result: { id: "dep-1", url: "https://nexus.pages.dev" } });
      const result = await cloudflareAdapter.execute(
        { taskType: "cloudflare.deploy-pages", accountId: "acct-1", projectName: "nexus" },
        makeCtx(ENV),
      );
      expect(result).toBeDefined();
    });

    it("throws AdapterConfigError when CLOUDFLARE_API_TOKEN is missing", async () => {
      await expect(
        cloudflareAdapter.execute(
          { taskType: "cloudflare.deploy-pages", accountId: "a", projectName: "p" },
          makeCtx({}),
        ),
      ).rejects.toThrow(AdapterConfigError);
    });

    it("throws AdapterHttpError on HTTP failure", async () => {
      mockFetch(403, "Forbidden");
      await expect(
        cloudflareAdapter.execute(
          { taskType: "cloudflare.deploy-pages", accountId: "a", projectName: "p" },
          makeCtx(ENV),
        ),
      ).rejects.toThrow(AdapterHttpError);
    });
  });

  describe("execute() — cloudflare.purge-cache", () => {
    it("sends a cache purge request", async () => {
      mockFetch(200, { result: { id: "purge-1" } });
      const result = await cloudflareAdapter.execute(
        { taskType: "cloudflare.purge-cache", zoneId: "zone-1", files: ["https://example.com/"] },
        makeCtx(ENV),
      );
      expect(result).toBeDefined();
    });
  });
});
