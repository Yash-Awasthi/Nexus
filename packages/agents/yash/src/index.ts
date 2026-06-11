/**
 * Agent-18: Yash (Personal Assistant)
 * ─────────────────────────────────────
 * The always-on personal agent for Yash Awasthi.
 * Has full routing authority over all 17 other agents.
 * Loads context from memory, calendar, email, and Linear at session start.
 * Surfaces only decisions that genuinely require human input.
 */
import {
  AgentBase, AgentTask, AgentResult, AgentConfig,
  MessageBus, StateStore, ToolDefinition,
} from '@workspace/core';
import * as GoogleCal from '@workspace/integrations/googlecalendar';
import * as Gmail from '@workspace/integrations/gmail';
import * as Groq from '@workspace/integrations/groq';
import * as Neon from '@workspace/integrations/neon';

const ALL_AGENTS = [
  'researcher','coder','github','slack','linear','deploy',
  'database','secrets','email','calendar','drive','content',
  'analyst','monitor','scheduler','memory','orchestrator',
];

const CONFIG: AgentConfig = {
  id:           'yash',
  name:         'Workspace (Yash)',
  description:  'Personal AI assistant — direct interface serving Yash Awasthi with full routing authority',
  version:      '1.0.0',
  capabilities: [
    'orchestrate','personal','context','delegate',
    'remember','plan','execute','report','brief',
  ],
  model:        'claude-opus-4-6',
  systemPrompt: [
    'You are Workspace — Yash Awasthi\'s personal AI system built on his custom multi-agent framework.',
    'Yash: 2nd-year B.Tech CSE at NIT Raipur, full-stack developer, AI/multi-agent systems architect.',
    'Stack: TypeScript, Python, React, Node.js, Playwright. Infra: Cloudflare, Vercel, Supabase, Neon.',
    'You have 17 specialist agents at your disposal. Delegate aggressively — never do specialist work yourself.',
    'Available agents: ' + ALL_AGENTS.join(', ') + '.',
    'Be direct, action-oriented, and autonomous. Prefer doing over asking.',
    'Start every session with a context brief: check calendar for today, scan inbox for urgent emails, check Linear for active issues.',
    'Surface only decisions that genuinely require Yash\'s input. Everything else — just handle it.',
    'Communication style: casual, precise, no filler. Match Yash\'s obsessive linguistic precision.',
  ].join(' '),
};

export class YashAgent extends AgentBase {
  constructor(bus: MessageBus, state: StateStore) {
    super(CONFIG, bus, state);
  }

