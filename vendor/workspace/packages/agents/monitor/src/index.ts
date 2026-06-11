/**
 * Agent-14: Monitor
 * ─────────────────
 * Infrastructure and uptime monitoring via Better Stack.
 * Tracks monitors, incidents, logs, and alerts.
 */
import {
  AgentBase, AgentTask, AgentResult, AgentConfig,
  MessageBus, StateStore, ToolDefinition,
} from '@workspace/core';
import * as BetterStack from '@workspace/integrations/betterstack';

const CONFIG: AgentConfig = {
  id:           'monitor',
  name:         'Monitor Agent',
  description:  'Infrastructure monitoring — uptime, incidents, alerts via Better Stack',
  version:      '1.0.0',
  capabilities: ['check_uptime','list_incidents','create_monitor','send_log','get_status'],
  model:        'claude-opus-4-6',
  systemPrompt: [
    'You are the Monitor Agent. You track infrastructure health and incidents.',
    'Always check current monitor status before creating new monitors.',
    'Classify incidents by severity: P0 (down), P1 (degraded), P2 (warning).',
    'When sending logs, always include structured metadata: service, environment, level.',
    'Escalate P0 incidents immediately via the bus to the yash agent.',
  ].join(' '),
};

export class MonitorAgent extends AgentBase {
  constructor(bus: MessageBus, state: StateStore) {
    super(CONFIG, bus, state);
  }

  protected registerTools(): void {
    const tools: ToolDefinition[] = [
      {
        name:        'list_monitors',
        description: 'List all uptime monitors in Better Stack',
        inputSchema: {
          type: 'object',
          properties: {
            page: { type: 'number', description: 'Page number (default: 1)' },
          },
        },
        handler: async ({ page = 1 }: { page?: number }) => {
          return BetterStack.listMonitors(page);
        },
      },
      {
        name:        'get_monitor',
        description: 'Get details and current status of a specific monitor',
        inputSchema: {
          type: 'object',
          required: ['monitorId'],
          properties: {
            monitorId: { type: 'string', description: 'Better Stack monitor ID' },
          },
        },
        handler: async ({ monitorId }: { monitorId: string }) => {
          return BetterStack.getMonitor(monitorId);
        },
      },
      {
        name:        'list_incidents',
        description: 'List recent incidents from Better Stack',
        inputSchema: {
          type: 'object',
          properties: {
            page:   { type: 'number', description: 'Page number (default: 1)' },
            status: { type: 'string', enum: ['ongoing', 'resolved'], description: 'Filter by status' },
          },
        },
        handler: async ({ page = 1, status }: { page?: number; status?: string }) => {
          return BetterStack.listIncidents(page, status);
        },
      },
      {
        name:        'create_monitor',
        description: 'Create a new uptime monitor in Better Stack',
        inputSchema: {
          type: 'object',
          required: ['url', 'name'],
          properties: {
            url:              { type: 'string', description: 'URL or endpoint to monitor' },
            name:             { type: 'string', description: 'Display name for the monitor' },
            checkFrequency:   { type: 'number', description: 'Check interval in seconds (default: 60)' },
            requestTimeout:   { type: 'number', description: 'Request timeout in seconds (default: 30)' },
            expectedStatus:   { type: 'number', description: 'Expected HTTP status code (default: 200)' },
          },
        },
        handler: async ({ url, name, checkFrequency = 60, requestTimeout = 30, expectedStatus = 200 }:
          { url: string; name: string; checkFrequency?: number;
            requestTimeout?: number; expectedStatus?: number }) => {
          return BetterStack.createMonitor({ url, name, checkFrequency, requestTimeout, expectedStatus });
        },
      },
      {
        name:        'send_log',
        description: 'Send a structured log entry to Better Stack',
        inputSchema: {
          type: 'object',
          required: ['message', 'level'],
          properties: {
            message:     { type: 'string', description: 'Log message' },
            level:       { type: 'string', enum: ['debug','info','warn','error'], description: 'Log level' },
            service:     { type: 'string', description: 'Service name' },
            environment: { type: 'string', description: 'Environment: production, staging, development' },
            metadata:    { type: 'object', description: 'Additional structured metadata' },
          },
        },
        handler: async ({ message, level, service, environment, metadata }:
          { message: string; level: string; service?: string;
            environment?: string; metadata?: Record<string, unknown> }) => {
          return BetterStack.sendLog({ message, level, service, environment, ...metadata });
        },
      },
      {
        name:        'get_system_health',
        description: 'Get an overall health summary of all monitored services',
        inputSchema: {
          type: 'object',
          properties: {},
        },
        handler: async () => {
          const [monitors, incidents] = await Promise.all([
            BetterStack.listMonitors(1),
            BetterStack.listIncidents(1, 'ongoing'),
          ]);
          return { monitors, ongoingIncidents: incidents };
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

export function createAgent(bus: MessageBus, state: StateStore): MonitorAgent {
  return new MonitorAgent(bus, state);
}
