import * as fs from "fs";
import * as path from "path";
import { FileEventStore } from "../orchestration/persistence-manager";
import { TaskRouter } from "../orchestration/task-router";
import { LocalEventBus } from "../orchestration/event-bus";

describe("JSONL replay golden", () => {
  const goldenPath = path.join(__dirname, "fixtures", "events-golden.jsonl");
  const tempPath = path.join(__dirname, "../temp-replay-golden", "events.jsonl");

  beforeAll(() => {
    const dir = path.dirname(tempPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(goldenPath, tempPath);
  });

  afterAll(() => {
    fs.rmSync(path.dirname(tempPath), { recursive: true, force: true });
  });

  it("replays a fixed event sequence deterministically", async () => {
    const store = new FileEventStore(tempPath);
    const bus = new LocalEventBus();
    const router = new TaskRouter(bus, store);
    const events = await store.replayEvents();
    for (const e of events) {
      await router.replayEvent(e);
    }
    const queue = router.getQueue();
    expect(queue.map((t) => t.id)).toEqual(["task-a", "task-b"]);
    expect(queue[1].dependencies).toContain("task-a");
  });
});
