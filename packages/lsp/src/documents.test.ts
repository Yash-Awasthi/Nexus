// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vite-plus/test";

import { DocumentSync } from "./documents.ts";

interface Call {
  method: string;
  params: unknown;
}

function makeSync(maxDocuments = 50): { sync: DocumentSync; calls: Call[] } {
  const calls: Call[] = [];
  const sync = new DocumentSync({
    maxDocuments,
    diagnosticsWaitMs: 50,
    notify: (method, params) => calls.push({ method, params }),
  });
  return { sync, calls };
}

const URI = "file:///workspace/a.ts";

describe("DocumentSync versions", () => {
  it("sends didOpen v1, didChange v2 and v3 with full text, then didClose", () => {
    const { sync, calls } = makeSync();
    expect(sync.open({ uri: URI, languageId: "typescript", text: "a" })).toBe(1);
    expect(sync.change(URI, "ab")).toBe(2);
    expect(sync.change(URI, "abc")).toBe(3);
    sync.close(URI);

    expect(calls.map((call) => call.method)).toEqual([
      "textDocument/didOpen",
      "textDocument/didChange",
      "textDocument/didChange",
      "textDocument/didClose",
    ]);
    const opened = calls[0]?.params as { textDocument: { version: number; text: string } };
    expect(opened.textDocument).toMatchObject({ version: 1, text: "a" });
    const changes = calls.slice(1, 3).map((call) => {
      const params = call.params as {
        textDocument: { version: number };
        contentChanges: Array<{ text: string }>;
      };
      return { version: params.textDocument.version, text: params.contentChanges[0]?.text };
    });
    expect(changes).toEqual([
      { version: 2, text: "ab" },
      { version: 3, text: "abc" },
    ]);
    const closed = calls[3]?.params as { textDocument: { uri: string } };
    expect(closed.textDocument.uri).toBe(URI);
    expect(sync.openCount).toBe(0);
  });

  it("evicts the least recently used document above the cap", () => {
    const { sync, calls } = makeSync(2);
    sync.open({ uri: "file:///a.ts", languageId: "typescript", text: "a" });
    sync.open({ uri: "file:///b.ts", languageId: "typescript", text: "b" });
    sync.open({ uri: "file:///c.ts", languageId: "typescript", text: "c" });

    expect(sync.openCount).toBe(2);
    expect(sync.isOpen("file:///a.ts")).toBe(false);
    expect(sync.isOpen("file:///c.ts")).toBe(true);
    const closes = calls.filter((call) => call.method === "textDocument/didClose");
    expect(closes).toHaveLength(1);
    expect((closes[0]?.params as { textDocument: { uri: string } }).textDocument.uri).toBe(
      "file:///a.ts",
    );
  });
});

describe("DocumentSync diagnostics", () => {
  it("returns an early publish without waiting", async () => {
    const { sync } = makeSync();
    sync.open({ uri: URI, languageId: "typescript", text: "a" });
    sync.publish({ uri: URI, version: 1, diagnostics: [{ message: "early" }] });
    const result = await sync.waitForDiagnostics(URI, 1, 500);
    expect(result).toEqual({ diagnostics: [{ message: "early" }], stale: false });
  });

  it("waits for a late publish", async () => {
    const { sync } = makeSync();
    sync.open({ uri: URI, languageId: "typescript", text: "a" });
    const pending = sync.waitForDiagnostics(URI, 1, 500);
    setTimeout(
      () => sync.publish({ uri: URI, version: 1, diagnostics: [{ message: "late" }] }),
      40,
    );
    const result = await pending;
    expect(result).toEqual({ diagnostics: [{ message: "late" }], stale: false });
  });

  it("returns the last known set as stale when nothing arrives", async () => {
    const { sync } = makeSync();
    sync.open({ uri: URI, languageId: "typescript", text: "a" });
    sync.publish({ uri: URI, version: 1, diagnostics: [{ message: "old" }] });
    sync.change(URI, "ab");
    const result = await sync.waitForDiagnostics(URI, 2, 30);
    expect(result).toEqual({ diagnostics: [{ message: "old" }], stale: true });
  });
});

describe("DocumentSync symbol cache", () => {
  it("serves a repeated read for the same uri and version and invalidates on change", () => {
    const { sync } = makeSync();
    sync.open({ uri: URI, languageId: "typescript", text: "a" });
    sync.setSymbols(URI, 1, [{ name: "x" }]);
    expect(sync.getSymbols(URI, 1)).toEqual([{ name: "x" }]);

    sync.change(URI, "ab");
    expect(sync.getSymbols(URI, 2)).toBeUndefined();
    expect(sync.getSymbols(URI, 1)).toBeUndefined();
  });
});
