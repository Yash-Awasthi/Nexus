// SPDX-License-Identifier: Apache-2.0

// ── Route types ───────────────────────────────────────────────────────────────

export interface RouteEntry {
  alias: string;
  /** Resolved model ID (e.g. "gpt-4o", "claude-3-5-sonnet-20241022"). */
  model: string;
  /** Provider name (e.g. "openai", "anthropic"). */
  provider: string;
  /** True if this entry is a runtime override, not a static config. */
  overridden: boolean;
  addedAt: number;
}

// ── Stats types ───────────────────────────────────────────────────────────────

export interface AliasStats {
  alias: string;
  requests: number;
  totalTokens: number;
  errors: number;
  /** Running average latency in ms. */
  avgLatencyMs: number;
  lastUsedAt?: number;
}

export interface RecordRequestOpts {
  tokens?: number;
  latencyMs?: number;
  error?: boolean;
}

// ── Admin request/response (framework-agnostic) ───────────────────────────────

export interface AdminRequest<TBody = unknown> {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  params?: Record<string, string>;
  body?: TBody;
}

export interface AdminResponse<TBody = unknown> {
  status: number;
  body: TBody;
}

// ── Error ─────────────────────────────────────────────────────────────────────

export class AdminGatewayError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(message: string, code: string, statusCode = 400) {
    super(message);
    this.name = "AdminGatewayError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ── GatewayAdminService ───────────────────────────────────────────────────────

export class GatewayAdminService {
  /** Static routes loaded from config. */
  private readonly _static = new Map<string, Omit<RouteEntry, "alias" | "overridden">>();
  /** Runtime overrides — take precedence over static routes. */
  private readonly _overrides = new Map<string, { model: string; addedAt: number }>();
  /** Per-alias stats. */
  private readonly _stats = new Map<string, AliasStats>();

  // ── Route management ────────────────────────────────────────────────────────

  /** Register a static route (from config). */
  addRoute(alias: string, model: string, provider: string): void {
    if (!alias.trim()) throw new AdminGatewayError("alias must be non-empty", "INVALID_ALIAS");
    if (!model.trim()) throw new AdminGatewayError("model must be non-empty", "INVALID_MODEL");
    this._static.set(alias, { model, provider, addedAt: Date.now() });
  }

  removeRoute(alias: string): boolean {
    const had = this._static.has(alias);
    this._static.delete(alias);
    this._overrides.delete(alias);
    return had;
  }

  /** Override an alias at runtime (does not require a static entry). */
  overrideAlias(alias: string, model: string): void {
    if (!alias.trim()) throw new AdminGatewayError("alias must be non-empty", "INVALID_ALIAS");
    if (!model.trim()) throw new AdminGatewayError("model must be non-empty", "INVALID_MODEL");
    this._overrides.set(alias, { model, addedAt: Date.now() });
  }

  /** Remove a runtime override, reverting to the static route. Returns false if no override existed. */
  removeOverride(alias: string): boolean {
    return this._overrides.delete(alias);
  }

  /** Resolve an alias → RouteEntry (override takes precedence). Returns undefined if unknown. */
  resolveAlias(alias: string): RouteEntry | undefined {
    const override = this._overrides.get(alias);
    if (override) {
      const base = this._static.get(alias);
      return {
        alias,
        model: override.model,
        provider: base?.provider ?? "unknown",
        overridden: true,
        addedAt: override.addedAt,
      };
    }
    const base = this._static.get(alias);
    if (!base) return undefined;
    return { alias, ...base, overridden: false };
  }

  /** List all known routes (static + any override-only entries). */
  listRoutes(): RouteEntry[] {
    const all = new Map<string, RouteEntry>();
    for (const [alias, base] of this._static) {
      all.set(alias, { alias, ...base, overridden: this._overrides.has(alias) });
    }
    for (const [alias, override] of this._overrides) {
      if (!all.has(alias)) {
        all.set(alias, {
          alias,
          model: override.model,
          provider: "unknown",
          overridden: true,
          addedAt: override.addedAt,
        });
      }
    }
    return Array.from(all.values()).sort((a, b) => a.alias.localeCompare(b.alias));
  }

