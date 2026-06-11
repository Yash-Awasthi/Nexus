import { AgentBase, AgentTask, AgentResult, AgentConfig, MessageBus, StateStore } from '@workspace/core';
import * as LIN from '@workspace/integrations/dist/linear/index.js';

const CONFIG: AgentConfig = {
  id: 'linear', name: 'Linear', description: 'Linear project tracking, sprints, issues, milestones',
  version: '0.1.0', capabilities: ['issue', 'sprint', 'milestone', 'roadmap', 'assign', 'project'],
  model: 'claude-opus-4-6',
  systemPrompt: 'You are a project management agent using Linear. Create and manage issues, sprints, and roadmaps effectively.',
};

export class LinearAgent extends AgentBase {
  constructor(bus: MessageBus, state: StateStore) { super(CONFIG, bus, state); }

  protected registerTools(): void {
    this.tools.register({
      name: 'list_issues', description: 'List Linear issues. Filter by team or state.',
      inputSchema: { type: 'object', properties: { teamId: { type: 'string' }, state: { type: 'string', description: 'e.g. Todo, In Progress, Done' } } },
      handler: async (i: unknown) => { const { teamId, state } = i as { teamId?: string; state?: string }; return LIN.listIssues(teamId, state); },
    });
    this.tools.register({
      name: 'create_issue', description: 'Create a new Linear issue.',
      inputSchema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, teamId: { type: 'string' }, priority: { type: 'number', description: '0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low' } }, required: ['title'] },
      handler: async (i: unknown) => { const { title, description, teamId, priority } = i as { title: string; description?: string; teamId?: string; priority?: number }; return LIN.createIssue(title, description, teamId, priority); },
    });
    this.tools.register({
      name: 'update_issue', description: 'Update a Linear issue status, priority or description.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, priority: { type: 'number' } }, required: ['id'] },
      handler: async (i: unknown) => { const { id, ...updates } = i as { id: string; title?: string; description?: string; priority?: number }; await LIN.updateIssue(id, updates); return { updated: true }; },
    });
    this.tools.register({
      name: 'list_teams', description: 'List all Linear teams.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => LIN.listTeams(),
    });
    this.tools.register({
      name: 'list_cycles', description: 'List sprints/cycles for a team.',
      inputSchema: { type: 'object', properties: { teamId: { type: 'string' } }, required: ['teamId'] },
      handler: async (i: unknown) => { const { teamId } = i as { teamId: string }; return LIN.listCycles(teamId); },
    });
  }

  protected async handle(task: AgentTask): Promise<AgentResult> {
    const start = Date.now();
    const result = await this.runAgentLoop(typeof task.input === 'string' ? task.input : JSON.stringify(task.input));
    return { taskId: task.id, agentId: this.config.id, success: true, output: result, durationMs: Date.now() - start };
  }
}

export function createAgent(bus: MessageBus, state: StateStore): LinearAgent {
  return new LinearAgent(bus, state);
}
