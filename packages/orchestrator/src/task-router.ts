import { randomUUID } from 'node:crypto';
import {
  AgentTask, AgentResult, MessageBus, MessagePriority,
} from '@workspace/core';
import { AgentRegistry } from './agent-registry.js';

interface RouteOptions {
  capability:  string;
  taskType:    string;
  input:       unknown;
  context?:    Record<string, unknown>;
  priority?:   MessagePriority;
  timeoutMs?:  number;
}

export class TaskRouter {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly bus:      MessageBus,
  ) {}

  /**
   * Route a task to the first available agent with the matching capability.
   * Waits for the result via the bus request/response pattern.
   */
  async route(opts: RouteOptions): Promise<AgentResult> {
    const agent = this.registry.availableFor(opts.capability);
    if (!agent) {
      throw new Error(
        `TaskRouter: no idle agent with capability "${opts.capability}"`,
      );
    }

    const task: AgentTask = {
      id:       randomUUID(),
      type:     opts.taskType,
      input:    opts.input,
      context:  opts.context,
    };

    return this.bus.request<AgentTask, AgentResult>(
      `agent.${agent.config.id}.task`,
      task,
      opts.timeoutMs ?? 120_000,
    );
  }

  /** Fire-and-forget — publishes task without waiting for result. */
  dispatch(agentId: string, task: Omit<AgentTask, 'id'>): string {
    const id = randomUUID();
    this.bus.publish(
      `agent.${agentId}.task`,
      { ...task, id },
      { priority: MessagePriority.NORMAL },
    );
    return id;
  }
}
