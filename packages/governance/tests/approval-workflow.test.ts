// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from "vitest";

import { ApprovalWorkflow } from "../src/approval-workflow.js";
import type { IEventBus } from "../src/event-bus.js";
import type { IApprovalRecord } from "../src/interfaces/governance.interface.js";
import type { IEventStore } from "../src/interfaces/persistence.interface.js";

function makeEventStore(seed: { event: string; payload: unknown }[] = []): IEventStore {
  const events = [...seed];
  return {
    replayEvents: vi.fn().mockResolvedValue(events),
    saveEvent: vi.fn().mockResolvedValue(undefined),
  };
}

function makeEventBus(): IEventBus {
  return { publish: vi.fn().mockResolvedValue(undefined) } as unknown as IEventBus;
}

describe("ApprovalWorkflow", () => {
  let eventStore: IEventStore;
  let eventBus: IEventBus;
  let workflow: ApprovalWorkflow;

  beforeEach(() => {
    eventStore = makeEventStore();
    eventBus = makeEventBus();
    workflow = new ApprovalWorkflow(eventStore, eventBus);
  });

  describe("createRequest()", () => {
    it("returns a pending IApprovalRecord", async () => {
      const record = await workflow.createRequest("task-001");
      expect(record.taskId).toBe("task-001");
      expect(record.status).toBe("pending");
      expect(record.approvalId).toBeTruthy();
      expect(record.requestTimestamp).toBeInstanceOf(Date);
    });

    it("saves an approval_requested event", async () => {
      await workflow.createRequest("task-002");
      expect(eventStore.saveEvent).toHaveBeenCalledWith(
        "approval_requested",
        expect.objectContaining({ taskId: "task-002" }),
      );
    });

    it("publishes approval_requested to event bus", async () => {
      await workflow.createRequest("task-003");
      expect(eventBus.publish).toHaveBeenCalledWith(
        "approval_requested",
        expect.objectContaining({ taskId: "task-003" }),
      );
    });

    it("generates unique approvalIds across calls", async () => {
      const r1 = await workflow.createRequest("task-a");
      const r2 = await workflow.createRequest("task-b");
      expect(r1.approvalId).not.toBe(r2.approvalId);
    });
  });

  describe("approve()", () => {
    it("transitions status to approved", async () => {
      const { approvalId } = await workflow.createRequest("task-approve");
      const record = await workflow.approve(approvalId, "admin");
      expect(record.status).toBe("approved");
      expect(record.decidedBy).toBe("admin");
      expect(record.decisionTimestamp).toBeInstanceOf(Date);
    });

    it("saves an approval_approved event", async () => {
      const { approvalId } = await workflow.createRequest("task-x");
      await workflow.approve(approvalId, "admin");
      expect(eventStore.saveEvent).toHaveBeenCalledWith(
        "approval_approved",
        expect.objectContaining({ status: "approved" }),
      );
    });

    it("throws when approvalId does not exist", async () => {
      await expect(workflow.approve("nonexistent-id", "admin")).rejects.toThrow(/not found/i);
    });

    it("throws when approval is already approved", async () => {
      const { approvalId } = await workflow.createRequest("task-double");
      await workflow.approve(approvalId, "admin");
      await expect(workflow.approve(approvalId, "admin")).rejects.toThrow(/not pending/i);
    });
  });

  describe("deny()", () => {
    it("transitions status to denied", async () => {
      const { approvalId } = await workflow.createRequest("task-deny");
      const record = await workflow.deny(approvalId, "reviewer");
      expect(record.status).toBe("denied");
      expect(record.decidedBy).toBe("reviewer");
    });

    it("saves an approval_denied event", async () => {
      const { approvalId } = await workflow.createRequest("task-deny-2");
      await workflow.deny(approvalId, "reviewer");
      expect(eventStore.saveEvent).toHaveBeenCalledWith(
        "approval_denied",
        expect.objectContaining({ status: "denied" }),
      );
    });

    it("throws when approvalId does not exist", async () => {
      await expect(workflow.deny("bad-id", "reviewer")).rejects.toThrow(/not found/i);
    });

    it("throws when approval is already denied", async () => {
      const { approvalId } = await workflow.createRequest("task-deny-double");
      await workflow.deny(approvalId, "reviewer");
      await expect(workflow.deny(approvalId, "reviewer")).rejects.toThrow(/not pending/i);
    });
  });

  describe("expire()", () => {
    it("transitions status to expired", async () => {
      const { approvalId } = await workflow.createRequest("task-expire");
      const record = await workflow.expire(approvalId);
      expect(record.status).toBe("expired");
    });

    it("throws when approval is already non-pending", async () => {
      const { approvalId } = await workflow.createRequest("task-expire-2");
      await workflow.approve(approvalId, "admin");
      await expect(workflow.expire(approvalId)).rejects.toThrow(/not pending/i);
    });
  });

  describe("getRecord()", () => {
    it("returns the record for a known approvalId", async () => {
      const { approvalId } = await workflow.createRequest("task-get");
      const record = await workflow.getRecord(approvalId);
      expect(record?.approvalId).toBe(approvalId);
    });

    it("returns null for an unknown approvalId", async () => {
      const record = await workflow.getRecord("unknown-xyz");
      expect(record).toBeNull();
    });
  });

  describe("listRecords()", () => {
    it("returns all records in the cache", async () => {
      await workflow.createRequest("list-task-1");
      await workflow.createRequest("list-task-2");
      const records = await workflow.listRecords();
      expect(records.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("state replay from event store", () => {
    it("rebuilds state from existing approval_requested events", async () => {
      const seedRecord: IApprovalRecord = {
        approvalId: "seeded-001",
        taskId: "seeded-task",
        status: "pending",
        requestTimestamp: new Date(),
      };
      const seededStore = makeEventStore([{ event: "approval_requested", payload: seedRecord }]);
      const seededWorkflow = new ApprovalWorkflow(seededStore, makeEventBus());

      const record = await seededWorkflow.getRecord("seeded-001");
      expect(record?.taskId).toBe("seeded-task");
      expect(record?.status).toBe("pending");
    });

    it("applies status transitions from replayed events", async () => {
      const base: IApprovalRecord = {
        approvalId: "seeded-002",
        taskId: "seeded-task-2",
        status: "pending",
        requestTimestamp: new Date(),
      };
      const approved: IApprovalRecord = {
        ...base,
        status: "approved",
        decidedBy: "admin",
        decisionTimestamp: new Date(),
      };
      const seededStore = makeEventStore([
        { event: "approval_requested", payload: base },
        { event: "approval_approved", payload: approved },
      ]);
      const seededWorkflow = new ApprovalWorkflow(seededStore, makeEventBus());

      const record = await seededWorkflow.getRecord("seeded-002");
      expect(record?.status).toBe("approved");
    });
  });
});
