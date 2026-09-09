// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  url: vi.fn(),
  post: vi.fn(),
}));

vi.mock("../src/bridge-manager.js", () => ({
  getBridgeManager: () => ({ url: mocks.url }),
  BridgeManager: { post: mocks.post },
}));

import type { IExecutionContext } from "../src/interfaces/execution.interface.js";
import { BrowserExecutionAdapter } from "../src/browser-adapter.js";

function telemetry() {
  return {
    browserSessionsActive: 0,
    navigationHistory: [] as string[],
    totalBytesWritten: 0,
    totalBytesFetched: 0,
    recordNavigation: vi.fn((url: string) => {}),
    recordFetch: vi.fn(),
  };
}

const ctx = {
  taskId: "bt-1",
  startTime: new Date(),
  attempt: 1,
  environment: {},
  logger: { info: () => {}, warn: () => {}, error: () => {} },
} as IExecutionContext;

beforeEach(() => {
  mocks.url.mockReset();
  mocks.post.mockReset();
  mocks.url.mockResolvedValue("http://localhost:7701");
});

describe("BrowserExecutionAdapter", () => {
  it("only handles the browser task type", () => {
    const adapter = new BrowserExecutionAdapter(telemetry() as never, true);
    expect(adapter.canExecute("browser")).toBe(true);
    expect(adapter.canExecute("scraping")).toBe(false);
  });

  it("blocks unsafe urls before starting a session", async () => {
    const t = telemetry();
    const adapter = new BrowserExecutionAdapter(t as never, true);
    const out = await adapter.executeBrowserTask({
      id: "1",
      url: "file:///etc/passwd",
      actions: [],
      timeoutMs: 5000,
    });
    expect(out.success).toBe(false);
    expect(out.content).toBe("BLOCKED_BY_SAFETY_POLICY");
    expect(t.browserSessionsActive).toBe(0);
  });

  it("simulates offline browsing and resets the session counter", async () => {
    const t = telemetry();
    const adapter = new BrowserExecutionAdapter(t as never, true);
    const out = await adapter.executeBrowserTask({
      id: "1",
      url: "https://example.com",
      actions: [{ type: "click", selector: "#btn" }],
      timeoutMs: 5000,
    });
    expect(out.success).toBe(true);
    expect(out.content).toContain("Mock page loaded");
    expect(out.screenshotUrl).toContain("/screenshots/1.png");
    expect(t.browserSessionsActive).toBe(0);
    expect(t.recordNavigation).toHaveBeenCalledWith("https://example.com");
    expect(out.logs.join("\n")).toContain("click");
  });

  it("blocks unsafe redirects inside actions", async () => {
    const t = telemetry();
    const adapter = new BrowserExecutionAdapter(t as never, true);
    const out = await adapter.executeBrowserTask({
      id: "1",
      url: "https://example.com",
      actions: [{ type: "navigate", value: "javascript:alert(1)" }],
      timeoutMs: 5000,
    });
    expect(out.success).toBe(false);
    expect(out.content).toBe("BLOCKED_BY_SAFETY_POLICY");
    expect(t.browserSessionsActive).toBe(0);
  });

  it("detects timeout breaches for tiny timeouts", async () => {
    const t = telemetry();
    const adapter = new BrowserExecutionAdapter(t as never, true);
    const out = await adapter.executeBrowserTask({
      id: "1",
      url: "https://example.com",
      actions: [],
      timeoutMs: 10,
    });
    expect(out.success).toBe(false);
    expect(out.content).toBe("TIMEOUT_BREACHED");
    expect(t.browserSessionsActive).toBe(0);
  });

  it("executes against the stealth bridge in live mode", async () => {
    const t = telemetry();
    mocks.post.mockResolvedValue({
      success: true,
      html: "<html>live</html>",
      title: "Live Page",
      final_url: "https://example.com",
      screenshot_b64: "c2NyZWVuc2hvdA==",
      error: "",
    });
    const adapter = new BrowserExecutionAdapter(t as never, false);
    const out = await adapter.executeBrowserTask({
      id: "1",
      url: "https://example.com",
      actions: [{ type: "click", selector: "#go" }],
      timeoutMs: 5000,
    });
    expect(out.success).toBe(true);
    expect(out.content).toBe("<html>live</html>");
    expect(out.screenshotUrl).toBe("data:image/png;base64,c2NyZWVuc2hvdA==");
    expect(mocks.post).toHaveBeenCalledWith(
      "http://localhost:7701",
      "/interact",
      expect.objectContaining({ url: "https://example.com", headless: true }),
    );
    expect(t.browserSessionsActive).toBe(0);
  });

  it("routes to /browse when there are no actions", async () => {
    const t = telemetry();
    mocks.post.mockResolvedValue({
      success: true,
      html: "page",
      title: "T",
      final_url: "https://example.com",
      screenshot_b64: "",
      error: "",
    });
    const adapter = new BrowserExecutionAdapter(t as never, false);
    const out = await adapter.executeBrowserTask({
      id: "2",
      url: "https://example.com",
      actions: [],
      timeoutMs: 30_000,
    });
    expect(out.success).toBe(true);
    expect(out.screenshotUrl).toBeUndefined();
    expect(mocks.post).toHaveBeenCalledWith("http://localhost:7701", "/browse", expect.anything());
  });

  it("surfaces bridge errors and network failures", async () => {
    const t = telemetry();
    mocks.post.mockResolvedValueOnce({
      success: false,
      error: "anti-bot detected",
      html: "",
      title: "",
      final_url: "",
      screenshot_b64: "",
    });
    const adapter = new BrowserExecutionAdapter(t as never, false);
    const failed = await adapter.executeBrowserTask({
      id: "3",
      url: "https://example.com",
      actions: [],
      timeoutMs: 30_000,
    });
    expect(failed.success).toBe(false);
    expect(failed.content).toBe("anti-bot detected");

    mocks.post.mockRejectedValueOnce(new Error("bridge down"));
    const thrown = await adapter.executeBrowserTask({
      id: "3",
      url: "https://example.com",
      actions: [],
      timeoutMs: 30_000,
    });
    expect(thrown.success).toBe(false);
    expect(thrown.content).toContain("bridge down");
    expect(t.browserSessionsActive).toBe(0);
  });

  it("execute() extracts payload fields into a browser task", async () => {
    const t = telemetry();
    const adapter = new BrowserExecutionAdapter(t as never, true);
    const out = await adapter.execute(
      { payload: { url: "https://example.org", timeoutMs: 5000 } },
      ctx,
    );
    expect(out.success).toBe(true);
    expect(out.logs[0]).toContain("https://example.org");
  });
});
