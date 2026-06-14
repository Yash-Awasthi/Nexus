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

export type ConnectorStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error"
  | "disabled";

export interface ConnectResult {
  ok: boolean;
  /** Short error description when ok:false */
  error?: string;
  /** Provider-specific metadata: authed user, available scopes, rate limits, etc. */
  metadata?: Record<string, unknown>;
}

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
  protected abstract _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs"> & { latencyMs?: number }>;

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

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs">> {
    return { ok: true };
  }
}

// ── GitHubConnector ────────────────────────────────────────────────────────────

export interface GitHubConnectorConfig {
  /** GitHub Personal Access Token */
  token: string;
  fetch?: FetchFn;
}

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

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs">> {
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
    const json = (await res.json()) as { ok: boolean; error?: string; team?: string; user?: string; bot_id?: string };
    if (!json.ok) return { ok: false, error: json.error ?? "auth.test failed" };
    return { ok: true, metadata: { team: json.team, user: json.user, botId: json.bot_id } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs">> {
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

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs">> {
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

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs">> {
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

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs">> {
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

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs">> {
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
      errors?: Array<{ message: string }>;
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

export interface HealthCheckAllResult {
  results: Record<string, HealthCheckResult>;
  healthy: number;
  unhealthy: number;
}

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

export interface SyncOptions {
  /** Max documents to emit (default: connector-specific) */
  limit?: number;
  /** Only yield documents updated after this Unix timestamp (ms) */
  since?: number;
  /** Optional search/filter query for connectors that support it */
  query?: string;
}

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

export abstract class BaseDocumentConnector
  extends BaseConnector
  implements DocumentConnector
{
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

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs">> {
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

    const issues = (await res.json()) as Array<{
      number: number;
      title: string;
      body?: string;
      html_url: string;
      updated_at: string;
      state: string;
      pull_request?: unknown;
    }>;

    const now = Date.now();
    const since = opts?.since;

    for (const issue of issues) {
      if (since !== undefined && new Date(issue.updated_at).getTime() < since) continue;

      if (opts?.query) {
        const q = opts.query.toLowerCase();
        if (
          !issue.title.toLowerCase().includes(q) &&
          !(issue.body ?? "").toLowerCase().includes(q)
        )
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

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs">> {
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
      messages?: Array<{ ts: string; text: string; user?: string }>;
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

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs">> {
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
        const title = firstLine.replace(/<[^>]*>/g, "").trim().slice(0, 200) || url;

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

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs">> {
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

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs">> {
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
          nodes: Array<{
            id: string;
            title: string;
            description?: string;
            url: string;
            updatedAt: string;
            state?: { name: string };
          }>;
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
    if (res.status === 401 || res.status === 403) return { ok: false, error: "Tavily API key is invalid" };
    if (!res.ok) return { ok: false, error: `Tavily API returned ${res.status}` };
    return { ok: true, metadata: { queryCount: this.queries.length } };
  }

  protected async _doHealthCheck(): Promise<Omit<HealthCheckResult, "latencyMs">> {
    const start = Date.now();
    const res = await this.fetchFn(`${TavilyDocumentConnector.BASE}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: this.apiKey, query: "health", search_depth: "basic", max_results: 1 }),
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
        results?: Array<{ title: string; url: string; content: string; score?: number }>;
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
