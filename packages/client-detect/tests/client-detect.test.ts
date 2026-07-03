// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { detectClient, makeClientDetectMiddleware } from "../src/index.js";

describe("detectClient", () => {
  it("detects claude-code via x-nexus-client header (high confidence)", () => {
    const r = detectClient({ "x-nexus-client": "claude-code" });
    expect(r.clientType).toBe("claude-code");
    expect(r.confidence).toBe("high");
    expect(r.responseFormat).toBe("tool-calls");
  });

  it("detects cursor via x-nexus-client header", () => {
    const r = detectClient({ "x-nexus-client": "cursor" });
    expect(r.clientType).toBe("cursor");
    expect(r.responseFormat).toBe("tool-calls");
  });

  it("detects claude-code via User-Agent", () => {
    const r = detectClient({ "user-agent": "claude-code/1.0.0 (Linux)" });
    expect(r.clientType).toBe("claude-code");
    expect(r.confidence).toBe("high");
  });

  it("detects cursor via User-Agent", () => {
    const r = detectClient({ "user-agent": "Cursor/0.44.2 (darwin)" });
    expect(r.clientType).toBe("cursor");
  });

  it("detects vscode via User-Agent", () => {
    const r = detectClient({ "user-agent": "VSCode/1.90.0" });
    expect(r.clientType).toBe("vscode");
    expect(r.responseFormat).toBe("plain");
  });

  it("detects browser via Mozilla User-Agent", () => {
    const r = detectClient({
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/120.0",
    });
    expect(r.clientType).toBe("browser");
    expect(r.responseFormat).toBe("markdown");
  });

  it("detects CLI via curl User-Agent", () => {
    const r = detectClient({ "user-agent": "curl/8.1.2" });
    expect(r.clientType).toBe("cli");
    expect(r.responseFormat).toBe("plain");
  });

  it("detects sdk via nexus-sdk User-Agent", () => {
    const r = detectClient({ "user-agent": "nexus-sdk/2.0.0" });
    expect(r.clientType).toBe("sdk");
    expect(r.responseFormat).toBe("json");
  });

  it("falls back to sdk for JSON-only Accept header", () => {
    const r = detectClient({ accept: "application/json" });
    expect(r.clientType).toBe("sdk");
    expect(r.confidence).toBe("low");
  });

  it("returns unknown with low confidence when no signals", () => {
    const r = detectClient({});
    expect(r.clientType).toBe("unknown");
    expect(r.confidence).toBe("low");
  });

  it("x-nexus-client takes priority over User-Agent", () => {
    const r = detectClient({ "x-nexus-client": "vscode", "user-agent": "curl/8.1.2" });
    expect(r.clientType).toBe("vscode");
  });

  it("case-insensitive header matching", () => {
    const r = detectClient({ "User-Agent": "claude-code/1.0" });
    expect(r.clientType).toBe("claude-code");
  });

  it("signal property is non-empty string", () => {
    const r = detectClient({ "user-agent": "curl/7" });
    expect(typeof r.signal).toBe("string");
    expect(r.signal.length).toBeGreaterThan(0);
  });
});

describe("makeClientDetectMiddleware", () => {
  it("attaches result to request under nexusClient key", () => {
    const mw = makeClientDetectMiddleware();
    const req = { headers: { "x-nexus-client": "cursor" } };
    let called = false;
    mw(req, {}, () => {
      called = true;
    });
    expect((req as Record<string, unknown>).nexusClient).toBeDefined();
    expect(
      ((req as Record<string, unknown>).nexusClient as { clientType: string }).clientType,
    ).toBe("cursor");
    expect(called).toBe(true);
  });

  it("uses custom attachAs key", () => {
    const mw = makeClientDetectMiddleware({ attachAs: "clientInfo" });
    const req = { headers: { "user-agent": "curl/8" } };
    mw(req, {});
    expect((req as Record<string, unknown>).clientInfo).toBeDefined();
  });
});
