import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { FileQueueBackend } from "../orchestration/file-queue-backend";
import { QueueJob } from "../orchestration/interfaces/queue.interface";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gs-fqb-test-"));
}

function makeJob(id: string, priority: QueueJob["priority"] = "medium", retries = 0, maxRetries = 3): QueueJob {
  return {
    id,
    payload: { type: "test", data: id },
    priority,
    retries,
    maxRetries,
    createdAt: new Date()
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("FileQueueBackend", () => {
  let tmpDir: string;
  let backend: FileQueueBackend;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    backend = new FileQueueBackend(tmpDir);
    await backend.init();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("basic queue operations", () => {
    it("push and pop a single job", async () => {
      await backend.push(makeJob("job-1"));
      expect(await backend.getQueueLength()).toBe(1);
      const job = await backend.pop();
      expect(job).toBeDefined();
      expect(job!.id).toBe("job-1");
      expect(await backend.getQueueLength()).toBe(0);
    });

    it("pop from empty queue returns undefined", async () => {
      const job = await backend.pop();
      expect(job).toBeUndefined();
    });

    it("getActiveJobs returns all pending jobs", async () => {
      await backend.push(makeJob("j1"));
      await backend.push(makeJob("j2"));
      await backend.push(makeJob("j3"));
      const active = await backend.getActiveJobs();
      expect(active.length).toBe(3);
      expect(active.map((j) => j.id)).toEqual(expect.arrayContaining(["j1", "j2", "j3"]));
    });
  });

  describe("priority ordering", () => {
    it("pops high-priority jobs before medium, medium before low", async () => {
      await backend.push(makeJob("low-1", "low"));
      await backend.push(makeJob("med-1", "medium"));
      await backend.push(makeJob("high-1", "high"));
      await backend.push(makeJob("med-2", "medium"));

      const first = await backend.pop();
      expect(first!.priority).toBe("high");
      const second = await backend.pop();
      expect(second!.priority).toBe("medium");
    });

    it("FIFO ordering within same priority", async () => {
      const now = Date.now();
      const older = makeJob("older", "medium");
      older.createdAt = new Date(now - 1000);
      const newer = makeJob("newer", "medium");
      newer.createdAt = new Date(now);
      await backend.push(newer);
      await backend.push(older);

      const first = await backend.pop();
      expect(first!.id).toBe("older");
    });
  });

  describe("dead-letter queue", () => {
    it("moves exhausted job to DLQ on push", async () => {
      const exhausted = makeJob("exhausted", "medium", 3, 3);
      await backend.push(exhausted);
      expect(await backend.getQueueLength()).toBe(0);
      const dlq = await backend.getDeadLetterQueue();
      expect(dlq.length).toBe(1);
      expect(dlq[0].id).toBe("exhausted");
    });

    it("moveToDeadLetter removes job from active and adds to DLQ", async () => {
      const job = makeJob("doomed");
      await backend.push(job);
      await backend.moveToDeadLetter(job, "intentional failure");
      expect(await backend.getQueueLength()).toBe(0);
      const dlq = await backend.getDeadLetterQueue();
      expect(dlq.some((j) => j.id === "doomed")).toBe(true);
    });
  });

  describe("persistence across restarts", () => {
    it("persists active queue to disk and recovers on new instance", async () => {
      await backend.push(makeJob("persist-1", "high"));
      await backend.push(makeJob("persist-2", "medium"));

      // Simulate restart
      const backend2 = new FileQueueBackend(tmpDir);
      await backend2.init();
      expect(await backend2.getQueueLength()).toBe(2);
      const active = await backend2.getActiveJobs();
      expect(active.map((j) => j.id)).toEqual(expect.arrayContaining(["persist-1", "persist-2"]));
    });

    it("persists DLQ to disk and recovers on new instance", async () => {
      const job = makeJob("dlq-persist");
      await backend.push(job);
      await backend.moveToDeadLetter(job, "test");

      const backend2 = new FileQueueBackend(tmpDir);
      await backend2.init();
      const dlq = await backend2.getDeadLetterQueue();
      expect(dlq.length).toBe(1);
      expect(dlq[0].id).toBe("dlq-persist");
    });

    it("recovers Date objects correctly from JSONL", async () => {
      const job = makeJob("date-test");
      await backend.push(job);

      const backend2 = new FileQueueBackend(tmpDir);
      await backend2.init();
      const jobs = await backend2.getActiveJobs();
      expect(jobs[0].createdAt).toBeInstanceOf(Date);
    });

    it("handles corrupt lines in JSONL gracefully", async () => {
      const queueFile = path.join(tmpDir, "queue.jsonl");
      fs.writeFileSync(queueFile, `${JSON.stringify(makeJob("good"))}\n{corrupt line\n`, "utf8");

      const recovered = new FileQueueBackend(tmpDir);
      await recovered.init();
      // Only the valid line should be loaded
      expect(await recovered.getQueueLength()).toBe(1);
    });
  });

  describe("clear and reload", () => {
    it("clear empties the active queue", async () => {
      await backend.push(makeJob("c1"));
      await backend.push(makeJob("c2"));
      await backend.clear();
      expect(await backend.getQueueLength()).toBe(0);
    });

    it("clear with includeDlq=true also empties DLQ", async () => {
      const job = makeJob("dlq-clear");
      await backend.push(job);
      await backend.moveToDeadLetter(job, "test");
      await backend.clear(true);
      const dlq = await backend.getDeadLetterQueue();
      expect(dlq.length).toBe(0);
    });

    it("reload re-reads from disk after external modification", async () => {
      await backend.push(makeJob("before-reload"));
      // Another process writes directly to the file
      const queueFile = path.join(tmpDir, "queue.jsonl");
      const newJob = makeJob("injected");
      fs.appendFileSync(queueFile, JSON.stringify(newJob) + "\n", "utf8");
      await backend.reload();
      const active = await backend.getActiveJobs();
      expect(active.some((j) => j.id === "injected")).toBe(true);
    });
  });

  describe("atomic write resilience", () => {
    it("queue file exists after operations and is valid JSON lines", async () => {
      await backend.push(makeJob("atomic-1"));
      await backend.push(makeJob("atomic-2"));
      const queueFile = path.join(tmpDir, "queue.jsonl");
      expect(fs.existsSync(queueFile)).toBe(true);
      const lines = fs.readFileSync(queueFile, "utf8").trim().split("\n");
      expect(lines.length).toBe(2);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it("queue file is empty after all jobs are popped", async () => {
      await backend.push(makeJob("drain-1"));
      await backend.push(makeJob("drain-2"));
      await backend.pop();
      await backend.pop();
      const queueFile = path.join(tmpDir, "queue.jsonl");
      const content = fs.readFileSync(queueFile, "utf8").trim();
      expect(content).toBe("");
    });
  });
});
