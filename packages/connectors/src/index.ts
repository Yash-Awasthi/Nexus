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
