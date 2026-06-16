// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/connectors — Unified connector registry with lifecycle management.
 *
 * Architecture
 * ─────────────
 *   Connector        — interface: connect / disconnect / healthCheck + status
 *   ConnectorRegistry — registers connectors, drives connectAll / healthCheckAll
 *
 * Built-in connectors (all with injectable fetch)
 * ─────────────────────────────────────────────────
 *   GitHubConnector   — PAT → GET /user verification
 *   SlackConnector    — Bot token → auth.test
 *   GroqConnector     — API key → GET /models
 *   TavilyConnector   — API key → POST /search (depth:basic, max_results:1)
 *   NeonConnector     — connection string → SQL ping via Neon HTTP API
 *   LinearConnector   — API key → GraphQL viewer { id }
 *   NullConnector     — always "connected"; useful for test stubs
 *
 * Status machine per connector
 * ─────────────────────────────
 *   disconnected → connecting → connected
 *                             ↓
 *                           error
 *   Any connector can be disabled via ConnectorRegistry.disable(id).
 *
 * Usage
 * ─────
 * ```ts
 * import { ConnectorRegistry, GitHubConnector, GroqConnector } from "@nexus/connectors";
 *
 * const registry = new ConnectorRegistry();
 * registry.register(new GitHubConnector({ token: process.env.GITHUB_TOKEN }));
 * registry.register(new GroqConnector({ apiKey: process.env.GROQ_API_KEY }));
 *
 * const results = await registry.connectAll();
 * console.log(results);  // { github: { ok: true }, groq: { ok: true } }
 *
 * const health = await registry.healthCheckAll();
 * ```
 *
 * Zero hard inter-package dependencies.
 */

// ── Error ─────────────────────────────────────────────────────────────────────

export type ConnectorErrorCode =
  | "AUTH_FAILED"
  | "NETWORK_ERROR"
  | "CONNECT_FAILED"
  | "ALREADY_REGISTERED"
  | "NOT_FOUND"
  | "HEALTH_CHECK_FAILED"
  | "DISABLED";

/** Connector error. */
export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly context?: Record<string, unknown>;

  constructor(code: ConnectorErrorCode, message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
    this.context = context;
  }
}

// ── Core types ────────────────────────────────────────────────────────────────

export type ConnectorStatus = "disconnected" | "connecting" | "connected" | "error" | "disabled";

/** Connect result interface definition. */
export interface ConnectResult {
  ok: boolean;
  /** Short error description when ok:false */
  error?: string;
  /** Provider-specific metadata: authed user, available scopes, rate limits, etc. */
  metadata?: Record<string, unknown>;
}

/** Health check result interface definition. */
export interface HealthCheckResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  /** Provider-specific detail: remaining quota, server version, etc. */
  details?: Record<string, unknown>;
}

// ── Connector interface ───────────────────────────────────────────────────────

export interface Connector {
  /** Unique connector id — used as registry key */
  readonly id: string;
  /** Human-readable name */
  readonly name: string;
  /** Current connection status */
  readonly status: ConnectorStatus;
  /**
   * Attempt to connect and verify credentials.
   * Implementations should set status to "connected" on success, "error" on failure.
   */
  connect(): Promise<ConnectResult>;
  /** Tear down the connection and reset status to "disconnected". */
  disconnect(): Promise<void>;
  /**
   * Lightweight liveness check — should be fast (HEAD or minimal API call).
   * Should NOT alter the connector's status.
   */
  healthCheck(): Promise<HealthCheckResult>;
}

// ── Injectable fetch ──────────────────────────────────────────────────────────

export type FetchFn = typeof fetch;

// ── BaseConnector ─────────────────────────────────────────────────────────────

/**
 * Abstract base that manages status transitions and provides helpers.
 * Concrete connectors extend this and implement _doConnect / _doHealthCheck.
 */
export abstract class BaseConnector implements Connector {
  abstract readonly id: string;
  abstract readonly name: string;

  protected _status: ConnectorStatus = "disconnected";

  get status(): ConnectorStatus {
    return this._status;
  }

  async connect(): Promise<ConnectResult> {
    if (this._status === "disabled") {
      return { ok: false, error: "Connector is disabled" };
    }
    this._status = "connecting";
    try {
      const result = await this._doConnect();
      this._status = result.ok ? "connected" : "error";
      return result;
    } catch (cause) {
      this._status = "error";
      return { ok: false, error: String(cause) };
    }
  }

  async disconnect(): Promise<void> {
    await this._doDisconnect();
    this._status = "disconnected";
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const result = await this._doHealthCheck();
      return { ...result, latencyMs: result.latencyMs ?? Date.now() - start };
    } catch (cause) {
      return { ok: false, latencyMs: Date.now() - start, error: String(cause) };
    }
  }

  /** @internal — called by connect() */
  protected abstract _doConnect(): Promise<ConnectResult>;

  /** @internal — override if teardown is needed */
  protected async _doDisconnect(): Promise<void> {}

  /** @internal — called by healthCheck() */
  protected abstract _doHealthCheck(): Promise<
    Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }
  >;

  /** Disable the connector — connect() will immediately return ok:false */
  disable(): void {
    this._status = "disabled";
  }

  enable(): void {
    if (this._status === "disabled") this._status = "disconnected";
  }
}

// ── NullConnector ─────────────────────────────────────────────────────────────

/**
 * No-op connector — always reports "connected" and healthy.
 * Useful as a test stub or placeholder.
 */
export class NullConnector extends BaseConnector {
  readonly id: string;
  readonly name: string;

  constructor(id = "null", name = "Null Connector") {
    super();
    this.id = id;
    this.name = name;
    this._status = "connected";
  }

  protected async _doConnect(): Promise<ConnectResult> {
    return { ok: true, metadata: { stub: true } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    return { ok: true };
  }
}

// ── GitHubConnector ────────────────────────────────────────────────────────────

export interface GitHubConnectorConfig {
  /** GitHub Personal Access Token */
  token: string;
  fetch?: FetchFn;
}

/** Git hub connector. */
export class GitHubConnector extends BaseConnector {
  readonly id = "github";
  readonly name = "GitHub";

  private readonly token: string;
  private readonly fetchFn: FetchFn;
  private static readonly BASE = "https://api.github.com";

  constructor(config: GitHubConnectorConfig) {
    super();
    this.token = config.token;
    this.fetchFn = config.fetch ?? fetch;
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${GitHubConnector.BASE}/user`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (res.status === 401) {
      return { ok: false, error: "GitHub token is invalid or expired" };
    }
    if (!res.ok) {
      return { ok: false, error: `GitHub API returned ${res.status}` };
    }

    const user = (await res.json()) as { login: string; id: number; plan?: { name: string } };
    return {
      ok: true,
      metadata: { login: user.login, id: user.id, plan: user.plan?.name },
    };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${GitHubConnector.BASE}/rate_limit`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) return { ok: false, latencyMs: Date.now() - start, error: `${res.status}` };
    const json = (await res.json()) as { rate?: { remaining: number; limit: number } };
    return {
      ok: true,
      latencyMs: Date.now() - start,
      details: { rateRemaining: json.rate?.remaining, rateLimit: json.rate?.limit },
    };
  }
}

// ── SlackConnector ─────────────────────────────────────────────────────────────

export interface SlackConnectorConfig {
  /** Slack Bot OAuth token (xoxb-…) */
  token: string;
  fetch?: FetchFn;
}

/** Slack connector. */
export class SlackConnector extends BaseConnector {
  readonly id = "slack";
  readonly name = "Slack";

  private readonly token: string;
  private readonly fetchFn: FetchFn;
  private static readonly BASE = "https://slack.com/api";

  constructor(config: SlackConnectorConfig) {
    super();
    this.token = config.token;
    this.fetchFn = config.fetch ?? fetch;
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${SlackConnector.BASE}/auth.test`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) return { ok: false, error: `Slack API returned ${res.status}` };
    const json = (await res.json()) as {
      ok: boolean;
      error?: string;
      team?: string;
      user?: string;
      bot_id?: string;
    };
    if (!json.ok) return { ok: false, error: json.error ?? "auth.test failed" };
    return { ok: true, metadata: { team: json.team, user: json.user, botId: json.bot_id } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${SlackConnector.BASE}/api.test`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) return { ok: false, latencyMs: Date.now() - start };
    const json = (await res.json()) as { ok: boolean };
    return { ok: json.ok, latencyMs: Date.now() - start };
  }
}

// ── GroqConnector ──────────────────────────────────────────────────────────────

export interface GroqConnectorConfig {
  apiKey: string;
  fetch?: FetchFn;
}

/** Groq connector. */
export class GroqConnector extends BaseConnector {
  readonly id = "groq";
  readonly name = "Groq";

  private readonly apiKey: string;
  private readonly fetchFn: FetchFn;
  private static readonly BASE = "https://api.groq.com/openai/v1";

  constructor(config: GroqConnectorConfig) {
    super();
    this.apiKey = config.apiKey;
    this.fetchFn = config.fetch ?? fetch;
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${GroqConnector.BASE}/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (res.status === 401) return { ok: false, error: "Groq API key is invalid" };
    if (!res.ok) return { ok: false, error: `Groq API returned ${res.status}` };

    const json = (await res.json()) as { data?: { id: string }[] };
    return { ok: true, metadata: { modelCount: json.data?.length ?? 0 } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${GroqConnector.BASE}/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }
}

// ── TavilyConnector ────────────────────────────────────────────────────────────

export interface TavilyConnectorConfig {
  apiKey: string;
  fetch?: FetchFn;
}

/** Tavily connector. */
export class TavilyConnector extends BaseConnector {
  readonly id = "tavily";
  readonly name = "Tavily";

  private readonly apiKey: string;
  private readonly fetchFn: FetchFn;
  private static readonly BASE = "https://api.tavily.com";

  constructor(config: TavilyConnectorConfig) {
    super();
    this.apiKey = config.apiKey;
    this.fetchFn = config.fetch ?? fetch;
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${TavilyConnector.BASE}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: this.apiKey,
        query: "ping",
        search_depth: "basic",
        max_results: 1,
      }),
    });

    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Tavily API key is invalid" };
    }
    if (!res.ok) return { ok: false, error: `Tavily API returned ${res.status}` };

    const json = (await res.json()) as { results?: unknown[] };
    return { ok: true, metadata: { resultCount: json.results?.length ?? 0 } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${TavilyConnector.BASE}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: this.apiKey,
        query: "health",
        search_depth: "basic",
        max_results: 1,
      }),
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }
}

// ── NeonConnector ──────────────────────────────────────────────────────────────

export interface NeonConnectorConfig {
  /**
   * Neon serverless HTTP endpoint.
   * Format: https://<project-host>.neon.tech
   * The connector posts a SQL ping via the Neon HTTP API.
   */
  endpoint: string;
  /** Neon project database name */
  database: string;
  /** Postgres user */
  user: string;
  /** Postgres password */
  password: string;
  fetch?: FetchFn;
}

/** Neon connector. */
export class NeonConnector extends BaseConnector {
  readonly id = "neon";
  readonly name = "Neon";

  private readonly endpoint: string;
  private readonly database: string;
  private readonly user: string;
  private readonly password: string;
  private readonly fetchFn: FetchFn;

  constructor(config: NeonConnectorConfig) {
    super();
    this.endpoint = config.endpoint.replace(/\/$/, "");
    this.database = config.database;
    this.user = config.user;
    this.password = config.password;
    this.fetchFn = config.fetch ?? fetch;
  }

  protected async _doConnect(): Promise<ConnectResult> {
    return this._ping();
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const result = await this._ping();
    return { ok: result.ok, latencyMs: Date.now() - start, error: result.error };
  }

  private async _ping(): Promise<ConnectResult> {
    const url = `${this.endpoint}/sql`;
    const auth = Buffer.from(`${this.user}:${this.password}`).toString("base64");

    const res = await this.fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        "Neon-Connection-String": `postgresql://${this.user}:${this.password}@${this.endpoint.replace("https://", "")}/${this.database}`,
      },
      body: JSON.stringify({ query: "SELECT 1 AS ping", params: [] }),
    });

    if (res.status === 401) return { ok: false, error: "Neon credentials are invalid" };
    if (!res.ok) return { ok: false, error: `Neon HTTP API returned ${res.status}` };

    const json = (await res.json()) as { rows?: [{ ping: number }] };
    const pong = json.rows?.[0]?.ping === 1;
    return { ok: pong, metadata: { pong }, error: pong ? undefined : "Unexpected ping response" };
  }
}

// ── LinearConnector ────────────────────────────────────────────────────────────

export interface LinearConnectorConfig {
  apiKey: string;
  fetch?: FetchFn;
}

/** Linear connector. */
export class LinearConnector extends BaseConnector {
  readonly id = "linear";
  readonly name = "Linear";

  private readonly apiKey: string;
  private readonly fetchFn: FetchFn;
  private static readonly ENDPOINT = "https://api.linear.app/graphql";

  constructor(config: LinearConnectorConfig) {
    super();
    this.apiKey = config.apiKey;
    this.fetchFn = config.fetch ?? fetch;
  }

  protected async _doConnect(): Promise<ConnectResult> {
    return this._query();
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const result = await this._query();
    return { ok: result.ok, latencyMs: Date.now() - start, error: result.error };
  }

  private async _query(): Promise<ConnectResult> {
    const res = await this.fetchFn(LinearConnector.ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "{ viewer { id name email } }" }),
    });

    if (res.status === 401) return { ok: false, error: "Linear API key is invalid" };
    if (!res.ok) return { ok: false, error: `Linear API returned ${res.status}` };

    const json = (await res.json()) as {
      data?: { viewer?: { id: string; name: string; email: string } };
      errors?: { message: string }[];
    };

    if (json.errors?.length) {
      return { ok: false, error: json.errors[0]?.message ?? "GraphQL error" };
    }

    const viewer = json.data?.viewer;
    return {
      ok: !!viewer?.id,
      metadata: { id: viewer?.id, name: viewer?.name, email: viewer?.email },
    };
  }
}

