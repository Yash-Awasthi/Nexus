// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  PrivacyCheckValidator,
  MockPromptStore,
  PrivacyAuditLog,
  ValidationPipeline,
  createPrivacyValidator,
  type PromptRow,
  type ValidationResult,
} from "../src/index.js";

function makeRow(prompt: string, sessionId = "s-1"): PromptRow {
  return { sessionId, prompt, createdAt: new Date().toISOString() };
}

// ── PrivacyCheckValidator — validate() ────────────────────────────────────────

describe("PrivacyCheckValidator.validate()", () => {
  let v: PrivacyCheckValidator;
  beforeEach(() => { v = new PrivacyCheckValidator(); });

  it("row absent → WARN_RACE when allowOnAbsent=true", () => {
    const r = v.validate("s-1", null, false);
    expect(r.decision).toBe("WARN_RACE");
    expect(r.reason).toBe("prompt_row_absent");
    expect(r.warnMessage).toBeDefined();
  });

  it("row absent → SUPPRESS when allowOnAbsent=false", () => {
    const v2 = new PrivacyCheckValidator({ allowOnAbsent: false });
    const r = v2.validate("s-1", null, false);
    expect(r.decision).toBe("SUPPRESS");
    expect(r.reason).toBe("prompt_row_absent_strict");
  });

  it("row exists but null → SUPPRESS (redacted)", () => {
    const r = v.validate("s-1", null, true);
    expect(r.decision).toBe("SUPPRESS");
    expect(r.reason).toBe("prompt_row_null");
  });

  it("row exists but prompt blank → SUPPRESS", () => {
    const r = v.validate("s-1", makeRow(""), true);
    expect(r.decision).toBe("SUPPRESS");
    expect(r.reason).toBe("prompt_blank_after_strip");
  });

  it("row with only whitespace → SUPPRESS", () => {
    const r = v.validate("s-1", makeRow("   \t\n  "), true);
    expect(r.decision).toBe("SUPPRESS");
  });

  it("row with content → ALLOW", () => {
    const r = v.validate("s-1", makeRow("Tell me the weather"), true);
    expect(r.decision).toBe("ALLOW");
    expect(r.reason).toBe("prompt_valid");
    expect(r.promptRow).toBeDefined();
  });

  it("sessionId is propagated in result", () => {
    const r = v.validate("session-xyz", makeRow("hello"), true);
    expect(r.sessionId).toBe("session-xyz");
  });
});

// ── PrivacyCheckValidator — checkWithStore() ─────────────────────────────────

describe("PrivacyCheckValidator.checkWithStore()", () => {
  it("key in store with valid prompt → ALLOW", async () => {
    const v = new PrivacyCheckValidator();
    const store = new MockPromptStore();
    store.set("s-1", makeRow("hello"));
    const r = await v.checkWithStore("s-1", store);
    expect(r.decision).toBe("ALLOW");
  });

  it("key in store with null → SUPPRESS (redacted)", async () => {
    const v = new PrivacyCheckValidator();
    const store = new MockPromptStore();
    store.set("s-1", null);
    const r = await v.checkWithStore("s-1", store);
    expect(r.decision).toBe("SUPPRESS");
  });

  it("key absent → WARN_RACE", async () => {
    const v = new PrivacyCheckValidator();
    const store = new MockPromptStore();
    // s-1 was never set
    const r = await v.checkWithStore("s-1", store);
    expect(r.decision).toBe("WARN_RACE");
  });
});

// ── MockPromptStore ───────────────────────────────────────────────────────────

describe("MockPromptStore", () => {
  it("getRow returns null for unknown session", async () => {
    const store = new MockPromptStore();
    expect(await store.getRow("unknown")).toBeNull();
  });

  it("getRow returns stored row", async () => {
    const store = new MockPromptStore();
    const row = makeRow("hello");
    store.set("s-1", row);
    expect(await store.getRow("s-1")).toEqual(row);
  });

  it("getRow returns null when explicitly set to null", async () => {
    const store = new MockPromptStore();
    store.set("s-1", null);
    expect(await store.getRow("s-1")).toBeNull();
  });
});

