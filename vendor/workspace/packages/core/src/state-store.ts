import pg from 'pg';

const { Pool } = pg;

export class StateStore {
  private readonly pool: pg.Pool;

  constructor(connectionString?: string) {
    this.pool = new Pool({
      connectionString: connectionString ?? process.env['NEON_DATABASE_URL'],
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  }

  async get<T>(agentId: string, key: string): Promise<T | null> {
    const res = await this.pool.query<{ value: T }>(
      'SELECT value FROM agent_state WHERE agent_id = $1 AND key = $2',
      [agentId, key],
    );
    return res.rows[0]?.value ?? null;
  }

  async set<T>(agentId: string, key: string, value: T): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_state (agent_id, key, value, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (agent_id, key)
       DO UPDATE SET value = $3::jsonb, updated_at = NOW()`,
      [agentId, key, JSON.stringify(value)],
    );
  }

  async delete(agentId: string, key: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM agent_state WHERE agent_id = $1 AND key = $2',
      [agentId, key],
    );
  }

  async getAll<T>(agentId: string): Promise<Record<string, T>> {
    const res = await this.pool.query<{ key: string; value: T }>(
      'SELECT key, value FROM agent_state WHERE agent_id = $1',
      [agentId],
    );
    return Object.fromEntries(res.rows.map((r) => [r.key, r.value]));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