// ── ConnectorRegistry ──────────────────────────────────────────────────────────

export interface ConnectAllResult {
  /** Per-connector connect results keyed by connector id */
  results: Record<string, ConnectResult>;
  /** Number of connectors that connected successfully */
  succeeded: number;
  /** Number of connectors that failed to connect */
  failed: number;
  /** Number of connectors that were skipped (disabled) */
  skipped: number;
}

/** Health check all result interface definition. */
export interface HealthCheckAllResult {
  results: Record<string, HealthCheckResult>;
  healthy: number;
  unhealthy: number;
}

/** Connector registry. */
export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>();

  // ── Registration ───────────────────────────────────────────────────────────

  register(connector: Connector): this {
    if (this.connectors.has(connector.id)) {
      throw new ConnectorError(
        "ALREADY_REGISTERED",
        `Connector "${connector.id}" is already registered`,
        { id: connector.id },
      );
    }
    this.connectors.set(connector.id, connector);
    return this;
  }

  unregister(id: string): this {
    if (!this.connectors.has(id)) {
      throw new ConnectorError("NOT_FOUND", `Connector "${id}" is not registered`, { id });
    }
    this.connectors.delete(id);
    return this;
  }

  get(id: string): Connector | undefined {
    return this.connectors.get(id);
  }

  list(): Connector[] {
    return [...this.connectors.values()];
  }

  listByStatus(status: ConnectorStatus): Connector[] {
    return this.list().filter((c) => c.status === status);
  }

  clear(): this {
    this.connectors.clear();
    return this;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Connect all registered (non-disabled) connectors in parallel.
   */
  async connectAll(): Promise<ConnectAllResult> {
    const result: ConnectAllResult = { results: {}, succeeded: 0, failed: 0, skipped: 0 };

    await Promise.all(
      this.list().map(async (connector) => {
        if (connector.status === "disabled") {
          result.skipped++;
          result.results[connector.id] = { ok: false, error: "disabled" };
          return;
        }
        const cr = await connector.connect();
        result.results[connector.id] = cr;
        if (cr.ok) result.succeeded++;
        else result.failed++;
      }),
    );

    return result;
  }

  /**
   * Run healthCheck on all connected connectors in parallel.
   */
  async healthCheckAll(): Promise<HealthCheckAllResult> {
    const result: HealthCheckAllResult = { results: {}, healthy: 0, unhealthy: 0 };

    await Promise.all(
      this.list().map(async (connector) => {
        const hc = await connector.healthCheck();
        result.results[connector.id] = hc;
        if (hc.ok) result.healthy++;
        else result.unhealthy++;
      }),
    );

    return result;
  }

  /**
   * Disconnect all connectors in parallel.
   */
  async disconnectAll(): Promise<void> {
    await Promise.all(this.list().map((c) => c.disconnect()));
  }
}

// ── Document sync layer ────────────────────────────────────────────────────────
//
// Extends the connector interface with a document-sync capability.
// Any connector implementing DocumentConnector can stream SyncedDocuments
// from its source, enabling a unified knowledge-ingestion pipeline.
//
// Concrete document connectors (all injectable fetch / readFile for testing):
//   GitHubDocumentConnector     — repo issues and PRs via GitHub REST API
//   SlackDocumentConnector      — channel message history
//   WebDocumentConnector        — arbitrary HTTP pages (GET + text body)
//   FileSystemDocumentConnector — local files (injectable readFile)
//   LinearDocumentConnector     — Linear issues via GraphQL
//   TavilyDocumentConnector     — web search results per query

// ── Core document types ────────────────────────────────────────────────────────

export interface SyncedDocument {
  /** Unique document ID — typically "<connectorId>::<sourceUrl>" */
  id: string;
  /** Human-readable document title */
  title: string;
  /** Full text content */
  content: string;
  /** Source URL or file path */
  sourceUrl: string;
  /** ID of the connector that produced this document */
  connectorId: string;
  /** Wall-clock ms when the document was synced */
  syncedAt: number;
  /** Optional connector-specific metadata */
  metadata?: Record<string, unknown>;
}

/** Sync options interface definition. */
export interface SyncOptions {
  /** Max documents to emit (default: connector-specific) */
  limit?: number;
  /** Only yield documents updated after this Unix timestamp (ms) */
  since?: number;
  /** Optional search/filter query for connectors that support it */
  query?: string;
}

/** Document connector interface definition. */
export interface DocumentConnector extends Connector {
  sync(opts?: SyncOptions): AsyncIterable<SyncedDocument>;
}

/**
 * Type guard — returns true when a Connector also implements DocumentConnector.
 */
export function isDocumentConnector(c: Connector): c is DocumentConnector {
  return typeof (c as DocumentConnector).sync === "function";
}

// ── BaseDocumentConnector ──────────────────────────────────────────────────────

export abstract class BaseDocumentConnector extends BaseConnector implements DocumentConnector {
  async *sync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    yield* this._doSync(opts);
  }

  protected abstract _doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument>;
}

// ── DocumentConnectorRegistry ─────────────────────────────────────────────────

export class DocumentConnectorRegistry extends ConnectorRegistry {
  /** Return only the registered connectors that implement DocumentConnector.sync() */
  getDocumentConnectors(): DocumentConnector[] {
    return this.list().filter(isDocumentConnector);
  }

  /**
   * Run sync() on every document connector in parallel and collect all results.
   * Non-document connectors are silently skipped.
   */
  async syncAll(opts?: SyncOptions): Promise<SyncedDocument[]> {
    const docs: SyncedDocument[] = [];
    await Promise.all(
      this.getDocumentConnectors().map(async (c) => {
        for await (const doc of c.sync(opts)) {
          docs.push(doc);
        }
      }),
    );
    return docs;
  }
}

// ── Internal helpers ───────────────────────────────────────────────────────────

function makeDocId(connectorId: string, sourceUrl: string): string {
  return `${connectorId}::${sourceUrl}`;
}

// ── GitHubDocumentConnector ───────────────────────────────────────────────────

export interface GitHubDocumentConnectorConfig {
  /** GitHub Personal Access Token */
  token: string;
  /** Repository owner (user or org) */
  owner: string;
  /** Repository name */
  repo: string;
  fetch?: FetchFn;
}

/**
 * Syncs issues and PRs from a GitHub repository.
 * Yields one SyncedDocument per issue/PR, with body as content.
 */
export class GitHubDocumentConnector extends BaseDocumentConnector {
  readonly id: string;
  readonly name: string;

  private readonly token: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly fetchFn: FetchFn;
  private static readonly BASE = "https://api.github.com";

  constructor(config: GitHubDocumentConnectorConfig) {
    super();
    this.token = config.token;
    this.owner = config.owner;
    this.repo = config.repo;
    this.id = `github-doc::${config.owner}/${config.repo}`;
    this.name = `GitHub (${config.owner}/${config.repo})`;
    this.fetchFn = config.fetch ?? fetch;
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${GitHubDocumentConnector.BASE}/user`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (res.status === 401) return { ok: false, error: "GitHub token is invalid or expired" };
    if (!res.ok) return { ok: false, error: `GitHub API returned ${res.status}` };
    const user = (await res.json()) as { login: string };
    return { ok: true, metadata: { login: user.login } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${GitHubDocumentConnector.BASE}/rate_limit`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const limit = opts?.limit ?? 50;
    const url = `${GitHubDocumentConnector.BASE}/repos/${this.owner}/${this.repo}/issues?state=all&per_page=${limit}`;
    const res = await this.fetchFn(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!res.ok) return;

    const issues = (await res.json()) as {
      number: number;
      title: string;
      body?: string;
      html_url: string;
      updated_at: string;
      state: string;
      pull_request?: unknown;
    }[];

    const now = Date.now();
    const since = opts?.since;

    for (const issue of issues) {
      if (since !== undefined && new Date(issue.updated_at).getTime() < since) continue;

      if (opts?.query) {
        const q = opts.query.toLowerCase();
        if (!issue.title.toLowerCase().includes(q) && !(issue.body ?? "").toLowerCase().includes(q))
          continue;
      }

      const docType = issue.pull_request ? "PR" : "Issue";
      yield {
        id: makeDocId(this.id, issue.html_url),
        title: `${docType} #${issue.number}: ${issue.title}`,
        content: issue.body ?? "",
        sourceUrl: issue.html_url,
        connectorId: this.id,
        syncedAt: now,
        metadata: { number: issue.number, state: issue.state, type: docType },
      };
    }
  }
}

// ── SlackDocumentConnector ────────────────────────────────────────────────────

export interface SlackDocumentConnectorConfig {
  /** Slack Bot OAuth token (xoxb-…) */
  token: string;
  /** Slack channel ID to sync messages from */
  channelId: string;
  fetch?: FetchFn;
}

/**
 * Syncs message history from a Slack channel.
 * Yields one SyncedDocument per message.
 */
export class SlackDocumentConnector extends BaseDocumentConnector {
  readonly id: string;
  readonly name: string;

  private readonly token: string;
  private readonly channelId: string;
  private readonly fetchFn: FetchFn;
  private static readonly BASE = "https://slack.com/api";

  constructor(config: SlackDocumentConnectorConfig) {
    super();
    this.token = config.token;
    this.channelId = config.channelId;
    this.id = `slack-doc::${config.channelId}`;
    this.name = `Slack (${config.channelId})`;
    this.fetchFn = config.fetch ?? fetch;
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${SlackDocumentConnector.BASE}/auth.test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
    });
    if (!res.ok) return { ok: false, error: `Slack API returned ${res.status}` };
    const json = (await res.json()) as { ok: boolean; error?: string; team?: string };
    if (!json.ok) return { ok: false, error: json.error ?? "auth.test failed" };
    return { ok: true, metadata: { team: json.team } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${SlackDocumentConnector.BASE}/api.test`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) return { ok: false, latencyMs: Date.now() - start };
    const json = (await res.json()) as { ok: boolean };
    return { ok: json.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const limit = opts?.limit ?? 50;
    const params = new URLSearchParams({ channel: this.channelId, limit: String(limit) });
    if (opts?.since !== undefined) {
      // Slack timestamps are Unix seconds (with decimal precision)
      params.set("oldest", String(opts.since / 1000));
    }

    const res = await this.fetchFn(
      `${SlackDocumentConnector.BASE}/conversations.history?${params}`,
      { headers: { Authorization: `Bearer ${this.token}` } },
    );

    if (!res.ok) return;

    const json = (await res.json()) as {
      ok: boolean;
      messages?: { ts: string; text: string; user?: string }[];
    };
    if (!json.ok || !json.messages) return;

    const now = Date.now();
    for (const msg of json.messages) {
      const msgUrl = `https://slack.com/archives/${this.channelId}/p${msg.ts.replace(".", "")}`;
      yield {
        id: makeDocId(this.id, msgUrl),
        title: `Slack message ${msg.ts}`,
        content: msg.text,
        sourceUrl: msgUrl,
        connectorId: this.id,
        syncedAt: now,
        metadata: { ts: msg.ts, user: msg.user },
      };
    }
  }
}

// ── WebDocumentConnector ──────────────────────────────────────────────────────

export interface WebDocumentConnectorConfig {
  /** List of URLs to fetch as text documents */
  urls: string[];
  fetch?: FetchFn;
}

/**
 * Syncs arbitrary web pages via HTTP GET.
 * Yields one SyncedDocument per URL, using the response body as content.
 */
export class WebDocumentConnector extends BaseDocumentConnector {
  readonly id = "web-doc";
  readonly name = "Web";

  private readonly urls: string[];
  private readonly fetchFn: FetchFn;

  constructor(config: WebDocumentConnectorConfig) {
    super();
    this.urls = config.urls;
    this.fetchFn = config.fetch ?? fetch;
  }

  protected async _doConnect(): Promise<ConnectResult> {
    if (this.urls.length === 0) return { ok: true, metadata: { urlCount: 0 } };
    try {
      const res = await this.fetchFn(this.urls[0]!);
      return { ok: res.ok, metadata: { urlCount: this.urls.length } };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    if (this.urls.length === 0) return { ok: true };
    try {
      const res = await this.fetchFn(this.urls[0]!);
      return { ok: res.ok };
    } catch {
      return { ok: false, error: "unreachable" };
    }
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const limit = opts?.limit !== undefined ? opts.limit : this.urls.length;
    const urls = this.urls.slice(0, limit);
    const now = Date.now();

    for (const url of urls) {
      try {
        const res = await this.fetchFn(url);
        if (!res.ok) continue;

        const content = await res.text();

        if (opts?.query && !content.toLowerCase().includes(opts.query.toLowerCase())) continue;

        // Derive a title from the first non-empty line, stripping HTML tags
        const firstLine = content.split("\n").find((l) => l.trim().length > 0) ?? url;
        const title =
          firstLine
            .replace(/<[^>]*>?/g, "")
            .trim()
            .slice(0, 200) || url;

        yield {
          id: makeDocId(this.id, url),
          title,
          content,
          sourceUrl: url,
          connectorId: this.id,
          syncedAt: now,
          metadata: { status: res.status },
        };
      } catch {
        // Skip unreachable URLs silently
      }
    }
  }
}

// ── FileSystemDocumentConnector ───────────────────────────────────────────────

/** Injectable file reader — matches the signature of fs/promises readFile(path, "utf8") */
export type ReadFileFn = (path: string) => Promise<string>;

/** File system document connector config interface definition. */
export interface FileSystemDocumentConnectorConfig {
  /** List of file paths to read */
  paths: string[];
  /** Injectable reader (default: Node's fs/promises readFile with utf-8 encoding) */
  readFile?: ReadFileFn;
}

/**
 * Syncs local files from disk.
 * Yields one SyncedDocument per file; unreadable files are silently skipped.
 * readFile is injectable for full testability without touching the filesystem.
 */
export class FileSystemDocumentConnector extends BaseDocumentConnector {
  readonly id = "fs-doc";
  readonly name = "FileSystem";

