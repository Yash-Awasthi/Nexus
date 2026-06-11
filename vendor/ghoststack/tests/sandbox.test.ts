import { FilesystemSandbox, SandboxConstraint } from "../orchestration/filesystem-sandbox";
import * as path from "path";
import * as fs from "fs";

describe("Milestone 1: Filesystem Sandbox & Path Isolation", () => {
  const rootDir = path.resolve(path.join(__dirname, "../temp-sandbox-test"));
  const constraint = new SandboxConstraint(100, rootDir); // 100 bytes limit

  beforeEach(() => {
    if (fs.existsSync(rootDir)) {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
    fs.mkdirSync(rootDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(rootDir)) {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("should allow safe write operations within sandbox bounds and log activities", async () => {
    const sandbox = new FilesystemSandbox(rootDir, constraint);
    const targetFile = path.join(rootDir, "data.txt");

    await sandbox.writeFile(targetFile, "Hello GhostStack!");
    const content = await sandbox.readFile(targetFile);
    expect(content).toBe("Hello GhostStack!");

    const log = sandbox.getWriteLog();
    expect(log.length).toBe(1);
    expect(log[0].bytes).toBe(17);
  });

  it("should block path traversal attempts violating sandbox limits", async () => {
    const sandbox = new FilesystemSandbox(rootDir, constraint);
    const illegalFile = path.resolve(path.join(rootDir, "../../illegal_host.txt"));

    await expect(sandbox.writeFile(illegalFile, "traversal content")).rejects.toThrow("Sandbox Write violation");

    await expect(sandbox.readFile(illegalFile)).rejects.toThrow("Sandbox Read violation");
  });

  it("should enforce write volume ceiling constraint limits", async () => {
    const sandbox = new FilesystemSandbox(rootDir, constraint);
    const file1 = path.join(rootDir, "file1.txt");
    const file2 = path.join(rootDir, "file2.txt");

    // 60 bytes written
    await sandbox.writeFile(file1, "A".repeat(60));

    // Attempt writing another 50 bytes -> totals 110 bytes (exceeds limit 100)
    await expect(sandbox.writeFile(file2, "B".repeat(50))).rejects.toThrow("Sandbox Write violation");
  });

  it("should perform recursive cleanup routines leaving zero traces", async () => {
    const sandbox = new FilesystemSandbox(rootDir, constraint);
    await sandbox.createDirectory("nest");
    await sandbox.writeFile(path.join(rootDir, "nest/foo.txt"), "temp content");

    expect(fs.existsSync(path.join(rootDir, "nest/foo.txt"))).toBe(true);

    await sandbox.cleanup();
    expect(fs.existsSync(rootDir)).toBe(false);
  });
});
