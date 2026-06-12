// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { vercelAdapter } from "../src/index.js";
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

const ENV = { VERCEL_API_TOKEN: "vrcl-test-token" };

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("vercelAdapter", () => {
  describe("metadata", () => {
    it("has the correct name", () => expect(vercelAdapter.name).toBe("nexus-adapter-vercel"));
    it("exposes deploy.trigger capability", () => {
      expect(vercelAdapter.capabilities).toContain("deploy.trigger");
    });
  });

  describe("canExecute()", () => {
    it("handles vercel.deploy", () => expect(vercelAdapter.canExecute("vercel.deploy")).toBe(true));
    it("handles vercel.list-deployments", () =>
      expect(vercelAdapter.canExecute("vercel.list-deployments")).toBe(true));
    it("handles vercel.alias", () => expect(vercelAdapter.canExecute("vercel.alias")).toBe(true));
    it("rejects unknown types", () =>
      expect(vercelAdapter.canExecute("cloudflare.deploy-pages")).toBe(false));
  });

  describe("execute() — vercel.deploy", () => {
    it("triggers a deployment and returns deployment metadata", async () => {
      mockFetch(200, { id: "dpl-1", url: "nexus-abc.vercel.app", readyState: "BUILDING" });
      const result = await vercelAdapter.execute(
        { taskType: "vercel.deploy", projectId: "prj-nexus" },
        makeCtx(ENV),
      );
      expect(result).toBeDefined();
    });

    it("throws AdapterConfigError when VERCEL_API_TOKEN is missing", async () => {
      await expect(
        vercelAdapter.execute({ taskType: "vercel.deploy", projectId: "prj-nexus" }, makeCtx({})),
      ).rejects.toThrow(AdapterConfigError);
    });

    it("throws AdapterHttpError on HTTP failure", async () => {
      mockFetch(400, { error: { code: "bad_request" } });
      await expect(
        vercelAdapter.execute({ taskType: "vercel.deploy", projectId: "prj-nexus" }, makeCtx(ENV)),
      ).rejects.toThrow(AdapterHttpError);
    });
  });

  describe("execute() — vercel.list-deployments", () => {
    it("lists deployments for a project", async () => {
      mockFetch(200, { deployments: [{ uid: "dpl-1", name: "nexus", state: "READY" }] });
      const result = await vercelAdapter.execute(
        { taskType: "vercel.list-deployments" },
        makeCtx(ENV),
      );
      expect(result).toBeDefined();
    });
  });

  describe("execute() — vercel.alias", () => {
    it("assigns an alias to a deployment", async () => {
      mockFetch(200, {
        uid: "als-1",
        alias: "nexus.vercel.app",
        created: new Date().toISOString(),
      });
      const result = await vercelAdapter.execute(
        { taskType: "vercel.alias", deploymentId: "dpl-1", alias: "nexus.vercel.app" },
        makeCtx(ENV),
      );
      expect(result).toBeDefined();
    });
  });
});
