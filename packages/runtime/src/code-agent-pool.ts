/**
 * CodeAgentPool — a pool of specialised code-focused execution agents.
 *
 * Agents:
 *   FilePicker  → finds relevant files in a codebase
 *   CodeEditor  → implements precise code changes
 *   Reviewer    → validates changes for correctness
 *   Researcher  → web research for technical questions
 *   Thinker     → deep reasoning with full context (no tools)
 *
 * Each agent is an IExecutionAdapter handling its own task type.
 * All agents share a single ILanguageModel instance.
 */

import * as fs from "fs";
import * as path from "path";
import { IExecutionContext } from "./interfaces/execution.interface";
import { ILanguageModel, ChatMessage } from "./interfaces/language-model.interface";
import { createLanguageModel } from "./language-model";
import { WebSearchEngine } from "./web-search-engine";

// ─── Shared LLM accessor ──────────────────────────────────────────────────────

function defaultLLM(): ILanguageModel {
  return createLanguageModel({ provider: "groq", groqApiKey: process.env.GROQ_API_KEY });
}

// ─── File tree helper ─────────────────────────────────────────────────────────

function buildFileTree(rootDir: string, maxDepth = 4, maxFiles = 200): string {
  const lines: string[] = [];
  let count = 0;

  function walk(dir: string, depth: number, prefix: string): void {
    if (depth > maxDepth || count >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Skip hidden dirs, node_modules, dist
    const filtered = entries.filter((e) => {
      const n = e.name;
      return !n.startsWith(".") && n !== "node_modules" && n !== "dist" && n !== "__pycache__";
    });
    for (const entry of filtered) {
      if (count >= maxFiles) break;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        lines.push(`${prefix}${entry.name}/`);
        walk(fullPath, depth + 1, prefix + "  ");
      } else {
        lines.push(`${prefix}${entry.name}`);
        count++;
      }
    }
  }

  walk(rootDir, 0, "");
  return lines.join("\n");
}

// ─── FilePickerAgent ──────────────────────────────────────────────────────────

/**
 * Finds relevant files in a codebase given a natural-language prompt.
 * Task type: "code_explore"
 * Payload: { prompt: string, rootDir?: string, directories?: string[] }
 */
export class FilePickerAgent {
  private llm: ILanguageModel;

  constructor(llm?: ILanguageModel) {
    this.llm = llm ?? defaultLLM();
  }

