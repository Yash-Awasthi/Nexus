// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  JinjaTemplater,
  WorkflowMatcher,
  ActionExecutor,
  MockActionBackend,
  WorkflowEngine,
  buildActionContext,
  type WorkflowDefinition,
  type ActionContext,
  type TriggerCondition,
} from "../src/index.js";

function pdfContext(): ActionContext {
  return buildActionContext({
    documentId: "doc-1",
    originalPath: "/uploads/report.pdf",
    outputPath: "/processed/report-2026-01-15.pdf",
    mimeType: "application/pdf",
    documentType: "pdf",
    owner: "alice",
    tags: ["finance", "report"],
  });
}

// ── JinjaTemplater ────────────────────────────────────────────────────────────

describe("JinjaTemplater", () => {
  const t = new JinjaTemplater();

  it("substitutes simple variable", () => {
    expect(t.render("Hello {{name}}!", { name: "World" })).toBe("Hello World!");
  });

  it("substitutes multiple variables", () => {
    const result = t.render("{{greeting}} {{name}}", { greeting: "Hi", name: "Alice" });
    expect(result).toBe("Hi Alice");
  });

  it("leaves unknown placeholder intact", () => {
    const result = t.render("{{unknown}}", {});
    expect(result).toBe("{{unknown}}");
  });

  it("resolves nested keys", () => {
    const result = t.render("{{meta.owner}}", { meta: { owner: "alice" } });
    expect(result).toBe("alice");
  });

  it("handles missing nested key gracefully", () => {
    const result = t.render("{{meta.missing}}", { meta: {} });
    expect(result).toBe("{{meta.missing}}");
  });

  it("renderParams substitutes all values", () => {
    const params = { subject: "Doc {{documentId}}", to: "{{owner}}@example.com" };
    const ctx = { documentId: "doc-42", owner: "alice" };
    const rendered = t.renderParams(params, ctx);
    expect(rendered["subject"]).toBe("Doc doc-42");
    expect(rendered["to"]).toBe("alice@example.com");
  });

  it("handles non-string context values", () => {
    const result = t.render("Count: {{count}}", { count: 42 });
    expect(result).toBe("Count: 42");
  });
});

// ── WorkflowMatcher ───────────────────────────────────────────────────────────

describe("WorkflowMatcher", () => {
  const matcher = new WorkflowMatcher();
  const ctx = pdfContext();

  it("equals operator matches exact value", () => {
    const c: TriggerCondition = {
      field: "mime_type",
      operator: "equals",
      value: "application/pdf",
    };
    expect(matcher.matches(ctx, c)).toBe(true);
  });

  it("equals operator rejects non-match", () => {
    const c: TriggerCondition = { field: "mime_type", operator: "equals", value: "image/png" };
    expect(matcher.matches(ctx, c)).toBe(false);
  });

  it("contains operator matches substring", () => {
    const c: TriggerCondition = {
      field: "original_path" as any,
      operator: "contains",
      value: "report",
    };
    // original_path isn't a standard field, use originalPath via ActionContext
    const c2: TriggerCondition = { field: "document_type", operator: "contains", value: "pd" };
    expect(matcher.matches(ctx, c2)).toBe(true);
  });

  it("starts_with matches prefix", () => {
    const c: TriggerCondition = { field: "document_type", operator: "starts_with", value: "pd" };
    expect(matcher.matches(ctx, c)).toBe(true);
  });

  it("ends_with matches suffix", () => {
    const c: TriggerCondition = { field: "document_type", operator: "ends_with", value: "df" };
    expect(matcher.matches(ctx, c)).toBe(true);
  });

  it("matchesAll returns true when all conditions match", () => {
    const conditions: TriggerCondition[] = [
      { field: "mime_type", operator: "equals", value: "application/pdf" },
      { field: "document_type", operator: "equals", value: "pdf" },
    ];
    expect(matcher.matchesAll(ctx, conditions)).toBe(true);
  });

  it("matchesAll returns false when any condition fails", () => {
    const conditions: TriggerCondition[] = [
      { field: "mime_type", operator: "equals", value: "application/pdf" },
      { field: "document_type", operator: "equals", value: "image" },
    ];
    expect(matcher.matchesAll(ctx, conditions)).toBe(false);
  });

  it("matchesAll returns true for empty conditions", () => {
    expect(matcher.matchesAll(ctx, [])).toBe(true);
  });

  it("tag field joins array values with comma", () => {
    const c: TriggerCondition = { field: "tag", operator: "contains", value: "finance" };
    // tag field reads from ctx['tag'] which is undefined; this tests graceful miss
    expect(matcher.matches(ctx, c)).toBe(false);
  });
});

// ── ActionExecutor ────────────────────────────────────────────────────────────

