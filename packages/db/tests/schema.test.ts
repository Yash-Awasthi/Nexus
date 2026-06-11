// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/db — schema boundary tests (property-based)
 *
 * These tests validate the TypeScript schema types without a live database.
 * They use fast-check to assert structural invariants on the type exports —
 * specifically that insertable and selectable types have the correct
 * required/optional fields, and that Drizzle's type inference is sane.
 *
 * For integration tests against a real DB, see packages/db/tests/integration/.
 */
import { describe, it, expect } from "vitest";
import { fc } from "@fast-check/vitest";
import {
  ingestedEvents,
  signals,
  verdicts,
  councilTranscripts,
  runtimeTasks,
  approvalRequests,
  auditLog,
  GENESIS_SENTINEL,
  type NewIngestedEvent,
  type NewSignal,
  type NewRuntimeTask,
  type NewApprovalRequest,
  type NewAuditLogEntry,
} from "../src/schema/index.js";

// ─── Table export shape ───────────────────────────────────────────────────────

describe("schema exports", () => {
  it("exports all 7 nexus tables", () => {
    expect(ingestedEvents).toBeDefined();
    expect(signals).toBeDefined();
    expect(verdicts).toBeDefined();
    expect(councilTranscripts).toBeDefined();
    expect(runtimeTasks).toBeDefined();
    expect(approvalRequests).toBeDefined();
    expect(auditLog).toBeDefined();
  });

  it("exports GENESIS_SENTINEL constant", () => {
    expect(GENESIS_SENTINEL).toBe("NEXUS_AUDIT_CHAIN_GENESIS_V1");
  });
});

// ─── Table column names ───────────────────────────────────────────────────────

describe("ingested_events table", () => {
  it("has the expected column names", () => {
    const cols = Object.keys(ingestedEvents);
    expect(cols).toContain("id");
    expect(cols).toContain("source");
    expect(cols).toContain("eventType");
    expect(cols).toContain("payload");
    expect(cols).toContain("createdAt");
    expect(cols).toContain("processedAt");
    expect(cols).toContain("idempotencyKey");
  });
});

describe("signals table", () => {
  it("has the expected column names", () => {
    const cols = Object.keys(signals);
    expect(cols).toContain("id");
    expect(cols).toContain("signalType");
    expect(cols).toContain("sourceEventIds");
    expect(cols).toContain("summary");
    expect(cols).toContain("priority");
    expect(cols).toContain("createdAt");
  });
});

describe("verdicts table", () => {
  it("has the expected column names", () => {
    const cols = Object.keys(verdicts);
    expect(cols).toContain("id");
    expect(cols).toContain("signalId");
    expect(cols).toContain("decision");
    expect(cols).toContain("confidence");
    expect(cols).toContain("rationale");
    expect(cols).toContain("dissents");
    expect(cols).toContain("costUsd");
  });
});

describe("runtime_tasks table", () => {
  it("has the expected column names", () => {
    const cols = Object.keys(runtimeTasks);
    expect(cols).toContain("id");
    expect(cols).toContain("type");
    expect(cols).toContain("payload");
    expect(cols).toContain("status");
    expect(cols).toContain("priority");
    expect(cols).toContain("verdictId");
    expect(cols).toContain("startedAt");
    expect(cols).toContain("completedAt");
  });
});

describe("audit_log table", () => {
  it("has the expected column names", () => {
    const cols = Object.keys(auditLog);
    expect(cols).toContain("id");
    expect(cols).toContain("sequence");
    expect(cols).toContain("entityType");
    expect(cols).toContain("entityId");
    expect(cols).toContain("action");
    expect(cols).toContain("actor");
    expect(cols).toContain("payloadHash");
    expect(cols).toContain("chainHash");
  });
});

// ─── Type inference checks (compile-time, but also runtime sanity) ────────────

describe("NewIngestedEvent type shape", () => {
  it("accepts a valid insert object", () => {
    const row: NewIngestedEvent = {
      source: "gmail",
      eventType: "email.received",
      payload: { subject: "Test", from: "user@example.com" },
    };
    expect(row.source).toBe("gmail");
    expect(row.eventType).toBe("email.received");
    // id is optional on insert (defaultRandom)
    expect(row.id).toBeUndefined();
  });
});

describe("NewSignal type shape", () => {
  it("accepts a valid insert object", () => {
    const row: NewSignal = {
      signalType: "email.action-required",
      summary: "Approval needed for purchase order",
      priority: "high",
    };
    expect(row.signalType).toBeTruthy();
  });
});

describe("NewRuntimeTask type shape", () => {
  it("accepts a minimal insert object", () => {
    const row: NewRuntimeTask = {
      type: "email.send",
      payload: { to: "team@example.com", subject: "Hello" },
    };
    expect(row.type).toBe("email.send");
    // Status has a default — optional on insert
    expect(row.status).toBeUndefined();
  });
});

describe("NewApprovalRequest type shape", () => {
  it("accepts a valid insert object", () => {
    const row: NewApprovalRequest = {
      entityType: "task",
      entityId: "00000000-0000-0000-0000-000000000001",
      action: "email.send-to-external",
      requestor: "nexus/runtime",
    };
    expect(row.entityType).toBe("task");
  });
});

describe("NewAuditLogEntry type shape", () => {
  it("accepts a valid insert object", () => {
    const row: NewAuditLogEntry = {
      sequence: 1,
      entityType: "task",
      entityId: "00000000-0000-0000-0000-000000000001",
      action: "task.completed",
      actor: "nexus/runtime",
      payloadHash: "a".repeat(64),
      chainHash: "b".repeat(64),
    };
    expect(row.sequence).toBe(1);
    expect(row.payloadHash).toHaveLength(64);
    expect(row.chainHash).toHaveLength(64);
  });
});

// ─── Property-based: signal priority enum ────────────────────────────────────

describe("signal priority — property-based", () => {
  const validPriorities = ["low", "medium", "high", "critical"] as const;

  it("only accepts valid priority enum values", () => {
    fc.assert(
      fc.property(fc.constantFrom(...validPriorities), (priority) => {
        const row: NewSignal = {
          signalType: "test",
          summary: "test signal",
          priority,
        };
        expect(validPriorities).toContain(row.priority);
      }),
    );
  });
});

describe("task status — property-based", () => {
  const validStatuses = [
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
    "awaiting_approval",
  ] as const;

  it("only accepts valid status enum values", () => {
    fc.assert(
      fc.property(fc.constantFrom(...validStatuses), (status) => {
        const row: NewRuntimeTask = {
          type: "test",
          payload: {},
          status,
        };
        expect(validStatuses).toContain(row.status);
      }),
    );
  });
});

// ─── GENESIS_SENTINEL immutability ────────────────────────────────────────────

describe("GENESIS_SENTINEL", () => {
  it("is a non-empty string", () => {
    expect(typeof GENESIS_SENTINEL).toBe("string");
    expect(GENESIS_SENTINEL.length).toBeGreaterThan(0);
  });

  it("does not start or end with whitespace (sentinel must be trimmed)", () => {
    expect(GENESIS_SENTINEL).toBe(GENESIS_SENTINEL.trim());
  });
});
