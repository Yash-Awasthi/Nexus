import * as fs from "fs";
import * as path from "path";
import {
  FileEventStore,
  FileRuntimePersistence,
  backupRuntimePersistence
} from "../orchestration/persistence-manager";

describe("persistence backup", () => {
  const testDir = path.join(__dirname, "../temp-backup-db");
  const backupsDir = path.join(testDir, "backups");

  beforeEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.mkdirSync(backupsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("copies event log and state file to backups directory", async () => {
    const eventStore = new FileEventStore(path.join(testDir, "events.jsonl"));
    const persistence = new FileRuntimePersistence(path.join(testDir, "cache.json"));

    await eventStore.saveEvent("task_routed", { id: "x" });
    await persistence.saveState("k", { v: 1 });

    const result = backupRuntimePersistence(eventStore, persistence, backupsDir);
    expect(fs.existsSync(result.eventsBackup)).toBe(true);
    expect(fs.existsSync(result.stateBackup)).toBe(true);
    expect(fs.readFileSync(result.eventsBackup, "utf8")).toContain("task_routed");
    expect(fs.readFileSync(result.stateBackup, "utf8")).toContain('"k"');
  });
});
