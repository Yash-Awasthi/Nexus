// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  FileLock,
  ChecksumRegistry,
  computeChecksum,
  MimeDetector,
  PermissionSetter,
  IngestionSignalBus,
  WorkflowTrigger,
  FilenameTemplater,
  DocConsumer,
  type IngestionSignalEvent,
  type IngestedDocument,
} from "../src/index.js";

// ── computeChecksum ───────────────────────────────────────────────────────────

describe("computeChecksum", () => {
  it("returns a hex string", () => {
    const cs = computeChecksum("hello world");
    expect(cs).toMatch(/^[0-9a-f]+$/);
  });

  it("same content → same checksum", () => {
    expect(computeChecksum("abc")).toBe(computeChecksum("abc"));
  });

  it("different content → different checksum", () => {
    expect(computeChecksum("abc")).not.toBe(computeChecksum("xyz"));
  });
});

// ── FileLock ──────────────────────────────────────────────────────────────────

describe("FileLock", () => {
  it("acquire returns true on first call", () => {
    const lock = new FileLock();
    expect(lock.acquire("/a")).toBe(true);
  });

  it("acquire returns false when already locked", () => {
    const lock = new FileLock();
    lock.acquire("/a");
    expect(lock.acquire("/a")).toBe(false);
  });

  it("release allows re-acquire", () => {
    const lock = new FileLock();
    lock.acquire("/a");
    lock.release("/a");
    expect(lock.acquire("/a")).toBe(true);
  });

  it("isLocked reflects state", () => {
    const lock = new FileLock();
    expect(lock.isLocked("/a")).toBe(false);
    lock.acquire("/a");
    expect(lock.isLocked("/a")).toBe(true);
  });

  it("lockedPaths returns all locked paths", () => {
    const lock = new FileLock();
    lock.acquire("/a");
    lock.acquire("/b");
    expect(lock.lockedPaths()).toContain("/a");
    expect(lock.lockedPaths()).toContain("/b");
  });

  it("clear removes all locks", () => {
    const lock = new FileLock();
    lock.acquire("/a");
    lock.clear();
    expect(lock.lockedPaths()).toHaveLength(0);
  });
});

// ── ChecksumRegistry ──────────────────────────────────────────────────────────

describe("ChecksumRegistry", () => {
  it("register first time returns not duplicate", () => {
    const reg = new ChecksumRegistry();
    const result = reg.register("abc123", "doc-1");
    expect(result.isDuplicate).toBe(false);
  });

  it("register second time returns duplicate with existing id", () => {
    const reg = new ChecksumRegistry();
    reg.register("abc123", "doc-1");
    const result = reg.register("abc123", "doc-2");
    expect(result.isDuplicate).toBe(true);
    expect(result.existingId).toBe("doc-1");
  });

  it("has returns correct boolean", () => {
    const reg = new ChecksumRegistry();
    reg.register("x", "doc-1");
    expect(reg.has("x")).toBe(true);
    expect(reg.has("y")).toBe(false);
  });

  it("remove clears entry", () => {
    const reg = new ChecksumRegistry();
    reg.register("x", "doc-1");
    reg.remove("x");
    expect(reg.has("x")).toBe(false);
  });

  it("clear empties registry", () => {
    const reg = new ChecksumRegistry();
    reg.register("a", "doc-1");
    reg.register("b", "doc-2");
    reg.clear();
    expect(reg.size()).toBe(0);
  });
});

// ── MimeDetector ──────────────────────────────────────────────────────────────

describe("MimeDetector", () => {
  const detector = new MimeDetector();

  it("detects pdf", () => {
    expect(detector.detect("report.pdf")).toBe("application/pdf");
  });

  it("detects typescript", () => {
    expect(detector.detect("src/index.ts")).toBe("text/typescript");
  });

  it("detects xlsx", () => {
    expect(detector.detect("data.xlsx")).toContain("spreadsheetml");
  });

  it("returns octet-stream for unknown extension", () => {
    expect(detector.detect("file.xyz")).toBe("application/octet-stream");
  });

  it("toDocumentType maps pdf correctly", () => {
    expect(detector.toDocumentType("application/pdf")).toBe("pdf");
  });

  it("toDocumentType maps image correctly", () => {
    expect(detector.toDocumentType("image/png")).toBe("image");
  });

  it("toDocumentType maps code correctly", () => {
    expect(detector.toDocumentType("text/typescript")).toBe("code");
  });

  it("toDocumentType returns unknown for unmapped type", () => {
    expect(detector.toDocumentType("application/octet-stream")).toBe("unknown");
  });
});

