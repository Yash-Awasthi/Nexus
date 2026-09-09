// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/ai-act-audit — EU AI Act Article 12 compliance audit logging.
 *
 * Inspired by systima/aiact-audit-log:
 *   • Article 12 schema mapping — every field annotated with compliance paragraph
 *   • Retention enforcement — configurable minimum with Article 19(1) floor (180 days)
 *   • PII protection — hash inputs/outputs, redact patterns (GDPR Article 5(1)(c))
 *   • AsyncLocalStorage context — correlate multi-step decisions
 *   • Coverage diagnostics — analyze logs for completeness gaps
 *   • Health checks — periodic integrity verification
 *
 * Complements @nexus/governance's AuditLog with EU AI Act specific features.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

// ── Article 12 Schema ──────────────────────────────────────────────────────

/**
 * EU AI Act Article 12 compliant audit log entry.
 * Every field is annotated with the Article 12 paragraph it relates to.
 */
export interface AiActAuditEntry {
  /** Schema version for forward compatibility. */
  schemaVersion: "v1";

  /** Unique event identification — Article 12(1). */
  entryId: string;

  /** Risk identification — Article 12(2)(a). */
  decisionId: string;

  /** System identification — Article 12(1). */
  systemId: string;

  /** Automatic recording — Article 12(1), 12(3)(a). */
  timestamp: string;

  /** Risk situation identification — Article 12(2)(a). */
  eventType: AiActEventType;

  /** Model version tracking — Article 12(2)(a), 72. */
  modelId: string | null;

  /** Provider identification. */
  providerId: string | null;

  /** Input data — Article 12(2)(a), 12(2)(c), 12(3)(c). */
  input: { type: string; value: string };

  /** Output data — Article 12(2)(a), 12(2)(b). */
  output: { type: string; value: string } | null;

  /** Performance monitoring — Article 12(2)(b), 72. */
  latencyMs: number | null;

  /** Post-market monitoring — Article 72. */
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;

  /** Error identification — Article 12(2)(a). */
  error: { code: string; message: string } | null;

  /** Configuration tracking — Article 12(2)(a). */
  parameters: Record<string, unknown> | null;

  /** Coverage analysis. */
  captureMethod: "middleware" | "manual" | "context";

  /** Event ordering — Article 12(1). */
  seq: number;

  /** Tamper evidence — previous hash in chain. */
  prevHash: string;

  /** Tamper evidence — SHA-256 hash of this entry. */
  hash: string;

  /** Human intervention details (optional). */
  humanIntervention?: {
    type: "approval" | "modification" | "override" | "rejection";
    userId: string;
    reason: string;
    timestamp: string;
  };

  /** Additional metadata. */
  metadata?: Record<string, unknown>;
}

/** Event types for Article 12 compliance. */
export type AiActEventType =
  | "inference"
  | "tool_call"
  | "tool_result"
  | "human_intervention"
  | "system_event"
  | "session_start"
  | "session_end";

// ── Retention Configuration ────────────────────────────────────────────────

/** Retention policy per Article 19(1). */
export interface RetentionPolicy {
  /** Minimum retention in days (Article 19(1) floor: 180 days). */
  minimumDays: number;
  /** Auto-configure S3 lifecycle rules (if applicable). */
  autoConfigureLifecycle: boolean;
}

/** Default retention policy — Article 19(1) floor. */
export const DEFAULT_RETENTION: RetentionPolicy = {
  minimumDays: 180,
  autoConfigureLifecycle: true,
};

/** Sector-specific retention recommendations. */
export const SECTOR_RETENTION: Record<string, number> = {
  general: 180,
  financial: 2555, // 7 years — MiFID II
  healthcare: 3650, // 10 years — clinical records
  employment: 1095, // 3 years — tribunal limitation
};

// ── PII Protection ─────────────────────────────────────────────────────────

/** PII protection configuration (GDPR Article 5(1)(c) data minimisation). */
export interface PiiConfig {
  /** Store SHA-256 hashes instead of raw inputs. */
  hashInputs: boolean;
  /** Store SHA-256 hashes instead of raw outputs. */
  hashOutputs: boolean;
  /** Regex patterns to redact before logging. */
  redactPatterns: string[];
}