  private readonly paths: string[];
  private readonly readFileFn: ReadFileFn;

  constructor(config: FileSystemDocumentConnectorConfig) {
    super();
    this.paths = config.paths;
    this.readFileFn =
      config.readFile ??
      (async (p: string) => {
        const { readFile } = await import("fs/promises");
        return readFile(p, "utf8");
      });
  }

  protected async _doConnect(): Promise<ConnectResult> {
    return { ok: true, metadata: { pathCount: this.paths.length } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    return { ok: true, details: { pathCount: this.paths.length } };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const limit = opts?.limit !== undefined ? opts.limit : this.paths.length;
    const paths = this.paths.slice(0, limit);
    const now = Date.now();

    for (const filePath of paths) {
      try {
        const content = await this.readFileFn(filePath);

        if (opts?.query && !content.toLowerCase().includes(opts.query.toLowerCase())) continue;

        const fileName = filePath.split("/").pop() ?? filePath;
        yield {
          id: makeDocId(this.id, filePath),
          title: fileName,
          content,
          sourceUrl: filePath,
          connectorId: this.id,
          syncedAt: now,
          metadata: { path: filePath },
        };
      } catch {
        // Skip unreadable files silently
      }
    }
  }
}

// ── LinearDocumentConnector ───────────────────────────────────────────────────

export interface LinearDocumentConnectorConfig {
  apiKey: string;
  /** Optional team ID to scope the issue query */
  teamId?: string;
  fetch?: FetchFn;
}

/**
 * Syncs issues from Linear via GraphQL.
 * Yields one SyncedDocument per issue, with description as content.
 */
export class LinearDocumentConnector extends BaseDocumentConnector {
  readonly id = "linear-doc";
  readonly name = "Linear";

  private readonly apiKey: string;
  private readonly teamId?: string;
  private readonly fetchFn: FetchFn;
  private static readonly ENDPOINT = "https://api.linear.app/graphql";

  constructor(config: LinearDocumentConnectorConfig) {
    super();
    this.apiKey = config.apiKey;
    this.teamId = config.teamId;
    this.fetchFn = config.fetch ?? fetch;
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(LinearDocumentConnector.ENDPOINT, {
      method: "POST",
      headers: { Authorization: this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ viewer { id name } }" }),
    });
    if (res.status === 401) return { ok: false, error: "Linear API key is invalid" };
    if (!res.ok) return { ok: false, error: `Linear API returned ${res.status}` };
    const json = (await res.json()) as {
      data?: { viewer?: { id: string; name: string } };
      errors?: unknown[];
    };
    if (json.errors) return { ok: false, error: "GraphQL error" };
    return { ok: true, metadata: { viewer: json.data?.viewer?.name } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(LinearDocumentConnector.ENDPOINT, {
      method: "POST",
      headers: { Authorization: this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ viewer { id } }" }),
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const limit = opts?.limit ?? 50;
    const filters: string[] = [];
    if (this.teamId) filters.push(`team: { id: { eq: "${this.teamId}" } }`);
    if (opts?.query) filters.push(`title: { containsIgnoreCase: "${opts.query}" }`);
    const filterStr = filters.length > 0 ? `, filter: { ${filters.join(", ")} }` : "";
    const gql = `{ issues(first: ${limit}${filterStr}) { nodes { id title description url updatedAt state { name } } } }`;

    const res = await this.fetchFn(LinearDocumentConnector.ENDPOINT, {
      method: "POST",
      headers: { Authorization: this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ query: gql }),
    });

    if (!res.ok) return;

    const json = (await res.json()) as {
      data?: {
        issues?: {
          nodes: {
            id: string;
            title: string;
            description?: string;
            url: string;
            updatedAt: string;
            state?: { name: string };
          }[];
        };
      };
    };

    const nodes = json.data?.issues?.nodes ?? [];
    const now = Date.now();
    const since = opts?.since;

    for (const issue of nodes) {
      if (since !== undefined && new Date(issue.updatedAt).getTime() < since) continue;
      yield {
        id: makeDocId(this.id, issue.url),
        title: issue.title,
        content: issue.description ?? "",
        sourceUrl: issue.url,
        connectorId: this.id,
        syncedAt: now,
        metadata: { linearId: issue.id, state: issue.state?.name },
      };
    }
  }
}

// ── TavilyDocumentConnector ───────────────────────────────────────────────────

export interface TavilyDocumentConnectorConfig {
  apiKey: string;
  /** Search queries to run — each query yields a batch of results */
  queries: string[];
  fetch?: FetchFn;
}

/**
 * Syncs web search results from Tavily.
 * Each query in `queries` produces up to ceil(limit / queries.length) results.
 */
export class TavilyDocumentConnector extends BaseDocumentConnector {
  readonly id = "tavily-doc";
  readonly name = "Tavily";

  private readonly apiKey: string;
  private readonly queries: string[];
  private readonly fetchFn: FetchFn;
  private static readonly BASE = "https://api.tavily.com";

  constructor(config: TavilyDocumentConnectorConfig) {
    super();
    this.apiKey = config.apiKey;
    this.queries = config.queries;
    this.fetchFn = config.fetch ?? fetch;
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const query = this.queries[0] ?? "ping";
    const res = await this.fetchFn(`${TavilyDocumentConnector.BASE}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: this.apiKey, query, search_depth: "basic", max_results: 1 }),
    });
    if (res.status === 401 || res.status === 403)
      return { ok: false, error: "Tavily API key is invalid" };
    if (!res.ok) return { ok: false, error: `Tavily API returned ${res.status}` };
    return { ok: true, metadata: { queryCount: this.queries.length } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${TavilyDocumentConnector.BASE}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: this.apiKey,
        query: "health",
        search_depth: "basic",
        max_results: 1,
      }),
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const queryCount = Math.max(1, this.queries.length);
    const perQueryLimit = opts?.limit !== undefined ? Math.ceil(opts.limit / queryCount) : 5;
    const hardLimit = opts?.limit;
    const now = Date.now();
    let emitted = 0;

    for (const query of this.queries) {
      if (hardLimit !== undefined && emitted >= hardLimit) break;

      const res = await this.fetchFn(`${TavilyDocumentConnector.BASE}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: this.apiKey,
          query,
          search_depth: "basic",
          max_results: perQueryLimit,
        }),
      });

      if (!res.ok) continue;

      const json = (await res.json()) as {
        results?: { title: string; url: string; content: string; score?: number }[];
      };

      for (const result of json.results ?? []) {
        if (hardLimit !== undefined && emitted >= hardLimit) break;
        yield {
          id: makeDocId(this.id, result.url),
          title: result.title,
          content: result.content,
          sourceUrl: result.url,
          connectorId: this.id,
          syncedAt: now,
          metadata: { query, score: result.score },
        };
        emitted++;
      }
    }
  }
}

// ── NeonDocumentConnector ─────────────────────────────────────────────────────

export interface NeonDocumentConnectorConfig {
  /** Neon HTTP endpoint: https://<host>/sql */
  endpointUrl: string;
  /** Database user */
  user: string;
  /** Database password */
  password: string;
  /**
   * SQL query to run during sync.  Must return rows with at least an `id` column.
   * Additional columns (`title`, `content`, `url`) are mapped to SyncedDocument fields.
   */
  query: string;
  fetch?: FetchFn;
}

/** Neon document connector. */
export class NeonDocumentConnector extends BaseDocumentConnector {
  readonly id = "neon-doc";
  readonly name = "Neon";

  private readonly cfg: NeonDocumentConnectorConfig;
  private readonly fetchFn: FetchFn;

  constructor(config: NeonDocumentConnectorConfig) {
    super();
    this.cfg = config;
    this.fetchFn = config.fetch ?? fetch;
  }

  private get authHeader(): string {
    return `Basic ${Buffer.from(`${this.cfg.user}:${this.cfg.password}`).toString("base64")}`;
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(this.cfg.endpointUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: this.authHeader },
      body: JSON.stringify({ query: "SELECT 1 AS ping" }),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: "Neon auth failed" };
    if (!res.ok) return { ok: false, error: `Neon returned ${res.status}` };
    return { ok: true };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(this.cfg.endpointUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: this.authHeader },
      body: JSON.stringify({ query: "SELECT 1" }),
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const res = await this.fetchFn(this.cfg.endpointUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: this.authHeader },
      body: JSON.stringify({ query: this.cfg.query }),
    });
    if (!res.ok) return;

    const json = (await res.json()) as { rows?: Record<string, unknown>[] };
    const rows = json.rows ?? [];
    const now = Date.now();
    let emitted = 0;

    for (const row of rows) {
      if (opts?.limit !== undefined && emitted >= opts.limit) break;
      const id = String(row["id"] ?? `row-${emitted}`);
      const title = String(row["title"] ?? id);
      const content = String(row["content"] ?? "");
      const url = String(row["url"] ?? `neon://${id}`);
      yield {
        id: makeDocId(this.id, url),
        title,
        content,
        sourceUrl: url,
        connectorId: this.id,
        syncedAt: now,
        metadata: row,
      };
      emitted++;
    }
  }
}

// ── RssDocumentConnector ──────────────────────────────────────────────────────

export interface RssDocumentConnectorConfig {
  feedUrl: string;
  fetch?: FetchFn;
}

/** Rss document connector. */
export class RssDocumentConnector extends BaseDocumentConnector {
  readonly id: string;
  readonly name: string;

  private readonly feedUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(config: RssDocumentConnectorConfig) {
    super();
    this.feedUrl = config.feedUrl;
    this.id = `rss-doc::${config.feedUrl}`;
    this.name = `RSS (${config.feedUrl})`;
    this.fetchFn = config.fetch ?? fetch;
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(this.feedUrl);
    if (!res.ok) return { ok: false, error: `Feed returned ${res.status}` };
    const text = await res.text();
    if (!text.includes("<rss") && !text.includes("<feed") && !text.includes("<channel")) {
      return { ok: false, error: "URL does not appear to be an RSS/Atom feed" };
    }
    return { ok: true };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(this.feedUrl);
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const res = await this.fetchFn(this.feedUrl);
    if (!res.ok) return;

    const xml = await res.text();
    const now = Date.now();
    const itemRe = /<(?:item|entry)[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
    const tagRe = (tag: string): RegExp =>
      new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i");

    let count = 0;
    let match: RegExpExecArray | null;

    while ((match = itemRe.exec(xml)) !== null) {
      if (opts?.limit !== undefined && count >= opts.limit) break;
      const block = match[1]!;
      const title = (tagRe("title").exec(block)?.[1] ?? "Untitled").trim();
      const link = (tagRe("link").exec(block)?.[1] ?? tagRe("id").exec(block)?.[1] ?? "").trim();
      const description = (
        tagRe("description").exec(block)?.[1] ??
        tagRe("content").exec(block)?.[1] ??
        tagRe("summary").exec(block)?.[1] ??
        ""
      ).trim();
      const pubDate =
        tagRe("pubDate").exec(block)?.[1] ?? tagRe("published").exec(block)?.[1] ?? "";
      if (!link) continue;
      yield {
        id: makeDocId(this.id, link),
        title,
        content: description,
        sourceUrl: link,
        connectorId: this.id,
        syncedAt: now,
        metadata: { pubDate },
      };
      count++;
    }
  }
}

// ── NotionDocumentConnector ───────────────────────────────────────────────────

export interface NotionDocumentConnectorConfig {
  token: string;
  databaseId: string;
  fetch?: FetchFn;
}

interface NotionPage {
  id: string;
  url?: string;
  last_edited_time?: string;
  properties?: Record<
    string,
    {
      type?: string;
      title?: { plain_text?: string }[];
      rich_text?: { plain_text?: string }[];
    }
  >;
}

function extractNotionTitle(page: NotionPage): string {
  if (!page.properties) return page.id;
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title" && prop.title?.[0]?.plain_text) return prop.title[0].plain_text;
  }
  return page.id;
}

/** Notion document connector. */
export class NotionDocumentConnector extends BaseDocumentConnector {
  readonly id: string;
  readonly name = "Notion";

  private readonly token: string;
  private readonly databaseId: string;
  private readonly fetchFn: FetchFn;
  private static readonly BASE = "https://api.notion.com/v1";
  private static readonly VER = "2022-06-28";

  constructor(config: NotionDocumentConnectorConfig) {
    super();
    this.token = config.token;
    this.databaseId = config.databaseId;
    this.id = `notion-doc::${config.databaseId}`;
    this.fetchFn = config.fetch ?? fetch;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Notion-Version": NotionDocumentConnector.VER,
      "Content-Type": "application/json",
    };
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${NotionDocumentConnector.BASE}/users/me`, {
      headers: this.headers,
    });
    if (res.status === 401) return { ok: false, error: "Notion token invalid" };
    if (!res.ok) return { ok: false, error: `Notion returned ${res.status}` };
    return { ok: true };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${NotionDocumentConnector.BASE}/users/me`, {
      headers: this.headers,
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const pageSize = Math.min(opts?.limit ?? 100, 100);
    const now = Date.now();
    let emitted = 0;
    let cursor: string | undefined;

    do {
      if (opts?.limit !== undefined && emitted >= opts.limit) break;
      const body: Record<string, unknown> = { page_size: pageSize };
      if (cursor) body["start_cursor"] = cursor;
      const res = await this.fetchFn(
        `${NotionDocumentConnector.BASE}/databases/${this.databaseId}/query`,
        { method: "POST", headers: this.headers, body: JSON.stringify(body) },
      );
      if (!res.ok) break;
      const json = (await res.json()) as {
        results?: NotionPage[];
        has_more?: boolean;
        next_cursor?: string | null;
      };
      for (const page of json.results ?? []) {
        if (opts?.limit !== undefined && emitted >= opts.limit) break;
        const title = extractNotionTitle(page);
        const url = page.url ?? `https://notion.so/${page.id.replace(/-/g, "")}`;
        yield {
          id: makeDocId(this.id, page.id),
          title,
          content: title,
          sourceUrl: url,
          connectorId: this.id,
          syncedAt: now,
          metadata: { notionId: page.id, lastEdited: page.last_edited_time },
        };
        emitted++;
      }
      cursor = json.has_more && json.next_cursor ? json.next_cursor : undefined;
    } while (cursor);
  }
}

