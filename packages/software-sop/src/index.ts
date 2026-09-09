// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/software-sop — SOP-based multi-role software development pipeline.
 *
 * Implements MetaGPT's "Code = SOP(Team)" philosophy: a structured pipeline
 * where Product Manager → Architect → Engineer → QA roles collaborate through
 * standardized handoffs to produce software from a single requirement.
 *
 * Also includes a Plan-and-Act data interpreter pattern and BM25-based
 * tool recommendation engine.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type RoleName =
  "product_manager" | "architect" | "engineer" | "qa_engineer" | "project_manager";

export interface RoleDefinition {
  name: RoleName;
  label: string;
  goal: string;
  constraints: string[];
  outputFormat: string;
}

export interface Handoff {
  from: RoleName;
  to: RoleName;
  artifact: string;
  schema?: Record<string, unknown>;
}

export interface StepResult {
  role: RoleName;
  step: number;
  artifact: string;
  content: string;
  timestamp: string;
  durationMs: number;
}

export interface SopConfig {
  /** LLM function */
  llm: (systemPrompt: string, userPrompt: string) => Promise<string>;
  /** Custom roles (override defaults) */
  roles?: Partial<Record<RoleName, RoleDefinition>>;
  /** Custom handoff chain (override default pipeline) */
  pipeline?: RoleName[];
  /** Max tokens per step */
  maxTokens?: number;
  /** Callback on step completion */
  onStepComplete?: (result: StepResult) => void;
}

// ─── Role Definitions ────────────────────────────────────────────────────────

export const DEFAULT_ROLES: Record<RoleName, RoleDefinition> = {
  product_manager: {
    name: "product_manager",
    label: "Product Manager",
    goal: "Analyze the user requirement and produce a detailed Product Requirements Document (PRD) with user stories, competitive analysis, and clear acceptance criteria.",
    constraints: [
      "Focus on WHAT to build, not HOW",
      "Be specific about acceptance criteria",
      "Consider edge cases and error scenarios",
      "Prioritize features by value",
    ],
    outputFormat:
      "PRD with sections: Overview, User Stories, Acceptance Criteria, Competitive Analysis, Priority Matrix",
  },
  architect: {
    name: "architect",
    label: "System Architect",
    goal: "Design the system architecture, data models, API contracts, and technology choices based on the PRD.",
    constraints: [
      "Design for scalability and maintainability",
      "Prefer established patterns over novel approaches",
      "Define clear API contracts between components",
      "Consider security implications",
    ],
    outputFormat:
      "Architecture doc with: System Overview, Data Models, API Design, Tech Stack, Directory Structure",
  },
  project_manager: {
    name: "project_manager",
    label: "Project Manager",
    goal: "Break the architecture into actionable engineering tasks with clear dependencies and priorities.",
    constraints: [
      "Each task should be completable in one coding session",
      "Identify dependencies between tasks",
      "Prioritize by dependency order (critical path first)",
      "Include test requirements for each task",
    ],
    outputFormat:
      "Task list with: Task ID, Description, Dependencies, Priority, Estimated Complexity",
  },
  engineer: {
    name: "engineer",
    label: "Software Engineer",
    goal: "Implement the code for each task, following the architecture and API contracts defined by the architect.",
    constraints: [
      "Follow the architecture and API contracts exactly",
      "Write clean, well-documented code",
      "Include error handling and edge cases",
      "Write unit tests for each module",
    ],
    outputFormat: "Complete source code files with tests",
  },
  qa_engineer: {
    name: "qa_engineer",
    label: "QA Engineer",
    goal: "Review the implemented code, write integration tests, identify bugs, and verify all acceptance criteria are met.",
    constraints: [
      "Test all acceptance criteria from the PRD",
      "Verify edge cases and error handling",
      "Check security and performance concerns",
      "Provide actionable bug reports",
    ],
    outputFormat:
      "Test results with: Pass/Fail per criterion, Bug reports, Improvement suggestions",
  },
};

