// SPDX-License-Identifier: Apache-2.0
/**
 * privacy-validator — Race-safe prompt-row privacy decision.
 *
 * Distinguishes two cases that naive null-checks conflate:
 *   1. Absent prompt row    — race condition (worker booted before session init)
 *                            → ALLOW + emit warning so caller can retry/wait
 *   2. Blank-after-stripping — genuine redaction (user cleared the prompt)
 *                            → SUPPRESS to prevent leaking empty observations
 *
 * Provides:
 *   • PrivacyDecision      — ALLOW | SUPPRESS | WARN_RACE
 *   • ValidationResult     — structured result with reason + metadata
 *   • PrivacyCheckValidator — core validator
 *   • PromptStore          — injectable prompt-row lookup abstraction
 *   • MockPromptStore      — test double
 *   • ValidationPipeline   — multi-step validator chain
 *   • PrivacyAuditLog      — append-only decision log for auditing
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type PrivacyDecision = "ALLOW" | "SUPPRESS" | "WARN_RACE";

/** Prompt row interface definition. */
export interface PromptRow {
  sessionId: string;
  prompt: string;
  createdAt: string;
  userId?: string;
  redactedAt?: string;
}

/** Validation result interface definition. */
export interface ValidationResult {
  decision: PrivacyDecision;
  reason: string;
  sessionId: string;
  promptRow?: PromptRow;
  warnMessage?: string;
  metadata?: Record<string, unknown>;
}

// ── PromptStore ───────────────────────────────────────────────────────────────

export interface PromptStore {
  getRow(sessionId: string): Promise<PromptRow | null>;
}

/** Mock prompt store. */
export class MockPromptStore implements PromptStore {
  private rows = new Map<string, PromptRow | null>();

  /** Set null to simulate absent row (race condition). */
  set(sessionId: string, row: PromptRow | null): void {
    this.rows.set(sessionId, row);
  }

  async getRow(sessionId: string): Promise<PromptRow | null> {
    if (!this.rows.has(sessionId)) return null;
    return this.rows.get(sessionId) ?? null;
  }
}

// ── PrivacyCheckValidator ─────────────────────────────────────────────────────

export interface PrivacyCheckOptions {
  /** Treat explicitly missing row (key not in store) as race condition. Default: true */
  allowOnAbsent?: boolean;
  /** Strip characters before checking for blank. Default: whitespace only */
  stripPattern?: RegExp;
  /** Custom warning message for race condition. */
  raceWarning?: string;
}

const DEFAULT_STRIP = /[\s\u200b\u00a0]/g; // whitespace + zero-width + NBSP

/** Privacy check validator. */
export class PrivacyCheckValidator {
  private opts: Required<PrivacyCheckOptions>;

  constructor(opts: PrivacyCheckOptions = {}) {
    this.opts = {
      allowOnAbsent: opts.allowOnAbsent ?? true,
      stripPattern: opts.stripPattern ?? DEFAULT_STRIP,
      raceWarning:
        opts.raceWarning ?? "Prompt row absent — possible race condition; allowing with warning",
    };
  }

  validate(sessionId: string, row: PromptRow | null, rowExists: boolean): ValidationResult {
    // Case 1: Row was never in the store (key absent) → race condition
    if (!rowExists) {
      if (this.opts.allowOnAbsent) {
        return {
          decision: "WARN_RACE",
          reason: "prompt_row_absent",
          sessionId,
          warnMessage: this.opts.raceWarning,
        };
      }
      return {
        decision: "SUPPRESS",
        reason: "prompt_row_absent_strict",
        sessionId,
      };
    }

    // Case 2: Row exists but is null (explicit null → redacted)
    if (row === null) {
      return {
        decision: "SUPPRESS",
        reason: "prompt_row_null",
        sessionId,
      };
    }

    // Case 3: Row exists but prompt is blank after stripping
    const stripped = row.prompt.replace(this.opts.stripPattern, "");
    if (stripped.length === 0) {
      return {
        decision: "SUPPRESS",
        reason: "prompt_blank_after_strip",
        sessionId,
        promptRow: row,
      };
    }

    // Case 4: Row exists and has content → ALLOW
    return {
      decision: "ALLOW",
      reason: "prompt_valid",
      sessionId,
      promptRow: row,
    };
  }

  /** Full async validation using a PromptStore. */
  async check(sessionId: string, store: PromptStore): Promise<ValidationResult> {
    const row = await store.getRow(sessionId);
    // We can't distinguish "key absent" from "value null" with the async store alone.
    // Use the convention: null means "was looked up, is explicitly null" (redacted).
    // To distinguish race, callers should call validate() directly with rowExists flag.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const rowExists = row !== undefined; // always true here since getRow returns null not undefined
    return this.validate(sessionId, row, true /* row was looked up */);
  }

  /** Convenience: full async check with explicit existence tracking. */
  async checkWithStore(sessionId: string, store: MockPromptStore): Promise<ValidationResult> {
    const row = await store.getRow(sessionId);
    const hasKey = (store as MockPromptStore)["rows"].has(sessionId);
    return this.validate(sessionId, row, hasKey);
  }
}

// ── PrivacyAuditLog ───────────────────────────────────────────────────────────

export interface AuditEntry {
  sessionId: string;
  decision: PrivacyDecision;
  reason: string;
  timestamp: string;
  warnMessage?: string;
}

/** Privacy audit log. */
export class PrivacyAuditLog {
  private entries: AuditEntry[] = [];

  record(result: ValidationResult): void {
    this.entries.push({
      sessionId: result.sessionId,
      decision: result.decision,
      reason: result.reason,
      timestamp: new Date().toISOString(),
      warnMessage: result.warnMessage,
    });
  }

  getAll(): AuditEntry[] {
    return [...this.entries];
  }
  getBySession(sessionId: string): AuditEntry[] {
    return this.entries.filter((e) => e.sessionId === sessionId);
  }
  getByDecision(decision: PrivacyDecision): AuditEntry[] {
    return this.entries.filter((e) => e.decision === decision);
  }
  clear(): void {
    this.entries = [];
  }
  size(): number {
    return this.entries.length;
  }
}

// ── ValidationPipeline ────────────────────────────────────────────────────────

export type ValidatorFn = (
  sessionId: string,
  row: PromptRow | null,
  rowExists: boolean,
) => ValidationResult | null;

/** Validation pipeline. */
export class ValidationPipeline {
  private validators: ValidatorFn[] = [];
  private auditLog?: PrivacyAuditLog;

  add(validator: ValidatorFn): this {
    this.validators.push(validator);
    return this;
  }

  withAuditLog(log: PrivacyAuditLog): this {
    this.auditLog = log;
    return this;
  }

  run(sessionId: string, row: PromptRow | null, rowExists: boolean): ValidationResult {
    for (const v of this.validators) {
      const result = v(sessionId, row, rowExists);
      if (result !== null) {
        this.auditLog?.record(result);
        return result;
      }
    }
    // Default: allow
    const defaultResult: ValidationResult = {
      decision: "ALLOW",
      reason: "pipeline_default",
      sessionId,
    };
    this.auditLog?.record(defaultResult);
    return defaultResult;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/** Create a standard validator + audit log wired together. */
export function createPrivacyValidator(opts?: PrivacyCheckOptions): {
  validator: PrivacyCheckValidator;
  auditLog: PrivacyAuditLog;
} {
  return {
    validator: new PrivacyCheckValidator(opts),
    auditLog: new PrivacyAuditLog(),
  };
}
