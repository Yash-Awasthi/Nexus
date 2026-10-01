// SPDX-License-Identifier: Apache-2.0
/**
 * Ambient module declarations for packages that ship without TypeScript types
 * and for which @types/* packages are not installed in this workspace.
 *
 * These stubs are intentionally minimal — they cover only the APIs that
 * this codebase actually calls. Add members as needed when new call-sites appear.
 */

// ── pg ────────────────────────────────────────────────────────────────────────
declare module "pg" {
  export type QueryResultRow = Record<string, unknown>;
  export interface QueryResult<R = QueryResultRow> {
    rows: R[];
    rowCount: number | null;
    command: string;
    oid: number;
    fields: unknown[];
  }
  export interface PoolConfig {
    connectionString?: string;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
    ssl?: boolean | { rejectUnauthorized?: boolean };
  }
  export interface PoolClient {
    query<R = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
    release(err?: Error | boolean): void;
  }
  export class Pool {
    constructor(config?: PoolConfig);
    query<R = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
    end(): Promise<void>;
    connect(): Promise<PoolClient>;
  }
  // Default export shape used by `import pg from "pg"; new pg.Pool()`
  const pg: { Pool: typeof Pool };
  export default pg;
}

// ── @neondatabase/serverless (ambient fallback for packages without pnpm symlink) ──
declare module "@neondatabase/serverless" {
  type NeonRow = Record<string, unknown>;
  interface NeonQueryFunction {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<NeonRow[]>;
    (sql: string, params?: unknown[]): Promise<NeonRow[]>;
  }
  export function neon(connectionString: string): NeonQueryFunction;
}

// ── patchright (optional stealth-browser peer dep, no @types) ─────────────────
declare module "patchright" {
  export interface LaunchOptions {
    headless?: boolean;
    args?: string[];
    executablePath?: string;
    proxy?: { server: string; username?: string; password?: string };
    [key: string]: unknown;
  }
  export interface Page {
    goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<void>;
    content(): Promise<string>;
    evaluate<T>(fn: () => T): Promise<T>;
    close(): Promise<void>;
    setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
  }
  export interface Browser {
    newPage(): Promise<Page>;
    close(): Promise<void>;
  }
  export interface BrowserType {
    launch(opts?: LaunchOptions): Promise<Browser>;
  }
  export const chromium: BrowserType;
}

// ── ioredis ───────────────────────────────────────────────────────────────────
declare module "ioredis" {
  export class Redis {
    constructor(url: string, options?: Record<string, unknown>);
    connect(): Promise<void>;
    ping(): Promise<string>;
    quit(): Promise<string>;
    get(key: string): Promise<string | null>;
    set(key: string, value: string, expiryMode?: string, time?: number): Promise<"OK">;
    del(...keys: string[]): Promise<number>;
    keys(pattern: string): Promise<string[]>;
    flushdb(): Promise<"OK">;
  }
  export default Redis;
}