  canExecute(taskType: string): boolean {
    return taskType === "code_explore" || taskType === "file_picker";
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(task: any, context: IExecutionContext): Promise<Record<string, unknown>> {
    const payload = task?.payload ?? task ?? {};
    const prompt: string = payload.prompt ?? payload.query ?? "";
    const rootDir: string = payload.rootDir ?? process.cwd();
    const directories: string[] = Array.isArray(payload.directories) ? payload.directories : [];

    context.logger.info(`FilePickerAgent: "${prompt.slice(0, 60)}"`);

    const searchRoot = directories.length > 0
      ? directories.map((d: string) => path.resolve(rootDir, d))
      : [rootDir];

    const treeParts = searchRoot.map((dir) => buildFileTree(dir, 4, 150));
    const treeText = treeParts.join("\n---\n");

    const systemPrompt = `You are an expert at finding relevant files in a codebase.
You have access to the file tree of the project. Your task is to identify which files are most relevant to the given prompt.

File tree:
${treeText}

Respond as JSON with this shape:
{
  "files": [
    { "path": "relative/path/to/file.ts", "reason": "brief explanation" }
  ],
  "summary": "one-sentence summary of what was found"
}

Return at most 12 most relevant files. Paths must be relative to the project root.`;

    try {
      const result = await this.llm.generateObject<{
        files: Array<{ path: string; reason: string }>;
        summary: string;
      }>({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt }
        ],
        schema: {
          type: "object",
          properties: {
            files: {
              type: "array",
              items: {
                type: "object",
                properties: { path: { type: "string" }, reason: { type: "string" } }
              }
            },
            summary: { type: "string" }
          }
        }
      });

      // Read actual file contents for top 5
      const filesWithContent = result.files.slice(0, 5).map((f) => {
        const absPath = path.resolve(rootDir, f.path);
        let content = "";
        try {
          content = fs.readFileSync(absPath, "utf8").slice(0, 3000);
        } catch {
          content = "(file not readable)";
        }
        return { ...f, content };
      });

      return {
        success: true,
        files: result.files,
        filesWithContent,
        summary: result.summary,
        rootDir
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}

// ─── CodeEditorAgent ──────────────────────────────────────────────────────────

/**
 * Implements code changes based on a natural-language request.
 * Task type: "code_edit"
 * Payload: { request: string, filePaths?: string[], rootDir?: string }
 */
export class CodeEditorAgent {
  private llm: ILanguageModel;

  constructor(llm?: ILanguageModel) {
    this.llm = llm ?? defaultLLM();
  }

  canExecute(taskType: string): boolean {
    return taskType === "code_edit" || taskType === "edit";
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(task: any, context: IExecutionContext): Promise<Record<string, unknown>> {
    const payload = task?.payload ?? task ?? {};
    const request: string = payload.request ?? payload.prompt ?? payload.query ?? "";
    const rootDir: string = payload.rootDir ?? process.cwd();
    const filePaths: string[] = Array.isArray(payload.filePaths) ? payload.filePaths : [];

    context.logger.info(`CodeEditorAgent: "${request.slice(0, 60)}"`);

    // Read provided files
    const fileContents: Record<string, string> = {};
    for (const fp of filePaths) {
      try {
        const absPath = path.resolve(rootDir, fp);
        fileContents[fp] = fs.readFileSync(absPath, "utf8");
      } catch {
        fileContents[fp] = "(unreadable)";
      }
    }

    const filesContext = Object.entries(fileContents)
      .map(([fp, content]) => `=== ${fp} ===\n${content.slice(0, 4000)}`)
      .join("\n\n");

    const systemPrompt = `You are an expert code editor. Your task is to implement the requested code changes.

${filesContext ? `Current file contents:\n${filesContext}\n\n` : ""}

Respond as JSON with this shape:
{
  "changes": [
    {
      "path": "relative/path/to/file.ts",
      "operation": "str_replace" | "write_file",
      "oldString": "exact code to replace (for str_replace)",
      "newString": "replacement code",
      "content": "full file content (for write_file only)"
    }
  ],
  "explanation": "brief explanation of changes made"
}

For new files use "write_file". For modifications use "str_replace" with exact matching.
Make ALL changes in one response.`;

    try {
      const result = await this.llm.generateObject<{
        changes: Array<{
          path: string;
          operation: "str_replace" | "write_file";
          oldString?: string;
          newString?: string;
          content?: string;
        }>;
        explanation: string;
      }>({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: request }
        ],
        schema: {
          type: "object",
          properties: {
            changes: { type: "array" },
            explanation: { type: "string" }
          }
        }
      });

      // Apply changes
      const applied: string[] = [];
      const failed: string[] = [];

      for (const change of result.changes) {
        const absPath = path.resolve(rootDir, change.path);
        try {
          fs.mkdirSync(path.dirname(absPath), { recursive: true });
          if (change.operation === "write_file" && change.content) {
            fs.writeFileSync(absPath, change.content, "utf8");
            applied.push(change.path);
          } else if (change.operation === "str_replace" && change.oldString !== undefined) {
            const existing = fs.readFileSync(absPath, "utf8");
            if (!existing.includes(change.oldString)) {
              failed.push(`${change.path}: oldString not found`);
              continue;
            }
            const updated = existing.replace(change.oldString, change.newString ?? "");
            fs.writeFileSync(absPath, updated, "utf8");
            applied.push(change.path);
          }
        } catch (err: any) {
          failed.push(`${change.path}: ${err.message}`);
        }
      }

      return {
        success: failed.length === 0,
        applied,
        failed,
        explanation: result.explanation,
        changesCount: result.changes.length
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}

// ─── CodeReviewerAgent ────────────────────────────────────────────────────────

/**
 * Reviews code changes for correctness, style, and potential issues.
 * Task type: "code_review"
 * Payload: { filePaths?: string[], diff?: string, request?: string, rootDir?: string }
 */
export class CodeReviewerAgent {
  private llm: ILanguageModel;

  constructor(llm?: ILanguageModel) {
    this.llm = llm ?? defaultLLM();
  }

  canExecute(taskType: string): boolean {
    return taskType === "code_review" || taskType === "review";
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(task: any, context: IExecutionContext): Promise<Record<string, unknown>> {
    const payload = task?.payload ?? task ?? {};
    const rootDir: string = payload.rootDir ?? process.cwd();
    const filePaths: string[] = Array.isArray(payload.filePaths) ? payload.filePaths : [];
    const diff: string = payload.diff ?? "";
    const request: string = payload.request ?? payload.query ?? "Review the provided code for issues.";

    context.logger.info(`CodeReviewerAgent: ${filePaths.length} files`);

    const fileContents = filePaths
      .map((fp) => {
        try {
          const content = fs.readFileSync(path.resolve(rootDir, fp), "utf8");
          return `=== ${fp} ===\n${content.slice(0, 5000)}`;
        } catch {
          return `=== ${fp} === (unreadable)`;
        }
      })
      .join("\n\n");

    const context_text = diff
      ? `Diff:\n${diff.slice(0, 8000)}`
      : fileContents
        ? `Files:\n${fileContents}`
        : "No files provided.";

    const systemPrompt = `You are an expert code reviewer. Review the provided code and identify issues.

Focus on:
1. Correctness — logic errors, off-by-one, null dereferences
2. Type safety — missing types, unsafe casts, implicit any
3. Security — input validation, injection vectors, unsafe operations
4. Performance — unnecessary loops, memory leaks, blocking operations
5. Style — naming conventions, code clarity, dead code

Respond as JSON:
{
  "approved": boolean,
  "issues": [
    { "severity": "critical"|"high"|"medium"|"low", "file": "path", "line": "description", "suggestion": "how to fix" }
  ],
  "summary": "one-paragraph review summary"
}`;

    try {
      const result = await this.llm.generateObject<{
        approved: boolean;
        issues: Array<{ severity: string; file: string; line: string; suggestion: string }>;
        summary: string;
      }>({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `${request}\n\n${context_text}` }
        ],
        schema: {
          type: "object",
          properties: {
            approved: { type: "boolean" },
            issues: { type: "array" },
            summary: { type: "string" }
          }
        }
      });

      return {
        success: true,
        approved: result.approved,
        issues: result.issues,
        issueCount: result.issues.length,
        criticalCount: result.issues.filter((i) => i.severity === "critical").length,
        summary: result.summary
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}

// ─── ResearcherAgent ─────────────────────────────────────────────────────────

/**
 * Web researcher agent — finds technical information online.
 * Task type: "research"
 * Payload: { query: string, depth?: "speed"|"balanced"|"quality" }
 */
export class ResearcherAgent {
  private searchEngine: WebSearchEngine;

  constructor(llm?: ILanguageModel) {
    const model = llm ?? defaultLLM();
    this.searchEngine = new WebSearchEngine({
      llm: model,
      tavilyApiKey: process.env.TAVILY_API_KEY,
      maxIterations: 3
    });
  }

  canExecute(taskType: string): boolean {
    return taskType === "research" || taskType === "web_research";
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(task: any, context: IExecutionContext): Promise<Record<string, unknown>> {
    const payload = task?.payload ?? task ?? {};
    const query: string = payload.query ?? payload.prompt ?? "";
    const depth = payload.depth ?? payload.mode ?? "balanced";

    context.logger.info(`ResearcherAgent: "${query.slice(0, 60)}"`);

    try {
      const result = await this.searchEngine.search(query, { mode: depth });
      return {
        success: true,
        answer: result.answer,
        findings: result.findings.slice(0, 8),
        queriesUsed: result.queriesUsed,
        findingsCount: result.findings.length
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}

// ─── ThinkerAgent ─────────────────────────────────────────────────────────────

/**
 * Deep reasoning agent — reasons through a problem using full context.
 * No external tools. Uses extended token budget.
 * Task type: "reason"
 * Payload: { prompt: string, context?: string, history?: ChatMessage[] }
 */
export class ThinkerAgent {
  private llm: ILanguageModel;

  constructor(llm?: ILanguageModel) {
    this.llm = llm ?? defaultLLM();
  }

  canExecute(taskType: string): boolean {
    return taskType === "reason" || taskType === "think";
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(task: any, context: IExecutionContext): Promise<Record<string, unknown>> {
    const payload = task?.payload ?? task ?? {};
    const prompt: string = payload.prompt ?? payload.query ?? "";
    const contextText: string = payload.context ?? "";
    const history: ChatMessage[] = Array.isArray(payload.history) ? payload.history : [];

    context.logger.info(`ThinkerAgent: "${prompt.slice(0, 60)}"`);

    const systemPrompt = `You are a deep reasoning agent. Your task is to think carefully and thoroughly about the problem presented.

Process:
1. Restate the problem in your own words to confirm understanding
2. Identify key constraints and requirements
3. Consider multiple approaches and their trade-offs
4. Select the best approach and explain why
5. Provide a clear, actionable conclusion

${contextText ? `Context provided:\n${contextText}\n\n` : ""}Be thorough. Show your reasoning. Prioritise correctness over brevity.`;

    try {
      const answer = await this.llm.generateText({
        messages: [
          { role: "system", content: systemPrompt },
          ...history.slice(-6),
          { role: "user", content: prompt }
        ],
        maxTokens: 2048,
        temperature: 0.3
      });

      return { success: true, answer, prompt };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}

// ─── CodeAgentPool ────────────────────────────────────────────────────────────

/**
 * Aggregates all code agents into a single pool.
 * Acts as a single IExecutionAdapter that dispatches to the right agent.
 */
export class CodeAgentPool {
  private agents: Array<{
    canExecute(t: string): boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute(task: any, ctx: IExecutionContext): Promise<Record<string, unknown>>;
  }>;

  constructor(llm?: ILanguageModel) {
    const model = llm ?? defaultLLM();
    this.agents = [
      new FilePickerAgent(model),
      new CodeEditorAgent(model),
      new CodeReviewerAgent(model),
      new ResearcherAgent(model),
      new ThinkerAgent(model)
    ];
  }

  canExecute(taskType: string): boolean {
    // "code" is the generic planner-assigned type — route to pool
    if (taskType === "code") return true;
    return this.agents.some((a) => a.canExecute(taskType));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(task: any, context: IExecutionContext): Promise<Record<string, unknown>> {
    const taskType: string = task?.type ?? task?.payload?.type ?? "";
    // Generic "code" type: delegate to the CodeEditorAgent as the general-purpose agent
    const resolvedType = taskType === "code" ? "code_edit" : taskType;
    const agent = this.agents.find((a) => a.canExecute(resolvedType));
    if (!agent) {
      return { success: false, error: `No agent for task type: ${taskType}` };
    }
    return agent.execute({ ...task, type: resolvedType }, context);
  }

  /** All task types handled by this pool */
  static readonly TASK_TYPES = [
    "code",
    "code_explore", "file_picker",
    "code_edit", "edit",
    "code_review", "review",
    "research", "web_research",
    "reason", "think"
  ] as const;
}
