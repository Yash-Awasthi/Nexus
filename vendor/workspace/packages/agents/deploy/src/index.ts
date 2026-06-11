import { AgentBase, AgentTask, AgentResult, AgentConfig, MessageBus, StateStore } from '@workspace/core';
import * as VCL from '@workspace/integrations/dist/vercel/index.js';
import * as CF  from '@workspace/integrations/dist/cloudflare/index.js';

const CONFIG: AgentConfig = {
  id: 'deploy', name: 'Deploy', description: 'Vercel and Cloudflare deployments, DNS, Workers',
  version: '0.1.0', capabilities: ['deploy', 'rollback', 'dns', 'worker', 'edge', 'cdn'],
  model: 'claude-opus-4-6',
  systemPrompt: 'You are a deployment agent managing Vercel and Cloudflare. Handle deployments, DNS, and edge workers safely.',
};

export class DeployAgent extends AgentBase {
  constructor(bus: MessageBus, state: StateStore) { super(CONFIG, bus, state); }

  protected registerTools(): void {
    this.tools.register({
      name: 'list_projects', description: 'List all Vercel projects.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => VCL.listProjects(),
    });
    this.tools.register({
      name: 'list_deployments', description: 'List recent Vercel deployments.',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' } } },
      handler: async (i: unknown) => { const { projectId } = i as { projectId?: string }; return VCL.listDeployments(projectId); },
    });
    this.tools.register({
      name: 'get_deployment', description: 'Get details of a specific deployment.',
      inputSchema: { type: 'object', properties: { deploymentId: { type: 'string' } }, required: ['deploymentId'] },
      handler: async (i: unknown) => { const { deploymentId } = i as { deploymentId: string }; return VCL.getDeployment(deploymentId); },
    });
    this.tools.register({
      name: 'cancel_deployment', description: 'Cancel an in-progress Vercel deployment.',
      inputSchema: { type: 'object', properties: { deploymentId: { type: 'string' } }, required: ['deploymentId'] },
      handler: async (i: unknown) => { const { deploymentId } = i as { deploymentId: string }; await VCL.cancelDeployment(deploymentId); return { cancelled: true }; },
    });
    this.tools.register({
      name: 'set_env_var', description: 'Set an environment variable on a Vercel project.',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, key: { type: 'string' }, value: { type: 'string' } }, required: ['projectId', 'key', 'value'] },
      handler: async (i: unknown) => { const { projectId, key, value } = i as { projectId: string; key: string; value: string }; await VCL.setEnvVar(projectId, key, value); return { set: true }; },
    });
    this.tools.register({
      name: 'list_cf_zones', description: 'List Cloudflare zones (domains).',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => CF.listZones(),
    });
    this.tools.register({
      name: 'list_dns_records', description: 'List DNS records for a Cloudflare zone.',
      inputSchema: { type: 'object', properties: { zoneId: { type: 'string' } }, required: ['zoneId'] },
      handler: async (i: unknown) => { const { zoneId } = i as { zoneId: string }; return CF.listDnsRecords(zoneId); },
    });
    this.tools.register({
      name: 'create_dns_record', description: 'Create a DNS record in Cloudflare.',
      inputSchema: { type: 'object', properties: { zoneId: { type: 'string' }, type: { type: 'string' }, name: { type: 'string' }, content: { type: 'string' } }, required: ['zoneId', 'type', 'name', 'content'] },
      handler: async (i: unknown) => { const { zoneId, type, name, content } = i as { zoneId: string; type: string; name: string; content: string }; return CF.createDnsRecord(zoneId, type, name, content); },
    });
    this.tools.register({
      name: 'purge_cf_cache', description: 'Purge Cloudflare cache for a zone.',
      inputSchema: { type: 'object', properties: { zoneId: { type: 'string' }, urls: { type: 'array', items: { type: 'string' } } }, required: ['zoneId'] },
      handler: async (i: unknown) => { const { zoneId, urls } = i as { zoneId: string; urls?: string[] }; await CF.purgeCache(zoneId, urls); return { purged: true }; },
    });
  }

  protected async handle(task: AgentTask): Promise<AgentResult> {
    const start = Date.now();
    const result = await this.runAgentLoop(typeof task.input === 'string' ? task.input : JSON.stringify(task.input));
    return { taskId: task.id, agentId: this.config.id, success: true, output: result, durationMs: Date.now() - start };
  }
}

export function createAgent(bus: MessageBus, state: StateStore): DeployAgent {
  return new DeployAgent(bus, state);
}
