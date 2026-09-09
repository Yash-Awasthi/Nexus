// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/audit-logging — Tamper-evident audit logging with SHA-256 hash chains.
 *
 * Inspired by aiact-audit-log's Article 12 compliance logging.
 * Provides structured audit logging with hash chain integrity verification
 * for AI system decision tracking.
 */

import { createHash } from "node:crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AuditLogEntry {
  id: string;
  timestamp: number;
  systemId: string;
  eventType: string;
  decision?: {
    input: unknown;
    output: unknown;
    model?: string;
    provider?: string;
  };
  metadata?: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

export interface AuditLoggerConfig {
  systemId: string;
  retentionDays?: number;
  batchSize?: number;
  batchDelayMs?: number;
}

export interface ChainVerification {
  valid: boolean;
  totalEntries: number;
  brokenAt?: number;
  message: string;
}

// ── Hash Chain ───────────────────────────────────────────────────────────────

export function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function computeEntryHash(entry: Omit<AuditLogEntry, "hash">): string {
  const payload = [
    entry.id,
    entry.timestamp,
    entry.systemId,
    entry.eventType,
    JSON.stringify(entry.decision),
    JSON.stringify(entry.metadata),
    entry.previousHash,
  ].join("|");
  return sha256(payload);
}

export function computeGenesisHash(systemId: string): string {
  return sha256(`genesis:${systemId}:${Date.now()}`);
}

// ── Audit Logger ─────────────────────────────────────────────────────────────

export class AuditLogger {
  private entries: AuditLogEntry[] = [];
  private chainHead: string;
  private entryCount = 0;
  private batchTimer?: ReturnType<typeof setTimeout>;
  private flushCallback?: (entries: AuditLogEntry[]) => Promise<void>;

  constructor(
    private config: AuditLoggerConfig,
    options?: { flushCallback?: (entries: AuditLogEntry[]) => Promise<void> },
  ) {
    this.chainHead = computeGenesisHash(config.systemId);
    this.flushCallback = options?.flushCallback;

    if (config.batchDelayMs && config.batchDelayMs > 0) {
      this.batchTimer = setInterval(() => {
        this.flush();
      }, config.batchDelayMs);
    }
  }

  /**
   * Log an audit event.
   */
  log(
    eventType: string,
    data?: {
      decision?: { input: unknown; output: unknown; model?: string; provider?: string };
      metadata?: Record<string, unknown>;
    },
  ): AuditLogEntry {
    const entry: Omit<AuditLogEntry, "hash"> = {
      id: `${this.config.systemId}-${this.entryCount++}-${Date.now()}`,
      timestamp: Date.now(),
      systemId: this.config.systemId,
      eventType,
      decision: data?.decision,
      metadata: data?.metadata,
      previousHash: this.chainHead,
    };

    const hash = computeEntryHash(entry);
    const fullEntry: AuditLogEntry = { ...entry, hash };

    this.entries.push(fullEntry);
    this.chainHead = hash;

    // Auto-flush if batch size reached
    if (this.config.batchSize && this.entries.length >= this.config.batchSize) {
      this.flush();
    }

    return fullEntry;
  }

  /**
   * Log an LLM call decision.
   */
  logLLMCall(
    input: unknown,
    output: unknown,
    model: string,
    provider: string,
    metadata?: Record<string, unknown>,
  ): AuditLogEntry {
    return this.log("llm.call", {
      decision: { input, output, model, provider },
      metadata,
    });
  }

  /**
   * Log a routing decision.
   */
  logRoutingDecision(
    input: string,
    selectedAgent: string,
    confidence: number,
    metadata?: Record<string, unknown>,
  ): AuditLogEntry {
    return this.log("routing.decision", {
      decision: { input, output: { selectedAgent, confidence } },
      metadata,
    });
  }

  /**
   * Log a tool execution.
   */
  logToolExecution(
    toolName: string,
    input: unknown,
    output: unknown,
    success: boolean,
    metadata?: Record<string, unknown>,
  ): AuditLogEntry {
    return this.log("tool.execution", {
      decision: { input, output, model: toolName },
      metadata: { ...metadata, success },
    });
  }

  /**
   * Get all logged entries.
   */
  getEntries(): AuditLogEntry[] {
    return [...this.entries];
  }

  /**
   * Get the current chain head hash.
   */
  getChainHead(): string {
    return this.chainHead;
  }

  /**
   * Flush buffered entries.
   */
  async flush(): Promise<void> {
    if (this.entries.length === 0) return;

    const toFlush = [...this.entries];
    this.entries = [];

    if (this.flushCallback) {
      await this.flushCallback(toFlush);
    }
  }

  /**
   * Stop the logger and flush remaining entries.
   */
  async shutdown(): Promise<void> {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = undefined;
    }
    await this.flush();
  }

  // ── Static Verification ────────────────────────────────────────────────

  /**
   * Verify the integrity of an audit log chain.
   */
  static verifyChain(entries: AuditLogEntry[], systemId: string): ChainVerification {
    if (entries.length === 0) {
      return { valid: true, totalEntries: 0, message: "Empty chain is valid" };
    }

    // Verify genesis
    const first = entries[0]!;
    const expectedGenesis = computeGenesisHash(systemId);
    if (first.previousHash !== expectedGenesis) {
      return {
        valid: false,
        totalEntries: entries.length,
        brokenAt: 0,
        message: `Genesis hash mismatch at entry 0`,
      };
    }

    // Verify chain
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const prevExpected = i === 0 ? expectedGenesis : entries[i - 1]!.hash;

      if (entry.previousHash !== prevExpected) {
        return {
          valid: false,
          totalEntries: entries.length,
          brokenAt: i,
          message: `Chain broken at entry ${i}: previous hash mismatch`,
        };
      }

      const { hash, ...rest } = entry;
      const computedHash = computeEntryHash(rest);
      if (hash !== computedHash) {
        return {
          valid: false,
          totalEntries: entries.length,
          brokenAt: i,
          message: `Entry ${i} hash mismatch: expected ${computedHash}, got ${hash}`,
        };
      }
    }

    return {
      valid: true,
      totalEntries: entries.length,
      message: `Chain of ${entries.length} entries is tamper-evident and valid`,
    };
  }
}

export default AuditLogger;
