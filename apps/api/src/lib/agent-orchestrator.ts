// SPDX-License-Identifier: Apache-2.0
/**
 * Agent Orchestrator — manages multi-agent workflows.
 *
 * Features:
 * - Task decomposition (break complex tasks into subtasks)
 * - Agent role assignment (researcher, coder, reviewer, planner)
 * - Parallel subtask execution
 * - Result aggregation and synthesis
 * - Error recovery and retry
 * - Token budget management across agents
 */

export type AgentRole =
  | "planner" // decomposes tasks, creates plans
  | "researcher" // gathers information, analyzes data
  | "coder" // writes code, implements features
  | "reviewer" // reviews code, finds issues
  | "synthesizer" // combines results into final output
  | "critic"; // challenges assumptions, finds flaws

export interface AgentTask {
  id: string;
  description: string;
  role: AgentRole;
  dependencies: string[]; // task IDs that must complete first
  status: TaskStatus;
  result?: string;
  error?: string;
  tokenBudget: number;
  tokensUsed: number;
  retries: number;
  maxRetries: number;
  createdAt: number;
  completedAt?: number;
}

export type TaskStatus = "pending" | "ready" | "running" | "completed" | "failed" | "retrying";

export interface WorkflowPlan {
  id: string;
  goal: string;
  tasks: AgentTask[];
  totalTokenBudget: number;
  tokensUsed: number;
  status: "planning" | "executing" | "completed" | "failed";
  createdAt: number;
  completedAt?: number;
}

export class AgentOrchestrator {
  private workflows = new Map<string, WorkflowPlan>();
  private activeTasks = new Map<string, AgentTask>();

  /**
   * Create a workflow plan from a high-level goal.
   */
  async planWorkflow(goal: string, tokenBudget = 100_000): Promise<WorkflowPlan> {
    const tasks = this.decomposeTask(goal);

    const plan: WorkflowPlan = {
      id: `wf-${Date.now()}`,
      goal,
      tasks,
      totalTokenBudget: tokenBudget,
      tokensUsed: 0,
      status: "planning",
      createdAt: Date.now(),
    };

    this.workflows.set(plan.id, plan);
    return plan;
  }

  /**
   * Execute a workflow plan.
   */
  async executeWorkflow(planId: string): Promise<WorkflowPlan> {
    const plan = this.workflows.get(planId);
    if (!plan) throw new Error(`Workflow ${planId} not found`);

    plan.status = "executing";

    // Execute tasks in dependency order
    while (true) {
      const readyTasks = plan.tasks.filter(
        (t) => t.status === "pending" && this.allDependenciesMet(t, plan.tasks),
      );

      if (readyTasks.length === 0) {
        const runningTasks = plan.tasks.filter(
          (t) => t.status === "running" || t.status === "retrying",
        );
        if (runningTasks.length === 0) break; // all done or all failed
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }

      // Execute ready tasks in parallel
      const promises = readyTasks.map((task) => this.executeTask(task, plan));
      await Promise.allSettled(promises);
    }

    // Check final status
    const failed = plan.tasks.filter((t) => t.status === "failed");
    plan.status = failed.length > 0 ? "failed" : "completed";
    plan.completedAt = Date.now();

    return plan;
  }

  /**
   * Get workflow status.
   */
  getWorkflowStatus(planId: string): WorkflowPlan | undefined {
    return this.workflows.get(planId);
  }

