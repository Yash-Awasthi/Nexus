import {
  AgentBase, AgentTask, AgentResult, AgentConfig, MessageBus, StateStore,
} from '@workspace/core';
import * as GH from '@workspace/integrations/dist/github/index.js';

const CONFIG: AgentConfig = {
  id:           'github',
  name:         'GitHub',
  description:  'GitHub repos, PRs, issues, Actions, code management',
  version:      '0.1.0',
  capabilities: ['pr', 'issue', 'commit', 'actions', 'release', 'repo'],
  model:        'claude-opus-4-6',
  systemPrompt: 'You are a GitHub automation agent. Manage repos, PRs, issues, and Actions professionally.',
};

export class GitHubAgent extends AgentBase {
  constructor(bus: MessageBus, state: StateStore) { super(CONFIG, bus, state); }

  protected registerTools(): void {
    this.tools.register({
      name: 'list_issues', description: 'List GitHub issues for a repository.',
      inputSchema: { type: 'object', properties: {
        owner: { type: 'string' }, repo: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
      }, required: ['owner', 'repo'] },
      handler: async (i: unknown) => { const { owner, repo, state = 'open' } = i as { owner: string; repo: string; state?: 'open' | 'closed' | 'all' }; return GH.listIssues(owner, repo, state); },
    });
    this.tools.register({
      name: 'create_issue', description: 'Create a new GitHub issue.',
      inputSchema: { type: 'object', properties: {
        owner: { type: 'string' }, repo: { type: 'string' },
        title: { type: 'string' }, body: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
      }, required: ['owner', 'repo', 'title'] },
      handler: async (i: unknown) => { const { owner, repo, title, body, labels } = i as { owner: string; repo: string; title: string; body?: string; labels?: string[] }; return GH.createIssue(owner, repo, title, body, labels); },
    });
    this.tools.register({
      name: 'close_issue', description: 'Close a GitHub issue.',
      inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, issueNumber: { type: 'number' } }, required: ['owner', 'repo', 'issueNumber'] },
      handler: async (i: unknown) => { const { owner, repo, issueNumber } = i as { owner: string; repo: string; issueNumber: number }; await GH.closeIssue(owner, repo, issueNumber); return { closed: true }; },
    });
    this.tools.register({
      name: 'create_pr', description: 'Create a pull request.',
      inputSchema: { type: 'object', properties: {
        owner: { type: 'string' }, repo: { type: 'string' },
        title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' },
        body: { type: 'string' },
      }, required: ['owner', 'repo', 'title', 'head', 'base'] },
      handler: async (i: unknown) => { const { owner, repo, title, head, base, body } = i as { owner: string; repo: string; title: string; head: string; base: string; body?: string }; return GH.createPR(owner, repo, title, head, base, body); },
    });
    this.tools.register({
      name: 'list_prs', description: 'List pull requests.',
      inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, required: ['owner', 'repo'] },
      handler: async (i: unknown) => { const { owner, repo, state = 'open' } = i as { owner: string; repo: string; state?: 'open' | 'closed' | 'all' }; return GH.listPRs(owner, repo, state); },
    });
    this.tools.register({
      name: 'merge_pr', description: 'Merge a pull request.',
      inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, prNumber: { type: 'number' }, commitTitle: { type: 'string' } }, required: ['owner', 'repo', 'prNumber'] },
      handler: async (i: unknown) => { const { owner, repo, prNumber, commitTitle } = i as { owner: string; repo: string; prNumber: number; commitTitle?: string }; await GH.mergePR(owner, repo, prNumber, commitTitle); return { merged: true }; },
    });
    this.tools.register({
      name: 'trigger_workflow', description: 'Trigger a GitHub Actions workflow.',
      inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, workflowId: { type: 'string' }, ref: { type: 'string' } }, required: ['owner', 'repo', 'workflowId', 'ref'] },
      handler: async (i: unknown) => { const { owner, repo, workflowId, ref } = i as { owner: string; repo: string; workflowId: string; ref: string }; await GH.triggerWorkflow(owner, repo, workflowId, ref); return { triggered: true }; },
    });
    this.tools.register({
      name: 'list_workflow_runs', description: 'List recent CI/CD workflow runs.',
      inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, workflowId: { type: 'string' } }, required: ['owner', 'repo'] },
      handler: async (i: unknown) => { const { owner, repo, workflowId } = i as { owner: string; repo: string; workflowId?: string }; return GH.listWorkflowRuns(owner, repo, workflowId); },
    });
  }

  protected async handle(task: AgentTask): Promise<AgentResult> {
    const start = Date.now();
    const result = await this.runAgentLoop(typeof task.input === 'string' ? task.input : JSON.stringify(task.input));
    return { taskId: task.id, agentId: this.config.id, success: true, output: result, durationMs: Date.now() - start };
  }
}

export function createAgent(bus: MessageBus, state: StateStore): GitHubAgent {
  return new GitHubAgent(bus, state);
}
