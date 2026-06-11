/**
 * Agent-16: Memory
 * ────────────────
 * Long-term memory store backed by Neon DB.
 * Stores, retrieves, and semantically queries agent memories and facts.
 */
import {
  AgentBase, AgentTask, AgentResult, AgentConfig,
  MessageBus, StateStore, ToolDefinition,
} from '@workspace/core';
import * as Neon from '@workspace/integrations/neon';
import * as Groq from '@workspace/integrations/groq';

const CONFIG: AgentConfig = {
  id:           'memory',
  name:         'Memory Agent',
  description:  'Long-term memory — store, retrieve, and query facts across sessions',
  version:      '1.0.0',
  capabilities: ['store_memory','recall_memory','search_memory','forget_memory','summarize_memories'],
  model:        'claude-opus-4-6',
  systemPrompt: [
    'You are the Memory Agent. You manage persistent memory for the Workspace system.',
    'Categorize memories clearly: fact, preference, decision, event, relationship, technical.',
    'Always include context and timestamps when storing.',
    'When recalling, rank by relevance and recency.',
    'Consolidate duplicate or outdated memories to keep the store lean.',
  ].join(' '),
};

export class MemoryAgent extends AgentBase {
  constructor(bus: MessageBus, state: StateStore) {
    super(CONFIG, bus, state);
  }

  protected registerTools(): void {
    const tools: ToolDefinition[] = [
      {
        name:        'store_memory',
        description: 'Store a new memory or fact in persistent storage',
        inputSchema: {
          type: 'object',
          required: ['content', 'category'],
          properties: {
            content:    { type: 'string', description: 'The memory content to store' },
            category:   { type: 'string', enum: ['fact','preference','decision','event','relationship','technical','other'],
                          description: 'Memory category' },
            tags:       { type: 'array', items: { type: 'string' }, description: 'Tags for retrieval' },
            agentId:    { type: 'string', description: 'Agent that created this memory' },
            confidence: { type: 'number', description: 'Confidence score 0-1 (default: 1.0)' },
          },
        },
        handler: async ({ content, category, tags, agentId, confidence = 1.0 }:
          { content: string; category: string; tags?: string[];
            agentId?: string; confidence?: number }) => {
          const result = await Neon.queryOne<{ id: number }>(
            `INSERT INTO agent_memories (content, category, tags, agent_id, confidence, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             RETURNING id`,
            [content, category, JSON.stringify(tags || []), agentId || 'system', confidence]
          );
          return { stored: true, id: result?.id };
        },
      },
      {
        name:        'recall_memories',
        description: 'Recall memories by category or tags',
        inputSchema: {
          type: 'object',
          properties: {
            category:   { type: 'string', description: 'Filter by category' },
            tags:       { type: 'array', items: { type: 'string' }, description: 'Filter by tags (any match)' },
            limit:      { type: 'number', description: 'Max memories to return (default: 20)' },
            since:      { type: 'string', description: 'Only memories after this ISO 8601 date' },
          },
        },
        handler: async ({ category, tags, limit = 20, since }:
          { category?: string; tags?: string[]; limit?: number; since?: string }) => {
          let sql = 'SELECT * FROM agent_memories WHERE 1=1';
          const params: unknown[] = [];
          let idx = 1;

          if (category) { sql += ` AND category = $${idx++}`; params.push(category); }
          if (since)    { sql += ` AND created_at > $${idx++}`; params.push(since); }
          if (tags?.length) {
            sql += ` AND tags ?| $${idx++}::text[]`;
            params.push(tags);
          }
          sql += ` ORDER BY created_at DESC LIMIT $${idx}`;
          params.push(limit);

          return Neon.query(sql, params as string[]);
        },
      },
      {
        name:        'search_memory',
        description: 'Search memories by keyword or phrase using text matching',
        inputSchema: {
          type: 'object',
          required: ['query'],
          properties: {
            query:  { type: 'string', description: 'Search query' },
            limit:  { type: 'number', description: 'Max results (default: 10)' },
          },
        },
        handler: async ({ query, limit = 10 }: { query: string; limit?: number }) => {
          return Neon.query(
            `SELECT * FROM agent_memories
             WHERE content ILIKE $1
             ORDER BY created_at DESC LIMIT $2`,
            [`%${query}%`, String(limit)]
          );
        },
      },
      {
        name:        'forget_memory',
        description: 'Delete a specific memory by ID',
        inputSchema: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'number', description: 'Memory ID to delete' },
          },
        },
        handler: async ({ id }: { id: number }) => {
          await Neon.execute('DELETE FROM agent_memories WHERE id = $1', [String(id)]);
          return { forgotten: true, id };
        },
      },
      {
        name:        'consolidate_memories',
        description: 'Use Groq to summarize and consolidate a set of related memories',
        inputSchema: {
          type: 'object',
          required: ['category'],
          properties: {
            category: { type: 'string', description: 'Memory category to consolidate' },
            limit:    { type: 'number', description: 'Max memories to consolidate (default: 50)' },
          },
        },
        handler: async ({ category, limit = 50 }: { category: string; limit?: number }) => {
          const memories = await Neon.query<{ id: number; content: string }>(
            'SELECT id, content FROM agent_memories WHERE category = $1 ORDER BY created_at DESC LIMIT $2',
            [category, String(limit)]
          );
          if (!memories.length) return { consolidated: 0, summary: 'No memories to consolidate' };

          const combined = memories.map((m, i) => `${i + 1}. ${m.content}`).join('\n');
          const summary = await Groq.fastChat(
            `Consolidate these ${category} memories into a concise, unified summary:\n\n${combined}`
          );

          // Store consolidated summary
          const result = await Neon.queryOne<{ id: number }>(
            `INSERT INTO agent_memories (content, category, tags, agent_id, confidence, created_at)
             VALUES ($1, $2, $3, 'memory', 1.0, NOW()) RETURNING id`,
            [typeof summary === 'string' ? summary : JSON.stringify(summary),
             category,
             JSON.stringify(['consolidated'])]
          );

          return { consolidated: memories.length, summaryId: result?.id, summary };
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

export function createAgent(bus: MessageBus, state: StateStore): MemoryAgent {
  return new MemoryAgent(bus, state);
}
