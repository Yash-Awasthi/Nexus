import { FileEventStore, FileRuntimePersistence } from "../orchestration/persistence-manager";
import * as fs from "fs";
import * as path from "path";

describe("Milestone 1: Persistence & Replay Engine", () => {
  const testDir = path.join(__dirname, "../temp-test-db");
  const eventLogPath = path.join(testDir, "events.jsonl");
  const statePath = path.join(testDir, "state.json");

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

  it("should record events in local file and replay them cleanly", async () => {
    const eventStore = new FileEventStore(eventLogPath);

    await eventStore.saveEvent("task_routed", { id: "task-01", title: "Job A" });
    await eventStore.saveEvent("task_completed", { id: "task-01" });

    const replayed = await eventStore.replayEvents();
    expect(replayed.length).toBe(2);
    expect(replayed[0].event).toBe("task_routed");
    expect(replayed[0].payload.id).toBe("task-01");
    expect(replayed[1].event).toBe("task_completed");
  });

  it("skips corrupt JSONL lines during replay and records count", async () => {
    const eventStore = new FileEventStore(eventLogPath);
    fs.writeFileSync(
      eventLogPath,
      '{"event":"ok","payload":{},"timestamp":"2020-01-01T00:00:00.000Z"}\nNOT_JSON\n{"event":"ok2","payload":{},"timestamp":"2020-01-02T00:00:00.000Z"}\n',
      "utf8"
    );
    const replayed = await eventStore.replayEvents();
    expect(replayed.length).toBe(2);
    expect(replayed[0].event).toBe("ok");
    expect(replayed[1].event).toBe("ok2");
    expect(eventStore.lastReplayCorruptLines).toBe(1);
  });

  it("should save, retrieve, and clear key-value runtime states", async () => {
    const persistence = new FileRuntimePersistence(statePath);

    await persistence.saveState("active_agent", { name: "ghoststack-worker" });
    const state = await persistence.getState<{ name: string }>("active_agent");

    expect(state).toEqual({ name: "ghoststack-worker" });

    await persistence.clearState("active_agent");
    const cleared = await persistence.getState("active_agent");
    expect(cleared).toBeUndefined();
  });
});