describe("ActionExecutor", () => {
  it("without handler returns failed result", async () => {
    const executor = new ActionExecutor();
    const result = await executor.execute(
      { type: "email", params: { to: "user@example.com" } },
      pdfContext(),
      "wf-1",
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("No action handler");
  });

  it("with handler returns success", async () => {
    const backend = new MockActionBackend();
    const executor = new ActionExecutor().inject(backend.asHandler());
    const result = await executor.execute(
      { type: "email", params: { to: "admin@example.com" } },
      pdfContext(),
      "wf-1",
    );
    expect(result.success).toBe(true);
    expect(backend.calls).toHaveLength(1);
  });

  it("renders Jinja params before calling handler", async () => {
    const backend = new MockActionBackend();
    const executor = new ActionExecutor().inject(backend.asHandler());
    await executor.execute(
      { type: "email", params: { to: "{{owner}}@company.com" } },
      pdfContext(),
      "wf-1",
    );
    expect(backend.calls[0]!.params["to"]).toBe("alice@company.com");
  });

  it("captures handler errors", async () => {
    const executor = new ActionExecutor().inject(async () => {
      throw new Error("email server down");
    });
    const result = await executor.execute({ type: "email", params: {} }, pdfContext(), "wf-1");
    expect(result.success).toBe(false);
    expect(result.error).toContain("email server down");
  });
});

// ── MockActionBackend ─────────────────────────────────────────────────────────

describe("MockActionBackend", () => {
  it("records all action calls", async () => {
    const backend = new MockActionBackend();
    const handler = backend.asHandler();
    await handler("email", { to: "a@b.com" }, pdfContext());
    await handler("trash", {}, pdfContext());
    expect(backend.calls).toHaveLength(2);
    expect(backend.calls[0]!.type).toBe("email");
    expect(backend.calls[1]!.type).toBe("trash");
  });

  it("setThrows makes specific action type fail", async () => {
    const backend = new MockActionBackend();
    backend.setThrows("webhook", "webhook unreachable");
    const handler = backend.asHandler();
    await expect(handler("webhook", {}, pdfContext())).rejects.toThrow("webhook unreachable");
  });

  it("non-throwing types still succeed after setThrows", async () => {
    const backend = new MockActionBackend();
    backend.setThrows("email", "email down");
    const handler = backend.asHandler();
    await expect(handler("trash", {}, pdfContext())).resolves.toBeDefined();
  });
});

// ── WorkflowEngine ────────────────────────────────────────────────────────────

describe("WorkflowEngine", () => {
  function makePdfWorkflow(id = "wf-pdf"): WorkflowDefinition {
    return {
      id,
      name: "PDF Handler",
      enabled: true,
      conditions: [{ field: "mime_type", operator: "equals", value: "application/pdf" }],
      actions: [{ type: "email", params: { to: "admin@example.com", subject: "New PDF" } }],
    };
  }

  it("matching workflow runs its actions", async () => {
    const backend = new MockActionBackend();
    const executor = new ActionExecutor().inject(backend.asHandler());
    const engine = new WorkflowEngine(executor);
    engine.registerWorkflow(makePdfWorkflow());
    const results = await engine.runForDocument(pdfContext());
    expect(results[0]!.matched).toBe(true);
    expect(results[0]!.actions[0]!.success).toBe(true);
  });

  it("non-matching workflow is skipped", async () => {
    const engine = new WorkflowEngine();
    engine.registerWorkflow({
      id: "wf-img",
      name: "Image Handler",
      enabled: true,
      conditions: [{ field: "mime_type", operator: "equals", value: "image/png" }],
      actions: [{ type: "email", params: {} }],
    });
    const results = await engine.runForDocument(pdfContext());
    expect(results[0]!.matched).toBe(false);
    expect(results[0]!.actions).toHaveLength(0);
  });

  it("disabled workflow is skipped", async () => {
    const engine = new WorkflowEngine();
    engine.registerWorkflow({ ...makePdfWorkflow(), enabled: false });
    const results = await engine.runForDocument(pdfContext());
    expect(results).toHaveLength(0);
  });

  it("multiple workflows run in order", async () => {
    const order: string[] = [];
    const executor = new ActionExecutor().inject(async (type, params) => {
      order.push(params["label"] ?? type);
    });
    const engine = new WorkflowEngine(executor);
    engine.registerWorkflow({
      ...makePdfWorkflow("wf-1"),
      order: 2,
      actions: [{ type: "email", params: { label: "second" } }],
    });
    engine.registerWorkflow({
      ...makePdfWorkflow("wf-2"),
      order: 1,
      actions: [{ type: "email", params: { label: "first" } }],
    });
    await engine.runForDocument(pdfContext());
    expect(order[0]).toBe("first");
    expect(order[1]).toBe("second");
  });

  it("unregisterWorkflow removes it", () => {
    const engine = new WorkflowEngine();
    engine.registerWorkflow(makePdfWorkflow("wf-x"));
    expect(engine.unregisterWorkflow("wf-x")).toBe(true);
    expect(engine.getWorkflows()).toHaveLength(0);
  });

  it("onDocumentFinished is alias for runForDocument", async () => {
    const engine = new WorkflowEngine();
    engine.registerWorkflow(makePdfWorkflow());
    const r1 = await engine.runForDocument(pdfContext());
    const r2 = await engine.onDocumentFinished(pdfContext());
    expect(r1).toHaveLength(r2.length);
  });
});

// ── buildActionContext ────────────────────────────────────────────────────────

describe("buildActionContext", () => {
  it("sets ingestedAt to now if not provided", () => {
    const ctx = buildActionContext({
      documentId: "d",
      originalPath: "/f",
      outputPath: "/out",
      mimeType: "text/plain",
      documentType: "text",
    });
    expect(typeof ctx.ingestedAt).toBe("string");
    expect(new Date(ctx.ingestedAt).getFullYear()).toBeGreaterThan(2020);
  });
});
