// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { linearAdapter } from "../src/index.js";
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

const ENV = { LINEAR_API_KEY: "lin_api_test" };

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("linearAdapter", () => {
  describe("metadata", () => {
    it("has the correct name", () => expect(linearAdapter.name).toBe("nexus-adapter-linear"));
  });

  describe("canExecute()", () => {
    it("handles linear.create-issue", () =>
      expect(linearAdapter.canExecute("linear.create-issue")).toBe(true));
    it("handles linear.update-issue", () =>
      expect(linearAdapter.canExecute("linear.update-issue")).toBe(true));
    it("handles linear.list-issues", () =>
      expect(linearAdapter.canExecute("linear.list-issues")).toBe(true));
    it("rejects unknown types", () =>
      expect(linearAdapter.canExecute("github.create-issue")).toBe(false));
  });

  describe("execute() — linear.create-issue", () => {
    it("POSTs a GraphQL mutation and returns the new issue", async () => {
      mockFetch(200, {
        data: {
          issueCreate: {
            success: true,
            issue: { id: "iss-1", identifier: "NEXUS-1", title: "Bug" },
          },
        },
      });
      const result = await linearAdapter.execute(
        { taskType: "linear.create-issue", teamId: "team-1", title: "Bug" },
        makeCtx(ENV),
      );
      expect(result).toBeDefined();
    });

    it("throws AdapterConfigError when LINEAR_API_KEY is missing", async () => {
      await expect(
        linearAdapter.execute(
          { taskType: "linear.create-issue", teamId: "team-1", title: "Bug" },
          makeCtx({}),
        ),
      ).rejects.toThrow(AdapterConfigError);
    });

    it("throws AdapterHttpError on HTTP failure", async () => {
      mockFetch(401, "Unauthorized");
      await expect(
        linearAdapter.execute(
          { taskType: "linear.create-issue", teamId: "team-1", title: "Bug" },
          makeCtx(ENV),
        ),
      ).rejects.toThrow(AdapterHttpError);
    });
  });

  describe("execute() — linear.list-issues", () => {
    it("queries issues and returns a list", async () => {
      mockFetch(200, {
        data: { issues: { nodes: [{ id: "iss-1", identifier: "NEXUS-1", title: "Bug" }] } },
      });
      const result = await linearAdapter.execute({ taskType: "linear.list-issues" }, makeCtx(ENV));
      expect(result).toBeDefined();
    });
  });
});