// ── ConfluenceDocumentConnector ───────────────────────────────────────────────

export interface ConfluenceDocumentConnectorConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  spaceKey: string;
  fetch?: FetchFn;
}

/** Confluence document connector. */
export class ConfluenceDocumentConnector extends BaseDocumentConnector {
  readonly id: string;
  readonly name = "Confluence";

  private readonly cfg: ConfluenceDocumentConnectorConfig;
  private readonly fetchFn: FetchFn;

  constructor(config: ConfluenceDocumentConnectorConfig) {
    super();
    this.cfg = config;
    this.id = `confluence-doc::${config.spaceKey}`;
    this.fetchFn = config.fetch ?? fetch;
  }

  private get authHeader(): string {
    return `Basic ${Buffer.from(`${this.cfg.email}:${this.cfg.apiToken}`).toString("base64")}`;
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${this.cfg.baseUrl}/wiki/rest/api/user/current`, {
      headers: { Authorization: this.authHeader, Accept: "application/json" },
    });
    if (res.status === 401) return { ok: false, error: "Confluence credentials invalid" };
    if (!res.ok) return { ok: false, error: `Confluence returned ${res.status}` };
    const json = (await res.json()) as { displayName?: string };
    return { ok: true, metadata: { user: json.displayName } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${this.cfg.baseUrl}/wiki/rest/api/user/current`, {
      headers: { Authorization: this.authHeader, Accept: "application/json" },
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const batchLimit = 25;
    const now = Date.now();
    let start = 0;
    let emitted = 0;

    while (true) {
      if (opts?.limit !== undefined && emitted >= opts.limit) break;
      const url =
        `${this.cfg.baseUrl}/wiki/rest/api/content` +
        `?spaceKey=${encodeURIComponent(this.cfg.spaceKey)}&type=page` +
        `&expand=body.storage&limit=${batchLimit}&start=${start}`;
      const res = await this.fetchFn(url, {
        headers: { Authorization: this.authHeader, Accept: "application/json" },
      });
      if (!res.ok) break;
      const json = (await res.json()) as {
        results?: {
          id: string;
          title: string;
          body?: { storage?: { value?: string } };
          _links?: { webui?: string };
        }[];
      };
      const pages = json.results ?? [];
      if (pages.length === 0) break;
      for (const page of pages) {
        if (opts?.limit !== undefined && emitted >= opts.limit) break;
        const pageUrl = page._links?.webui
          ? `${this.cfg.baseUrl}/wiki${page._links.webui}`
          : `${this.cfg.baseUrl}/wiki/spaces/${this.cfg.spaceKey}/pages/${page.id}`;
        yield {
          id: makeDocId(this.id, page.id),
          title: page.title,
          content: page.body?.storage?.value ?? "",
          sourceUrl: pageUrl,
          connectorId: this.id,
          syncedAt: now,
          metadata: { confluenceId: page.id, spaceKey: this.cfg.spaceKey },
        };
        emitted++;
      }
      start += pages.length;
      if (pages.length < batchLimit) break;
    }
  }
}

// ── JiraDocumentConnector ─────────────────────────────────────────────────────

export interface JiraDocumentConnectorConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  jql?: string;
  fetch?: FetchFn;
}

function extractJiraText(
  doc: { content?: { content?: { text?: string }[] }[] } | undefined,
): string {
  if (!doc?.content) return "";
  return doc.content
    .flatMap((b) => b.content ?? [])
    .map((i) => i.text ?? "")
    .join(" ")
    .trim();
}

/** Jira document connector. */
export class JiraDocumentConnector extends BaseDocumentConnector {
  readonly id: string;
  readonly name = "Jira";

  private readonly cfg: JiraDocumentConnectorConfig;
  private readonly fetchFn: FetchFn;

  constructor(config: JiraDocumentConnectorConfig) {
    super();
    this.cfg = config;
    this.id = `jira-doc::${new URL(config.baseUrl).hostname}`;
    this.fetchFn = config.fetch ?? fetch;
  }

  private get authHeader(): string {
    return `Basic ${Buffer.from(`${this.cfg.email}:${this.cfg.apiToken}`).toString("base64")}`;
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${this.cfg.baseUrl}/rest/api/3/myself`, {
      headers: { Authorization: this.authHeader, Accept: "application/json" },
    });
    if (res.status === 401) return { ok: false, error: "Jira credentials invalid" };
    if (!res.ok) return { ok: false, error: `Jira returned ${res.status}` };
    const json = (await res.json()) as { displayName?: string };
    return { ok: true, metadata: { user: json.displayName } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${this.cfg.baseUrl}/rest/api/3/myself`, {
      headers: { Authorization: this.authHeader, Accept: "application/json" },
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const jql = opts?.query ?? this.cfg.jql ?? "ORDER BY updated DESC";
    const maxResults = 50;
    const now = Date.now();
    let startAt = 0;
    let emitted = 0;

    while (true) {
      if (opts?.limit !== undefined && emitted >= opts.limit) break;
      const res = await this.fetchFn(`${this.cfg.baseUrl}/rest/api/3/search`, {
        method: "POST",
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          jql,
          fields: ["summary", "description", "status"],
          startAt,
          maxResults,
        }),
      });
      if (!res.ok) break;
      const json = (await res.json()) as {
        issues?: {
          key: string;
          fields?: {
            summary?: string;
            description?: { content?: { content?: { text?: string }[] }[] };
            status?: { name?: string };
          };
        }[];
        total?: number;
      };
      const issues = json.issues ?? [];
      if (issues.length === 0) break;
      for (const issue of issues) {
        if (opts?.limit !== undefined && emitted >= opts.limit) break;
        yield {
          id: makeDocId(this.id, issue.key),
          title: `[${issue.key}] ${issue.fields?.summary ?? "Untitled"}`,
          content: extractJiraText(issue.fields?.description),
          sourceUrl: `${this.cfg.baseUrl}/browse/${issue.key}`,
          connectorId: this.id,
          syncedAt: now,
          metadata: { jiraKey: issue.key, status: issue.fields?.status?.name },
        };
        emitted++;
      }
      startAt += issues.length;
      if (json.total !== undefined && startAt >= json.total) break;
    }
  }
}

// ── GitLabDocumentConnector ───────────────────────────────────────────────────

export interface GitLabDocumentConnectorConfig {
  baseUrl?: string;
  token: string;
  projectId: string | number;
  syncType?: "issues" | "merge_requests" | "both";
  fetch?: FetchFn;
}

/** Git lab document connector. */
export class GitLabDocumentConnector extends BaseDocumentConnector {
  readonly id: string;
  readonly name = "GitLab";

  private readonly baseUrl: string;
  private readonly token: string;
  private readonly projectId: string | number;
  private readonly syncType: "issues" | "merge_requests" | "both";
  private readonly fetchFn: FetchFn;

  constructor(config: GitLabDocumentConnectorConfig) {
    super();
    this.baseUrl = config.baseUrl ?? "https://gitlab.com";
    this.token = config.token;
    this.projectId = config.projectId;
    this.syncType = config.syncType ?? "both";
    this.id = `gitlab-doc::${config.projectId}`;
    this.fetchFn = config.fetch ?? fetch;
  }

  private get apiBase(): string {
    return `${this.baseUrl}/api/v4`;
  }
  private get authHeaders(): Record<string, string> {
    return { "PRIVATE-TOKEN": this.token };
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${this.apiBase}/user`, { headers: this.authHeaders });
    if (res.status === 401) return { ok: false, error: "GitLab token invalid" };
    if (!res.ok) return { ok: false, error: `GitLab returned ${res.status}` };
    const json = (await res.json()) as { username?: string };
    return { ok: true, metadata: { username: json.username } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${this.apiBase}/user`, { headers: this.authHeaders });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const pid = encodeURIComponent(String(this.projectId));
    const now = Date.now();
    let emitted = 0;
    const endpoints: ("issues" | "merge_requests")[] =
      this.syncType === "issues"
        ? ["issues"]
        : this.syncType === "merge_requests"
          ? ["merge_requests"]
          : ["issues", "merge_requests"];

    for (const endpoint of endpoints) {
      let page = 1;
      while (true) {
        if (opts?.limit !== undefined && emitted >= opts.limit) break;
        const res = await this.fetchFn(
          `${this.apiBase}/projects/${pid}/${endpoint}?per_page=50&page=${page}&state=opened`,
          { headers: this.authHeaders },
        );
        if (!res.ok) break;
        const items = (await res.json()) as {
          iid: number;
          title: string;
          description?: string;
          web_url: string;
          state?: string;
        }[];
        if (items.length === 0) break;
        for (const item of items) {
          if (opts?.limit !== undefined && emitted >= opts.limit) break;
          const prefix = endpoint === "issues" ? "Issue" : "MR";
          yield {
            id: makeDocId(this.id, item.web_url),
            title: `[${prefix} #${item.iid}] ${item.title}`,
            content: item.description ?? "",
            sourceUrl: item.web_url,
            connectorId: this.id,
            syncedAt: now,
            metadata: { iid: item.iid, type: endpoint, state: item.state },
          };
          emitted++;
        }
        const nextPage = res.headers?.get?.("x-next-page");
        if (!nextPage) break;
        page++;
      }
    }
  }
}

// ── HackerNewsDocumentConnector ───────────────────────────────────────────────

export interface HackerNewsDocumentConnectorConfig {
  storyType?: "topstories" | "newstories" | "beststories" | "askstories" | "showstories";
  fetch?: FetchFn;
}

/** Hacker news document connector. */
export class HackerNewsDocumentConnector extends BaseDocumentConnector {
  readonly id = "hackernews-doc";
  readonly name = "Hacker News";

  private readonly storyType: string;
  private readonly fetchFn: FetchFn;
  private static readonly BASE = "https://hacker-news.firebaseio.com/v0";

  constructor(config: HackerNewsDocumentConnectorConfig = {}) {
    super();
    this.storyType = config.storyType ?? "topstories";
    this.fetchFn = config.fetch ?? fetch;
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${HackerNewsDocumentConnector.BASE}/${this.storyType}.json`);
    if (!res.ok) return { ok: false, error: `HN API returned ${res.status}` };
    return { ok: true, metadata: { storyType: this.storyType } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${HackerNewsDocumentConnector.BASE}/${this.storyType}.json`);
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const listRes = await this.fetchFn(
      `${HackerNewsDocumentConnector.BASE}/${this.storyType}.json`,
    );
    if (!listRes.ok) return;
    const ids = (await listRes.json()) as number[];
    const limit = opts?.limit ?? 30;
    const now = Date.now();

    for (const id of ids.slice(0, limit)) {
      const itemRes = await this.fetchFn(`${HackerNewsDocumentConnector.BASE}/item/${id}.json`);
      if (!itemRes.ok) continue;
      const item = (await itemRes.json()) as {
        id: number;
        title?: string;
        url?: string;
        text?: string;
        by?: string;
        score?: number;
        type?: string;
      };
      if (!item.title) continue;
      const url = item.url ?? `https://news.ycombinator.com/item?id=${item.id}`;
      yield {
        id: makeDocId(this.id, String(item.id)),
        title: item.title,
        content: item.text ?? item.url ?? "",
        sourceUrl: url,
        connectorId: this.id,
        syncedAt: now,
        metadata: { hnId: item.id, by: item.by, score: item.score, type: item.type },
      };
    }
  }
}

// ── AirtableDocumentConnector ─────────────────────────────────────────────────

export interface AirtableDocumentConnectorConfig {
  /** Airtable personal access token */
  apiKey: string;
  /** Base ID (appXXXXXXXXXXXXXX) */
  baseId: string;
  /** Table name or table ID */
  tableId: string;
  /** Field name to use as content (default: "Notes") */
  contentField?: string;
  /** Field name to use as title (default: "Name") */
  titleField?: string;
  fetch?: FetchFn;
}

/** Airtable document connector. */
export class AirtableDocumentConnector extends BaseDocumentConnector {
  readonly id: string;
  readonly name = "Airtable";

  private readonly cfg: AirtableDocumentConnectorConfig;
  private readonly fetchFn: FetchFn;
  private static readonly BASE = "https://api.airtable.com/v0";

  constructor(config: AirtableDocumentConnectorConfig) {
    super();
    this.cfg = config;
    this.id = `airtable-doc::${config.baseId}/${config.tableId}`;
    this.fetchFn = config.fetch ?? fetch;
  }

  private get headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.apiKey}`, "Content-Type": "application/json" };
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(
      `${AirtableDocumentConnector.BASE}/${this.cfg.baseId}/${encodeURIComponent(this.cfg.tableId)}?maxRecords=1`,
      { headers: this.headers },
    );
    if (res.status === 401 || res.status === 403)
      return { ok: false, error: "Airtable API key invalid" };
    if (!res.ok) return { ok: false, error: `Airtable returned ${res.status}` };
    return { ok: true };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(
      `${AirtableDocumentConnector.BASE}/${this.cfg.baseId}/${encodeURIComponent(this.cfg.tableId)}?maxRecords=1`,
      { headers: this.headers },
    );
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const titleField = this.cfg.titleField ?? "Name";
    const contentField = this.cfg.contentField ?? "Notes";
    const now = Date.now();
    let offset: string | undefined;
    let emitted = 0;

    do {
      if (opts?.limit !== undefined && emitted >= opts.limit) break;
      const params = new URLSearchParams({ pageSize: "100" });
      if (offset) params.set("offset", offset);

      const res = await this.fetchFn(
        `${AirtableDocumentConnector.BASE}/${this.cfg.baseId}/${encodeURIComponent(this.cfg.tableId)}?${params}`,
        { headers: this.headers },
      );
      if (!res.ok) break;

      const json = (await res.json()) as {
        records?: { id: string; fields?: Record<string, unknown> }[];
        offset?: string;
      };
      for (const record of json.records ?? []) {
        if (opts?.limit !== undefined && emitted >= opts.limit) break;
        const fields = record.fields ?? {};
        const title = String(fields[titleField] ?? record.id);
        const content = String(fields[contentField] ?? "");
        const url = `https://airtable.com/${this.cfg.baseId}/${this.cfg.tableId}/${record.id}`;
        yield {
          id: makeDocId(this.id, record.id),
          title,
          content,
          sourceUrl: url,
          connectorId: this.id,
          syncedAt: now,
          metadata: { airtableId: record.id },
        };
        emitted++;
      }
      offset = json.offset;
    } while (offset);
  }
}

