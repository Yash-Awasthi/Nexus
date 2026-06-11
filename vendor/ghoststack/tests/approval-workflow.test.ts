import { ApprovalWorkflow } from "../orchestration/approval-workflow";
import { FileEventStore } from "../orchestration/persistence-manager";
import { LocalEventBus } from "../orchestration/event-bus";
import * as path from "path";
import * as fs from "fs";

describe("Milestone 3: Replayable Approvals & Safety Guards", () => {
  const testDir = path.join(__dirname, "../temp-governance-test-db");
  const eventLogPath = path.join(testDir, "approval_events.jsonl");

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should process approval states pending -> approved cleanly and restore correctly from event replay history", async () => {
    const eventBus = new LocalEventBus();
    const eventStore = new FileEventStore(eventLogPath);
    const workflow = new ApprovalWorkflow(eventStore, eventBus);

    const req = await workflow.createRequest("task-dangerous-10");
    expect(req.status).toBe("pending");

    await workflow.approve(req.approvalId, "operator-supervisor");

    const record = await workflow.getRecord(req.approvalId);
    expect(record?.status).toBe("approved");
    expect(record?.decidedBy).toBe("operator-supervisor");

    // Simulate system restart - initialize a NEW workflow reading from the SAME event logs
    const recoveredWorkflow = new ApprovalWorkflow(eventStore, eventBus);
    const list = await recoveredWorkflow.listRecords();

    expect(list.length).toBe(1);
    expect(list[0].approvalId).toBe(req.approvalId);
    expect(list[0].status).toBe("approved");
    expect(list[0].decidedBy).toBe("operator-supervisor");
  });

  it("should enforce deterministic transition restrictions on non-pending approval blocks", async () => {
    const eventBus = new LocalEventBus();
    const eventStore = new FileEventStore(eventLogPath);
    const workflow = new ApprovalWorkflow(eventStore, eventBus);

    const req = await workflow.createRequest("task-dangerous-11");
    await workflow.deny(req.approvalId, "admin-bot");

    await expect(workflow.approve(req.approvalId, "admin-bot")).rejects.toThrow("Approval is not pending");
  });
});
