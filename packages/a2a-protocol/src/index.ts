// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/a2a-protocol — Agent-to-Agent communication protocol.
 *
 * Inspired by Google ADK's A2A implementation.
 * Standardized protocol for agents to discover, delegate to, and
 * collaborate with other agents across process boundaries.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface A2AAgentCard {
  name: string;
  description: string;
  version: string;
  capabilities: string[];
  endpoint: string;
  authentication?: { type: string; credentials?: Record<string, string> };
  inputModes: ("text" | "file" | "data")[];
  outputModes: ("text" | "file" | "data")[];
}

export interface A2ATask {
  id: string;
  agentCard: A2AAgentCard;
  input: A2ATaskInput;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  result?: A2ATaskResult;
  error?: { code: string; message: string };
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface A2ATaskInput {
  type: "text" | "file" | "data";
  content: string;
  mimeType?: string;
  filename?: string;
}

export interface A2ATaskResult {
  type: "text" | "file" | "data";
  content: string;
  mimeType?: string;
  artifacts?: Array<{
    name: string;
    type: string;
    content: string;
  }>;
}

// ── Agent Registry ───────────────────────────────────────────────────────────

export class A2AAgentRegistry {
  private agents: Map<string, A2AAgentCard> = new Map();

  register(card: A2AAgentCard): void {
    this.agents.set(card.name, card);
  }

  unregister(name: string): boolean {
    return this.agents.delete(name);
  }

  getAgent(name: string): A2AAgentCard | undefined {
    return this.agents.get(name);
  }

  listAgents(): A2AAgentCard[] {
    return Array.from(this.agents.values());
  }

  discoverByCapability(capability: string): A2AAgentCard[] {
    return this.listAgents().filter((a) =>
      a.capabilities.includes(capability),
    );
  }

  discoverByInputMode(mode: "text" | "file" | "data"): A2AAgentCard[] {
    return this.listAgents().filter((a) => a.inputModes.includes(mode));
  }
}

// ── Task Manager ─────────────────────────────────────────────────────────────

export type TaskExecutor = (
  input: A2ATaskInput,
  task: A2ATask,
) => Promise<A2ATaskResult>;

export class A2ATaskManager {
  private tasks: Map<string, A2ATask> = new Map();
  private executors: Map<string, TaskExecutor> = new Map();
  private registry: A2AAgentRegistry;

  constructor(registry: A2AAgentRegistry) {
    this.registry = registry;
  }

  registerExecutor(agentName: string, executor: TaskExecutor): void {
    this.executors.set(agentName, executor);
  }

  async createTask(agentName: string, input: A2ATaskInput): Promise<A2ATask> {
    const card = this.registry.getAgent(agentName);
    if (!card) {
      throw new Error(`Agent '${agentName}' not found in registry`);
    }

    const task: A2ATask = {
      id: crypto.randomUUID(),
      agentCard: card,
      input,
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.tasks.set(task.id, task);
    return task;
  }

  async executeTask(taskId: string): Promise<A2ATask> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task '${taskId}' not found`);
    }

    const executor = this.executors.get(task.agentCard.name);
    if (!executor) {
      task.status = "failed";
      task.error = { code: "NO_EXECUTOR", message: "No executor registered for this agent" };
      task.updatedAt = Date.now();
      return task;
    }

    task.status = "running";
    task.updatedAt = Date.now();

    try {
      task.result = await executor(task.input, task);
      task.status = "completed";
    } catch (err) {
      task.status = "failed";
      task.error = {
        code: "EXECUTION_FAILED",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    task.updatedAt = Date.now();
    return task;
  }

  async delegateTask(
    sourceAgent: string,
    targetAgent: string,
    input: A2ATaskInput,
  ): Promise<A2ATask> {
    const task = await this.createTask(targetAgent, input);
    task.metadata = { delegatedFrom: sourceAgent };
    return this.executeTask(task.id);
  }

  getTask(taskId: string): A2ATask | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(status?: A2ATask["status"]): A2ATask[] {
    const all = Array.from(this.tasks.values());
    return status ? all.filter((t) => t.status === status) : all;
  }

  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === "pending" || task.status === "running") {
      task.status = "cancelled";
      task.updatedAt = Date.now();
      return true;
    }
    return false;
  }
}

// ── Client ───────────────────────────────────────────────────────────────────

export class A2AClient {
  private registry: A2AAgentRegistry;
  private taskManager: A2ATaskManager;

  constructor(registry?: A2AAgentRegistry) {
    this.registry = registry ?? new A2AAgentRegistry();
    this.taskManager = new A2ATaskManager(this.registry);
  }

  getRegistry(): A2AAgentRegistry {
    return this.registry;
  }

  getTaskManager(): A2ATaskManager {
    return this.taskManager;
  }

  async discover(agentName: string): Promise<A2AAgentCard | undefined> {
    return this.registry.getAgent(agentName);
  }

  async callAgent(
    agentName: string,
    input: A2ATaskInput,
  ): Promise<A2ATaskResult> {
    const task = await this.taskManager.createTask(agentName, input);
    const result = await this.taskManager.executeTask(task.id);
    if (result.status === "failed") {
      throw new Error(result.error?.message ?? "Task execution failed");
    }
    return result.result!;
  }
}

export default A2AClient;
