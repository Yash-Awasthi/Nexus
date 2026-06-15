// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import {
  WorkflowEngine,
  containsText,
  hasTag,
  hasMetadata,
  matchesRegex,
  hasFormat,
  fromSource,
  tagAction,
  setMetadataAction,
  routeAction,
  webhookAction,
  transformAction,
  type WorkflowDoc,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDoc(overrides: Partial<WorkflowDoc> = {}): WorkflowDoc {
  return {
    id: "doc-001",
    content: "This document discusses quarterly earnings and finance",
    format: "pdf",
    source: "email",
    tags: [],
    metadata: {},
    createdAt: Date.now(),
    ...overrides,
  };
}

// ── WorkflowEngine register / unregister ──────────────────────────────────────

describe("WorkflowEngine register / unregister", () => {
  it("registers a workflow and it appears in listWorkflows()", () => {
    const engine = new WorkflowEngine();
    engine.register({ id: "wf-1", trigger: "on_ingest", conditions: [], actions: [] });
    expect(engine.listWorkflows()).toContain("wf-1");
  });

  it("unregisters a workflow by id", () => {
    const engine = new WorkflowEngine();
    engine.register({ id: "wf-del", trigger: "on_ingest", conditions: [], actions: [] });
    engine.unregister("wf-del");
    expect(engine.listWorkflows()).not.toContain("wf-del");
  });

  it("allows multiple workflows", () => {
    const engine = new WorkflowEngine();
    engine.register({ id: "wf-a", trigger: "on_ingest", conditions: [], actions: [] });
    engine.register({ id: "wf-b", trigger: "on_tag", conditions: [], actions: [] });
    expect(engine.listWorkflows()).toHaveLength(2);
  });
});

// ── Built-in conditions ───────────────────────────────────────────────────────

describe("containsText condition", () => {
  it("passes when doc content contains the text", async () => {
    expect(await containsText("earnings")(makeDoc())).toBe(true);
  });

  it("fails when text is absent", async () => {
    expect(await containsText("NOTPRESENT_XYZ")(makeDoc())).toBe(false);
  });

  it("is case-insensitive by default", async () => {
    expect(await containsText("EARNINGS")(makeDoc())).toBe(true);
  });

  it("respects caseSensitive: true", async () => {
    expect(await containsText("EARNINGS", { caseSensitive: true })(makeDoc())).toBe(false);
  });
});

describe("hasTag condition", () => {
  it("passes when doc.tags includes the tag", async () => {
    expect(await hasTag("urgent")(makeDoc({ tags: ["urgent", "finance"] }))).toBe(true);
  });

  it("fails when tag is absent", async () => {
    expect(await hasTag("urgent")(makeDoc())).toBe(false);
  });
});

describe("hasMetadata condition", () => {
  it("passes when metadata[key] equals value", async () => {
    expect(await hasMetadata("format", "pdf")(makeDoc({ metadata: { format: "pdf" } }))).toBe(true);
  });

  it("fails when value differs", async () => {
    expect(await hasMetadata("format", "pdf")(makeDoc({ metadata: { format: "docx" } }))).toBe(
      false,
    );
  });
});

describe("matchesRegex condition", () => {
  it("passes when content matches regex", async () => {
    const doc = makeDoc({ content: "Results for Q3 2026 are strong" });
    expect(await matchesRegex(/Q[1-4]\s+\d{4}/)(doc)).toBe(true);
  });

  it("fails when content does not match", async () => {
    expect(await matchesRegex(/Q[1-4]\s+\d{4}/)(makeDoc())).toBe(false);
  });
});

describe("hasFormat condition", () => {
  it("passes when doc.format matches", async () => {
    expect(await hasFormat("pdf")(makeDoc())).toBe(true);
  });

  it("fails when format differs", async () => {
    expect(await hasFormat("docx")(makeDoc())).toBe(false);
  });
});

describe("fromSource condition", () => {
  it("passes when source matches string", async () => {
    expect(await fromSource("email")(makeDoc())).toBe(true);
  });

  it("passes when source matches regex", async () => {
    expect(await fromSource(/^email$/)(makeDoc())).toBe(true);
  });

  it("fails when source is absent", async () => {
    expect(await fromSource("email")(makeDoc({ source: undefined }))).toBe(false);
  });
});

// ── WorkflowEngine.process ────────────────────────────────────────────────────

describe("WorkflowEngine.process", () => {
  it("returns ProcessResult with docId and executed array", async () => {
    const engine = new WorkflowEngine();
    engine.register({ id: "wf", trigger: "on_ingest", conditions: [], actions: [] });
    const result = await engine.process(makeDoc(), "on_ingest");
    expect(result.docId).toBe("doc-001");
    expect(Array.isArray(result.executed)).toBe(true);
  });

  it("skips workflows with non-matching trigger", async () => {
    const engine = new WorkflowEngine();
    engine.register({
      id: "wf-update",
      trigger: "on_update",
      conditions: [],
      actions: [tagAction("updated")],
    });
    const result = await engine.process(makeDoc(), "on_ingest");
    expect(result.executed).toHaveLength(0);
  });

  it("AND logic: fails when any condition is false", async () => {
    const engine = new WorkflowEngine();
    engine.register({
      id: "wf-and",
      trigger: "on_ingest",
      conditions: [containsText("earnings"), hasFormat("txt")], // second fails
      actions: [tagAction("matched")],
    });
    const result = await engine.process(makeDoc(), "on_ingest"); // format is "pdf"
    expect(result.executed[0]?.matched).toBe(false);
  });

  it("runs actions when all conditions pass", async () => {
    const engine = new WorkflowEngine();
    engine.register({
      id: "wf-hit",
      trigger: "on_ingest",
      conditions: [containsText("earnings"), hasFormat("pdf")],
      actions: [tagAction("finance")],
    });
    const doc = makeDoc();
    const result = await engine.process(doc, "on_ingest");
    expect(result.executed[0]?.matched).toBe(true);
    expect(result.executed[0]?.actionResults[0]?.success).toBe(true);
  });

  it("totalDurationMs is a number", async () => {
    const engine = new WorkflowEngine();
    engine.register({ id: "wf", trigger: "on_ingest", conditions: [], actions: [] });
    const result = await engine.process(makeDoc(), "on_ingest");
    expect(typeof result.totalDurationMs).toBe("number");
  });
});

