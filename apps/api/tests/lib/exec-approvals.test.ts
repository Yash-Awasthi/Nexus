// SPDX-License-Identifier: Apache-2.0
/**
 * The parts of the approval lifecycle a route test cannot reach: the window
 * closing, the record outliving the process, and the cleanup that keeps the
 * store from growing forever. The clock is a parameter for exactly this reason.
 */
import { describe, it, expect, beforeAll } from "vitest";

import {
  APPROVAL_TTL_MS,
  decideApproval,
  listApprovals,
  loadApprovalStore,
  pruneApprovals,
  redeemApproval,
  requestApproval,
} from "../../src/lib/exec-approvals.js";
import type { ExecAction } from "@nexus/exec-policy";

const OWNER = "owner-expiry";
const ACTION: ExecAction = { surface: "pty", command: "npm", args: ["install"] };
const T0 = Date.parse("2026-09-13T10:00:00.000Z");

beforeAll(async () => {
  await loadApprovalStore();
});

describe("the approval window", () => {
  it("closes on its own, without anyone deciding", () => {
    const pending = requestApproval(OWNER, ACTION, "Nothing covers npm.", T0);

    const later = T0 + APPROVAL_TTL_MS + 1;
    const listed = listApprovals(OWNER, later).find((r) => r.id === pending.id);

    expect(listed?.status).toBe("expired");
    expect(decideApproval(OWNER, pending.id, true, later)).toBe("expired");
  });

  it("cannot be redeemed after it closes, even once approved", () => {
    const pending = requestApproval(OWNER, ACTION, "Nothing covers npm.", T0);
    decideApproval(OWNER, pending.id, true, T0 + 1_000);

    const result = redeemApproval(OWNER, pending.id, ACTION, T0 + APPROVAL_TTL_MS + 1);

    expect(result).toBe("expired");
  });

  it("is redeemable inside the window", () => {
    const pending = requestApproval(OWNER, ACTION, "Nothing covers npm.", T0);
    decideApproval(OWNER, pending.id, true, T0 + 1_000);

    const result = redeemApproval(OWNER, pending.id, ACTION, T0 + 2_000);

    expect(typeof result === "string" ? result : result.status).toBe("spent");
  });
});

describe("the record outlives the process", () => {
  it("is still there after the store is reloaded", async () => {
    const pending = requestApproval(`${OWNER}-restart`, ACTION, "Nothing covers npm.", T0);

    const store = await import("../../src/lib/exec-approvals.js");
    store._resetApprovalStoreForTests();
    await store.loadApprovalStore();

    expect(
      store.listApprovals(`${OWNER}-restart`, T0 + 1_000).some((r) => r.id === pending.id),
    ).toBe(true);
  });
});

describe("cleanup", () => {
  it("drops decided records past the retention window and keeps pending ones", () => {
    const owner = `${OWNER}-prune`;
    const decided = requestApproval(owner, ACTION, "Nothing covers npm.", T0);
    decideApproval(owner, decided.id, false, T0 + 1_000);
    const stillPending = requestApproval(owner, ACTION, "Nothing covers npm.", T0);

    const removed = pruneApprovals(T0 + 48 * 60 * 60_000, 24 * 60 * 60_000);

    expect(removed).toBeGreaterThan(0);
    const ids = listApprovals(owner, T0 + 48 * 60 * 60_000).map((r) => r.id);
    expect(ids).not.toContain(decided.id);
    expect(ids).toContain(stillPending.id);
  });
});