// ── AsanaDocumentConnector ────────────────────────────────────────────────────

export interface AsanaDocumentConnectorConfig {
  /** Asana personal access token */
  accessToken: string;
  /** Project GID to sync tasks from */
  projectGid: string;
  fetch?: FetchFn;
}

/** Asana document connector. */
export class AsanaDocumentConnector extends BaseDocumentConnector {
  readonly id: string;
  readonly name = "Asana";

  private readonly token: string;
  private readonly projectGid: string;
  private readonly fetchFn: FetchFn;
  private static readonly BASE = "https://app.asana.com/api/1.0";

  constructor(config: AsanaDocumentConnectorConfig) {
    super();
    this.token = config.accessToken;
    this.projectGid = config.projectGid;
    this.id = `asana-doc::${config.projectGid}`;
    this.fetchFn = config.fetch ?? fetch;
  }

  private get headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, Accept: "application/json" };
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${AsanaDocumentConnector.BASE}/users/me`, {
      headers: this.headers,
    });
    if (res.status === 401) return { ok: false, error: "Asana token invalid" };
    if (!res.ok) return { ok: false, error: `Asana returned ${res.status}` };
    const json = (await res.json()) as { data?: { name?: string; email?: string } };
    return { ok: true, metadata: { user: json.data?.name, email: json.data?.email } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${AsanaDocumentConnector.BASE}/users/me`, {
      headers: this.headers,
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const now = Date.now();
    let cursor: string | undefined;
    let emitted = 0;

    do {
      if (opts?.limit !== undefined && emitted >= opts.limit) break;
      const params = new URLSearchParams({
        project: this.projectGid,
        limit: "100",
        opt_fields: "name,notes,permalink_url",
      });
      if (cursor) params.set("offset", cursor);

      const res = await this.fetchFn(`${AsanaDocumentConnector.BASE}/tasks?${params}`, {
        headers: this.headers,
      });
      if (!res.ok) break;

      const json = (await res.json()) as {
        data?: { gid: string; name?: string; notes?: string; permalink_url?: string }[];
        next_page?: { offset?: string };
      };
      for (const task of json.data ?? []) {
        if (opts?.limit !== undefined && emitted >= opts.limit) break;
        yield {
          id: makeDocId(this.id, task.gid),
          title: task.name ?? task.gid,
          content: task.notes ?? "",
          sourceUrl: task.permalink_url ?? `https://app.asana.com/0/${this.projectGid}/${task.gid}`,
          connectorId: this.id,
          syncedAt: now,
          metadata: { gid: task.gid },
        };
        emitted++;
      }
      cursor = json.next_page?.offset;
    } while (cursor);
  }
}

// ── BitbucketDocumentConnector ────────────────────────────────────────────────

export interface BitbucketDocumentConnectorConfig {
  workspace: string;
  repoSlug: string;
  username: string;
  appPassword: string;
  fetch?: FetchFn;
}

/** Bitbucket document connector. */
export class BitbucketDocumentConnector extends BaseDocumentConnector {
  readonly id: string;
  readonly name = "Bitbucket";

  private readonly cfg: BitbucketDocumentConnectorConfig;
  private readonly fetchFn: FetchFn;
  private static readonly BASE = "https://api.bitbucket.org/2.0";

  constructor(config: BitbucketDocumentConnectorConfig) {
    super();
    this.cfg = config;
    this.id = `bitbucket-doc::${config.workspace}/${config.repoSlug}`;
    this.fetchFn = config.fetch ?? fetch;
  }

  private get authHeader(): string {
    return `Basic ${Buffer.from(`${this.cfg.username}:${this.cfg.appPassword}`).toString("base64")}`;
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${BitbucketDocumentConnector.BASE}/user`, {
      headers: { Authorization: this.authHeader },
    });
    if (res.status === 401) return { ok: false, error: "Bitbucket credentials invalid" };
    if (!res.ok) return { ok: false, error: `Bitbucket returned ${res.status}` };
    const json = (await res.json()) as { display_name?: string };
    return { ok: true, metadata: { user: json.display_name } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${BitbucketDocumentConnector.BASE}/user`, {
      headers: { Authorization: this.authHeader },
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const now = Date.now();
    let url: string | undefined =
      `${BitbucketDocumentConnector.BASE}/repositories/${this.cfg.workspace}/${this.cfg.repoSlug}/issues?pagelen=50`;
    let emitted = 0;

    while (url) {
      if (opts?.limit !== undefined && emitted >= opts.limit) break;
      const res = await this.fetchFn(url, { headers: { Authorization: this.authHeader } });
      if (!res.ok) break;
      const json = (await res.json()) as {
        values?: {
          id: number;
          title: string;
          content?: { raw?: string };
          links?: { html?: { href?: string } };
        }[];
        next?: string;
      };
      for (const issue of json.values ?? []) {
        if (opts?.limit !== undefined && emitted >= opts.limit) break;
        yield {
          id: makeDocId(this.id, String(issue.id)),
          title: `Issue #${issue.id}: ${issue.title}`,
          content: issue.content?.raw ?? "",
          sourceUrl: issue.links?.html?.href ?? "",
          connectorId: this.id,
          syncedAt: now,
          metadata: { issueId: issue.id },
        };
        emitted++;
      }
      url = json.next;
    }
  }
}

// ── BookstackDocumentConnector ────────────────────────────────────────────────

export interface BookstackDocumentConnectorConfig {
  baseUrl: string;
  tokenId: string;
  tokenSecret: string;
  fetch?: FetchFn;
}

/** Bookstack document connector. */
export class BookstackDocumentConnector extends BaseDocumentConnector {
  readonly id: string;
  readonly name = "BookStack";

  private readonly cfg: BookstackDocumentConnectorConfig;
  private readonly fetchFn: FetchFn;

  constructor(config: BookstackDocumentConnectorConfig) {
    super();
    this.cfg = config;
    this.id = `bookstack-doc::${new URL(config.baseUrl).hostname}`;
    this.fetchFn = config.fetch ?? fetch;
  }

  private get authHeader(): string {
    return `Token ${this.cfg.tokenId}:${this.cfg.tokenSecret}`;
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${this.cfg.baseUrl}/api/users?count=1`, {
      headers: { Authorization: this.authHeader },
    });
    if (res.status === 401 || res.status === 403)
      return { ok: false, error: "BookStack token invalid" };
    if (!res.ok) return { ok: false, error: `BookStack returned ${res.status}` };
    return { ok: true };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${this.cfg.baseUrl}/api/users?count=1`, {
      headers: { Authorization: this.authHeader },
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const now = Date.now();
    let page = 1;
    let emitted = 0;

    while (true) {
      if (opts?.limit !== undefined && emitted >= opts.limit) break;
      const res = await this.fetchFn(`${this.cfg.baseUrl}/api/pages?count=50&page=${page}`, {
        headers: { Authorization: this.authHeader },
      });
      if (!res.ok) break;
      const json = (await res.json()) as {
        data?: { id: number; name: string; slug?: string; book_id?: number }[];
        total?: number;
      };
      const pages = json.data ?? [];
      if (pages.length === 0) break;
      for (const p of pages) {
        if (opts?.limit !== undefined && emitted >= opts.limit) break;
        // Fetch page content
        const detail = await this.fetchFn(`${this.cfg.baseUrl}/api/pages/${p.id}`, {
          headers: { Authorization: this.authHeader },
        });
        const content = detail.ok ? (((await detail.json()) as { html?: string }).html ?? "") : "";
        yield {
          id: makeDocId(this.id, String(p.id)),
          title: p.name,
          content,
          sourceUrl: `${this.cfg.baseUrl}/books/${p.book_id}/page/${p.slug ?? p.id}`,
          connectorId: this.id,
          syncedAt: now,
          metadata: { pageId: p.id },
        };
        emitted++;
      }
      if (pages.length < 50) break;
      page++;
    }
  }
}

// ── CanvasDocumentConnector ───────────────────────────────────────────────────

export interface CanvasDocumentConnectorConfig {
  /** Canvas LMS base URL e.g. "https://myschool.instructure.com" */
  baseUrl: string;
  accessToken: string;
  fetch?: FetchFn;
}

/** Canvas document connector. */
export class CanvasDocumentConnector extends BaseDocumentConnector {
  readonly id: string;
  readonly name = "Canvas";

  private readonly cfg: CanvasDocumentConnectorConfig;
  private readonly fetchFn: FetchFn;

  constructor(config: CanvasDocumentConnectorConfig) {
    super();
    this.cfg = config;
    this.id = `canvas-doc::${new URL(config.baseUrl).hostname}`;
    this.fetchFn = config.fetch ?? fetch;
  }

  private get headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.accessToken}` };
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${this.cfg.baseUrl}/api/v1/users/self`, {
      headers: this.headers,
    });
    if (res.status === 401) return { ok: false, error: "Canvas token invalid" };
    if (!res.ok) return { ok: false, error: `Canvas returned ${res.status}` };
    const json = (await res.json()) as { name?: string };
    return { ok: true, metadata: { user: json.name } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${this.cfg.baseUrl}/api/v1/users/self`, {
      headers: this.headers,
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const now = Date.now();
    let emitted = 0;
    // Fetch courses first
    const coursesRes = await this.fetchFn(`${this.cfg.baseUrl}/api/v1/courses?per_page=50`, {
      headers: this.headers,
    });
    if (!coursesRes.ok) return;
    const courses = (await coursesRes.json()) as { id: number; name: string }[];

    for (const course of courses) {
      if (opts?.limit !== undefined && emitted >= opts.limit) break;
      // Fetch announcements per course
      const annRes = await this.fetchFn(
        `${this.cfg.baseUrl}/api/v1/courses/${course.id}/discussion_topics?only_announcements=true&per_page=50`,
        { headers: this.headers },
      );
      if (!annRes.ok) continue;
      const announcements = (await annRes.json()) as {
        id: number;
        title: string;
        message?: string;
        html_url?: string;
      }[];
      for (const ann of announcements) {
        if (opts?.limit !== undefined && emitted >= opts.limit) break;
        yield {
          id: makeDocId(this.id, `${course.id}/${ann.id}`),
          title: `[${course.name}] ${ann.title}`,
          content: ann.message ?? "",
          sourceUrl: ann.html_url ?? "",
          connectorId: this.id,
          syncedAt: now,
          metadata: { courseId: course.id },
        };
        emitted++;
      }
    }
  }
}

// ── ClickUpDocumentConnector ──────────────────────────────────────────────────

export interface ClickUpDocumentConnectorConfig {
  apiKey: string;
  /** Space ID to sync tasks from */
  spaceId: string;
  fetch?: FetchFn;
}

/** Click up document connector. */
export class ClickUpDocumentConnector extends BaseDocumentConnector {
  readonly id: string;
  readonly name = "ClickUp";

  private readonly apiKey: string;
  private readonly spaceId: string;
  private readonly fetchFn: FetchFn;
  private static readonly BASE = "https://api.clickup.com/api/v2";

  constructor(config: ClickUpDocumentConnectorConfig) {
    super();
    this.apiKey = config.apiKey;
    this.spaceId = config.spaceId;
    this.id = `clickup-doc::${config.spaceId}`;
    this.fetchFn = config.fetch ?? fetch;
  }

  private get headers(): Record<string, string> {
    return { Authorization: this.apiKey, "Content-Type": "application/json" };
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${ClickUpDocumentConnector.BASE}/user`, {
      headers: this.headers,
    });
    if (res.status === 401) return { ok: false, error: "ClickUp API key invalid" };
    if (!res.ok) return { ok: false, error: `ClickUp returned ${res.status}` };
    const json = (await res.json()) as { user?: { username?: string } };
    return { ok: true, metadata: { user: json.user?.username } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${ClickUpDocumentConnector.BASE}/user`, {
      headers: this.headers,
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const now = Date.now();
    let emitted = 0;
    // Get lists in space
    const listsRes = await this.fetchFn(
      `${ClickUpDocumentConnector.BASE}/space/${this.spaceId}/list`,
      { headers: this.headers },
    );
    if (!listsRes.ok) return;
    const { lists = [] } = (await listsRes.json()) as {
      lists?: { id: string; name: string }[];
    };

    for (const list of lists) {
      let page = 0;
      while (true) {
        if (opts?.limit !== undefined && emitted >= opts.limit) break;
        const res = await this.fetchFn(
          `${ClickUpDocumentConnector.BASE}/list/${list.id}/task?page=${page}&include_closed=true`,
          { headers: this.headers },
        );
        if (!res.ok) break;
        const json = (await res.json()) as {
          tasks?: { id: string; name: string; description?: string; url?: string }[];
          last_page?: boolean;
        };
        for (const task of json.tasks ?? []) {
          if (opts?.limit !== undefined && emitted >= opts.limit) break;
          yield {
            id: makeDocId(this.id, task.id),
            title: `[${list.name}] ${task.name}`,
            content: task.description ?? "",
            sourceUrl: task.url ?? `https://app.clickup.com/t/${task.id}`,
            connectorId: this.id,
            syncedAt: now,
            metadata: { taskId: task.id, listId: list.id },
          };
          emitted++;
        }
        if (json.last_page) break;
        page++;
      }
    }
  }
}

