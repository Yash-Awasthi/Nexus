// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  CodeSearchAgent,
  DirectoryListerAgent,
  FileListerAgent,
  FilePickerAgent,
  GlobMatcherAgent,
  createFileExplorerAgents,
  createMockFileExplorerAgents,
  mockCodeSearchHandler,
  mockDirectoryListHandler,
  mockFileListHandler,
  mockFilePickerHandler,
  mockGlobMatchHandler,
  type CodeSearchResult,
  type FileEntry,
} from "../src/index.js";

// ── CodeSearchAgent ───────────────────────────────────────────────────────────

describe("CodeSearchAgent", () => {
  it("throws when no handler injected", async () => {
    const agent = new CodeSearchAgent();
    const result = await agent.execute({ query: "test" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("no handler injected");
  });

  it("executes with injected handler", async () => {
    const agent = new CodeSearchAgent();
    agent.inject(mockCodeSearchHandler());
    const result = await agent.execute({ query: "useState" });
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.results.length).toBeGreaterThan(0);
  });

  it("captures handler errors gracefully", async () => {
    const agent = new CodeSearchAgent();
    agent.inject(async () => { throw new Error("search failed"); });
    const result = await agent.execute({ query: "q" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("search failed");
  });

  it("inject returns this for chaining", () => {
    const agent = new CodeSearchAgent();
    expect(agent.inject(mockCodeSearchHandler())).toBe(agent);
  });

  it("spawnerPrompt returns non-empty string", () => {
    expect(CodeSearchAgent.spawnerPrompt().length).toBeGreaterThan(0);
  });

  it("custom results are returned", async () => {
    const results: CodeSearchResult[] = [
      { path: "lib/util.ts", snippet: "function util() {}", lineNumber: 5, relevanceScore: 0.95 },
    ];
    const agent = new CodeSearchAgent().inject(mockCodeSearchHandler(results));
    const output = await agent.execute({ query: "util" });
    const data = output.data as any;
    expect(data.results[0].path).toBe("lib/util.ts");
  });
});

// ── DirectoryListerAgent ──────────────────────────────────────────────────────

describe("DirectoryListerAgent", () => {
  it("throws when no handler injected", async () => {
    const agent = new DirectoryListerAgent();
    const result = await agent.execute({ path: "/src" });
    expect(result.success).toBe(false);
  });

  it("lists directory entries", async () => {
    const agent = new DirectoryListerAgent().inject(mockDirectoryListHandler());
    const result = await agent.execute({ path: "/src" });
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.entries.length).toBeGreaterThan(0);
    expect(data.path).toBe("/src");
  });

  it("custom entries override defaults", async () => {
    const entries: FileEntry[] = [
      { path: "/src/custom.ts", name: "custom.ts", type: "file" },
    ];
    const agent = new DirectoryListerAgent().inject(mockDirectoryListHandler(entries));
    const result = await agent.execute({ path: "/src" });
    const data = result.data as any;
    expect(data.entries[0].name).toBe("custom.ts");
  });

  it("spawnerPrompt is defined", () => {
    expect(DirectoryListerAgent.spawnerPrompt().length).toBeGreaterThan(0);
  });
});

// ── FileListerAgent ───────────────────────────────────────────────────────────

describe("FileListerAgent", () => {
  it("throws when no handler injected", async () => {
    const agent = new FileListerAgent();
    const result = await agent.execute({ directory: "/src" });
    expect(result.success).toBe(false);
  });

  it("lists files", async () => {
    const agent = new FileListerAgent().inject(mockFileListHandler());
    const result = await agent.execute({ directory: "/src", extensions: ["ts"] });
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.files.length).toBeGreaterThan(0);
  });

  it("spawnerPrompt is defined", () => {
    expect(FileListerAgent.spawnerPrompt().length).toBeGreaterThan(0);
  });
});

// ── FilePickerAgent ───────────────────────────────────────────────────────────

describe("FilePickerAgent", () => {
  it("throws when no handler injected", async () => {
    const agent = new FilePickerAgent();
    const result = await agent.execute({ description: "main entry", candidates: ["src/index.ts"] });
    expect(result.success).toBe(false);
  });

  it("picks a file from candidates", async () => {
    const agent = new FilePickerAgent().inject(mockFilePickerHandler("src/main.ts"));
    const result = await agent.execute({
      description: "main file",
      candidates: ["src/main.ts", "src/index.ts"],
    });
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.pickedPath).toBe("src/main.ts");
    expect(data.reasoning).toBeDefined();
  });

  it("handles null pick", async () => {
    const agent = new FilePickerAgent().inject(mockFilePickerHandler(null));
    const result = await agent.execute({ description: "missing", candidates: [] });
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.pickedPath).toBeNull();
  });

  it("spawnerPrompt is defined", () => {
    expect(FilePickerAgent.spawnerPrompt().length).toBeGreaterThan(0);
  });
});

// ── GlobMatcherAgent ──────────────────────────────────────────────────────────

describe("GlobMatcherAgent", () => {
  it("throws when no handler injected", async () => {
    const agent = new GlobMatcherAgent();
    const result = await agent.execute({ patterns: ["*.ts"], paths: ["a.ts"] });
    expect(result.success).toBe(false);
  });

  it("matches paths against patterns", async () => {
    const agent = new GlobMatcherAgent().inject(mockGlobMatchHandler());
    const result = await agent.execute({
      patterns: ["src/**"],
      paths: ["src/index.ts", "src/util.ts", "lib/helper.ts"],
    });
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.matched).toContain("src/index.ts");
    expect(data.unmatched).toContain("lib/helper.ts");
  });

  it("totalMatched reflects count", async () => {
    const agent = new GlobMatcherAgent().inject(mockGlobMatchHandler());
    const result = await agent.execute({
      patterns: ["src/**"],
      paths: ["src/a.ts", "src/b.ts", "other/c.ts"],
    });
    const data = result.data as any;
    expect(data.totalMatched).toBe(data.matched.length);
  });

  it("spawnerPrompt is defined", () => {
    expect(GlobMatcherAgent.spawnerPrompt().length).toBeGreaterThan(0);
  });
});

// ── createFileExplorerAgents ──────────────────────────────────────────────────

describe("createFileExplorerAgents", () => {
  it("returns all 5 agents", () => {
    const agents = createFileExplorerAgents();
    expect(agents.codeSearch).toBeDefined();
    expect(agents.directoryLister).toBeDefined();
    expect(agents.fileLister).toBeDefined();
    expect(agents.filePicker).toBeDefined();
    expect(agents.globMatcher).toBeDefined();
  });

  it("agents without handlers fail gracefully", async () => {
    const agents = createFileExplorerAgents();
    const result = await agents.codeSearch.execute({ query: "x" });
    expect(result.success).toBe(false);
  });
});

// ── createMockFileExplorerAgents ──────────────────────────────────────────────

describe("createMockFileExplorerAgents", () => {
  it("all agents succeed with mock handlers", async () => {
    const agents = createMockFileExplorerAgents();
    const cs = await agents.codeSearch.execute({ query: "foo" });
    expect(cs.success).toBe(true);

    const dl = await agents.directoryLister.execute({ path: "/src" });
    expect(dl.success).toBe(true);

    const fl = await agents.fileLister.execute({ directory: "/src" });
    expect(fl.success).toBe(true);

    const fp = await agents.filePicker.execute({ description: "main", candidates: ["a.ts"] });
    expect(fp.success).toBe(true);

    const gm = await agents.globMatcher.execute({ patterns: ["src/**"], paths: ["src/x.ts"] });
    expect(gm.success).toBe(true);
  });
});
