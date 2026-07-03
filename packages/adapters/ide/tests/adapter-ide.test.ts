// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  CursorAdapter,
  WindsurfAdapter,
  CodexAdapter,
  GeminiCLIAdapter,
  IDEAdapterRegistry,
  IDEAdapterError,
  NullFs,
  renderMarkdown,
  type IDEAdapter,
  type IDEContext,
} from "../src/index.js";

const ROOT = "/workspace/project";
const CTX: IDEContext = {
  memory: "User prefers TypeScript with strict mode.",
  rules: ["Always write tests.", "Use dependency injection."],
  persona: "You are a senior TypeScript engineer.",
  sections: { "Coding Style": "Prefer functional patterns." },
};

// ── renderMarkdown ────────────────────────────────────────────────────────────

describe("renderMarkdown", () => {
  it("includes title as h1", () => {
    const md = renderMarkdown("My Context", {});
    expect(md.startsWith("# My Context")).toBe(true);
  });

  it("includes persona section when provided", () => {
    const md = renderMarkdown("ctx", { persona: "You are a bot." });
    expect(md).toContain("## Persona");
    expect(md).toContain("You are a bot.");
  });

  it("includes memory section when provided", () => {
    const md = renderMarkdown("ctx", { memory: "Remember this." });
    expect(md).toContain("## Memory");
    expect(md).toContain("Remember this.");
  });

  it("includes numbered rules", () => {
    const md = renderMarkdown("ctx", { rules: ["Rule A", "Rule B"] });
    expect(md).toContain("1. Rule A");
    expect(md).toContain("2. Rule B");
  });

  it("includes custom sections", () => {
    const md = renderMarkdown("ctx", { sections: { Custom: "body text" } });
    expect(md).toContain("## Custom");
    expect(md).toContain("body text");
  });

  it("omits sections when context is empty", () => {
    const md = renderMarkdown("ctx", {});
    expect(md).not.toContain("## Memory");
    expect(md).not.toContain("## Rules");
  });

  it("ends with a newline", () => {
    expect(renderMarkdown("x", CTX).endsWith("\n")).toBe(true);
  });
});

// ── CursorAdapter ─────────────────────────────────────────────────────────────

