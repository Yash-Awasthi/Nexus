// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { slackAdapter } from "../src/index.js";
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

const ENV = { SLACK_BOT_TOKEN: "xoxb-test-token" };

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("slackAdapter", () => {
  describe("metadata", () => {
    it("has the correct name", () => expect(slackAdapter.name).toBe("nexus-adapter-slack"));
    it("exposes communication.chat capability", () => {
      expect(slackAdapter.capabilities).toContain("communication.chat");
    });
  });

  describe("canExecute()", () => {
    it("handles slack.post-message", () =>
      expect(slackAdapter.canExecute("slack.post-message")).toBe(true));
    it("handles slack.post-channel", () =>
      expect(slackAdapter.canExecute("slack.post-channel")).toBe(true));
    it("handles slack.create-channel", () =>
      expect(slackAdapter.canExecute("slack.create-channel")).toBe(true));
    it("rejects unknown types", () => expect(slackAdapter.canExecute("gmail.send")).toBe(false));
  });

  describe("execute() — slack.post-message", () => {
    it("POSTs a DM and returns message result", async () => {
      mockFetch(200, { ok: true, ts: "1234567890.000001", channel: "U12345" });
      const result = await slackAdapter.execute(
        { taskType: "slack.post-message", userId: "U12345", text: "Hello there" },
        makeCtx(ENV),
      );
      expect(result).toBeDefined();
    });

    it("throws AdapterConfigError when SLACK_BOT_TOKEN is missing", async () => {
      await expect(
        slackAdapter.execute(
          { taskType: "slack.post-message", userId: "U12345", text: "Hello" },
          makeCtx({}),
        ),
      ).rejects.toThrow(AdapterConfigError);
    });

    it("throws AdapterHttpError on HTTP failure", async () => {
      mockFetch(403, "Forbidden");
      await expect(
        slackAdapter.execute(
          { taskType: "slack.post-message", userId: "U12345", text: "Hello" },
          makeCtx(ENV),
        ),
      ).rejects.toThrow(AdapterHttpError);
    });
  });

  describe("execute() — slack.post-channel", () => {
    it("posts a message to a channel", async () => {
      mockFetch(200, { ok: true, ts: "1234567890.000002", channel: "C12345" });
      const result = await slackAdapter.execute(
        { taskType: "slack.post-channel", channel: "C12345", text: "Deployment complete" },
        makeCtx(ENV),
      );
      expect(result).toBeDefined();
    });
  });

  describe("execute() — slack.create-channel", () => {
    it("creates a public channel", async () => {
      mockFetch(200, { ok: true, channel: { id: "C99999", name: "nexus-alerts" } });
      const result = await slackAdapter.execute(
        { taskType: "slack.create-channel", name: "nexus-alerts" },
        makeCtx(ENV),
      );
      expect(result).toBeDefined();
    });
  });
});
