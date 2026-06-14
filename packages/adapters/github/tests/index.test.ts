// SPDX-License-Identifier: Apache-2.0
import type { IExecutionContext } from "@nexus/plugin-sdk";
import { AdapterConfigError, AdapterHttpError } from "@nexus/plugin-sdk";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { githubAdapter } from "../src/index.js";

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

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

const ENV = { GITHUB_TOKEN: "ghp_test" };

describe("githubAdapter", () => {
  describe("metadata", () => {
    it("has the correct name", () => expect(githubAdapter.name).toBe("nexus-adapter-github"));
    it("exposes storage capabilities", () => {
      expect(githubAdapter.capabilities).toContain("storage.read");
      expect(githubAdapter.capabilities).toContain("storage.write");
    });
  });

  describe("canExecute()", () => {
    const validTypes = [
      "github.create-issue",
      "github.list-issues",
      "github.create-pr",
      "github.get-pr",
      "github.merge-pr",
      "github.create-comment",
      "github.get-repo",
    ];
    for (const type of validTypes) {
      it(`handles ${type}`, () => expect(githubAdapter.canExecute(type)).toBe(true));
    }
    it("rejects unknown task types", () =>
      expect(githubAdapter.canExecute("slack.post-message")).toBe(false));
  });

  describe("execute() — github.create-issue", () => {
    it("POSTs to /issues and returns the created issue", async () => {
      const body = { id: 1, number: 42, title: "Bug report" };
      mockFetch(201, body);
      const result = await githubAdapter.execute(
        { taskType: "github.create-issue", owner: "org", repo: "repo", title: "Bug report" },
        makeCtx(ENV),
      );
      expect(result).toMatchObject({ number: 42 });
      const [url, opts] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/repos/org/repo/issues");
      expect(opts.method).toBe("POST");
    });

    it("throws AdapterConfigError when GITHUB_TOKEN is missing", async () => {
      await expect(
        githubAdapter.execute(
          { taskType: "github.create-issue", owner: "o", repo: "r", title: "t" },
          makeCtx({}),
        ),
      ).rejects.toThrow(AdapterConfigError);
    });

    it("throws AdapterHttpError on 422 response", async () => {
      mockFetch(422, "Unprocessable Entity");
      await expect(
        githubAdapter.execute(
          { taskType: "github.create-issue", owner: "o", repo: "r", title: "t" },
          makeCtx(ENV),
        ),
      ).rejects.toThrow(AdapterHttpError);
    });
  });

  describe("execute() — github.list-issues", () => {
    it("GETs issues with default state=open", async () => {
      mockFetch(200, [{ id: 1, title: "Issue 1" }]);
      await githubAdapter.execute(
        { taskType: "github.list-issues", owner: "org", repo: "repo" },
        makeCtx(ENV),
      );
      const [url] = vi.mocked(fetch).mock.calls[0] as [string, ...unknown[]];
      expect(url).toContain("state=open");
    });
  });

  describe("execute() — github.get-repo", () => {
    it("GETs repo metadata", async () => {
      const body = { id: 999, name: "repo", full_name: "org/repo" };
      mockFetch(200, body);
      const result = await githubAdapter.execute(
        { taskType: "github.get-repo", owner: "org", repo: "repo" },
        makeCtx(ENV),
      );
      expect(result).toMatchObject({ name: "repo" });
    });
  });

  describe("execute() — github.create-pr", () => {
    it("POSTs to /pulls", async () => {
      mockFetch(201, { id: 1, number: 5, title: "Feature" });
      await githubAdapter.execute(
        {
          taskType: "github.create-pr",
          owner: "org",
          repo: "repo",
          title: "Feature",
          head: "feat",
          base: "main",
        },
        makeCtx(ENV),
      );
      const [url, opts] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/pulls");
      expect(opts.method).toBe("POST");
    });
  });
});
