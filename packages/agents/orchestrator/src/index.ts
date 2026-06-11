/**
 * Agent-17: Orchestrator Agent
 * ────────────────────────────
 * LLM-backed routing agent (different from the Orchestrator class).
 * Receives high-level tasks and routes sub-tasks to appropriate agents via the bus.
 * Uses Claude's reasoning to decompose complex multi-step workflows.
 */
import {
  AgentBase, AgentTask, AgentResult, AgentConfig,
  MessageBus, StateStore, ToolDefinition,
} from '@workspace/core';

const AGENT_REGISTRY_MAP: Record<string, string> = {
  researcher:   'Web research, search, deep research',
  coder:        'Code generation, review, debug, refactor',
  github:       'GitHub issues, PRs, workflows, repositories',
  slack:        'Slack messages, channels, threads',
  linear:       'Linear issues, projects, cycles',
  deploy:       'Vercel deployments, Cloudflare DNS, environments',
  database:     'Database queries, migrations, Neon, Supabase',
  secrets:      'Doppler secrets, environment variables',
  email:        'Gmail — send, reply, search, archive',
  calendar:     'Google Calendar — events, scheduling, availability',
  drive:        'Google Drive — files, upload, download, share',
  content:      'Content drafting, editing, publishing',
  analyst:      'Data analysis, insights, reports, summaries',
  monitor:      'Better Stack uptime, incidents, health',
  scheduler:    'Scheduled tasks, reminders, crons',
  memory:       'Long-term memory — store, recall, search',
};

const CONFIG: AgentConfig = {
  id:           'orchestrator',
  name:         'Orchestrator Agent',
  description:  'LLM-based task decomposition and multi-agent workflow routing',
  version:      '1.0.0',
  capabilities: ['decompose','route','coordinate','plan_workflow','delegate'],
  model:        'claude-opus-4-6',
  systemPrompt: [
    'You are the Orchestrator Agent. You decompose complex tasks into sub-tasks and delegate to specialist agents.',
    `Available agents and their capabilities: ${JSON.stringify(AGENT_REGISTRY_MAP)}`,
    'When given a task: 1) Identify which agents are needed. 2) Decompose into ordered sub-tasks.',
    '3) Route each sub-task to the correct agent using delegate_to_agent.',
    '4) Aggregate results and return a coherent response.',
    'Prefer parallel execution where sub-tasks are independent.',
    'Never do work yourself that a specialist agent should do.',
  ].join(' '),
};

export class OrchestratorAgent extends AgentBase {
  constructor(bus: MessageBus, state: StateStore) {
    super(CONFIG, bus, state);
  }

  protected registerTools(): void {
    const tools: ToolDefinition[] = [
      {
        name:        'delegate_to_agent',
        description: 'Delegate a sub-task to a specific agent via the message bus',
        inputSchema: {
          type: 'object',
          required: ['agentId', 'taskInput'],
          properties: {
            agentId:     { type: 'string', description: 'Target agent ID', enum: Object.keys(AGENT_REGISTRY_MAP) },
            taskInput:   { type: 'string', description: 'Task input/prompt for the agent' },
            priority:    { type: 'string', enum: ['critical','high','normal','low'], description: 'Task priority' },
            timeoutMs:   { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
          },
        },
        handler: async ({ agentId, taskInput, priority = 'normal', timeoutMs = 30000 }:
          { agentId: string; taskInput: string; priority?: string; timeoutMs?: number }) => {
          try {
            const result = await this.bus.request(
              `agent.${agentId}.task`,
              {
                type:    'TASK',
                from:    this.config.id,
                to:      agentId,
                payload: { input: taskInput, priority },
              },
              timeoutMs
            );
            return { agentId, success: true, result };
          } catch (err) {
            return { agentId, success: false, error: String(err) };
          }
        },
      },
      {
        name:        'list_available_agents',
        description: 'List all available agents and their capabilities',
        inputSchema: {
          type: 'object',
          properties: {},
        },
        handler: async () => AGENT_REGISTRY_MAP,
      },
      {
        name:        'plan_workflow',
        description: 'Decompose a complex task into an ordered list of agent sub-tasks',
        inputSchema: {
          type: 'object',
          required: ['task'],
          properties: {
            task: { type: 'string', description: 'Complex task to decompose' },
          },
        },
        handler: async ({ task }: { task: string }) => {
          // This gets processed by the LLM in the tool-use loop
          return {
            task,
            agents: AGENT_REGISTRY_MAP,
            instruction: 'Analyze this task and produce an ordered execution plan with agent assignments.',
          };
        },
      },
    ];

    for (const t of tools) this.toolRegistry.register(t);
  }

  protected async handle(task: AgentTask): Promise<AgentResult> {
    const start = Date.now();
    const result = await this.runAgentLoop(task.input as string);
    return {
      taskId:     task.id,
      agentId:    this.config.id,
      success:    true,
      output:     result,
      durationMs: Date.now() - start,
    };
  }
}

export function createAgent(bus: MessageBus, state: StateStore): OrchestratorAgent {
  return new OrchestratorAgent(bus, state);
}