// ── PrivacyAuditLog ───────────────────────────────────────────────────────────

describe("PrivacyAuditLog", () => {
  it("record and getAll", () => {
    const log = new PrivacyAuditLog();
    log.record({ decision: "ALLOW", reason: "prompt_valid", sessionId: "s-1" });
    expect(log.getAll()).toHaveLength(1);
    expect(log.getAll()[0]!.decision).toBe("ALLOW");
  });

  it("getBySession filters correctly", () => {
    const log = new PrivacyAuditLog();
    log.record({ decision: "ALLOW", reason: "r", sessionId: "a" });
    log.record({ decision: "SUPPRESS", reason: "r", sessionId: "b" });
    expect(log.getBySession("a")).toHaveLength(1);
    expect(log.getBySession("b")).toHaveLength(1);
  });

  it("getByDecision filters correctly", () => {
    const log = new PrivacyAuditLog();
    log.record({ decision: "ALLOW", reason: "r", sessionId: "a" });
    log.record({ decision: "SUPPRESS", reason: "r", sessionId: "b" });
    log.record({ decision: "SUPPRESS", reason: "r", sessionId: "c" });
    expect(log.getByDecision("SUPPRESS")).toHaveLength(2);
    expect(log.getByDecision("ALLOW")).toHaveLength(1);
  });

  it("clear empties log", () => {
    const log = new PrivacyAuditLog();
    log.record({ decision: "ALLOW", reason: "r", sessionId: "s" });
    log.clear();
    expect(log.size()).toBe(0);
  });

  it("size reflects number of entries", () => {
    const log = new PrivacyAuditLog();
    log.record({ decision: "WARN_RACE", reason: "r", sessionId: "s" });
    log.record({ decision: "ALLOW", reason: "r", sessionId: "s" });
    expect(log.size()).toBe(2);
  });
});

// ── ValidationPipeline ────────────────────────────────────────────────────────

describe("ValidationPipeline", () => {
  it("first matching validator wins", () => {
    const pipeline = new ValidationPipeline()
      .add((_sid, _row, rowExists) => {
        if (!rowExists) return { decision: "WARN_RACE", reason: "no_row", sessionId: "s-1" };
        return null;
      })
      .add(() => ({ decision: "ALLOW", reason: "second", sessionId: "s-1" }));

    const r = pipeline.run("s-1", null, false);
    expect(r.decision).toBe("WARN_RACE");
  });

  it("falls through to default when no validator matches", () => {
    const pipeline = new ValidationPipeline().add(() => null);
    const r = pipeline.run("s-1", null, false);
    expect(r.decision).toBe("ALLOW");
    expect(r.reason).toBe("pipeline_default");
  });

  it("records to audit log when withAuditLog set", () => {
    const log = new PrivacyAuditLog();
    const pipeline = new ValidationPipeline()
      .withAuditLog(log)
      .add(() => ({ decision: "SUPPRESS", reason: "test", sessionId: "s-1" }));
    pipeline.run("s-1", null, false);
    expect(log.size()).toBe(1);
    expect(log.getAll()[0]!.decision).toBe("SUPPRESS");
  });
});

// ── createPrivacyValidator ────────────────────────────────────────────────────

describe("createPrivacyValidator", () => {
  it("returns validator and auditLog", () => {
    const { validator, auditLog } = createPrivacyValidator();
    expect(validator).toBeDefined();
    expect(auditLog).toBeDefined();
  });

  it("validator with custom raceWarning", () => {
    const { validator } = createPrivacyValidator({ raceWarning: "custom warning" });
    const r = validator.validate("s-1", null, false);
    expect(r.warnMessage).toBe("custom warning");
  });
});
