import { AgentBase, AgentTask, AgentResult, AgentConfig, MessageBus, StateStore } from '@workspace/core';
import * as Doppler from '@workspace/integrations/dist/doppler/index.js';

const CONFIG: AgentConfig = {
  id: 'secrets', name: 'Secrets', description: 'Doppler secrets management and env rotation',
  version: '0.1.0', capabilities: ['get', 'set', 'rotate', 'audit', 'sync', 'secrets'],
  model: 'claude-opus-4-6',
  systemPrompt: 'You are a secrets management agent using Doppler. Never expose secret values in logs or outputs. Only confirm operations were completed.',
};

export class SecretsAgent extends AgentBase {
  constructor(bus: MessageBus, state: StateStore) { super(CONFIG, bus, state); }

  protected registerTools(): void {
    this.tools.register({
      name: 'list_projects', description: 'List Doppler projects.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => Doppler.listProjects(),
    });
    this.tools.register({
      name: 'list_secrets', description: 'List secret names (not values) in a Doppler config.',
      inputSchema: { type: 'object', properties: { project: { type: 'string' }, config: { type: 'string' } }, required: ['project', 'config'] },
      handler: async (i: unknown) => { const { project, config } = i as { project: string; config: string }; return Doppler.listSecrets(project, config); },
    });
    this.tools.register({
      name: 'set_secret', description: 'Set a secret value in Doppler.',
      inputSchema: { type: 'object', properties: { project: { type: 'string' }, config: { type: 'string' }, name: { type: 'string' }, value: { type: 'string' } }, required: ['project', 'config', 'name', 'value'] },
      handler: async (i: unknown) => { const { project, config, name, value } = i as { project: string; config: string; name: string; value: string }; await Doppler.setSecret(project, config, name, value); return { set: true, name }; },
    });
    this.tools.register({
      name: 'delete_secret', description: 'Delete a secret from Doppler.',
      inputSchema: { type: 'object', properties: { project: { type: 'string' }, config: { type: 'string' }, name: { type: 'string' } }, required: ['project', 'config', 'name'] },
      handler: async (i: unknown) => { const { project, config, name } = i as { project: string; config: string; name: string }; await Doppler.deleteSecret(project, config, name); return { deleted: true }; },
    });
    this.tools.register({
      name: 'sync_secrets', description: 'Download all secrets for a Doppler config to sync to a service.',
      inputSchema: { type: 'object', properties: { project: { type: 'string' }, config: { type: 'string' } }, required: ['project', 'config'] },
      handler: async (i: unknown) => {
        const { project, config } = i as { project: string; config: string };
        const secrets = await Doppler.downloadSecrets(project, config);
        return { keys: Object.keys(secrets), count: Object.keys(secrets).length };
      },
    });
  }

  protected async handle(task: AgentTask): Promise<AgentResult> {
    const start = Date.now();
    const result = await this.runAgentLoop(typeof task.input === 'string' ? task.input : JSON.stringify(task.input));
    return { taskId: task.id, agentId: this.config.id, success: true, output: result, durationMs: Date.now() - start };
  }
}

export function createAgent(bus: MessageBus, state: StateStore): SecretsAgent {
  return new SecretsAgent(bus, state);
}
