// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { gmailAdapter } from "../src/index.js";
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

const ENV = { GMAIL_ACCESS_TOKEN: "ya29.gmail-test" };

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("gmailAdapter", () => {
  describe("metadata", () => {
    it("has the correct name", () => expect(gmailAdapter.name).toBe("nexus-adapter-gmail"));
    it("exposes communication.email capability", () => {
      expect(gmailAdapter.capabilities).toContain("communication.email");
    });
  });

  describe("canExecute()", () => {
    it("handles gmail.send", () => expect(gmailAdapter.canExecute("gmail.send")).toBe(true));
    it("handles gmail.list", () => expect(gmailAdapter.canExecute("gmail.list")).toBe(true));
    it("handles gmail.read", () => expect(gmailAdapter.canExecute("gmail.read")).toBe(true));
    it("rejects unknown types", () =>
      expect(gmailAdapter.canExecute("slack.post-message")).toBe(false));
  });

  describe("execute() — gmail.send", () => {
    it("sends an email and returns message metadata", async () => {
      mockFetch(200, { id: "msg-1", threadId: "thread-1", labelIds: ["SENT"] });
      const result = await gmailAdapter.execute(
        {
          taskType: "gmail.send",
          to: "user@example.com",
          subject: "Test",
          body: "Hello world",
        },
        makeCtx(ENV),
      );
      expect(result).toBeDefined();
    });

    it("throws AdapterConfigError when GMAIL_ACCESS_TOKEN is missing", async () => {
      await expect(
        gmailAdapter.execute(
          { taskType: "gmail.send", to: "user@example.com", subject: "Test", body: "Hello" },
          makeCtx({}),
        ),
      ).rejects.toThrow(AdapterConfigError);
    });

    it("throws AdapterHttpError on HTTP failure", async () => {
      mockFetch(403, "Forbidden");
      await expect(
        gmailAdapter.execute(
          { taskType: "gmail.send", to: "user@example.com", subject: "Test", body: "Hello" },
          makeCtx(ENV),
        ),
      ).rejects.toThrow(AdapterHttpError);
    });
  });

  describe("execute() — gmail.list", () => {
    it("lists messages and returns results", async () => {
      mockFetch(200, { messages: [], resultSizeEstimate: 0 });
      const result = await gmailAdapter.execute({ taskType: "gmail.list" }, makeCtx(ENV));
      expect(result).toBeDefined();
    });
  });

  describe("execute() — gmail.read", () => {
    it("reads a specific message by ID", async () => {
      mockFetch(200, { id: "msg-1", snippet: "Hello world", payload: {} });
      const result = await gmailAdapter.execute(
        { taskType: "gmail.read", messageId: "msg-1" },
        makeCtx(ENV),
      );
      expect(result).toBeDefined();
    });
  });
});
