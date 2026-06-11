/**
 * Agent-15: Scheduler
 * ───────────────────
 * Manages scheduled tasks, reminders, crons stored in Neon DB.
 * Integrates with Google Calendar for time-based events.
 */
import {
  AgentBase, AgentTask, AgentResult, AgentConfig,
  MessageBus, StateStore, ToolDefinition,
} from '@workspace/core';
import * as Neon from '@workspace/integrations/neon';
import * as GoogleCal from '@workspace/integrations/googlecalendar';

const CONFIG: AgentConfig = {
  id:           'scheduler',
  name:         'Scheduler Agent',
  description:  'Cron jobs, reminders, scheduled tasks — Neon-backed with Calendar integration',
  version:      '1.0.0',
  capabilities: ['schedule_task','list_scheduled','cancel_scheduled','create_reminder','list_reminders'],
  model:        'claude-opus-4-6',
  systemPrompt: [
    'You are the Scheduler Agent. You manage time-based tasks and reminders.',
    'Always store schedules in Neon DB for persistence across restarts.',
    'When creating reminders, also add to Google Calendar so the user sees them.',
    'Use cron syntax for recurring tasks. Validate syntax before saving.',
    'Provide human-readable descriptions alongside cron expressions.',
  ].join(' '),
};

export class SchedulerAgent extends AgentBase {
  constructor(bus: MessageBus, state: StateStore) {
    super(CONFIG, bus, state);
  }

  protected registerTools(): void {
    const tools: ToolDefinition[] = [
      {
        name:        'schedule_task',
        description: 'Schedule a recurring or one-time task using cron syntax',
        inputSchema: {
          type: 'object',
          required: ['name', 'cron', 'agentId', 'taskInput'],
          properties: {
            name:      { type: 'string', description: 'Descriptive name for the task' },
            cron:      { type: 'string', description: 'Cron expression (e.g. "0 9 * * 1" = every Monday 9am)' },
            agentId:   { type: 'string', description: 'Target agent ID to route the task to' },
            taskInput: { type: 'string', description: 'Task input/prompt to send to the agent' },
            timezone:  { type: 'string', description: 'Timezone (default: Asia/Kolkata)' },
            enabled:   { type: 'boolean', description: 'Whether the task is active (default: true)' },
          },
        },
        handler: async ({ name, cron, agentId, taskInput, timezone = 'Asia/Kolkata', enabled = true }:
          { name: string; cron: string; agentId: string; taskInput: string;
            timezone?: string; enabled?: boolean }) => {
          await Neon.execute(
            `INSERT INTO scheduled_tasks (name, cron, agent_id, task_input, timezone, enabled, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             ON CONFLICT (name) DO UPDATE SET cron=$2, agent_id=$3, task_input=$4, timezone=$5, enabled=$6`,
            [name, cron, agentId, taskInput, timezone, enabled]
          );
          return { scheduled: true, name, cron, agentId };
        },
      },
      {
        name:        'list_scheduled_tasks',
        description: 'List all scheduled tasks',
        inputSchema: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean', description: 'Filter by enabled status' },
          },
        },
        handler: async ({ enabled }: { enabled?: boolean }) => {
          const sql = enabled !== undefined
            ? 'SELECT * FROM scheduled_tasks WHERE enabled = $1 ORDER BY created_at DESC'
            : 'SELECT * FROM scheduled_tasks ORDER BY created_at DESC';
          const params = enabled !== undefined ? [enabled] : [];
          return Neon.query(sql, params as string[]);
        },
      },
      {
        name:        'cancel_scheduled_task',
        description: 'Disable or delete a scheduled task',
        inputSchema: {
          type: 'object',
          required: ['name'],
          properties: {
            name:   { type: 'string', description: 'Task name to cancel' },
            delete: { type: 'boolean', description: 'Permanently delete vs just disable (default: disable)' },
          },
        },
        handler: async ({ name, delete: del = false }: { name: string; delete?: boolean }) => {
          if (del) {
            await Neon.execute('DELETE FROM scheduled_tasks WHERE name = $1', [name]);
            return { deleted: true, name };
          }
          await Neon.execute('UPDATE scheduled_tasks SET enabled = false WHERE name = $1', [name]);
          return { disabled: true, name };
        },
      },
      {
        name:        'create_reminder',
        description: 'Create a one-time reminder as a Google Calendar event',
        inputSchema: {
          type: 'object',
          required: ['title', 'datetime'],
          properties: {
            title:       { type: 'string', description: 'Reminder title' },
            datetime:    { type: 'string', description: 'When to remind (ISO 8601)' },
            description: { type: 'string', description: 'Reminder details' },
            durationMin: { type: 'number', description: 'Duration in minutes (default: 15)' },
          },
        },
        handler: async ({ title, datetime, description, durationMin = 15 }:
          { title: string; datetime: string; description?: string; durationMin?: number }) => {
          const start = new Date(datetime);
          const end = new Date(start.getTime() + durationMin * 60 * 1000);
          return GoogleCal.createEvent({
            summary:     title,
            start:       start.toISOString(),
            end:         end.toISOString(),
            description: description || `Reminder: ${title}`,
            calendarId:  'primary',
          });
        },
      },
      {
        name:        'list_upcoming_reminders',
        description: 'List upcoming reminders from Google Calendar',
        inputSchema: {
          type: 'object',
          properties: {
            hours:      { type: 'number', description: 'Look ahead hours (default: 24)' },
            maxResults: { type: 'number', description: 'Max results (default: 10)' },
          },
        },
        handler: async ({ hours = 24, maxResults = 10 }:
          { hours?: number; maxResults?: number }) => {
          const timeMin = new Date().toISOString();
          const timeMax = new Date(Date.now() + hours * 3600 * 1000).toISOString();
          return GoogleCal.listEvents({ timeMin, timeMax, maxResults, calendarId: 'primary' });
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

export function createAgent(bus: MessageBus, state: StateStore): SchedulerAgent {
  return new SchedulerAgent(bus, state);
}