// ── Built-in actions ──────────────────────────────────────────────────────────

describe("tagAction", () => {
  it("adds tag to doc.tags", async () => {
    const engine = new WorkflowEngine();
    engine.register({
      id: "wf",
      trigger: "on_ingest",
      conditions: [],
      actions: [tagAction("auto-tagged")],
    });
    const doc = makeDoc();
    await engine.process(doc, "on_ingest");
    expect(doc.tags).toContain("auto-tagged");
  });

  it("returns action:tag result", async () => {
    const engine = new WorkflowEngine();
    engine.register({ id: "wf", trigger: "on_ingest", conditions: [], actions: [tagAction("x")] });
    const result = await engine.process(makeDoc(), "on_ingest");
    expect(result.executed[0]?.actionResults[0]?.action).toBe("tag");
  });
});

describe("setMetadataAction", () => {
  it("sets metadata key and value on the doc", async () => {
    const engine = new WorkflowEngine();
    engine.register({
      id: "wf",
      trigger: "on_ingest",
      conditions: [],
      actions: [setMetadataAction("reviewed", true)],
    });
    const doc = makeDoc();
    await engine.process(doc, "on_ingest");
    expect(doc.metadata["reviewed"]).toBe(true);
  });
});

describe("routeAction", () => {
  it("sets doc.metadata.route to the queue name", async () => {
    const engine = new WorkflowEngine();
    engine.register({
      id: "wf",
      trigger: "on_ingest",
      conditions: [],
      actions: [routeAction("archive-queue")],
    });
    const doc = makeDoc();
    await engine.process(doc, "on_ingest");
    expect(doc.metadata["route"]).toBe("archive-queue");
  });
});

describe("webhookAction", () => {
  it("POSTs to the webhook URL", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;
    const engine = new WorkflowEngine({ fetchFn });
    engine.register({
      id: "wf",
      trigger: "on_ingest",
      conditions: [],
      actions: [webhookAction("https://example.com/hook")],
    });
    await engine.process(makeDoc(), "on_ingest");
    expect(fetchFn).toHaveBeenCalledWith(
      "https://example.com/hook",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns action:webhook on success", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;
    const engine = new WorkflowEngine({ fetchFn });
    engine.register({
      id: "wf",
      trigger: "on_ingest",
      conditions: [],
      actions: [webhookAction("https://x.example")],
    });
    const result = await engine.process(makeDoc(), "on_ingest");
    expect(result.executed[0]?.actionResults[0]?.action).toBe("webhook");
    expect(result.executed[0]?.actionResults[0]?.success).toBe(true);
  });

  it("returns success:false when fetch fails", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
    const engine = new WorkflowEngine({ fetchFn });
    engine.register({
      id: "wf",
      trigger: "on_ingest",
      conditions: [],
      actions: [webhookAction("https://fail.example")],
    });
    const result = await engine.process(makeDoc(), "on_ingest");
    expect(result.executed[0]?.actionResults[0]?.action).toBe("webhook");
    expect(result.executed[0]?.actionResults[0]?.success).toBe(false);
  });
});

describe("transformAction", () => {
  it("applies transform and stores result in metadata", async () => {
    const engine = new WorkflowEngine();
    engine.register({
      id: "wf",
      trigger: "on_ingest",
      conditions: [],
      actions: [transformAction((c) => c.toUpperCase(), "upper")],
    });
    const doc = makeDoc({ content: "hello" });
    await engine.process(doc, "on_ingest");
    expect(doc.metadata["upper"]).toBe("HELLO");
  });
});

// ── continueOnMatch ───────────────────────────────────────────────────────────

describe("continueOnMatch: false", () => {
  it("stops processing after first matching workflow", async () => {
    const engine = new WorkflowEngine();
    engine.register({
      id: "first",
      trigger: "on_ingest",
      conditions: [],
      actions: [tagAction("first")],
      continueOnMatch: false,
    });
    engine.register({
      id: "second",
      trigger: "on_ingest",
      conditions: [],
      actions: [tagAction("second")],
    });
    const doc = makeDoc();
    const result = await engine.process(doc, "on_ingest");
    expect(doc.tags).toContain("first");
    expect(doc.tags).not.toContain("second");
    expect(result.executed).toHaveLength(1);
  });
});

// ── Error isolation ───────────────────────────────────────────────────────────

describe("error isolation in actions", () => {
  it("records action error but continues to next action", async () => {
    const engine = new WorkflowEngine();
    engine.register({
      id: "wf",
      trigger: "on_ingest",
      conditions: [],
      actions: [
        async () => {
          throw new Error("action failed");
        },
        tagAction("after-error"),
      ],
    });
    const doc = makeDoc();
    const result = await engine.process(doc, "on_ingest");
    const ars = result.executed[0]?.actionResults ?? [];
    expect(ars[0]?.success).toBe(false);
    expect(ars[1]?.action).toBe("tag");
    expect(ars[1]?.success).toBe(true);
  });
});