export const DEFAULT_PIPELINE: RoleName[] = [
  "product_manager",
  "architect",
  "project_manager",
  "engineer",
  "qa_engineer",
];

// ─── Prompt Templates ────────────────────────────────────────────────────────

function buildSystemPrompt(role: RoleDefinition, context: string): string {
  const constraints = role.constraints.map((c) => `  - ${c}`).join("\n");
  return `You are the ${role.label} in a software development team.

Goal: ${role.goal}

Constraints:
${constraints}

Output Format: ${role.outputFormat}

Previous context from other team members:
${context}

Provide your output as a well-structured document. Be thorough and specific.`;
}

// ─── SOP Pipeline ────────────────────────────────────────────────────────────

/**
 * SOP-based software development pipeline.
 * Orchestrates PM → Architect → PM → Engineer → QA with structured handoffs.
 */
export class SoftwareSopPipeline {
  private config: SopConfig;
  private roles: Record<RoleName, RoleDefinition>;
  private pipeline: RoleName[];
  private history: StepResult[] = [];

  constructor(config: SopConfig) {
    this.config = config;
    this.roles = { ...DEFAULT_ROLES, ...config.roles };
    this.pipeline = config.pipeline ?? DEFAULT_PIPELINE;
  }

  /**
   * Run the full pipeline from a one-line requirement.
   */
  async run(requirement: string): Promise<{
    results: StepResult[];
    artifacts: Record<RoleName, string>;
    finalOutput: string;
  }> {
    this.history = [];
    const artifacts: Partial<Record<RoleName, string>> = {};
    let context = `## User Requirement\n${requirement}`;

    for (let i = 0; i < this.pipeline.length; i++) {
      const roleName = this.pipeline[i];
      const role = this.roles[roleName];

      const result = await this.executeStep(roleName, role, context, i);
      this.history.push(result);
      artifacts[roleName] = result.content;

      // Build context for next step
      context += `\n\n## ${role.label} Output\n${result.content}`;

      this.config.onStepComplete?.(result);
    }

    const lastResult = this.history[this.history.length - 1];

    return {
      results: this.history,
      artifacts: artifacts as Record<RoleName, string>,
      finalOutput: lastResult.content,
    };
  }

  /**
   * Run a single step in the pipeline.
   */
  async runStep(
    requirement: string,
    stepIndex: number,
    previousArtifacts?: Record<string, string>,
  ): Promise<StepResult> {
    const roleName = this.pipeline[stepIndex];
    if (!roleName) throw new Error(`No step at index ${stepIndex}`);

    const role = this.roles[roleName];

    let context = `## User Requirement\n${requirement}`;
    if (previousArtifacts) {
      for (const [key, value] of Object.entries(previousArtifacts)) {
        context += `\n\n## ${key} Output\n${value}`;
      }
    }

    return this.executeStep(roleName, role, context, stepIndex);
  }

  private async executeStep(
    roleName: RoleName,
    role: RoleDefinition,
    context: string,
    step: number,
  ): Promise<StepResult> {
    const systemPrompt = buildSystemPrompt(role, context);
    const userPrompt = `Based on the context provided, produce your ${role.label} output now.`;

    const start = Date.now();
    const content = await this.config.llm(systemPrompt, userPrompt);
    const durationMs = Date.now() - start;

    return {
      role: roleName,
      step,
      artifact: `${role.label}_output`,
      content,
      timestamp: new Date().toISOString(),
      durationMs,
    };
  }

  /** Get the full history of the pipeline run. */
  getHistory(): StepResult[] {
    return [...this.history];
  }
}

// ─── Plan-and-Act Data Interpreter ───────────────────────────────────────────

export interface DataPlan {
  objective: string;
  steps: DataPlanStep[];
}

export interface DataPlanStep {
  id: number;
  description: string;
  tool?: string;
  code?: string;
  status: "pending" | "running" | "completed" | "failed";
  result?: string;
}

