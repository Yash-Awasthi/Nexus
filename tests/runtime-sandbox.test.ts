import * as path from "path";
import * as fs from "fs";
import { createRuntimeSandbox, resolveSandboxPath } from "../orchestration/runtime-sandbox";

describe("runtime-sandbox", () => {
  const repo = path.join(__dirname, "../temp-sandbox-repo");

  beforeEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.mkdirSync(repo, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("creates sandbox layout under repo root", () => {
    const layout = createRuntimeSandbox(repo);
    expect(fs.existsSync(layout.workspacesDir)).toBe(true);
    expect(fs.existsSync(layout.backupsDir)).toBe(true);
  });

  it("rejects paths outside repo root", () => {
    const layout = createRuntimeSandbox(repo);
    expect(() => resolveSandboxPath(layout.dataDir, layout.root, "../../outside")).toThrow(/boundary/i);
  });
});