// ── CodaDocumentConnector ─────────────────────────────────────────────────────

export interface CodaDocumentConnectorConfig {
  apiToken: string;
  /** Coda document ID */
  docId: string;
  fetch?: FetchFn;
}

/** Coda document connector. */
export class CodaDocumentConnector extends BaseDocumentConnector {
  readonly id: string;
  readonly name = "Coda";

  private readonly apiToken: string;
  private readonly docId: string;
  private readonly fetchFn: FetchFn;
  private static readonly BASE = "https://coda.io/apis/v1";

  constructor(config: CodaDocumentConnectorConfig) {
    super();
    this.apiToken = config.apiToken;
    this.docId = config.docId;
    this.id = `coda-doc::${config.docId}`;
    this.fetchFn = config.fetch ?? fetch;
  }

  private get headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiToken}` };
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${CodaDocumentConnector.BASE}/docs/${this.docId}`, {
      headers: this.headers,
    });
    if (res.status === 401 || res.status === 403)
      return { ok: false, error: "Coda API token invalid" };
    if (!res.ok) return { ok: false, error: `Coda returned ${res.status}` };
    const json = (await res.json()) as { name?: string };
    return { ok: true, metadata: { docName: json.name } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${CodaDocumentConnector.BASE}/docs/${this.docId}`, {
      headers: this.headers,
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const now = Date.now();
    let emitted = 0;
    let pageToken: string | undefined;

    do {
      if (opts?.limit !== undefined && emitted >= opts.limit) break;
      const params = new URLSearchParams({ limit: "50" });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await this.fetchFn(
        `${CodaDocumentConnector.BASE}/docs/${this.docId}/pages?${params}`,
        { headers: this.headers },
      );
      if (!res.ok) break;
      const json = (await res.json()) as {
        items?: { id: string; name: string; browserLink?: string }[];
        nextPageToken?: string;
      };
      for (const page of json.items ?? []) {
        if (opts?.limit !== undefined && emitted >= opts.limit) break;
        // Fetch page content export
        const exportRes = await this.fetchFn(
          `${CodaDocumentConnector.BASE}/docs/${this.docId}/pages/${page.id}/export`,
          {
            method: "POST",
            headers: { ...this.headers, "Content-Type": "application/json" },
            body: JSON.stringify({ outputFormat: "markdown" }),
          },
        );
        const content = exportRes.ok
          ? (((await exportRes.json()) as { markdown?: string }).markdown ?? "")
          : "";
        yield {
          id: makeDocId(this.id, page.id),
          title: page.name,
          content,
          sourceUrl: page.browserLink ?? `https://coda.io/d/${this.docId}/${page.id}`,
          connectorId: this.id,
          syncedAt: now,
          metadata: { pageId: page.id },
        };
        emitted++;
      }
      pageToken = json.nextPageToken;
    } while (pageToken);
  }
}

// ── DiscordDocumentConnector ──────────────────────────────────────────────────

export interface DiscordDocumentConnectorConfig {
  /** Discord bot token */
  botToken: string;
  /** Channel IDs to sync messages from */
  channelIds: string[];
  fetch?: FetchFn;
}

/** Discord document connector. */
export class DiscordDocumentConnector extends BaseDocumentConnector {
  readonly id = "discord-doc";
  readonly name = "Discord";

  private readonly botToken: string;
  private readonly channelIds: string[];
  private readonly fetchFn: FetchFn;
  private static readonly BASE = "https://discord.com/api/v10";

  constructor(config: DiscordDocumentConnectorConfig) {
    super();
    this.botToken = config.botToken;
    this.channelIds = config.channelIds;
    this.fetchFn = config.fetch ?? fetch;
  }

  private get headers(): Record<string, string> {
    return { Authorization: `Bot ${this.botToken}` };
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${DiscordDocumentConnector.BASE}/users/@me`, {
      headers: this.headers,
    });
    if (res.status === 401) return { ok: false, error: "Discord bot token invalid" };
    if (!res.ok) return { ok: false, error: `Discord returned ${res.status}` };
    const json = (await res.json()) as { username?: string; id?: string };
    return { ok: true, metadata: { bot: json.username, id: json.id } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${DiscordDocumentConnector.BASE}/users/@me`, {
      headers: this.headers,
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const now = Date.now();
    let emitted = 0;
    const perChannel = opts?.limit
      ? Math.ceil(opts.limit / Math.max(1, this.channelIds.length))
      : 100;

    for (const channelId of this.channelIds) {
      if (opts?.limit !== undefined && emitted >= opts.limit) break;
      let before: string | undefined;
      let fetched = 0;

      while (fetched < perChannel) {
        const params = new URLSearchParams({ limit: "100" });
        if (before) params.set("before", before);
        const res = await this.fetchFn(
          `${DiscordDocumentConnector.BASE}/channels/${channelId}/messages?${params}`,
          { headers: this.headers },
        );
        if (!res.ok) break;
        const messages = (await res.json()) as {
          id: string;
          content?: string;
          author?: { username?: string };
          timestamp?: string;
        }[];
        if (messages.length === 0) break;
        for (const msg of messages) {
          if (opts?.limit !== undefined && emitted >= opts.limit) break;
          if (!msg.content?.trim()) continue;
          yield {
            id: makeDocId(this.id, msg.id),
            title: `Discord message by ${msg.author?.username ?? "unknown"}`,
            content: msg.content,
            sourceUrl: `https://discord.com/channels/${channelId}/${msg.id}`,
            connectorId: this.id,
            syncedAt: now,
            metadata: { channelId, author: msg.author?.username, timestamp: msg.timestamp },
          };
          emitted++;
          fetched++;
        }
        before = messages[messages.length - 1]?.id;
        if (messages.length < 100) break;
      }
    }
  }
}

// ── DiscourseDocumentConnector ────────────────────────────────────────────────

export interface DiscourseDocumentConnectorConfig {
  baseUrl: string;
  apiKey: string;
  apiUsername: string;
  fetch?: FetchFn;
}

/** Discourse document connector. */
export class DiscourseDocumentConnector extends BaseDocumentConnector {
  readonly id: string;
  readonly name = "Discourse";

  private readonly cfg: DiscourseDocumentConnectorConfig;
  private readonly fetchFn: FetchFn;

  constructor(config: DiscourseDocumentConnectorConfig) {
    super();
    this.cfg = config;
    this.id = `discourse-doc::${new URL(config.baseUrl).hostname}`;
    this.fetchFn = config.fetch ?? fetch;
  }

  private get headers(): Record<string, string> {
    return { "Api-Key": this.cfg.apiKey, "Api-Username": this.cfg.apiUsername };
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${this.cfg.baseUrl}/users/${this.cfg.apiUsername}.json`, {
      headers: this.headers,
    });
    if (res.status === 403) return { ok: false, error: "Discourse API key invalid" };
    if (!res.ok) return { ok: false, error: `Discourse returned ${res.status}` };
    return { ok: true };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${this.cfg.baseUrl}/users/${this.cfg.apiUsername}.json`, {
      headers: this.headers,
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const now = Date.now();
    let page = 0;
    let emitted = 0;

    while (true) {
      if (opts?.limit !== undefined && emitted >= opts.limit) break;
      const res = await this.fetchFn(`${this.cfg.baseUrl}/latest.json?page=${page}`, {
        headers: this.headers,
      });
      if (!res.ok) break;
      const json = (await res.json()) as {
        topic_list?: {
          topics?: {
            id: number;
            title: string;
            slug?: string;
            posts_count?: number;
            excerpt?: string;
          }[];
        };
      };
      const topics = json.topic_list?.topics ?? [];
      if (topics.length === 0) break;
      for (const topic of topics) {
        if (opts?.limit !== undefined && emitted >= opts.limit) break;
        yield {
          id: makeDocId(this.id, String(topic.id)),
          title: topic.title,
          content: topic.excerpt ?? "",
          sourceUrl: `${this.cfg.baseUrl}/t/${topic.slug ?? topic.id}/${topic.id}`,
          connectorId: this.id,
          syncedAt: now,
          metadata: { topicId: topic.id, postsCount: topic.posts_count },
        };
        emitted++;
      }
      page++;
    }
  }
}

// ── DropboxDocumentConnector ──────────────────────────────────────────────────

export interface DropboxDocumentConnectorConfig {
  accessToken: string;
  /** Folder path to sync (default: "") meaning root */
  folderPath?: string;
  fetch?: FetchFn;
}

/** Dropbox document connector. */
export class DropboxDocumentConnector extends BaseDocumentConnector {
  readonly id = "dropbox-doc";
  readonly name = "Dropbox";

  private readonly accessToken: string;
  private readonly folderPath: string;
  private readonly fetchFn: FetchFn;

  constructor(config: DropboxDocumentConnectorConfig) {
    super();
    this.accessToken = config.accessToken;
    this.folderPath = config.folderPath ?? "";
    this.fetchFn = config.fetch ?? fetch;
  }

  private get headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" };
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn("https://api.dropboxapi.com/2/users/get_current_account", {
      method: "POST",
      headers: this.headers,
    });
    if (res.status === 401) return { ok: false, error: "Dropbox access token invalid" };
    if (!res.ok) return { ok: false, error: `Dropbox returned ${res.status}` };
    const json = (await res.json()) as { name?: { display_name?: string }; email?: string };
    return { ok: true, metadata: { user: json.name?.display_name, email: json.email } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn("https://api.dropboxapi.com/2/users/get_current_account", {
      method: "POST",
      headers: this.headers,
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const now = Date.now();
    let emitted = 0;
    let cursor: string | undefined;
    let hasMore = true;

    // List folder
    let url = "https://api.dropboxapi.com/2/files/list_folder";
    let body: Record<string, unknown> = { path: this.folderPath, recursive: true, limit: 200 };

    while (hasMore) {
      if (opts?.limit !== undefined && emitted >= opts.limit) break;
      if (cursor) {
        url = "https://api.dropboxapi.com/2/files/list_folder/continue";
        body = { cursor };
      }

      const res = await this.fetchFn(url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) break;
      const json = (await res.json()) as {
        entries?: {
          ".tag"?: string;
          id?: string;
          name?: string;
          path_display?: string;
          path_lower?: string;
        }[];
        has_more?: boolean;
        cursor?: string;
      };

      for (const entry of json.entries ?? []) {
        if (entry[".tag"] !== "file") continue;
        if (opts?.limit !== undefined && emitted >= opts.limit) break;
        yield {
          id: makeDocId(this.id, entry.path_lower ?? entry.id ?? ""),
          title: entry.name ?? "",
          content: "",
          sourceUrl: `https://www.dropbox.com/home${entry.path_display ?? ""}`,
          connectorId: this.id,
          syncedAt: now,
          metadata: { path: entry.path_display },
        };
        emitted++;
      }
      hasMore = json.has_more ?? false;
      cursor = json.cursor;
    }
  }
}

// ── FirefliesDocumentConnector ────────────────────────────────────────────────

export interface FirefliesDocumentConnectorConfig {
  apiKey: string;
  fetch?: FetchFn;
}

/** Fireflies document connector. */
export class FirefliesDocumentConnector extends BaseDocumentConnector {
  readonly id = "fireflies-doc";
  readonly name = "Fireflies";

  private readonly apiKey: string;
  private readonly fetchFn: FetchFn;
  private static readonly BASE = "https://api.fireflies.ai/graphql";

  constructor(config: FirefliesDocumentConnectorConfig) {
    super();
    this.apiKey = config.apiKey;
    this.fetchFn = config.fetch ?? fetch;
  }

  private get headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }

  private async gql(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<{ data?: Record<string, unknown>; errors?: unknown[] }> {
    const res = await this.fetchFn(FirefliesDocumentConnector.BASE, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) return { errors: [{ message: `HTTP ${res.status}` }] };
    return res.json() as Promise<{ data?: Record<string, unknown>; errors?: unknown[] }>;
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const result = await this.gql(`query { user { email name } }`);
    if (result.errors?.length) return { ok: false, error: "Fireflies API key invalid" };
    const user = result.data?.["user"] as Record<string, unknown> | undefined;
    return { ok: true, metadata: { email: user?.["email"], name: user?.["name"] } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const result = await this.gql(`query { user { email } }`);
    return { ok: !result.errors?.length, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const limit = opts?.limit ?? 50;
    const now = Date.now();
    const result = await this.gql(
      `query Transcripts($limit: Int) { transcripts(limit: $limit) { id title date summary { overview } } }`,
      { limit },
    );
    const transcripts =
      (result.data?.["transcripts"] as {
        id: string;
        title?: string;
        date?: string;
        summary?: { overview?: string };
      }[]) ?? [];
    for (const t of transcripts) {
      yield {
        id: makeDocId(this.id, t.id),
        title: t.title ?? t.id,
        content: t.summary?.overview ?? "",
        sourceUrl: `https://app.fireflies.ai/view/${t.id}`,
        connectorId: this.id,
        syncedAt: now,
        metadata: { transcriptId: t.id, date: t.date },
      };
    }
  }
}

// ── FreshdeskDocumentConnector ────────────────────────────────────────────────

export interface FreshdeskDocumentConnectorConfig {
  domain: string;
  apiKey: string;
  fetch?: FetchFn;
}

/** Freshdesk document connector. */
export class FreshdeskDocumentConnector extends BaseDocumentConnector {
  readonly id: string;
  readonly name = "Freshdesk";

  private readonly domain: string;
  private readonly apiKey: string;
  private readonly fetchFn: FetchFn;

  constructor(config: FreshdeskDocumentConnectorConfig) {
    super();
    this.domain = config.domain;
    this.apiKey = config.apiKey;
    this.id = `freshdesk-doc::${config.domain}`;
    this.fetchFn = config.fetch ?? fetch;
  }

  private get authHeader(): string {
    return `Basic ${Buffer.from(`${this.apiKey}:X`).toString("base64")}`;
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`https://${this.domain}.freshdesk.com/api/v2/agents/me`, {
      headers: { Authorization: this.authHeader },
    });
    if (res.status === 401) return { ok: false, error: "Freshdesk API key invalid" };
    if (!res.ok) return { ok: false, error: `Freshdesk returned ${res.status}` };
    const json = (await res.json()) as { contact?: { name?: string } };
    return { ok: true, metadata: { user: json.contact?.name } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`https://${this.domain}.freshdesk.com/api/v2/agents/me`, {
      headers: { Authorization: this.authHeader },
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const now = Date.now();
    let page = 1;
    let emitted = 0;

    while (true) {
      if (opts?.limit !== undefined && emitted >= opts.limit) break;
      const res = await this.fetchFn(
        `https://${this.domain}.freshdesk.com/api/v2/tickets?per_page=100&page=${page}&include=description`,
        { headers: { Authorization: this.authHeader } },
      );
      if (!res.ok) break;
      const tickets = (await res.json()) as {
        id: number;
        subject: string;
        description_text?: string;
        ticket_url?: string;
      }[];
      if (tickets.length === 0) break;
      for (const t of tickets) {
        if (opts?.limit !== undefined && emitted >= opts.limit) break;
        yield {
          id: makeDocId(this.id, String(t.id)),
          title: `Ticket #${t.id}: ${t.subject}`,
          content: t.description_text ?? "",
          sourceUrl: `https://${this.domain}.freshdesk.com/a/tickets/${t.id}`,
          connectorId: this.id,
          syncedAt: now,
          metadata: { ticketId: t.id },
        };
        emitted++;
      }
      if (tickets.length < 100) break;
      page++;
    }
  }
}

// ── GitBookDocumentConnector ──────────────────────────────────────────────────

export interface GitBookDocumentConnectorConfig {
  apiToken: string;
  /** Space ID to sync */
  spaceId: string;
  fetch?: FetchFn;
}

/** Git book document connector. */
export class GitBookDocumentConnector extends BaseDocumentConnector {
  readonly id: string;
  readonly name = "GitBook";

  private readonly apiToken: string;
  private readonly spaceId: string;
  private readonly fetchFn: FetchFn;
  private static readonly BASE = "https://api.gitbook.com/v1";

  constructor(config: GitBookDocumentConnectorConfig) {
    super();
    this.apiToken = config.apiToken;
    this.spaceId = config.spaceId;
    this.id = `gitbook-doc::${config.spaceId}`;
    this.fetchFn = config.fetch ?? fetch;
  }

  private get headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiToken}` };
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${GitBookDocumentConnector.BASE}/user`, {
      headers: this.headers,
    });
    if (res.status === 401) return { ok: false, error: "GitBook token invalid" };
    if (!res.ok) return { ok: false, error: `GitBook returned ${res.status}` };
    const json = (await res.json()) as { displayName?: string; email?: string };
    return { ok: true, metadata: { user: json.displayName, email: json.email } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${GitBookDocumentConnector.BASE}/user`, {
      headers: this.headers,
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const now = Date.now();
    let emitted = 0;
    let next: string | undefined =
      `${GitBookDocumentConnector.BASE}/spaces/${this.spaceId}/content/pages`;

    while (next) {
      if (opts?.limit !== undefined && emitted >= opts.limit) break;
      const res = await this.fetchFn(next, { headers: this.headers });
      if (!res.ok) break;
      const json = (await res.json()) as {
        items?: { id: string; title: string; path?: string; urls?: { app?: string } }[];
        next?: { url?: string };
      };
      for (const page of json.items ?? []) {
        if (opts?.limit !== undefined && emitted >= opts.limit) break;
        yield {
          id: makeDocId(this.id, page.id),
          title: page.title,
          content: "",
          sourceUrl:
            page.urls?.app ?? `https://app.gitbook.com/spaces/${this.spaceId}/pages/${page.id}`,
          connectorId: this.id,
          syncedAt: now,
          metadata: { pageId: page.id, path: page.path },
        };
        emitted++;
      }
      next = json.next?.url;
    }
  }
}

// ── GongDocumentConnector ─────────────────────────────────────────────────────

export interface GongDocumentConnectorConfig {
  accessKey: string;
  accessKeySecret: string;
  fetch?: FetchFn;
}

/** Gong document connector. */
export class GongDocumentConnector extends BaseDocumentConnector {
  readonly id = "gong-doc";
  readonly name = "Gong";