  hasAlias(alias: string): boolean {
    return this._static.has(alias) || this._overrides.has(alias);
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

  recordRequest(alias: string, opts: RecordRequestOpts = {}): void {
    let s = this._stats.get(alias);
    if (!s) {
      s = { alias, requests: 0, totalTokens: 0, errors: 0, avgLatencyMs: 0 };
      this._stats.set(alias, s);
    }
    s.requests++;
    if (opts.error) s.errors++;
    if (opts.tokens !== undefined) s.totalTokens += opts.tokens;
    if (opts.latencyMs !== undefined) {
      // Running average
      s.avgLatencyMs = (s.avgLatencyMs * (s.requests - 1) + opts.latencyMs) / s.requests;
    }
    s.lastUsedAt = Date.now();
  }

  getStats(alias?: string): AliasStats[] {
    if (alias !== undefined) {
      const s = this._stats.get(alias);
      return s ? [{ ...s }] : [{ alias, requests: 0, totalTokens: 0, errors: 0, avgLatencyMs: 0 }];
    }
    return Array.from(this._stats.values())
      .map((s) => ({ ...s }))
      .sort((a, b) => a.alias.localeCompare(b.alias));
  }

  resetStats(alias?: string): void {
    if (alias !== undefined) {
      this._stats.delete(alias);
    } else {
      this._stats.clear();
    }
  }
}

// ── AdminRouter ───────────────────────────────────────────────────────────────

/**
 * Framework-agnostic admin HTTP router.
 * Call `handle(req)` from any HTTP framework adapter.
 */
export class AdminRouter {
  constructor(private readonly service: GatewayAdminService) {}

  handle<T = unknown>(req: AdminRequest): AdminResponse<T> {
    try {
      return this._route(req) as AdminResponse<T>;
    } catch (err) {
      if (err instanceof AdminGatewayError) {
        return { status: err.statusCode, body: { error: err.message, code: err.code } } as AdminResponse<T>;
      }
      return { status: 500, body: { error: "Internal error" } } as AdminResponse<T>;
    }
  }

  private _route(req: AdminRequest): AdminResponse {
    const { method, path } = req;

    // GET /routes
    if (method === "GET" && path === "/routes") {
      return { status: 200, body: { routes: this.service.listRoutes() } };
    }

    // GET /routes/:alias
    const routeMatch = path.match(/^\/routes\/([^/]+)$/);
    if (routeMatch) {
      const alias = decodeURIComponent(routeMatch[1]!);

      if (method === "GET") {
        const route = this.service.resolveAlias(alias);
        if (!route) return { status: 404, body: { error: `Unknown alias: ${alias}` } };
        return { status: 200, body: { route } };
      }

      if (method === "PATCH") {
        const body = req.body as { model?: string } | undefined;
        if (!body?.model) {
          throw new AdminGatewayError("body.model is required", "MISSING_MODEL");
        }
        this.service.overrideAlias(alias, body.model);
        return { status: 200, body: { route: this.service.resolveAlias(alias) } };
      }

      if (method === "DELETE") {
        const removed = this.service.removeOverride(alias);
        return {
          status: removed ? 200 : 404,
          body: removed ? { ok: true } : { error: `No override for alias: ${alias}` },
        };
      }
    }

    // GET /stats
    if (method === "GET" && path === "/stats") {
      return { status: 200, body: { stats: this.service.getStats() } };
    }

    // GET /stats/:alias
    const statsMatch = path.match(/^\/stats\/([^/]+)$/);
    if (statsMatch && method === "GET") {
      const alias = decodeURIComponent(statsMatch[1]!);
      return { status: 200, body: { stats: this.service.getStats(alias)[0] } };
    }

    // POST /stats/reset
    if (method === "POST" && path === "/stats/reset") {
      const body = req.body as { alias?: string } | undefined;
      this.service.resetStats(body?.alias);
      return { status: 200, body: { ok: true } };
    }

    return { status: 404, body: { error: `Unknown route: ${method} ${path}` } };
  }
}
