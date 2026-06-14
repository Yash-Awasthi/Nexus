// SPDX-License-Identifier: Apache-2.0

// ── Filesystem abstraction (injectable) ───────────────────────────────────────

export interface FsLike {
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  unlink(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

// ── Context ───────────────────────────────────────────────────────────────────

export interface IDEContext {
  /** Agent memory / notes to surface inside the IDE. */
  memory?: string;
  /** Ordered list of project rules. */
  rules?: string[];
  /** Persona or system-prompt description. */
  persona?: string;
  /** Extra named sections injected at the bottom. */
  sections?: Record<string, string>;
}

// ── Result ────────────────────────────────────────────────────────────────────

export interface InjectResult {
  ide: IDEName;
  files: string[];
  success: boolean;
  error?: string;
}

// ── IDE names ─────────────────────────────────────────────────────────────────

export type IDEName = "cursor" | "windsurf" | "codex" | "gemini-cli";

// ── Shared renderer ───────────────────────────────────────────────────────────

export function renderMarkdown(title: string, ctx: IDEContext): string {
  const lines: string[] = [`# ${title}`, ""];

  if (ctx.persona) {
    lines.push("## Persona", "", ctx.persona, "");
  }

  if (ctx.memory) {
    lines.push("## Memory", "", ctx.memory, "");
  }

  if (ctx.rules && ctx.rules.length > 0) {
    lines.push("## Rules", "");
    ctx.rules.forEach((r, i) => lines.push(`${i + 1}. ${r}`));
    lines.push("");
  }

  if (ctx.sections) {
    for (const [heading, body] of Object.entries(ctx.sections)) {
      lines.push(`## ${heading}`, "", body, "");
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

// ── IDEAdapter interface ──────────────────────────────────────────────────────

export interface IDEAdapter {
  readonly name: IDEName;
  /** Inject context into the IDE config under `root`. */
  inject(root: string, ctx: IDEContext, fs: FsLike): Promise<InjectResult>;
  /** Remove all files written by inject(). */
  eject(root: string, fs: FsLike): Promise<void>;
  /** Paths this adapter writes (relative to root). */
  filePaths(): string[];
}

// ── CursorAdapter ─────────────────────────────────────────────────────────────

export class CursorAdapter implements IDEAdapter {
  readonly name: IDEName = "cursor";

  filePaths(): string[] {
    return [".cursor/rules"];
  }

  async inject(root: string, ctx: IDEContext, fs: FsLike): Promise<InjectResult> {
    const files = this.filePaths().map((f) => `${root}/${f}`);
    try {
      await fs.mkdir(`${root}/.cursor`, { recursive: true });
      const content = renderMarkdown("Nexus Agent Context", ctx);
      await fs.writeFile(files[0]!, content);
      return { ide: this.name, files, success: true };
    } catch (err) {
      return { ide: this.name, files, success: false, error: String(err) };
    }
  }

  async eject(root: string, fs: FsLike): Promise<void> {
    for (const rel of this.filePaths()) {
      const p = `${root}/${rel}`;
      if (await fs.exists(p)) await fs.unlink(p);
    }
  }
}

// ── WindsurfAdapter ───────────────────────────────────────────────────────────

export class WindsurfAdapter implements IDEAdapter {
  readonly name: IDEName = "windsurf";

  filePaths(): string[] {
    return [".windsurfrules"];
  }

  async inject(root: string, ctx: IDEContext, fs: FsLike): Promise<InjectResult> {
    const files = this.filePaths().map((f) => `${root}/${f}`);
    try {
      const content = renderMarkdown("Nexus Agent Context", ctx);
      await fs.writeFile(files[0]!, content);
      return { ide: this.name, files, success: true };
    } catch (err) {
      return { ide: this.name, files, success: false, error: String(err) };
    }
  }

  async eject(root: string, fs: FsLike): Promise<void> {
    for (const rel of this.filePaths()) {
      const p = `${root}/${rel}`;
      if (await fs.exists(p)) await fs.unlink(p);
    }
  }
}

// ── CodexAdapter ──────────────────────────────────────────────────────────────

export class CodexAdapter implements IDEAdapter {
  readonly name: IDEName = "codex";

  filePaths(): string[] {
    return ["AGENTS.md"];
  }

  async inject(root: string, ctx: IDEContext, fs: FsLike): Promise<InjectResult> {
    const files = this.filePaths().map((f) => `${root}/${f}`);
    try {
      const content = renderMarkdown("Agent Instructions", ctx);
      await fs.writeFile(files[0]!, content);
      return { ide: this.name, files, success: true };
    } catch (err) {
      return { ide: this.name, files, success: false, error: String(err) };
    }
  }

  async eject(root: string, fs: FsLike): Promise<void> {
    for (const rel of this.filePaths()) {
      const p = `${root}/${rel}`;
      if (await fs.exists(p)) await fs.unlink(p);
    }
  }
}

// ── GeminiCLIAdapter ──────────────────────────────────────────────────────────

export class GeminiCLIAdapter implements IDEAdapter {
  readonly name: IDEName = "gemini-cli";

  filePaths(): string[] {
    return ["GEMINI.md"];
  }

  async inject(root: string, ctx: IDEContext, fs: FsLike): Promise<InjectResult> {
    const files = this.filePaths().map((f) => `${root}/${f}`);
    try {
      const content = renderMarkdown("Gemini Context", ctx);
      await fs.writeFile(files[0]!, content);
      return { ide: this.name, files, success: true };
    } catch (err) {
      return { ide: this.name, files, success: false, error: String(err) };
    }
  }

  async eject(root: string, fs: FsLike): Promise<void> {
    for (const rel of this.filePaths()) {
      const p = `${root}/${rel}`;
      if (await fs.exists(p)) await fs.unlink(p);
    }
  }
}

// ── IDEAdapterRegistry ────────────────────────────────────────────────────────

export class IDEAdapterRegistry {
  private readonly _adapters = new Map<IDEName, IDEAdapter>();

  /** Register all default adapters. */
  static withDefaults(): IDEAdapterRegistry {
    const r = new IDEAdapterRegistry();
    r.register(new CursorAdapter());
    r.register(new WindsurfAdapter());
    r.register(new CodexAdapter());
    r.register(new GeminiCLIAdapter());
    return r;
  }

  register(adapter: IDEAdapter): void {
    this._adapters.set(adapter.name, adapter);
  }

  get(name: IDEName): IDEAdapter | undefined {
    return this._adapters.get(name);
  }

  list(): IDEAdapter[] {
    return Array.from(this._adapters.values());
  }

  /** Inject into all registered adapters in parallel. */
  async injectAll(root: string, ctx: IDEContext, fs: FsLike): Promise<InjectResult[]> {
    return Promise.all(this.list().map((a) => a.inject(root, ctx, fs)));
  }

  /** Eject from all registered adapters. */
  async ejectAll(root: string, fs: FsLike): Promise<void> {
    await Promise.all(this.list().map((a) => a.eject(root, fs)));
  }
}

// ── IDEAdapterError ───────────────────────────────────────────────────────────

export class IDEAdapterError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "IDEAdapterError";
    this.code = code;
  }
}

// ── NullFs (for testing) ──────────────────────────────────────────────────────

export class NullFs implements FsLike {
  readonly written = new Map<string, string>();
  readonly deleted = new Set<string>();
  readonly mkdirs = new Set<string>();

  async mkdir(path: string, _opts?: { recursive?: boolean }): Promise<void> {
    this.mkdirs.add(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.written.set(path, content);
    this.deleted.delete(path);
  }

  async readFile(path: string): Promise<string> {
    const v = this.written.get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  }

  async unlink(path: string): Promise<void> {
    this.written.delete(path);
    this.deleted.add(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.written.has(path);
  }
}
