// @ts-nocheck
import pg from 'pg';

const { Pool } = pg;
let _pool: pg.Pool | null = null;

export function pool(): pg.Pool {
  if (!_pool) {
    const url = process.env['NEON_DATABASE_URL'];
    if (!url) throw new Error('NEON_DATABASE_URL not set');
    _pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 10 });
  }
  return _pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string, params?: unknown[],
): Promise<T[]> {
  const res = await pool().query<T>(sql, params);
  return res.rows;
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string, params?: unknown[],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function execute(sql: string, params?: unknown[]): Promise<number> {
  const res = await pool().query(sql, params);
  return res.rowCount ?? 0;
}

export async function listTables(): Promise<string[]> {
  const rows = await query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  return rows.map((r) => r.tablename);
}

export async function describeTable(tableName: string): Promise<Array<{
  column: string; type: string; nullable: boolean;
}>> {
  const rows = await query<{
    column_name: string; data_type: string; is_nullable: string;
  }>(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_name = $1 AND table_schema = 'public'
     ORDER BY ordinal_position`,
    [tableName],
  );
  return rows.map((r) => ({
    column:   r.column_name,
    type:     r.data_type,
    nullable: r.is_nullable === 'YES',
  }));
}

export async function close(): Promise<void> {
  await _pool?.end();
  _pool = null;
}
