// SPDX-License-Identifier: Apache-2.0
/**
 * GDPR right-to-erasure handler (§14.4) — the thin route-facing logic, kept
 * dependency-free so it unit-tests without a live database.
 *
 * The actual cascade lives in @nexus/db (`eraseUserData`); this module only
 * enforces the self-erasure guard and shapes the audit log line. The log line is
 * deliberately content-free: it carries the user id and per-table row counts and
 * never any message/LLM/prompt data.
 */
import type { ErasureResult } from "@nexus/db";

/** Minimal logger surface the route's pino logger satisfies. */
export interface ErasureLogger {
  info(obj: Record<string, unknown>, msg: string): void;
}

/** Minimal erase surface — satisfied by `@nexus/db`'s `eraseUserData`. */
export type ErasureFn = (userId: string) => Promise<ErasureResult[]>;

export type ErasureOutcome =
  | { status: 403; body: { code: string; message: string } }
  | { status: 204 }
  | { status: 500; body: { code: string; message: string } };

/**
 * Erase `targetId`'s data only when `callerId` is the same user (self-service
 * erasure). Returns a discriminated outcome the route maps onto an HTTP reply.
 */
export async function handleSelfErasure(
  callerId: string | undefined,
  targetId: string,
  erase: ErasureFn,
  log: ErasureLogger,
): Promise<ErasureOutcome> {
  if (!callerId || callerId !== targetId) {
    return {
      status: 403,
      body: { code: "FORBIDDEN", message: "You may only erase your own data" },
    };
  }

  try {
    const results = await erase(targetId);
    // Audit line is content-free on purpose — never log prompt/LLM data.
    log.info(
      {
        event: "user_data_erased",
        userId: targetId,
        tables: results.map((r) => ({ table: r.table, deleted: r.deleted })),
      },
      "GDPR erasure complete",
    );
    return { status: 204 };
  } catch {
    return { status: 500, body: { code: "ERASURE_FAILED", message: "Erasure failed" } };
  }
}
