import type { IEventBus } from "./event-bus.js";
import type { IApprovalWorkflow, IApprovalRecord } from "./interfaces/governance.interface.js";
import type { IEventStore } from "./interfaces/persistence.interface.js";

export class ApprovalWorkflow implements IApprovalWorkflow {
  private eventStore: IEventStore;
  private eventBus: IEventBus;
  private cachePromise: Promise<Map<string, IApprovalRecord>> | null = null;

  constructor(eventStore: IEventStore, eventBus: IEventBus) {
    this.eventStore = eventStore;
    this.eventBus = eventBus;
  }

  private async ensureCached(): Promise<Map<string, IApprovalRecord>> {
    if (!this.cachePromise) {
      this.cachePromise = this.rebuildState();
    }
    return this.cachePromise;
  }

  private async rebuildState(): Promise<Map<string, IApprovalRecord>> {
    const recordsMap = new Map<string, IApprovalRecord>();
    const events = await this.eventStore.replayEvents();

    for (const e of events) {
      if (e.event === "approval_requested") {
        const payload = e.payload as IApprovalRecord;
        recordsMap.set(payload.approvalId, {
          ...payload,
          requestTimestamp: new Date(payload.requestTimestamp)
        });
      } else if (e.event === "approval_approved" || e.event === "approval_denied" || e.event === "approval_expired") {
        const payload = e.payload as IApprovalRecord;
        const existing = recordsMap.get(payload.approvalId);
        if (existing) {
          existing.status = payload.status;
          if (payload.decisionTimestamp) { existing.decisionTimestamp = new Date(payload.decisionTimestamp); } else { delete existing.decisionTimestamp; }
          if (payload.decidedBy !== undefined) { existing.decidedBy = payload.decidedBy; } else { delete existing.decidedBy; }
        }
      }
    }

    return recordsMap;
  }

  async createRequest(taskId: string): Promise<IApprovalRecord> {
    const recordsMap = await this.ensureCached();
    const approvalId = `appr-${Math.floor(1000 + Math.random() * 9000)}`;
    const record: IApprovalRecord = {
      approvalId,
      taskId,
      status: "pending",
      requestTimestamp: new Date()
    };

    recordsMap.set(approvalId, record);
    await this.eventStore.saveEvent("approval_requested", record);
    await this.eventBus.publish("approval_requested", record);

    return record;
  }

  async approve(approvalId: string, user: string): Promise<IApprovalRecord> {
    const recordsMap = await this.ensureCached();
    const record = recordsMap.get(approvalId);
    if (!record) {
      throw new Error(`Approval record not found: ${approvalId}`);
    }
    if (record.status !== "pending") {
      throw new Error(`Approval is not pending: ${approvalId} (status: ${record.status})`);
    }

    record.status = "approved";
    record.decisionTimestamp = new Date();
    record.decidedBy = user;

    await this.eventStore.saveEvent("approval_approved", record);
    await this.eventBus.publish("approval_approved", record);

    return record;
  }

  async deny(approvalId: string, user: string): Promise<IApprovalRecord> {
    const recordsMap = await this.ensureCached();
    const record = recordsMap.get(approvalId);
    if (!record) {
      throw new Error(`Approval record not found: ${approvalId}`);
    }
    if (record.status !== "pending") {
      throw new Error(`Approval is not pending: ${approvalId} (status: ${record.status})`);
    }

    record.status = "denied";
    record.decisionTimestamp = new Date();
    record.decidedBy = user;

    await this.eventStore.saveEvent("approval_denied", record);
    await this.eventBus.publish("approval_denied", record);

    return record;
  }

  async expire(approvalId: string): Promise<IApprovalRecord> {
    const recordsMap = await this.ensureCached();
    const record = recordsMap.get(approvalId);
    if (!record) {
      throw new Error(`Approval record not found: ${approvalId}`);
    }
    if (record.status !== "pending") {
      throw new Error(`Approval is not pending: ${approvalId} (status: ${record.status})`);
    }

    record.status = "expired";
    record.decisionTimestamp = new Date();

    await this.eventStore.saveEvent("approval_expired", record);
    await this.eventBus.publish("approval_expired", record);

    return record;
  }

  async getRecord(approvalId: string): Promise<IApprovalRecord | null> {
    const recordsMap = await this.ensureCached();
    return recordsMap.get(approvalId) || null;
  }

  async listRecords(): Promise<IApprovalRecord[]> {
    const recordsMap = await this.ensureCached();
    return Array.from(recordsMap.values());
  }

  /**
   * Resets the cache promise to force a clean reload from the event store.
   * Useful during recovery tests and simulations.
   */
  resetCache(): void {
    this.cachePromise = null;
  }
}