  private readonly accessKey: string;
  private readonly accessKeySecret: string;
  private readonly fetchFn: FetchFn;
  private static readonly BASE = "https://us-11211.api.gong.io";

  constructor(config: GongDocumentConnectorConfig) {
    super();
    this.accessKey = config.accessKey;
    this.accessKeySecret = config.accessKeySecret;
    this.fetchFn = config.fetch ?? fetch;
  }

  private get authHeader(): string {
    return `Basic ${Buffer.from(`${this.accessKey}:${this.accessKeySecret}`).toString("base64")}`;
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${GongDocumentConnector.BASE}/v2/users?limit=1`, {
      headers: { Authorization: this.authHeader },
    });
    if (res.status === 401) return { ok: false, error: "Gong credentials invalid" };
    if (!res.ok) return { ok: false, error: `Gong returned ${res.status}` };
    return { ok: true };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${GongDocumentConnector.BASE}/v2/users?limit=1`, {
      headers: { Authorization: this.authHeader },
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const now = Date.now();
    let emitted = 0;
    let cursor: string | undefined;

    do {
      if (opts?.limit !== undefined && emitted >= opts.limit) break;
      const body: Record<string, unknown> = { limit: 100 };
      if (cursor) body["cursor"] = cursor;
      const res = await this.fetchFn(`${GongDocumentConnector.BASE}/v2/calls`, {
        method: "GET",
        headers: { Authorization: this.authHeader },
      });
      if (!res.ok) break;
      const json = (await res.json()) as {
        calls?: { id: string; title?: string; started?: string; url?: string }[];
        cursor?: string;
      };
      for (const call of json.calls ?? []) {
        if (opts?.limit !== undefined && emitted >= opts.limit) break;
        yield {
          id: makeDocId(this.id, call.id),
          title: call.title ?? `Call ${call.id}`,
          content: "",
          sourceUrl: call.url ?? `https://app.gong.io/call?id=${call.id}`,
          connectorId: this.id,
          syncedAt: now,
          metadata: { callId: call.id, started: call.started },
        };
        emitted++;
      }
      cursor = json.cursor;
    } while (cursor);
  }
}

// ── GoogleDriveDocumentConnector ──────────────────────────────────────────────

export interface GoogleDriveDocumentConnectorConfig {
  /** OAuth2 access token */
  accessToken: string;
  /** Optional folder ID to restrict to (default: "root") */
  folderId?: string;
  fetch?: FetchFn;
}

/** Google drive document connector. */
export class GoogleDriveDocumentConnector extends BaseDocumentConnector {
  readonly id = "gdrive-doc";
  readonly name = "Google Drive";

  private readonly accessToken: string;
  private readonly folderId: string;
  private readonly fetchFn: FetchFn;
  private static readonly BASE = "https://www.googleapis.com/drive/v3";

  constructor(config: GoogleDriveDocumentConnectorConfig) {
    super();
    this.accessToken = config.accessToken;
    this.folderId = config.folderId ?? "root";
    this.fetchFn = config.fetch ?? fetch;
  }

  private get headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: this.headers,
    });
    if (res.status === 401) return { ok: false, error: "Google access token invalid" };
    if (!res.ok) return { ok: false, error: `Google returned ${res.status}` };
    const json = (await res.json()) as { name?: string; email?: string };
    return { ok: true, metadata: { user: json.name, email: json.email } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: this.headers,
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const now = Date.now();
    let emitted = 0;
    let pageToken: string | undefined;

    do {
      if (opts?.limit !== undefined && emitted >= opts.limit) break;
      const params = new URLSearchParams({
        q: `'${this.folderId}' in parents and trashed=false`,
        fields: "nextPageToken,files(id,name,webViewLink,mimeType)",
        pageSize: "100",
      });
      if (pageToken) params.set("pageToken", pageToken);

      const res = await this.fetchFn(`${GoogleDriveDocumentConnector.BASE}/files?${params}`, {
        headers: this.headers,
      });
      if (!res.ok) break;
      const json = (await res.json()) as {
        files?: { id: string; name: string; webViewLink?: string; mimeType?: string }[];
        nextPageToken?: string;
      };
      for (const file of json.files ?? []) {
        if (opts?.limit !== undefined && emitted >= opts.limit) break;
        yield {
          id: makeDocId(this.id, file.id),
          title: file.name,
          content: "",
          sourceUrl: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}`,
          connectorId: this.id,
          syncedAt: now,
          metadata: { fileId: file.id, mimeType: file.mimeType },
        };
        emitted++;
      }
      pageToken = json.nextPageToken;
    } while (pageToken);
  }
}

// ── GuruDocumentConnector ─────────────────────────────────────────────────────

export interface GuruDocumentConnectorConfig {
  username: string;
  apiToken: string;
  fetch?: FetchFn;
}

/** Guru document connector. */
export class GuruDocumentConnector extends BaseDocumentConnector {
  readonly id = "guru-doc";
  readonly name = "Guru";

  private readonly username: string;
  private readonly apiToken: string;
  private readonly fetchFn: FetchFn;
  private static readonly BASE = "https://api.getguru.com/api/v1";

  constructor(config: GuruDocumentConnectorConfig) {
    super();
    this.username = config.username;
    this.apiToken = config.apiToken;
    this.fetchFn = config.fetch ?? fetch;
  }

  private get authHeader(): string {
    return `Basic ${Buffer.from(`${this.username}:${this.apiToken}`).toString("base64")}`;
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${GuruDocumentConnector.BASE}/whoami`, {
      headers: { Authorization: this.authHeader },
    });
    if (res.status === 401) return { ok: false, error: "Guru credentials invalid" };
    if (!res.ok) return { ok: false, error: `Guru returned ${res.status}` };
    const json = (await res.json()) as { email?: string };
    return { ok: true, metadata: { email: json.email } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${GuruDocumentConnector.BASE}/whoami`, {
      headers: { Authorization: this.authHeader },
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const now = Date.now();
    let page = 0;
    let emitted = 0;

    while (true) {
      if (opts?.limit !== undefined && emitted >= opts.limit) break;
      const res = await this.fetchFn(
        `${GuruDocumentConnector.BASE}/search/cardmgr?q=&queryType=search&maxResults=50&page=${page}`,
        { headers: { Authorization: this.authHeader } },
      );
      if (!res.ok) break;
      const cards = (await res.json()) as {
        preferredPhrase?: string;
        id?: string;
        content?: { text?: string };
        htmlContent?: string;
        shareLink?: string;
      }[];
      if (cards.length === 0) break;
      for (const card of cards) {
        if (opts?.limit !== undefined && emitted >= opts.limit) break;
        yield {
          id: makeDocId(this.id, card.id ?? ""),
          title: card.preferredPhrase ?? card.id ?? "",
          content: card.content?.text ?? "",
          sourceUrl: card.shareLink ?? `https://app.getguru.com/cards/${card.id}`,
          connectorId: this.id,
          syncedAt: now,
          metadata: { cardId: card.id },
        };
        emitted++;
      }
      if (cards.length < 50) break;
      page++;
    }
  }
}

// ── HubSpotDocumentConnector ──────────────────────────────────────────────────

export interface HubSpotDocumentConnectorConfig {
  accessToken: string;
  /** Object types to sync. Default: ["contacts"] */
  objectTypes?: ("contacts" | "companies" | "deals" | "tickets")[];
  fetch?: FetchFn;
}

/** Hub spot document connector. */
export class HubSpotDocumentConnector extends BaseDocumentConnector {
  readonly id = "hubspot-doc";
  readonly name = "HubSpot";

  private readonly accessToken: string;
  private readonly objectTypes: ("contacts" | "companies" | "deals" | "tickets")[];
  private readonly fetchFn: FetchFn;
  private static readonly BASE = "https://api.hubapi.com";

  constructor(config: HubSpotDocumentConnectorConfig) {
    super();
    this.accessToken = config.accessToken;
    this.objectTypes = config.objectTypes ?? ["contacts"];
    this.fetchFn = config.fetch ?? fetch;
  }

  private get headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" };
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${HubSpotDocumentConnector.BASE}/crm/v3/owners/`, {
      headers: this.headers,
    });
    if (res.status === 401) return { ok: false, error: "HubSpot token invalid" };
    if (!res.ok) return { ok: false, error: `HubSpot returned ${res.status}` };
    return { ok: true };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${HubSpotDocumentConnector.BASE}/crm/v3/owners/`, {
      headers: this.headers,
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const now = Date.now();
    let emitted = 0;

    for (const objType of this.objectTypes) {
      let after: string | undefined;
      while (true) {
        if (opts?.limit !== undefined && emitted >= opts.limit) break;
        const params = new URLSearchParams({ limit: "100" });
        if (after) params.set("after", after);
        const res = await this.fetchFn(
          `${HubSpotDocumentConnector.BASE}/crm/v3/objects/${objType}?${params}`,
          { headers: this.headers },
        );
        if (!res.ok) break;
        const json = (await res.json()) as {
          results?: { id: string; properties?: Record<string, string | null> }[];
          paging?: { next?: { after?: string } };
        };
        for (const obj of json.results ?? []) {
          if (opts?.limit !== undefined && emitted >= opts.limit) break;
          const props = obj.properties ?? {};
          const title = props["name"] ?? props["firstname"] ?? props["subject"] ?? obj.id;
          const content = props["description"] ?? props["notes_last_contacted"] ?? "";
          yield {
            id: makeDocId(this.id, `${objType}/${obj.id}`),
            title: `[${objType}] ${title}`,
            content: content ?? "",
            sourceUrl: `https://app.hubspot.com/contacts/${objType}/${obj.id}`,
            connectorId: this.id,
            syncedAt: now,
            metadata: { objectType: objType, objectId: obj.id },
          };
          emitted++;
        }
        after = json.paging?.next?.after;
        if (!after) break;
      }
    }
  }
}