export interface DataInterpreterConfig {
  llm: (systemPrompt: string, userPrompt: string) => Promise<string>;
  /** Execute code (sandboxed) */
  executeCode: (code: string) => Promise<{ output: string; error?: string }>;
  /** Available tools */
  tools?: string[];
  /** Max react loops (default: 10) */
  maxLoops?: number;
  /** Mode: "plan_and_act" or "react" */
  mode?: "plan_and_act" | "react";
}

/**
 * Data Interpreter — plan-and-act pattern for data analysis.
 * Creates a plan, then executes each step, reflecting on results.
 */
export class DataInterpreter {
  private config: DataInterpreterConfig;
  private workingMemory: string[] = [];

  constructor(config: DataInterpreterConfig) {
    this.config = { maxLoops: 10, mode: "plan_and_act", ...config };
  }

  /**
   * Run the interpreter on a user requirement.
   */
  async run(requirement: string): Promise<{
    plan: DataPlan;
    results: DataPlanStep[];
    output: string;
  }> {
    // Step 1: Create plan
    const plan = await this.createPlan(requirement);
    const results: DataPlanStep[] = [];

    // Step 2: Execute plan steps
    for (const step of plan.steps) {
      step.status = "running";

      try {
        if (step.code) {
          // Execute the code
          const execResult = await this.config.executeCode(step.code);
          if (execResult.error) {
            step.status = "failed";
            step.result = execResult.error;

            // Try to fix
            const fixed = await this.fixCode(step.code, execResult.error, requirement);
            if (fixed) {
              const retryResult = await this.config.executeCode(fixed);
              if (!retryResult.error) {
                step.code = fixed;
                step.status = "completed";
                step.result = retryResult.output;
              }
            }
          } else {
            step.status = "completed";
            step.result = execResult.output;
          }
        } else {
          step.status = "completed";
          step.result = "No code to execute";
        }
      } catch (err) {
        step.status = "failed";
        step.result = err instanceof Error ? err.message : String(err);
      }

      results.push({ ...step });
      this.workingMemory.push(`Step ${step.id}: ${step.description} → ${step.status}`);

      // Reflection check (react mode)
      if (this.config.mode === "react") {
        const shouldContinue = await this.reflect(requirement, results);
        if (!shouldContinue) break;
      }
    }

    // Step 3: Synthesize final output
    const output = await this.synthesize(requirement, results);

    return { plan, results, output };
  }

  private async createPlan(requirement: string): Promise<DataPlan> {
    const toolHint = this.config.tools?.length
      ? `\nAvailable tools: ${this.config.tools.join(", ")}`
      : "";

    const prompt = `Create a step-by-step plan to fulfill this data analysis requirement.

Requirement: ${requirement}
${toolHint}

Respond in JSON format:
{
  "objective": "one-line summary of the goal",
  "steps": [
    {"id": 1, "description": "step description", "tool": "optional tool name"}
  ]
}`;

    const response = await this.config.llm("You are a data analysis planner.", prompt);

    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const steps: DataPlanStep[] = (parsed.steps ?? []).map(
          (s: { id: number; description: string; tool?: string }) => ({
            ...s,
            status: "pending" as const,
          }),
        );
        return { objective: parsed.objective ?? requirement, steps };
      }
    } catch {
      // Fall through
    }

    return {
      objective: requirement,
      steps: [{ id: 1, description: requirement, status: "pending" }],
    };
  }

  private async fixCode(code: string, error: string, requirement: string): Promise<string | null> {
    const prompt = `The following code produced an error. Fix it.

Requirement: ${requirement}

Code:
${code}

Error:
${error}

Provide the fixed code only, no explanation.`;

    const response = await this.config.llm(
      "You are a Python code fixer. Return only the fixed code.",
      prompt,
    );

    const codeMatch = response.match(/```(?:python)?\n([\s\S]*?)```/);
    return codeMatch ? codeMatch[1].trim() : null;
  }

  private async reflect(requirement: string, results: DataPlanStep[]): Promise<boolean> {
    const summary = results.map((r) => `Step ${r.id}: ${r.description} → ${r.status}`).join("\n");

    const prompt = `User requirement: ${requirement}

Progress:
${summary}

Thoughts on current situation. Should we continue or is the requirement fulfilled?
Respond with JSON: {"thoughts": "...", "state": true/false}`;

    const response = await this.config.llm("You are a reflective agent.", prompt);

    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        this.workingMemory.push(parsed.thoughts);
        return parsed.state === true;
      }
    } catch {
      // Continue by default
    }

    return true;
  }

  private async synthesize(requirement: string, results: DataPlanStep[]): Promise<string> {
    const summary = results
      .map(
        (r) =>
          `### Step ${r.id}: ${r.description}\nStatus: ${r.status}\nResult:\n${r.result ?? "N/A"}`,
      )
      .join("\n\n");

    const prompt = `Based on the analysis results below, provide a comprehensive summary answering the user's requirement.

Requirement: ${requirement}

Results:
${summary}

Provide a clear, well-structured summary.`;

    return this.config.llm("You are a data analysis summarizer.", prompt);
  }
}