// ── PermissionSetter ──────────────────────────────────────────────────────────

describe("PermissionSetter", () => {
  it("set and get works", () => {
    const ps = new PermissionSetter();
    ps.set("doc-1", "write");
    expect(ps.get("doc-1")).toBe("write");
  });

  it("get returns none for unknown document", () => {
    const ps = new PermissionSetter();
    expect(ps.get("unknown")).toBe("none");
  });

  it("defaultFor owner returns owner", () => {
    const ps = new PermissionSetter();
    expect(ps.defaultFor("text", "user-1")).toBe("owner");
  });

  it("defaultFor code without owner returns write", () => {
    const ps = new PermissionSetter();
    expect(ps.defaultFor("code")).toBe("write");
  });

  it("defaultFor text without owner returns read", () => {
    const ps = new PermissionSetter();
    expect(ps.defaultFor("text")).toBe("read");
  });
});

// ── IngestionSignalBus ────────────────────────────────────────────────────────

describe("IngestionSignalBus", () => {
  it("on receives emitted events", () => {
    const bus = new IngestionSignalBus();
    const events: IngestionSignalEvent[] = [];
    bus.on((e) => events.push(e));
    bus.emit({
      type: "document_consumption_started",
      documentId: "doc-1",
      path: "/file.txt",
      timestamp: new Date().toISOString(),
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("document_consumption_started");
  });

  it("unsubscribe stops delivery", () => {
    const bus = new IngestionSignalBus();
    const events: IngestionSignalEvent[] = [];
    const unsub = bus.on((e) => events.push(e));
    unsub();
    bus.emit({ type: "document_skipped", documentId: "d", path: "/", timestamp: "" });
    expect(events).toHaveLength(0);
  });

  it("handler error does not propagate", () => {
    const bus = new IngestionSignalBus();
    bus.on(() => { throw new Error("boom"); });
    expect(() => bus.emit({ type: "document_consumption_finished", documentId: "d", path: "/", timestamp: "" })).not.toThrow();
  });
});

// ── WorkflowTrigger ───────────────────────────────────────────────────────────

describe("WorkflowTrigger", () => {
  function fakeDoc(): IngestedDocument {
    return {
      id: "doc-1", originalPath: "/a.txt", outputPath: "/out/a.txt",
      mimeType: "text/plain", documentType: "text",
      checksum: "abc", sizeBytes: 100, permissions: "read",
      ingestedAt: new Date().toISOString(), metadata: {},
    };
  }

  it("trigger without executor returns triggered=false", async () => {
    const trigger = new WorkflowTrigger();
    const result = await trigger.trigger("wf-1", fakeDoc());
    expect(result.triggered).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("trigger with executor calls it", async () => {
    const trigger = new WorkflowTrigger();
    const called: string[] = [];
    trigger.inject(async (wfId) => { called.push(wfId); });
    const result = await trigger.trigger("wf-1", fakeDoc());
    expect(result.triggered).toBe(true);
    expect(called).toContain("wf-1");
  });

  it("executor error is captured", async () => {
    const trigger = new WorkflowTrigger();
    trigger.inject(async () => { throw new Error("workflow failed"); });
    const result = await trigger.trigger("wf-1", fakeDoc());
    expect(result.triggered).toBe(false);
    expect(result.error).toContain("workflow failed");
  });
});

// ── FilenameTemplater ─────────────────────────────────────────────────────────

describe("FilenameTemplater", () => {
  const templater = new FilenameTemplater();

  it("generates filename from template", () => {
    const name = templater.generate("{name}-{date}.{ext}", {
      name: "report", ext: "pdf", type: "pdf", id: "doc-1", date: "2026-01-15",
    });
    expect(name).toBe("report-2026-01-15.pdf");
  });

  it("replaces all tokens", () => {
    const name = templater.generate("{id}-{type}-{name}.{ext}", {
      name: "file", ext: "ts", type: "code", id: "doc-42",
    });
    expect(name).toBe("doc-42-code-file.ts");
  });

  it("parse extracts name and extension", () => {
    const { name, ext } = templater.parse("/path/to/document.pdf");
    expect(name).toBe("document");
    expect(ext).toBe("pdf");
  });

  it("parse handles file without extension", () => {
    const { name, ext } = templater.parse("/path/README");
    expect(name).toBe("README");
    expect(ext).toBe("");
  });
});

// ── DocConsumer ───────────────────────────────────────────────────────────────

describe("DocConsumer", () => {
  it("ingest returns success with document", async () => {
    const consumer = new DocConsumer();
    const result = await consumer.ingest({
      path: "/docs/report.pdf",
      content: "PDF content here",
    });
    expect(result.status).toBe("success");
    expect(result.document).toBeDefined();
    expect(result.document!.documentType).toBe("pdf");
    expect(result.document!.mimeType).toBe("application/pdf");
  });

  it("ingest emits started and finished signals", async () => {
    const bus = new IngestionSignalBus();
    const consumer = new DocConsumer({ signalBus: bus });
    const signalTypes: string[] = [];
    bus.on((e) => signalTypes.push(e.type));
    await consumer.ingest({ path: "/f.txt", content: "hello" });
    expect(signalTypes).toContain("document_consumption_started");
    expect(signalTypes).toContain("document_consumption_finished");
  });

  it("ingest skips duplicate (same checksum)", async () => {
    const consumer = new DocConsumer();
    const content = "identical content";
    await consumer.ingest({ path: "/f1.txt", content });
    const result = await consumer.ingest({ path: "/f2.txt", content });
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("Duplicate");
  });

  it("ingest skips locked file", async () => {
    const lock = new FileLock();
    lock.acquire("/locked.txt");
    const consumer = new DocConsumer({ lock });
    const result = await consumer.ingest({ path: "/locked.txt", content: "data" });
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("locked");
  });

  it("lock is released after ingestion", async () => {
    const lock = new FileLock();
    const consumer = new DocConsumer({ lock });
    await consumer.ingest({ path: "/f.txt", content: "hi" });
    expect(lock.isLocked("/f.txt")).toBe(false);
  });

  it("uses output template when provided", async () => {
    const consumer = new DocConsumer();
    const result = await consumer.ingest({
      path: "/docs/report.pdf",
      content: "content",
      outputTemplate: "{id}-{name}.{ext}",
    });
    expect(result.document!.outputPath).toContain("report");
    expect(result.document!.outputPath).toContain(".pdf");
  });

  it("sets owner permission when owner provided", async () => {
    const consumer = new DocConsumer();
    const result = await consumer.ingest({
      path: "/f.txt",
      content: "text",
      owner: "alice",
    });
    expect(result.document!.permissions).toBe("owner");
  });

  it("triggers workflow when workflowId provided", async () => {
    const triggered: string[] = [];
    const trigger = new WorkflowTrigger();
    trigger.inject(async (wfId) => { triggered.push(wfId); });
    const consumer = new DocConsumer({ workflowTrigger: trigger });
    await consumer.ingest({ path: "/f.txt", content: "hi", workflowId: "wf-process" });
    expect(triggered).toContain("wf-process");
  });

  it("getSignalBus, getLock, getChecksumRegistry return instances", () => {
    const consumer = new DocConsumer();
    expect(consumer.getSignalBus()).toBeDefined();
    expect(consumer.getLock()).toBeDefined();
    expect(consumer.getChecksumRegistry()).toBeDefined();
  });

  it("ingested document includes tags from request", async () => {
    const consumer = new DocConsumer();
    const result = await consumer.ingest({
      path: "/f.txt",
      content: "content",
      tags: ["important", "review"],
    });
    expect((result.document!.metadata.tags as string[])).toContain("important");
  });
});