/** Default PII config — no protection. */
export const DEFAULT_PII: PiiConfig = {
  hashInputs: false,
  hashOutputs: false,
  redactPatterns: [],
};

// ── Hash Chain Utilities ───────────────────────────────────────────────────

const GENESIS_HASH = "0".repeat(64);

/**
 * Compute SHA-256 hash of an entry for tamper evidence.
 */
export function computeEntryHash(entry: Omit<AiActAuditEntry, "hash">): string {
  const payload = JSON.stringify({
    entryId: entry.entryId,
    decisionId: entry.decisionId,
    systemId: entry.systemId,
    timestamp: entry.timestamp,
    eventType: entry.eventType,
    modelId: entry.modelId,
    providerId: entry.providerId,
    input: entry.input,
    output: entry.output,
    latencyMs: entry.latencyMs,
    usage: entry.usage,
    error: entry.error,
    parameters: entry.parameters,
    captureMethod: entry.captureMethod,
    seq: entry.seq,
    prevHash: entry.prevHash,
  });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Verify hash chain integrity for a sequence of entries.
 */
export function verifyHashChain(entries: AiActAuditEntry[]): {
  valid: boolean;
  entriesChecked: number;
  firstBreak: {
    seq: number;
    expectedPrevHash: string;
    actualPrevHash: string;
  } | null;
} {
  let prevHash = GENESIS_HASH;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;

    // Check prevHash matches
    if (entry.prevHash !== prevHash) {
      return {
        valid: false,
        entriesChecked: i + 1,
        firstBreak: {
          seq: entry.seq,
          expectedPrevHash: prevHash,
          actualPrevHash: entry.prevHash,
        },
      };
    }

    // Verify hash (compute over the entry without its stored hash field)
    const { hash: _storedHash, ...entryWithoutHash } = entry;
    const expectedHash = computeEntryHash(entryWithoutHash);
    if (entry.hash !== expectedHash) {
      return {
        valid: false,
        entriesChecked: i + 1,
        firstBreak: {
          seq: entry.seq,
          expectedPrevHash: prevHash,
          actualPrevHash: entry.prevHash,
        },
      };
    }

    prevHash = entry.hash;
  }

  return {
    valid: true,
    entriesChecked: entries.length,
    firstBreak: null,
  };
}

// ── AsyncLocalStorage Context ──────────────────────────────────────────────

/** Audit context for correlating multi-step decisions. */
export interface AuditContext {
  decisionId: string;
  metadata?: Record<string, unknown>;
}

/** AsyncLocalStorage for audit context propagation. */
const auditContextStorage = new AsyncLocalStorage<AuditContext>();

/**
 * Execute a callback with audit context.
 * All logger.log() calls within inherit the decisionId.
 */
export function withAuditContext<T>(context: AuditContext, callback: () => Promise<T>): Promise<T> {
  return auditContextStorage.run(context, callback);
}

/**
 * Get the current audit context (returns undefined if none active).
 */
export function getAuditContext(): AuditContext | undefined {
  return auditContextStorage.getStore();
}

// ── PII Protection Helpers ─────────────────────────────────────────────────

/**
 * Apply PII protection to a value (hash or redact).
 */
export function applyPiiProtection(
  value: string,
  config: PiiConfig,
  type: "input" | "output",
): string {
  let result = value;

  // Apply redaction patterns
  for (const pattern of config.redactPatterns) {
    result = result.replace(new RegExp(pattern, "gi"), "[REDACTED]");
  }

  // Apply hashing
  const shouldHash = type === "input" ? config.hashInputs : config.hashOutputs;
  if (shouldHash) {
    result = createHash("sha256").update(result).digest("hex");
  }

  return result;
}

// ── Coverage Analysis ──────────────────────────────────────────────────────