// ── ImapDocumentConnector ─────────────────────────────────────────────────────
// Note: Full IMAP requires a socket connection (not fetch-based).
// This connector uses an injectable queryFn that abstracts the IMAP protocol,
// enabling testing without a real mail server.

export interface ImapMessage {
  uid: string;
  subject: string;
  from: string;
  date: string;
  text: string;
}

/** Imap query fn type alias. */
export type ImapQueryFn = (opts: { mailbox?: string; limit?: number }) => Promise<ImapMessage[]>;

/** Imap document connector config interface definition. */
export interface ImapDocumentConnectorConfig {
  host: string;
  port?: number;
  user: string;
  password: string;
  mailbox?: string;
  /** Injectable IMAP query function — avoids hard dependency on imap library */
  queryFn?: ImapQueryFn;
  fetch?: FetchFn;
}

/** Imap document connector. */
export class ImapDocumentConnector extends BaseDocumentConnector {
  readonly id: string;
  readonly name = "IMAP Email";

  private readonly cfg: ImapDocumentConnectorConfig;
  private readonly queryFn: ImapQueryFn;

  constructor(config: ImapDocumentConnectorConfig) {
    super();
    this.cfg = config;
    this.id = `imap-doc::${config.user}@${config.host}`;
    // Default query fn signals not connected
    this.queryFn = config.queryFn ?? (() => Promise.resolve([]));
  }

  protected async _doConnect(): Promise<ConnectResult> {
    // Without a queryFn, we can't verify the connection; treat as ok when queryFn provided
    if (this.cfg.queryFn) {
      try {
        await this.queryFn({ mailbox: this.cfg.mailbox ?? "INBOX", limit: 1 });
        return { ok: true, metadata: { host: this.cfg.host, user: this.cfg.user } };
      } catch (err) {
        return { ok: false, error: `IMAP connect failed: ${String(err)}` };
      }
    }
    return { ok: true, metadata: { note: "no queryFn provided — configure a real IMAP adapter" } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    try {
      await this.queryFn({ mailbox: this.cfg.mailbox ?? "INBOX", limit: 1 });
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const now = Date.now();
    const messages = await this.queryFn({
      mailbox: this.cfg.mailbox ?? "INBOX",
      limit: opts?.limit,
    });
    for (const msg of messages) {
      yield {
        id: makeDocId(this.id, msg.uid),
        title: msg.subject || "(no subject)",
        content: msg.text,
        sourceUrl: `imap://${this.cfg.host}/${this.cfg.mailbox ?? "INBOX"}/${msg.uid}`,
        connectorId: this.id,
        syncedAt: now,
        metadata: { from: msg.from, date: msg.date, uid: msg.uid },
      };
    }
  }
}

// ── LoopiODocumentConnector ───────────────────────────────────────────────────

export interface LoopiODocumentConnectorConfig {
  apiKey: string;
  fetch?: FetchFn;
}

/** Loopi o document connector. */
export class LoopiODocumentConnector extends BaseDocumentConnector {
  readonly id = "loopio-doc";
  readonly name = "Loopio";

  private readonly apiKey: string;
  private readonly fetchFn: FetchFn;
  private static readonly BASE = "https://api.loopio.com/data/2.0";

  constructor(config: LoopiODocumentConnectorConfig) {
    super();
    this.apiKey = config.apiKey;
    this.fetchFn = config.fetch ?? fetch;
  }

  private get headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${LoopiODocumentConnector.BASE}/entries?limit=1`, {
      headers: this.headers,
    });
    if (res.status === 401 || res.status === 403)
      return { ok: false, error: "Loopio API key invalid" };
    if (!res.ok) return { ok: false, error: `Loopio returned ${res.status}` };
    return { ok: true };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${LoopiODocumentConnector.BASE}/entries?limit=1`, {
      headers: this.headers,
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const now = Date.now();
    let offset = 0;
    let emitted = 0;

    while (true) {
      if (opts?.limit !== undefined && emitted >= opts.limit) break;
      const res = await this.fetchFn(
        `${LoopiODocumentConnector.BASE}/entries?limit=50&offset=${offset}`,
        { headers: this.headers },
      );
      if (!res.ok) break;
      const json = (await res.json()) as {
        items?: { id: number; question?: string; answer?: string; tags?: string[] }[];
      };
      const items = json.items ?? [];
      if (items.length === 0) break;
      for (const entry of items) {
        if (opts?.limit !== undefined && emitted >= opts.limit) break;
        yield {
          id: makeDocId(this.id, String(entry.id)),
          title: entry.question ?? `Entry ${entry.id}`,
          content: entry.answer ?? "",
          sourceUrl: `https://app.loopio.com/library/${entry.id}`,
          connectorId: this.id,
          syncedAt: now,
          metadata: { entryId: entry.id, tags: entry.tags },
        };
        emitted++;
      }
      offset += items.length;
      if (items.length < 50) break;
    }
  }
}

// ── MediaWikiDocumentConnector ────────────────────────────────────────────────

export interface MediaWikiDocumentConnectorConfig {
  /** MediaWiki API endpoint e.g. "https://en.wikipedia.org/w/api.php" */
  apiUrl: string;
  /** Category to list pages from (without "Category:" prefix) */
  category?: string;
  /** Specific page titles to sync instead of category listing */
  pageTitles?: string[];
  fetch?: FetchFn;
}

/** Media wiki document connector. */
export class MediaWikiDocumentConnector extends BaseDocumentConnector {
  readonly id: string;
  readonly name = "MediaWiki";

  private readonly cfg: MediaWikiDocumentConnectorConfig;
  private readonly fetchFn: FetchFn;

  constructor(config: MediaWikiDocumentConnectorConfig) {
    super();
    this.cfg = config;
    this.id = `mediawiki-doc::${new URL(config.apiUrl).hostname}`;
    this.fetchFn = config.fetch ?? fetch;
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(
      `${this.cfg.apiUrl}?action=query&meta=siteinfo&siprop=general&format=json`,
    );
    if (!res.ok) return { ok: false, error: `MediaWiki returned ${res.status}` };
    const json = (await res.json()) as { query?: { general?: { sitename?: string } } };
    return { ok: true, metadata: { site: json.query?.general?.sitename } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${this.cfg.apiUrl}?action=query&meta=siteinfo&format=json`);
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const now = Date.now();
    let emitted = 0;
    let titles: string[];

    if (this.cfg.pageTitles && this.cfg.pageTitles.length > 0) {
      titles = this.cfg.pageTitles;
    } else if (this.cfg.category) {
      // List pages in category
      const res = await this.fetchFn(
        `${this.cfg.apiUrl}?action=query&list=categorymembers&cmtitle=Category:${encodeURIComponent(this.cfg.category)}&cmlimit=500&format=json`,
      );
      if (!res.ok) return;
      const json = (await res.json()) as { query?: { categorymembers?: { title: string }[] } };
      titles = (json.query?.categorymembers ?? []).map((m) => m.title);
    } else {
      return;
    }

    for (const title of titles) {
      if (opts?.limit !== undefined && emitted >= opts.limit) break;
      const res = await this.fetchFn(
        `${this.cfg.apiUrl}?action=query&titles=${encodeURIComponent(title)}&prop=extracts&exintro=true&explaintext=true&format=json`,
      );
      if (!res.ok) continue;
      const json = (await res.json()) as {
        query?: { pages?: Record<string, { extract?: string; pageid?: number }> };
      };
      const pages = Object.values(json.query?.pages ?? {});
      for (const page of pages) {
        const url = `${new URL(this.cfg.apiUrl).origin}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
        yield {
          id: makeDocId(this.id, title),
          title,
          content: page.extract ?? "",
          sourceUrl: url,
          connectorId: this.id,
          syncedAt: now,
          metadata: { pageId: page.pageid },
        };
        emitted++;
      }
    }
  }
}

// ── SharePointDocumentConnector ───────────────────────────────────────────────

export interface SharePointDocumentConnectorConfig {
  /** SharePoint site URL e.g. "https://tenant.sharepoint.com/sites/mysite" */
  siteUrl: string;
  /** OAuth2 access token (Microsoft Graph) */
  accessToken: string;
  /** Drive ID (default: "root" drive) */
  driveId?: string;
  fetch?: FetchFn;
}

/** Share point document connector. */
export class SharePointDocumentConnector extends BaseDocumentConnector {
  readonly id: string;
  readonly name = "SharePoint";

  private readonly cfg: SharePointDocumentConnectorConfig;
  private readonly fetchFn: FetchFn;
  private static readonly GRAPH = "https://graph.microsoft.com/v1.0";

  constructor(config: SharePointDocumentConnectorConfig) {
    super();
    this.cfg = config;
    this.id = `sharepoint-doc::${new URL(config.siteUrl).hostname}`;
    this.fetchFn = config.fetch ?? fetch;
  }

  private get headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.accessToken}` };
  }

  private get siteId(): string {
    const u = new URL(this.cfg.siteUrl);
    // Graph API requires hostname:relative-path format
    return `${u.hostname}:${u.pathname}`;
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${SharePointDocumentConnector.GRAPH}/sites/${this.siteId}`, {
      headers: this.headers,
    });
    if (res.status === 401) return { ok: false, error: "SharePoint access token invalid" };
    if (!res.ok) return { ok: false, error: `SharePoint returned ${res.status}` };
    const json = (await res.json()) as { displayName?: string };
    return { ok: true, metadata: { site: json.displayName } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${SharePointDocumentConnector.GRAPH}/sites/${this.siteId}`, {
      headers: this.headers,
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const now = Date.now();
    let emitted = 0;
    const driveBase = this.cfg.driveId
      ? `${SharePointDocumentConnector.GRAPH}/sites/${this.siteId}/drives/${this.cfg.driveId}`
      : `${SharePointDocumentConnector.GRAPH}/sites/${this.siteId}/drive`;

    let next: string | undefined =
      `${driveBase}/root/children?$top=100&$select=id,name,webUrl,file`;

    while (next) {
      if (opts?.limit !== undefined && emitted >= opts.limit) break;
      const res = await this.fetchFn(next, { headers: this.headers });
      if (!res.ok) break;
      const json = (await res.json()) as {
        value?: { id: string; name: string; webUrl?: string; file?: unknown }[];
        "@odata.nextLink"?: string;
      };
      for (const item of json.value ?? []) {
        if (!item.file) continue; // skip folders
        if (opts?.limit !== undefined && emitted >= opts.limit) break;
        yield {
          id: makeDocId(this.id, item.id),
          title: item.name,
          content: "",
          sourceUrl: item.webUrl ?? "",
          connectorId: this.id,
          syncedAt: now,
          metadata: { fileId: item.id },
        };
        emitted++;
      }
      next = json["@odata.nextLink"];
    }
  }
}

// ── ZendeskDocumentConnector ──────────────────────────────────────────────────

export interface ZendeskDocumentConnectorConfig {
  subdomain: string;
  email: string;
  apiToken: string;
  fetch?: FetchFn;
}

/** Zendesk document connector. */
export class ZendeskDocumentConnector extends BaseDocumentConnector {
  readonly id: string;
  readonly name = "Zendesk";

  private readonly cfg: ZendeskDocumentConnectorConfig;
  private readonly fetchFn: FetchFn;

  constructor(config: ZendeskDocumentConnectorConfig) {
    super();
    this.cfg = config;
    this.id = `zendesk-doc::${config.subdomain}`;
    this.fetchFn = config.fetch ?? fetch;
  }

  private get apiBase(): string {
    return `https://${this.cfg.subdomain}.zendesk.com/api/v2`;
  }
  private get authHeader(): string {
    return `Basic ${Buffer.from(`${this.cfg.email}/token:${this.cfg.apiToken}`).toString("base64")}`;
  }

  protected async _doConnect(): Promise<ConnectResult> {
    const res = await this.fetchFn(`${this.apiBase}/users/me.json`, {
      headers: { Authorization: this.authHeader },
    });
    if (res.status === 401) return { ok: false, error: "Zendesk credentials invalid" };
    if (!res.ok) return { ok: false, error: `Zendesk returned ${res.status}` };
    const json = (await res.json()) as { user?: { name?: string; email?: string } };
    return { ok: true, metadata: { user: json.user?.name, email: json.user?.email } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }> {
    const start = Date.now();
    const res = await this.fetchFn(`${this.apiBase}/users/me.json`, {
      headers: { Authorization: this.authHeader },
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  }

  protected async *_doSync(opts?: SyncOptions): AsyncIterable<SyncedDocument> {
    const now = Date.now();
    let emitted = 0;
    let url: string | undefined =
      `${this.apiBase}/tickets.json?per_page=100&sort_by=updated_at&sort_order=desc`;

    while (url) {
      if (opts?.limit !== undefined && emitted >= opts.limit) break;
      const res = await this.fetchFn(url, { headers: { Authorization: this.authHeader } });
      if (!res.ok) break;
      const json = (await res.json()) as {
        tickets?: {
          id: number;
          subject: string;
          description?: string;
          url?: string;
          status?: string;
        }[];
        next_page?: string;
      };
      for (const t of json.tickets ?? []) {
        if (opts?.limit !== undefined && emitted >= opts.limit) break;
        yield {
          id: makeDocId(this.id, String(t.id)),
          title: `Ticket #${t.id}: ${t.subject}`,
          content: t.description ?? "",
          sourceUrl: `https://${this.cfg.subdomain}.zendesk.com/agent/tickets/${t.id}`,
          connectorId: this.id,
          syncedAt: now,
          metadata: { ticketId: t.id, status: t.status },
        };
        emitted++;
      }
      url = json.next_page ?? undefined;
    }
  }
}