describe("CursorAdapter", () => {
  let fs: NullFs;
  let adapter: CursorAdapter;

  beforeEach(() => {
    fs = new NullFs();
    adapter = new CursorAdapter();
  });

  it("name is 'cursor'", () => expect(adapter.name).toBe("cursor"));

  it("filePaths returns .cursor/rules", () => {
    expect(adapter.filePaths()).toContain(".cursor/rules");
  });

  it("inject creates .cursor directory", async () => {
    await adapter.inject(ROOT, CTX, fs);
    expect(fs.mkdirs.has(`${ROOT}/.cursor`)).toBe(true);
  });

  it("inject writes .cursor/rules file", async () => {
    await adapter.inject(ROOT, CTX, fs);
    expect(fs.written.has(`${ROOT}/.cursor/rules`)).toBe(true);
  });

  it("inject file contains memory content", async () => {
    await adapter.inject(ROOT, CTX, fs);
    const content = fs.written.get(`${ROOT}/.cursor/rules`)!;
    expect(content).toContain(CTX.memory);
  });

  it("inject returns success=true", async () => {
    const result = await adapter.inject(ROOT, CTX, fs);
    expect(result.success).toBe(true);
    expect(result.ide).toBe("cursor");
  });

  it("inject returns file paths in result", async () => {
    const result = await adapter.inject(ROOT, CTX, fs);
    expect(result.files[0]).toContain(".cursor/rules");
  });

  it("inject returns success=false on fs error", async () => {
    const badFs: NullFs = Object.assign(new NullFs(), {
      writeFile: async () => {
        throw new Error("disk full");
      },
    });
    const result = await adapter.inject(ROOT, CTX, badFs);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("eject removes .cursor/rules", async () => {
    await adapter.inject(ROOT, CTX, fs);
    await adapter.eject(ROOT, fs);
    expect(fs.written.has(`${ROOT}/.cursor/rules`)).toBe(false);
    expect(fs.deleted.has(`${ROOT}/.cursor/rules`)).toBe(true);
  });

  it("eject is a no-op when file does not exist", async () => {
    await expect(adapter.eject(ROOT, fs)).resolves.toBeUndefined();
  });
});

// ── WindsurfAdapter ───────────────────────────────────────────────────────────

describe("WindsurfAdapter", () => {
  let fs: NullFs;
  let adapter: WindsurfAdapter;

  beforeEach(() => {
    fs = new NullFs();
    adapter = new WindsurfAdapter();
  });

  it("name is 'windsurf'", () => expect(adapter.name).toBe("windsurf"));

  it("writes .windsurfrules at root", async () => {
    await adapter.inject(ROOT, CTX, fs);
    expect(fs.written.has(`${ROOT}/.windsurfrules`)).toBe(true);
  });

  it("file includes rules content", async () => {
    await adapter.inject(ROOT, CTX, fs);
    const content = fs.written.get(`${ROOT}/.windsurfrules`)!;
    expect(content).toContain("Always write tests.");
  });

  it("eject removes .windsurfrules", async () => {
    await adapter.inject(ROOT, CTX, fs);
    await adapter.eject(ROOT, fs);
    expect(fs.written.has(`${ROOT}/.windsurfrules`)).toBe(false);
  });
});

// ── CodexAdapter ──────────────────────────────────────────────────────────────

describe("CodexAdapter", () => {
  let fs: NullFs;
  let adapter: CodexAdapter;

  beforeEach(() => {
    fs = new NullFs();
    adapter = new CodexAdapter();
  });

  it("name is 'codex'", () => expect(adapter.name).toBe("codex"));

  it("writes AGENTS.md at root", async () => {
    await adapter.inject(ROOT, CTX, fs);
    expect(fs.written.has(`${ROOT}/AGENTS.md`)).toBe(true);
  });

  it("AGENTS.md includes persona", async () => {
    await adapter.inject(ROOT, CTX, fs);
    const content = fs.written.get(`${ROOT}/AGENTS.md`)!;
    expect(content).toContain(CTX.persona);
  });

  it("eject removes AGENTS.md", async () => {
    await adapter.inject(ROOT, CTX, fs);
    await adapter.eject(ROOT, fs);
    expect(fs.written.has(`${ROOT}/AGENTS.md`)).toBe(false);
  });
});

// ── GeminiCLIAdapter ──────────────────────────────────────────────────────────

describe("GeminiCLIAdapter", () => {
  let fs: NullFs;
  let adapter: GeminiCLIAdapter;

  beforeEach(() => {
    fs = new NullFs();
    adapter = new GeminiCLIAdapter();
  });

  it("name is 'gemini-cli'", () => expect(adapter.name).toBe("gemini-cli"));

  it("writes GEMINI.md at root", async () => {
    await adapter.inject(ROOT, CTX, fs);
    expect(fs.written.has(`${ROOT}/GEMINI.md`)).toBe(true);
  });

  it("GEMINI.md includes custom sections", async () => {
    await adapter.inject(ROOT, CTX, fs);
    const content = fs.written.get(`${ROOT}/GEMINI.md`)!;
    expect(content).toContain("Coding Style");
  });

  it("eject removes GEMINI.md", async () => {
    await adapter.inject(ROOT, CTX, fs);
    await adapter.eject(ROOT, fs);
    expect(fs.written.has(`${ROOT}/GEMINI.md`)).toBe(false);
  });
});

// ── IDEAdapterRegistry ────────────────────────────────────────────────────────

describe("IDEAdapterRegistry", () => {
  it("withDefaults registers all 4 adapters", () => {
    const registry = IDEAdapterRegistry.withDefaults();
    expect(registry.list()).toHaveLength(4);
    expect(registry.get("cursor")).toBeDefined();
    expect(registry.get("windsurf")).toBeDefined();
    expect(registry.get("codex")).toBeDefined();
    expect(registry.get("gemini-cli")).toBeDefined();
  });

  it("register + get round-trips", () => {
    const registry = new IDEAdapterRegistry();
    const adapter = new CursorAdapter();
    registry.register(adapter);
    expect(registry.get("cursor")).toBe(adapter);
  });

  it("list returns all registered adapters", () => {
    const registry = new IDEAdapterRegistry();
    registry.register(new CursorAdapter());
    registry.register(new WindsurfAdapter());
    expect(registry.list()).toHaveLength(2);
  });

  it("injectAll injects into all adapters", async () => {
    const registry = IDEAdapterRegistry.withDefaults();
    const fs = new NullFs();
    const results = await registry.injectAll(ROOT, CTX, fs);
    expect(results).toHaveLength(4);
    expect(results.every((r) => r.success)).toBe(true);
    expect(fs.written.size).toBe(4); // 4 files written
  });

  it("ejectAll removes all files", async () => {
    const registry = IDEAdapterRegistry.withDefaults();
    const fs = new NullFs();
    await registry.injectAll(ROOT, CTX, fs);
    await registry.ejectAll(ROOT, fs);
    expect(fs.written.size).toBe(0);
  });

  it("injectAll result includes all ide names", async () => {
    const registry = IDEAdapterRegistry.withDefaults();
    const fs = new NullFs();
    const results = await registry.injectAll(ROOT, CTX, fs);
    const names = results.map((r) => r.ide);
    expect(names).toContain("cursor");
    expect(names).toContain("windsurf");
    expect(names).toContain("codex");
    expect(names).toContain("gemini-cli");
  });

  it("get returns undefined for unknown IDE", () => {
    const registry = new IDEAdapterRegistry();
    expect(registry.get("cursor")).toBeUndefined();
  });
});

// ── NullFs ────────────────────────────────────────────────────────────────────

describe("NullFs", () => {
  it("writeFile stores content", async () => {
    const fs = new NullFs();
    await fs.writeFile("/a.txt", "hello");
    expect(fs.written.get("/a.txt")).toBe("hello");
  });

  it("readFile returns stored content", async () => {
    const fs = new NullFs();
    await fs.writeFile("/b.txt", "world");
    expect(await fs.readFile("/b.txt")).toBe("world");
  });

  it("readFile throws for missing file", async () => {
    const fs = new NullFs();
    await expect(fs.readFile("/missing")).rejects.toThrow("ENOENT");
  });

  it("exists returns true after write", async () => {
    const fs = new NullFs();
    await fs.writeFile("/x", "y");
    expect(await fs.exists("/x")).toBe(true);
    expect(await fs.exists("/z")).toBe(false);
  });

  it("unlink removes file", async () => {
    const fs = new NullFs();
    await fs.writeFile("/del.txt", "bye");
    await fs.unlink("/del.txt");
    expect(await fs.exists("/del.txt")).toBe(false);
    expect(fs.deleted.has("/del.txt")).toBe(true);
  });
});

// ── IDEAdapterError ───────────────────────────────────────────────────────────

describe("IDEAdapterError", () => {
  it("has correct name, code, and message", () => {
    const e = new IDEAdapterError("fs error", "FS_ERROR");
    expect(e.name).toBe("IDEAdapterError");
    expect(e.code).toBe("FS_ERROR");
    expect(e instanceof Error).toBe(true);
  });
});