  protected registerTools(): void {
    const tools: ToolDefinition[] = [
      {
        name:        'delegate_to_agent',
        description: 'Delegate any task to a specialist agent via the message bus',
        inputSchema: {
          type: 'object',
          required: ['agentId', 'taskInput'],
          properties: {
            agentId:   { type: 'string', description: 'Target agent ID', enum: ALL_AGENTS },
            taskInput: { type: 'string', description: 'Task description or prompt for the agent' },
            priority:  { type: 'string', enum: ['critical','high','normal','low'], description: 'Task priority (default: normal)' },
            timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default: 60000)' },
          },
        },
        handler: async ({ agentId, taskInput, priority = 'normal', timeoutMs = 60000 }:
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
        name:        'get_daily_brief',
        description: 'Get a morning context brief: today\'s calendar, urgent emails, active Linear issues',
        inputSchema: {
          type: 'object',
          properties: {
            hoursAhead: { type: 'number', description: 'Hours to look ahead for calendar (default: 24)' },
          },
        },
        handler: async ({ hoursAhead = 24 }: { hoursAhead?: number }) => {
          const timeMin = new Date().toISOString();
          const timeMax = new Date(Date.now() + hoursAhead * 3600 * 1000).toISOString();

          const [events, emails] = await Promise.all([
            GoogleCal.listEvents({ timeMin, timeMax, maxResults: 10, calendarId: 'primary' }),
            Gmail.listEmails({ maxResults: 10, labelIds: ['INBOX', 'UNREAD'] }),
          ]);

          // Fetch memories for context
          const recentMemories = await Neon.query<{ content: string; category: string }>(
            `SELECT content, category FROM agent_memories
             WHERE created_at > NOW() - INTERVAL '7 days'
             ORDER BY created_at DESC LIMIT 10`
          ).catch(() => []);

          return {
            calendar: events,
            inbox:    emails,
            recentContext: recentMemories,
          };
        },
      },
      {
        name:        'store_context',
        description: 'Store an important context item, decision, or fact in memory',
        inputSchema: {
          type: 'object',
          required: ['content', 'category'],
          properties: {
            content:  { type: 'string', description: 'Context to remember' },
            category: { type: 'string', enum: ['fact','preference','decision','event','technical','other'] },
            tags:     { type: 'array', items: { type: 'string' }, description: 'Tags for later retrieval' },
          },
        },
        handler: async ({ content, category, tags }:
          { content: string; category: string; tags?: string[] }) => {
          await Neon.execute(
            `INSERT INTO agent_memories (content, category, tags, agent_id, confidence, created_at)
             VALUES ($1, $2, $3, 'yash', 1.0, NOW())`,
            [content, category, JSON.stringify(tags || [])]
          );
          return { stored: true };
        },
      },
      {
        name:        'recall_context',
        description: 'Recall stored context or memories by keyword search',
        inputSchema: {
          type: 'object',
          required: ['query'],
          properties: {
            query:    { type: 'string', description: 'What to recall' },
            category: { type: 'string', description: 'Filter by category' },
            limit:    { type: 'number', description: 'Max results (default: 10)' },
          },
        },
        handler: async ({ query, category, limit = 10 }:
          { query: string; category?: string; limit?: number }) => {
          let sql = `SELECT * FROM agent_memories WHERE content ILIKE $1`;
          const params: unknown[] = [`%${query}%`];
          let idx = 2;
          if (category) { sql += ` AND category = $${idx++}`; params.push(category); }
          sql += ` ORDER BY created_at DESC LIMIT $${idx}`;
          params.push(limit);
          return Neon.query(sql, params as string[]);
        },
      },
      {
        name:        'quick_answer',
        description: 'Get a fast answer using Groq without delegating to a specialist agent',
        inputSchema: {
          type: 'object',
          required: ['question'],
          properties: {
            question: { type: 'string', description: 'Question to answer quickly' },
          },
        },
        handler: async ({ question }: { question: string }) => {
          return Groq.fastChat(question);
        },
      },
      {
        name:        'broadcast_to_agents',
        description: 'Broadcast a message or status update to multiple agents simultaneously',
        inputSchema: {
          type: 'object',
          required: ['agentIds', 'message'],
          properties: {
            agentIds: { type: 'array', items: { type: 'string' }, description: 'Target agent IDs' },
            message:  { type: 'string', description: 'Message to broadcast' },
            type:     { type: 'string', description: 'Message type (default: STATUS_UPDATE)' },
          },
        },
        handler: async ({ agentIds, message, type = 'STATUS_UPDATE' }:
          { agentIds: string[]; message: string; type?: string }) => {
          const results: Record<string, boolean> = {};
          for (const agentId of agentIds) {
            try {
              this.bus.publish(`agent.${agentId}.broadcast`, {
                type,
                from:    this.config.id,
                to:      agentId,
                payload: { message },
              });
              results[agentId] = true;
            } catch {
              results[agentId] = false;
            }
          }
          return { broadcast: true, results };
        },
      },
    ];

    for (const t of tools) this.toolRegistry.register(t);
  }

  /**
   * Override init to load session context on startup.
   */
  async init(): Promise<void> {
    await super.init();
    this.logger.info('Yash agent online — loading session context...');
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

export function createAgent(bus: MessageBus, state: StateStore): YashAgent {
  return new YashAgent(bus, state);
}