// ─── BM25 Tool Recommender ───────────────────────────────────────────────────

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  /** Tags/categories */
  tags?: string[];
}

/**
 * BM25-based tool recommendation engine.
 * Recommends the most relevant tools for a given task description.
 */
export class Bm25ToolRecommender {
  private tools: ToolDefinition[];
  private avgDocLength: number;
  private docFreqs: Map<string, number> = new Map();
  private docLengths: number[] = [];
  private k1 = 1.5;
  private b = 0.75;

  constructor(tools: ToolDefinition[]) {
    this.tools = tools;
    this.docLengths = tools.map(
      (t) => this.tokenize(t.description + " " + (t.tags?.join(" ") ?? "")).length,
    );
    this.avgDocLength = this.docLengths.reduce((s, l) => s + l, 0) / this.docLengths.length;

    // Build document frequency map
    for (const tool of tools) {
      const tokens = new Set(this.tokenize(tool.description + " " + (tool.tags?.join(" ") ?? "")));
      for (const token of tokens) {
        this.docFreqs.set(token, (this.docFreqs.get(token) ?? 0) + 1);
      }
    }
  }

  /**
   * Recommend the top-K most relevant tools for a query.
   */
  recommend(query: string, topK = 5): Array<{ tool: ToolDefinition; score: number }> {
    const queryTokens = this.tokenize(query);
    const N = this.tools.length;

    const scored = this.tools.map((tool, i) => {
      const docTokens = this.tokenize(tool.description + " " + (tool.tags?.join(" ") ?? ""));
      const docLen = this.docLengths[i];
      let score = 0;

      for (const qt of queryTokens) {
        const tf = docTokens.filter((t) => t === qt).length;
        const df = this.docFreqs.get(qt) ?? 0;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
        const tfNorm =
          (tf * (this.k1 + 1)) /
          (tf + this.k1 * (1 - this.b + (this.b * docLen) / this.avgDocLength));
        score += idf * tfNorm;
      }

      return { tool, score };
    });

    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /** Add a tool dynamically. */
  addTool(tool: ToolDefinition): void {
    this.tools.push(tool);
    const tokens = this.tokenize(tool.description + " " + (tool.tags?.join(" ") ?? ""));
    this.docLengths.push(tokens.length);
    this.avgDocLength = this.docLengths.reduce((s, l) => s + l, 0) / this.docLengths.length;
    const uniqueTokens = new Set(tokens);
    for (const token of uniqueTokens) {
      this.docFreqs.set(token, (this.docFreqs.get(token) ?? 0) + 1);
    }
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1);
  }
}
