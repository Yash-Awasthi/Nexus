// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { calendarAdapter } from "../src/index.js";
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

const ENV = { GOOGLE_ACCESS_TOKEN: "ya29.test" };

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("calendarAdapter", () => {
  describe("metadata", () => {
    it("has the correct name", () => expect(calendarAdapter.name).toBe("nexus-adapter-calendar"));
  });

  describe("canExecute()", () => {
    it("handles calendar.create-event", () =>
      expect(calendarAdapter.canExecute("calendar.create-event")).toBe(true));
    it("handles calendar.list-events", () =>
      expect(calendarAdapter.canExecute("calendar.list-events")).toBe(true));
    it("handles calendar.delete-event", () =>
      expect(calendarAdapter.canExecute("calendar.delete-event")).toBe(true));
    it("rejects unknown types", () => expect(calendarAdapter.canExecute("gmail.send")).toBe(false));
  });

  describe("execute() — calendar.create-event", () => {
    it("POSTs a new event and returns created event data", async () => {
      const event = { id: "evt-1", summary: "Team Standup", status: "confirmed" };
      mockFetch(200, event);
      const result = await calendarAdapter.execute(
        {
          taskType: "calendar.create-event",
          summary: "Team Standup",
          start: "2024-01-01T10:00:00Z",
          end: "2024-01-01T10:30:00Z",
        },
        makeCtx(ENV),
      );
      expect(result).toMatchObject({ id: "evt-1", summary: "Team Standup" });
    });

    it("throws AdapterConfigError when GOOGLE_ACCESS_TOKEN is missing", async () => {
      await expect(
        calendarAdapter.execute(
          {
            taskType: "calendar.create-event",
            summary: "Test",
            start: "2024-01-01T10:00:00Z",
            end: "2024-01-01T11:00:00Z",
          },
          makeCtx({}),
        ),
      ).rejects.toThrow(AdapterConfigError);
    });

    it("throws AdapterHttpError on HTTP failure", async () => {
      mockFetch(401, "Unauthorized");
      await expect(
        calendarAdapter.execute(
          {
            taskType: "calendar.create-event",
            summary: "Test",
            start: "2024-01-01T10:00:00Z",
            end: "2024-01-01T11:00:00Z",
          },
          makeCtx(ENV),
        ),
      ).rejects.toThrow(AdapterHttpError);
    });
  });

  describe("execute() — calendar.list-events", () => {
    it("GETs events from the calendar", async () => {
      mockFetch(200, { items: [] });
      const result = await calendarAdapter.execute(
        { taskType: "calendar.list-events" },
        makeCtx(ENV),
      );
      expect(result).toBeDefined();
    });
  });
});
