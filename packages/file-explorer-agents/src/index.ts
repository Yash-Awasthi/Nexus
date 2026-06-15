// SPDX-License-Identifier: Apache-2.0
/**
 * file-explorer-agents — Spawnable LLM sub-agents for file system exploration.
 *
 * Provides injectable, testable agent shells for:
 *   • CodeSearchAgent      — semantic code search across a project
 *   • DirectoryListerAgent — list directories with depth/pattern control
 *   • FileListerAgent      — list files matching criteria
 *   • FilePickerAgent      — pick best matching file for a description
 *   • GlobMatcherAgent     — match file paths against glob patterns
 *
 * Each agent follows inject/execute pattern: handlers are injected separately
 * from construction, making them trivially testable without LLM calls.
 */

// ── Base types ────────────────────────────────────────────────────────────────

export type AgentInput = Record<string, unknown>;

/** Agent output interface definition. */
export interface AgentOutput {
  success: boolean;
  data: unknown;
  error?: string;
  tokensUsed?: number;
}

/** Agent handler type alias. */
export type AgentHandler<I extends AgentInput, O> = (input: I, ctx?: AgentContext) => Promise<O>;

/** Agent context interface definition. */
export interface AgentContext {
  sessionId?: string;
  workspacePath?: string;
  maxTokens?: number;
  model?: string;
}

// ── FileEntry ─────────────────────────────────────────────────────────────────

export interface FileEntry {
  path: string;
  name: string;
  type: "file" | "directory";
  size?: number;
  extension?: string;
  lastModified?: string;
}

// ── CodeSearchAgent ───────────────────────────────────────────────────────────

export interface CodeSearchInput extends AgentInput {
  query: string;
  language?: string;
  maxResults?: number;
  projectPath?: string;
}

/** Code search result interface definition. */
export interface CodeSearchResult {
  path: string;
  snippet: string;
  lineNumber?: number;
  relevanceScore: number;
}

/** Code search output interface definition. */
export interface CodeSearchOutput {
  results: CodeSearchResult[];
  query: string;
  totalFound: number;
}

/** Code search agent. */
export class CodeSearchAgent {
  private handler?: AgentHandler<CodeSearchInput, CodeSearchOutput>;

  inject(handler: AgentHandler<CodeSearchInput, CodeSearchOutput>): this {
    this.handler = handler;
    return this;
  }

