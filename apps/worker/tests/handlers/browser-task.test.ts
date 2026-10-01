// SPDX-License-Identifier: Apache-2.0
import type { BrowserAgentPage, BrowserAgentSession } from "@nexus/browser-automation";
import { describe, it, expect } from "vitest";

import { handleBrowserTaskJob } from "../../src/handlers/browser-task.js";

function session(over: Partial<BrowserAgentSession> = {}): BrowserAgentSession {
  return {
    id: "s1",
    sessionId: "s1",
    task: "read the headline",
    status: "running",
    steps: [],
    createdAt: new Date().toISOString(),
    ...over,
  };
}

const page: BrowserAgentPage = {
  url: "https://example.com/",
  goto: async () => undefined,
  click: async () => undefined,
  type: async () => undefined,
  title: async () => "Example",
  evaluate: async <T>() => "headline text" as unknown as T,
  screenshot: async () => Buffer.from("png"),
};

const browser = { withPage: <T>(fn: (p: BrowserAgentPage) => Promise<T>) => fn(page) };

/** A driver that answers with one decision then ends the run. */
function driverAnswering(replies: string[]) {
  let i = 0;
  return {
    model: "test-model",
    driver: {
      complete: async () => ({ content: replies[i++] ?? '{"action":"done","done":true}' }),
    } as never,
  };
}

describe("handleBrowserTaskJob", () => {
  it("reports a session that is not in the store", async () => {
    const res = await handleBrowserTaskJob(
      { sessionId: "gone" },
      { load: async () => null, save: async () => undefined },
    );
    expect(res).toMatchObject({ status: "error", error: "session not found" });
  });

  it("records the missing-engine reason on the session rather than throwing", async () => {
    const s = session();
    const saved: BrowserAgentSession[] = [];
    const res = await handleBrowserTaskJob(
      { sessionId: "s1" },
      {
        load: async () => s,
        save: async (x) => {
          saved.push(structuredClone(x));
        },
        driver: null,
      },
    );

    expect(res.status).toBe("error");
    expect(res.error).toMatch(/model key/i);
    expect(saved.at(-1)?.status).toBe("error");
  });

  it("runs the loop and persists the finished session", async () => {
    const s = session();
    const saved: BrowserAgentSession[] = [];

    const res = await handleBrowserTaskJob(
      { sessionId: "s1" },
      {
        load: async () => s,
        save: async (x) => {
          saved.push(structuredClone(x));
        },
        browser,
        driver: driverAnswering([
          '{"action":"click","target":"#more","description":"expand"}',
          '{"action":"done","done":true,"result":"Nexus ships"}',
        ]),
      },
    );

    expect(res).toMatchObject({ status: "completed", steps: 1, result: "Nexus ships" });
    expect(saved.at(-1)?.status).toBe("completed");
  });

  it("continues a session that already has steps", async () => {
    const s = session({
      steps: [{ action: "click", target: "#a", description: "x", success: true }],
    });
    const res = await handleBrowserTaskJob(
      { sessionId: "s1" },
      {
        load: async () => s,
        save: async () => undefined,
        browser,
        driver: driverAnswering(['{"action":"done","done":true,"result":"ok"}']),
      },
    );

    expect(res.steps).toBe(1);
    expect(res.result).toBe("ok");
  });

  it("keeps the session's owner on every save, finished or failed", async () => {
    type Owned = BrowserAgentSession & { ownerId?: string | null };
    const saved: Owned[] = [];
    const run = (driver: ReturnType<typeof driverAnswering> | null) =>
      handleBrowserTaskJob(
        { sessionId: "s1" },
        {
          load: async () => ({ ...session(), ownerId: "owner-1" }) as Owned,
          save: async (x) => {
            saved.push(structuredClone(x) as Owned);
          },
          browser,
          driver,
        },
      );
    await run(driverAnswering(['{"action":"done","done":true,"result":"ok"}']));
    await run(null);
    expect(saved.length).toBeGreaterThan(1);
    expect(saved.every((x) => x.ownerId === "owner-1")).toBe(true);
  });
});