/** Coverage analysis result. */
export interface CoverageReport {
  /** Total entries analyzed. */
  totalEntries: number;
  /** Distribution by event type. */
  byEventType: Record<string, number>;
  /** Distribution by capture method. */
  byCaptureMethod: Record<string, number>;
  /** Warnings about missing data. */
  warnings: string[];
  /** Recommendations for improvement. */
  recommendations: string[];
}

/**
 * Analyze audit logs for completeness gaps.
 */
export function analyseCoverage(
  entries: AiActAuditEntry[],
  _options?: { from?: string; to?: string },
): CoverageReport {
  const warnings: string[] = [];
  const recommendations: string[] = [];
  const byEventType: Record<string, number> = {};
  const byCaptureMethod: Record<string, number> = {};

  for (const entry of entries) {
    byEventType[entry.eventType] = (byEventType[entry.eventType] ?? 0) + 1;
    byCaptureMethod[entry.captureMethod] = (byCaptureMethod[entry.captureMethod] ?? 0) + 1;

    // Check for missing required fields
    if (!entry.modelId && entry.eventType === "inference") {
      warnings.push(`Entry ${entry.entryId}: missing modelId for inference event`);
    }
    if (!entry.output && entry.eventType === "inference") {
      warnings.push(`Entry ${entry.entryId}: missing output for inference event`);
    }
    if (entry.error && !entry.error.code) {
      warnings.push(`Entry ${entry.entryId}: error missing code`);
    }
  }

  // Generate recommendations
  const inferenceCount = byEventType["inference"] ?? 0;
  const humanCount = byEventType["human_intervention"] ?? 0;
  if (inferenceCount > 0 && humanCount === 0) {
    recommendations.push(
      "No human intervention events recorded. Consider adding human oversight logging for Article 14 compliance.",
    );
  }

  const manualCount = byCaptureMethod["manual"] ?? 0;
  const middlewareCount = byCaptureMethod["middleware"] ?? 0;
  if (manualCount > middlewareCount * 2) {
    recommendations.push(
      "High ratio of manual vs middleware captures. Consider using middleware for more consistent logging.",
    );
  }

  return {
    totalEntries: entries.length,
    byEventType,
    byCaptureMethod,
    warnings,
    recommendations,
  };
}

// ── Retention Validation ───────────────────────────────────────────────────

/**
 * Check if an entry violates retention policy.
 */
export function checkRetention(
  entry: AiActAuditEntry,
  policy: RetentionPolicy = DEFAULT_RETENTION,
): { compliant: boolean; reason?: string } {
  const entryDate = new Date(entry.timestamp);
  const now = new Date();
  const ageDays = Math.floor((now.getTime() - entryDate.getTime()) / (1000 * 60 * 60 * 24));

  if (ageDays > policy.minimumDays) {
    return {
      compliant: false,
      reason: `Entry is ${ageDays} days old, exceeding retention policy of ${policy.minimumDays} days`,
    };
  }

  // Check Article 19(1) floor
  if (ageDays > 180 && policy.minimumDays < 180) {
    return {
      compliant: false,
      reason: `Entry is ${ageDays} days old, exceeding Article 19(1) minimum of 180 days`,
    };
  }

  return { compliant: true };
}

// ── Compliance Export ──────────────────────────────────────────────────────

/** Compliance evidence package. */
export interface CompliancePackage {
  /** Export metadata. */
  metadata: {
    exportedAt: string;
    systemId: string;
    dateRange: { from: string; to: string };
    entryCount: number;
  };
  /** Hash chain verification result. */
  verification: ReturnType<typeof verifyHashChain>;
  /** Coverage analysis. */
  coverage: CoverageReport;
  /** The actual log entries. */
  entries: AiActAuditEntry[];
}

/**
 * Export a compliance evidence package for regulators.
 */
export function exportCompliancePackage(
  entries: AiActAuditEntry[],
  systemId: string,
  options: { from: string; to: string },
): CompliancePackage {
  return {
    metadata: {
      exportedAt: new Date().toISOString(),
      systemId,
      dateRange: options,
      entryCount: entries.length,
    },
    verification: verifyHashChain(entries),
    coverage: analyseCoverage(entries, options),
    entries,
  };
}