  async execute(input: CodeSearchInput, ctx?: AgentContext): Promise<AgentOutput> {
    if (!this.handler)
      return { success: false, data: null, error: "CodeSearchAgent: no handler injected" };
    try {
      const data = await this.handler(input, ctx);
      return { success: true, data };
    } catch (err) {
      return {
        success: false,
        data: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Spawner prompt for LLM-based instantiation. */
  static spawnerPrompt(): string {
    return [
      "You are a code search agent. Given a query, search the project codebase for relevant code snippets.",
      "Return results with file paths, snippets, line numbers, and relevance scores.",
      "Focus on semantic similarity, not just keyword matching.",
    ].join(" ");
  }
}

// ── DirectoryListerAgent ──────────────────────────────────────────────────────

export interface DirectoryListInput extends AgentInput {
  path: string;
  depth?: number;
  includeHidden?: boolean;
  pattern?: string;
}

/** Directory list output interface definition. */
export interface DirectoryListOutput {
  entries: FileEntry[];
  path: string;
  totalEntries: number;
}

/** Directory lister agent. */
export class DirectoryListerAgent {
  private handler?: AgentHandler<DirectoryListInput, DirectoryListOutput>;

  inject(handler: AgentHandler<DirectoryListInput, DirectoryListOutput>): this {
    this.handler = handler;
    return this;
  }

  async execute(input: DirectoryListInput, ctx?: AgentContext): Promise<AgentOutput> {
    if (!this.handler)
      return { success: false, data: null, error: "DirectoryListerAgent: no handler injected" };
    try {
      const data = await this.handler(input, ctx);
      return { success: true, data };
    } catch (err) {
      return {
        success: false,
        data: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  static spawnerPrompt(): string {
    return "You are a directory listing agent. List the contents of a directory, respecting depth and pattern constraints.";
  }
}

// ── FileListerAgent ───────────────────────────────────────────────────────────

export interface FileListInput extends AgentInput {
  directory: string;
  extensions?: string[];
  recursive?: boolean;
  maxFiles?: number;
}

/** File list output interface definition. */
export interface FileListOutput {
  files: FileEntry[];
  directory: string;
  totalFiles: number;
}

/** File lister agent. */
export class FileListerAgent {
  private handler?: AgentHandler<FileListInput, FileListOutput>;

  inject(handler: AgentHandler<FileListInput, FileListOutput>): this {
    this.handler = handler;
    return this;
  }

  async execute(input: FileListInput, ctx?: AgentContext): Promise<AgentOutput> {
    if (!this.handler)
      return { success: false, data: null, error: "FileListerAgent: no handler injected" };
    try {
      const data = await this.handler(input, ctx);
      return { success: true, data };
    } catch (err) {
      return {
        success: false,
        data: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  static spawnerPrompt(): string {
    return "You are a file listing agent. List files in a directory, optionally filtered by extension or recursion depth.";
  }
}

// ── FilePickerAgent ───────────────────────────────────────────────────────────

export interface FilePickerInput extends AgentInput {
  description: string;
  candidates: string[]; // list of file paths to pick from
  context?: string;
}

/** File picker output interface definition. */
export interface FilePickerOutput {
  pickedPath: string | null;
  reasoning: string;
  alternatives?: string[];
}

/** File picker agent. */
export class FilePickerAgent {
  private handler?: AgentHandler<FilePickerInput, FilePickerOutput>;

  inject(handler: AgentHandler<FilePickerInput, FilePickerOutput>): this {
    this.handler = handler;
    return this;
  }

  async execute(input: FilePickerInput, ctx?: AgentContext): Promise<AgentOutput> {
    if (!this.handler)
      return { success: false, data: null, error: "FilePickerAgent: no handler injected" };
    try {
      const data = await this.handler(input, ctx);
      return { success: true, data };
    } catch (err) {
      return {
        success: false,
        data: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  static spawnerPrompt(): string {
    return "You are a file picker agent. Given a description and candidate file paths, pick the most relevant file.";
  }
}

// ── GlobMatcherAgent ──────────────────────────────────────────────────────────

export interface GlobMatchInput extends AgentInput {
  patterns: string[];
  paths: string[];
  negatePatterns?: string[];
}

/** Glob match output interface definition. */
export interface GlobMatchOutput {
  matched: string[];
  unmatched: string[];
  totalMatched: number;
}

/** Glob matcher agent. */
export class GlobMatcherAgent {
  private handler?: AgentHandler<GlobMatchInput, GlobMatchOutput>;

  inject(handler: AgentHandler<GlobMatchInput, GlobMatchOutput>): this {
    this.handler = handler;
    return this;
  }

  async execute(input: GlobMatchInput, ctx?: AgentContext): Promise<AgentOutput> {
    if (!this.handler)
      return { success: false, data: null, error: "GlobMatcherAgent: no handler injected" };
    try {
      const data = await this.handler(input, ctx);
      return { success: true, data };
    } catch (err) {
      return {
        success: false,
        data: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  static spawnerPrompt(): string {
    return "You are a glob matcher agent. Given patterns and file paths, return matched and unmatched sets.";
  }
}

// ── MockHandlers (for testing) ────────────────────────────────────────────────

export function mockCodeSearchHandler(
  results: CodeSearchResult[] = [],
): AgentHandler<CodeSearchInput, CodeSearchOutput> {
  return async (input) => ({
    results:
      results.length > 0
        ? results
        : [
            {
              path: "src/main.ts",
              snippet: `// code for: ${input.query}`,
              lineNumber: 1,
              relevanceScore: 0.9,
            },
          ],
    query: input.query,
    totalFound: results.length || 1,
  });
}

/** Mock directory list handler. */
export function mockDirectoryListHandler(
  entries: FileEntry[] = [],
): AgentHandler<DirectoryListInput, DirectoryListOutput> {
  return async (input) => ({
    entries:
      entries.length > 0
        ? entries
        : [
            { path: `${input.path}/file.ts`, name: "file.ts", type: "file", extension: "ts" },
            { path: `${input.path}/subdir`, name: "subdir", type: "directory" },
          ],
    path: input.path,
    totalEntries: entries.length || 2,
  });
}

/** Mock file list handler. */
export function mockFileListHandler(
  files: FileEntry[] = [],
): AgentHandler<FileListInput, FileListOutput> {
  return async (input) => ({
    files:
      files.length > 0
        ? files
        : [
            {
              path: `${input.directory}/index.ts`,
              name: "index.ts",
              type: "file",
              extension: "ts",
            },
          ],
    directory: input.directory,
    totalFiles: files.length || 1,
  });
}

/** Mock file picker handler. */
export function mockFilePickerHandler(
  picked: string | null = "src/main.ts",
): AgentHandler<FilePickerInput, FilePickerOutput> {
  return async (input) => ({
    pickedPath: picked ?? input.candidates[0] ?? null,
    reasoning: "Best match based on description",
    alternatives: input.candidates.slice(1),
  });
}

/** Mock glob match handler. */
export function mockGlobMatchHandler(): AgentHandler<GlobMatchInput, GlobMatchOutput> {
  return async (input) => {
    // Simple glob simulation: pattern ending in /* matches files in that dir
    const matched: string[] = [];
    const unmatched: string[] = [];
    for (const p of input.paths) {
      const matches = input.patterns.some((pat) => {
        if (pat.endsWith("/**")) {
          return p.startsWith(pat.slice(0, -3));
        }
        if (pat.endsWith("/*")) {
          const dir = pat.slice(0, -2);
          return p.startsWith(dir) && !p.slice(dir.length + 1).includes("/");
        }
        return p === pat || p.endsWith(pat.replace("*", ""));
      });
      (matches ? matched : unmatched).push(p);
    }
    return { matched, unmatched, totalMatched: matched.length };
  };
}

// ── FileExplorerAgentFactory ──────────────────────────────────────────────────

export interface FileExplorerAgents {
  codeSearch: CodeSearchAgent;
  directoryLister: DirectoryListerAgent;
  fileLister: FileListerAgent;
  filePicker: FilePickerAgent;
  globMatcher: GlobMatcherAgent;
}

/** Create file explorer agents. */
export function createFileExplorerAgents(): FileExplorerAgents {
  return {
    codeSearch: new CodeSearchAgent(),
    directoryLister: new DirectoryListerAgent(),
    fileLister: new FileListerAgent(),
    filePicker: new FilePickerAgent(),
    globMatcher: new GlobMatcherAgent(),
  };
}

/** Create mock file explorer agents. */
export function createMockFileExplorerAgents(): FileExplorerAgents {
  const agents = createFileExplorerAgents();
  agents.codeSearch.inject(mockCodeSearchHandler());
  agents.directoryLister.inject(mockDirectoryListHandler());
  agents.fileLister.inject(mockFileListHandler());
  agents.filePicker.inject(mockFilePickerHandler());
  agents.globMatcher.inject(mockGlobMatchHandler());
  return agents;
}
