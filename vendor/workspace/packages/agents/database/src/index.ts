import { AgentBase, AgentTask, AgentResult, AgentConfig, MessageBus, StateStore } from '@workspace/core';
import * as Neon     from '@workspace/integrations/dist/neon/index.js';
import * as Supabase from '@workspace/integrations/dist/supabase/index.js';

const CONFIG: AgentConfig = {
  id: 'database', name: 'Database', description: 'Neon and Supabase queries, migrations, schema ops',
  version: '0.1.0', capabilities: ['query', 'migrate', 'schema', 'backup', 'restore', 'insert', 'select'],
  model: 'claude-opus-4-6',
  systemPrompt: 'You are a database agent with access to Neon Postgres and Supabase. Always validate queries before running. Never run destructive operations without confirmation in the task context.',
};

export class DatabaseAgent extends AgentBase {
  constructor(bus: MessageBus, state: StateStore) { super(CONFIG, bus, state); }

  protected registerTools(): void {
    this.tools.register({
      name: 'run_query', description: 'Run a SELECT query on Neon Postgres. Only SELECT is allowed here.',
      inputSchema: { type: 'object', properties: { sql: { type: 'string', description: 'SELECT SQL query' }, params: { type: 'array', items: {}, description: 'Query parameters' } }, required: ['sql'] },
      handler: async (i: unknown) => {
        const { sql, params } = i as { sql: string; params?: unknown[] };
        if (!sql.trim().toUpperCase().startsWith('SELECT')) throw new Error('Only SELECT queries allowed via this tool. Use run_migration for DDL/DML.');
        return Neon.query(sql, params);
      },
    });
    this.tools.register({
      name: 'run_migration', description: 'Run a SQL migration (INSERT/UPDATE/DELETE/DDL). Returns rows affected.',
      inputSchema: { type: 'object', properties: { sql: { type: 'string' }, params: { type: 'array', items: {} } }, required: ['sql'] },
      handler: async (i: unknown) => { const { sql, params } = i as { sql: string; params?: unknown[] }; const rows = await Neon.execute(sql, params); return { rowsAffected: rows }; },
    });
    this.tools.register({
      name: 'list_tables', description: 'List all tables in the Neon database.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => Neon.listTables(),
    });
    this.tools.register({
      name: 'describe_table', description: 'Describe columns of a Neon table.',
      inputSchema: { type: 'object', properties: { tableName: { type: 'string' } }, required: ['tableName'] },
      handler: async (i: unknown) => { const { tableName } = i as { tableName: string }; return Neon.describeTable(tableName); },
    });
    this.tools.register({
      name: 'supabase_select', description: 'Query rows from a Supabase table.',
      inputSchema: { type: 'object', properties: { table: { type: 'string' }, filter: { type: 'object' }, limit: { type: 'number' }, columns: { type: 'string' } }, required: ['table'] },
      handler: async (i: unknown) => { const { table, filter, limit, columns } = i as { table: string; filter?: Record<string, unknown>; limit?: number; columns?: string }; return Supabase.select(table, { filter, limit, columns }); },
    });
    this.tools.register({
      name: 'supabase_insert', description: 'Insert a row into a Supabase table.',
      inputSchema: { type: 'object', properties: { table: { type: 'string' }, row: { type: 'object' } }, required: ['table', 'row'] },
      handler: async (i: unknown) => { const { table, row } = i as { table: string; row: Record<string, unknown> }; return Supabase.insert(table, row); },
    });
  }

  protected async handle(task: AgentTask): Promise<AgentResult> {
    const start = Date.now();
    const result = await this.runAgentLoop(typeof task.input === 'string' ? task.input : JSON.stringify(task.input));
    return { taskId: task.id, agentId: this.config.id, success: true, output: result, durationMs: Date.now() - start };
  }
}

export function createAgent(bus: MessageBus, state: StateStore): DatabaseAgent {
  return new DatabaseAgent(bus, state);
}