  /**
   * Decompose a goal into subtasks.
   */
  private decomposeTask(goal: string): AgentTask[] {
    const tasks: AgentTask[] = [];
    let taskId = 0;

    // Phase 1: Planning
    tasks.push({
      id: `t-${++taskId}`,
      description: `Analyze the goal and create a detailed plan: "${goal}"`,
      role: "planner",
      dependencies: [],
      status: "pending",
      tokenBudget: 5000,
      tokensUsed: 0,
      retries: 0,
      maxRetries: 2,
      createdAt: Date.now(),
    });

    // Phase 2: Research
    tasks.push({
      id: `t-${++taskId}`,
      description: `Research existing solutions and gather context for: "${goal}"`,
      role: "researcher",
      dependencies: ["t-1"],
      status: "pending",
      tokenBudget: 15000,
      tokensUsed: 0,
      retries: 0,
      maxRetries: 2,
      createdAt: Date.now(),
    });

    // Phase 3: Implementation
    tasks.push({
      id: `t-${++taskId}`,
      description: `Implement the solution based on the plan and research`,
      role: "coder",
      dependencies: ["t-1", "t-2"],
      status: "pending",
      tokenBudget: 30000,
      tokensUsed: 0,
      retries: 0,
      maxRetries: 3,
      createdAt: Date.now(),
    });

    // Phase 4: Review
    tasks.push({
      id: `t-${++taskId}`,
      description: `Review the implementation for issues and improvements`,
      role: "reviewer",
      dependencies: ["t-3"],
      status: "pending",
      tokenBudget: 10000,
      tokensUsed: 0,
      retries: 0,
      maxRetries: 2,
      createdAt: Date.now(),
    });

    // Phase 5: Critique
    tasks.push({
      id: `t-${++taskId}`,
      description: `Critically evaluate the solution against edge cases`,
      role: "critic",
      dependencies: ["t-4"],
      status: "pending",
      tokenBudget: 10000,
      tokensUsed: 0,
      retries: 0,
      maxRetries: 1,
      createdAt: Date.now(),
    });

    // Phase 6: Synthesis
    tasks.push({
      id: `t-${++taskId}`,
      description: `Synthesize all results into a final deliverable`,
      role: "synthesizer",
      dependencies: ["t-3", "t-4", "t-5"],
      status: "pending",
      tokenBudget: 10000,
      tokensUsed: 0,
      retries: 0,
      maxRetries: 1,
      createdAt: Date.now(),
    });

    return tasks;
  }

  private allDependenciesMet(task: AgentTask, allTasks: AgentTask[]): boolean {
    return task.dependencies.every((depId) => {
      const dep = allTasks.find((t) => t.id === depId);
      return dep?.status === "completed";
    });
  }

  private async executeTask(task: AgentTask, plan: WorkflowPlan): Promise<void> {
    task.status = "running";
    this.activeTasks.set(task.id, task);

    try {
      // Simulate execution (in production, this calls LLM)
      const tokens = Math.min(task.tokenBudget, 5000 + Math.random() * 5000);
      await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 200));

      task.result = `[${task.role}] Completed: ${task.description.substring(0, 100)}...`;
      task.tokensUsed = Math.round(tokens);
      task.status = "completed";
      task.completedAt = Date.now();
      plan.tokensUsed += task.tokensUsed;
    } catch (e) {
      task.error = (e as Error).message || "Unknown error";

      if (task.retries < task.maxRetries) {
        task.retries++;
        task.status = "retrying";
        await new Promise((resolve) => setTimeout(resolve, 1000));
        task.status = "pending"; // will be retried in next loop
      } else {
        task.status = "failed";
      }
    } finally {
      this.activeTasks.delete(task.id);
    }
  }

  /**
   * Get role-specific prompt for an agent.
   */
  static getRolePrompt(role: AgentRole): string {
    const prompts: Record<AgentRole, string> = {
      planner:
        "You are a strategic planner. Break down complex goals into actionable steps. Identify dependencies, risks, and success criteria. Be specific and practical.",
      researcher:
        "You are a thorough researcher. Gather relevant information, analyze existing solutions, and provide evidence-based recommendations. Cite sources when possible.",
      coder:
        "You are an expert programmer. Write clean, efficient, well-documented code. Follow best practices and handle edge cases. Include error handling.",
      reviewer:
        "You are a meticulous code reviewer. Find bugs, security issues, performance problems, and style violations. Be constructive but thorough.",
      synthesizer:
        "You are a synthesizer. Combine inputs from multiple sources into a coherent, complete deliverable. Remove redundancy, resolve conflicts, and ensure consistency.",
      critic:
        "You are a constructive critic. Challenge assumptions, identify weaknesses, and suggest improvements. Think about edge cases, scalability, and maintainability.",
    };
    return prompts[role];
  }
}
