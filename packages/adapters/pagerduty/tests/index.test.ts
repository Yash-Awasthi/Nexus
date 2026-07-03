// SPDX-License-Identifier: Apache-2.0
import type { IExecutionContext } from "@nexus/plugin-sdk";
import { AdapterConfigError, AdapterHttpError } from "@nexus/plugin-sdk";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { pagerdutyAdapter } from "../src/index.js";

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
  const fn = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

const ROUTING = { PAGERDUTY_ROUTING_KEY: "R0UT1NG" };
const APIKEY = { PAGERDUTY_API_KEY: "tok_123" };

describe("pagerdutyAdapter", () => {
  describe("metadata", () => {
    it("has the correct name", () => expect(pagerdutyAdapter.name).toBe("nexus-adapter-pagerduty"));
    it("exposes monitoring capabilities", () => {
      expect(pagerdutyAdapter.capabilities).toContain("monitoring.alert");
    });
  });

  describe("canExecute()", () => {
    for (const t of [
      "pagerduty.trigger-incident",
      "pagerduty.resolve-incident",
      "pagerduty.acknowledge",
      "pagerduty.list-incidents",
    ]) {
      it(`handles ${t}`, () => expect(pagerdutyAdapter.canExecute(t)).toBe(true));
    }
    it("rejects unknown types", () =>
      expect(pagerdutyAdapter.canExecute("stripe.refund")).toBe(false));
  });

  describe("trigger-incident (Events API v2)", () => {
    it("requires PAGERDUTY_ROUTING_KEY", async () => {
      await expect(
        pagerdutyAdapter.execute(
          { taskType: "pagerduty.trigger-incident", summary: "x", source: "s", severity: "error" },
          makeCtx(),
        ),
      ).rejects.toBeInstanceOf(AdapterConfigError);
    });

    it("posts a trigger event with payload", async () => {
      const fetchFn = mockFetch(202, { status: "success", dedup_key: "abc" });
      const out = await pagerdutyAdapter.execute(
        {
          taskType: "pagerduty.trigger-incident",
          summary: "DB down",
          source: "api-1",
          severity: "critical",
          dedup_key: "db-down",
        },
        makeCtx(ROUTING),
      );
      expect(out).toMatchObject({ status: "success" });
      const [url, init] = fetchFn.mock.calls[0]!;
      expect(url).toBe("https://events.pagerduty.com/v2/enqueue");
      const sent = JSON.parse(init.body as string);
      expect(sent.routing_key).toBe("R0UT1NG");
      expect(sent.event_action).toBe("trigger");
      expect(sent.dedup_key).toBe("db-down");
      expect(sent.payload).toMatchObject({ summary: "DB down", severity: "critical" });
    });
  });

  describe("resolve-incident", () => {
    it("posts a resolve event with dedup_key", async () => {
      const fetchFn = mockFetch(202, { status: "success" });
      await pagerdutyAdapter.execute(
        { taskType: "pagerduty.resolve-incident", dedup_key: "db-down" },
        makeCtx(ROUTING),
      );
      const sent = JSON.parse(fetchFn.mock.calls[0]![1].body as string);
      expect(sent.event_action).toBe("resolve");
      expect(sent.dedup_key).toBe("db-down");
    });
  });

  describe("list-incidents (REST API)", () => {
    it("requires PAGERDUTY_API_KEY and uses Token auth", async () => {
      const fetchFn = mockFetch(200, { incidents: [] });
      await pagerdutyAdapter.execute(
        { taskType: "pagerduty.list-incidents", statuses: ["triggered"], limit: 5 },
        makeCtx(APIKEY),
      );
      const [url, init] = fetchFn.mock.calls[0]!;
      expect(url).toContain("https://api.pagerduty.com/incidents?");
      expect(url).toContain("limit=5");
      expect(url).toContain("statuses%5B%5D=triggered");
      expect(init.headers.Authorization).toBe("Token token=tok_123");
    });

    it("throws AdapterHttpError on failure", async () => {
      mockFetch(401, { error: "unauthorized" });
      await expect(
        pagerdutyAdapter.execute({ taskType: "pagerduty.list-incidents" }, makeCtx(APIKEY)),
      ).rejects.toBeInstanceOf(AdapterHttpError);
    });
  });
});
