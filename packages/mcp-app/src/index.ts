// SPDX-License-Identifier: Apache-2.0
/**
 * mcp-app — FastMCP-style Model Context Protocol application framework.
 *
 * Provides:
 *   • McpTool     — define tools with typed input schemas and handlers
 *   • McpResource — define resources (files, URIs) serveable over MCP
 *   • McpPrompt   — define reusable prompt templates
 *   • McpServer   — register tools/resources/prompts and dispatch requests
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type JsonSchemaType = "string" | "number" | "boolean" | "object" | "array" | "null";

export interface JsonSchemaProperty {
  type: JsonSchemaType;
  description?: string;
  enum?: (string | number)[];
  items?: JsonSchemaProperty;
}

export interface InputSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: InputSchema;
}

export type ToolResult =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "error"; text: string };

export type ToolHandler = (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;

// ── Progress notifications ────────────────────────────────────────────────────
// Mirrors the MCP spec's notifications/progress message so long-running tools
// can stream progress to the caller (fastmcp ctx.reportProgress() pattern).

export interface McpProgressNotification {
  /** Opaque token issued per invocation; echoed in every update. */
  progressToken: string;
  /** Units of work completed. */
  progress: number;
  /** Total units (omit when unknown). */
  total?: number;
}

export type ProgressCallback = (n: McpProgressNotification) => void | Promise<void>;

/** Injected into progress-aware handlers so they can emit progress updates. */
export interface ToolContext {
  readonly progressToken: string;
  /**
   * Emit a progress update toward the caller's ProgressCallback.
   * Fire-and-forget — errors in the callback are swallowed.
   */
  reportProgress(progress: number, total?: number): void;
}

/**
 * Progress-aware tool handler.  Accepts both args and a ToolContext.
 * Old ToolHandler implementations still work (extra arg silently ignored).
 */
export type ProgressAwareHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => ToolResult | Promise<ToolResult>;

// ── McpTool ───────────────────────────────────────────────────────────────────

export class McpTool {
  readonly definition: McpToolDefinition;
  // Stored as ProgressAwareHandler (superset of ToolHandler) so both signatures work
  private handler: ProgressAwareHandler;

  constructor(definition: McpToolDefinition, handler: ToolHandler | ProgressAwareHandler) {
    this.definition = definition;
    this.handler = handler as ProgressAwareHandler;
  }

  /**
   * Invoke the tool.  If `ctx` is provided it is forwarded to the handler;
   * old-style handlers (arity 1) silently ignore the second argument.
   */
  async call(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const effectiveCtx: ToolContext = ctx ?? {
      progressToken: "",
      reportProgress: () => { /* no-op when called without a context */ },
    };
    return this.handler(args, effectiveCtx);
  }
}

// ── McpResource ───────────────────────────────────────────────────────────────

export interface McpResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export type ResourceReader = (uri: string) => { content: string; mimeType?: string } | Promise<{ content: string; mimeType?: string }>;

export class McpResource {
  readonly definition: McpResourceDefinition;
  private reader: ResourceReader;

  constructor(definition: McpResourceDefinition, reader: ResourceReader) {
    this.definition = definition;
    this.reader = reader;
  }

  async read(): Promise<{ content: string; mimeType?: string }> {
    return this.reader(this.definition.uri);
  }
}

// ── McpPrompt ─────────────────────────────────────────────────────────────────

export interface McpPromptDefinition {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export type PromptBuilder = (args: Record<string, string>) => string | Promise<string>;

export class McpPrompt {
  readonly definition: McpPromptDefinition;
  private builder: PromptBuilder;

  constructor(definition: McpPromptDefinition, builder: PromptBuilder) {
    this.definition = definition;
    this.builder = builder;
  }

  async render(args: Record<string, string> = {}): Promise<string> {
    return this.builder(args);
  }
}

// ── McpError ──────────────────────────────────────────────────────────────────

export class McpError extends Error {
  constructor(
    public readonly code: "TOOL_NOT_FOUND" | "RESOURCE_NOT_FOUND" | "PROMPT_NOT_FOUND" | "VALIDATION_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "McpError";
  }
}

// ── McpAuthError ──────────────────────────────────────────────────────────────

export type McpAuthErrorCode = "UNAUTHORIZED" | "FORBIDDEN" | "TOKEN_EXPIRED";

export class McpAuthError extends Error {
  constructor(
    public readonly code: McpAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "McpAuthError";
  }
}

// ── McpOAuthProvider ──────────────────────────────────────────────────────────

export interface OAuthToken {
  accessToken: string;
  tokenType: string;
  /** Unix epoch ms when this token expires. */
  expiresAt: number;
  scopes: string[];
}

export interface McpOAuthProviderOptions {
  clientId: string;
  clientSecret: string;
  /** Token endpoint URL (e.g. https://auth.example.com/oauth/token). */
  tokenUrl: string;
  scopes?: string[];
  /** Injectable fetch (defaults to global fetch). */
  fetchFn?: typeof fetch;
}

export class McpOAuthProvider {
  private clientId:     string;
  private clientSecret: string;
  private tokenUrl:     string;
  private scopes:       string[];
  private fetchFn:      typeof fetch;
  /** In-memory token cache keyed by access_token. */
  private tokenCache = new Map<string, OAuthToken>();

  constructor(opts: McpOAuthProviderOptions) {
    this.clientId     = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.tokenUrl     = opts.tokenUrl;
    this.scopes       = opts.scopes ?? [];
    this.fetchFn      = opts.fetchFn ?? fetch;
  }

  /**
   * Exchange an authorization code for an access token.
   * Posts to the configured tokenUrl using client_credentials flow.
   */
  async exchangeCode(code: string, redirectUri: string): Promise<OAuthToken> {
    const body = new URLSearchParams({
      grant_type:    "authorization_code",
      code,
      redirect_uri:  redirectUri,
      client_id:     this.clientId,
      client_secret: this.clientSecret,
    });

    const res = await this.fetchFn(this.tokenUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    body.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new McpAuthError("UNAUTHORIZED", `OAuth token exchange failed: ${res.status} ${text}`);
    }

    const data = await res.json() as {
      access_token:  string;
      token_type?:   string;
      expires_in?:   number;
      scope?:        string;
    };

    const token: OAuthToken = {
      accessToken: data.access_token,
      tokenType:   data.token_type ?? "Bearer",
      expiresAt:   Date.now() + (data.expires_in ?? 3600) * 1000,
      scopes:      data.scope ? data.scope.split(" ") : this.scopes,
    };

    this.tokenCache.set(token.accessToken, token);
    return token;
  }

  /**
   * Validate an access token — returns true when the token is known and
   * has not yet expired, false otherwise.  Removes expired tokens from cache.
   */
  validate(token: string): boolean {
    const cached = this.tokenCache.get(token);
    if (!cached) return false;
    if (Date.now() >= cached.expiresAt) {
      this.tokenCache.delete(token);
      return false;
    }
    return true;
  }

  /**
   * Introspect a token: returns the cached OAuthToken or null when unknown /
   * expired.  Can be overridden in subclasses to call a remote introspection
   * endpoint.
   */
  introspect(token: string): OAuthToken | null {
    if (!this.validate(token)) return null;
    return this.tokenCache.get(token) ?? null;
  }

  /** Store a pre-validated token (e.g. from an external introspection call). */
  store(token: OAuthToken): void {
    this.tokenCache.set(token.accessToken, token);
  }

  /** Revoke a token from the local cache. */
  revoke(token: string): void {
    this.tokenCache.delete(token);
  }
}

// ── McpServer ─────────────────────────────────────────────────────────────────

export interface McpServerInfo {
  name: string;
  version: string;
  description?: string;
}

export class McpServer {
  private tools        = new Map<string, McpTool>();
  private resources    = new Map<string, McpResource>();
  private prompts      = new Map<string, McpPrompt>();
  private oauthProvider: McpOAuthProvider | null = null;

  constructor(public readonly info: McpServerInfo) {}

  // ── Registration ──────────────────────────────────────────────────────────

  tool(definition: McpToolDefinition, handler: ToolHandler): this {
    this.tools.set(definition.name, new McpTool(definition, handler));
    return this;
  }

  resource(definition: McpResourceDefinition, reader: ResourceReader): this {
    this.resources.set(definition.uri, new McpResource(definition, reader));
    return this;
  }

  prompt(definition: McpPromptDefinition, builder: PromptBuilder): this {
    this.prompts.set(definition.name, new McpPrompt(definition, builder));
    return this;
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  listTools(): McpToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  listResources(): McpResourceDefinition[] {
    return [...this.resources.values()].map((r) => r.definition);
  }

  listPrompts(): McpPromptDefinition[] {
    return [...this.prompts.values()].map((p) => p.definition);
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  /**
   * Call a registered tool.
   *
   * @param onProgress  Optional callback invoked whenever the handler calls
   *                    ctx.reportProgress().  Enables the server to relay MCP
   *                    notifications/progress events to a connected client.
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    onProgress?: ProgressCallback,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new McpError("TOOL_NOT_FOUND", `Tool not found: ${name}`);

    // Build a ToolContext for this invocation
    const progressToken = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ctx: ToolContext = {
      progressToken,
      reportProgress: (progress, total) => {
        if (!onProgress) return;
        void Promise.resolve(
          onProgress({ progressToken, progress, total }),
        ).catch(() => { /* progress errors are non-fatal */ });
      },
    };

    return tool.call(args, ctx);
  }

  async readResource(uri: string): Promise<{ content: string; mimeType?: string }> {
    const resource = this.resources.get(uri);
    if (!resource) throw new McpError("RESOURCE_NOT_FOUND", `Resource not found: ${uri}`);
    return resource.read();
  }

  async renderPrompt(name: string, args: Record<string, string> = {}): Promise<string> {
    const prompt = this.prompts.get(name);
    if (!prompt) throw new McpError("PROMPT_NOT_FOUND", `Prompt not found: ${name}`);
    return prompt.render(args);
  }

  hasTool(name: string): boolean { return this.tools.has(name); }
  hasResource(uri: string): boolean { return this.resources.has(uri); }
  hasPrompt(name: string): boolean { return this.prompts.has(name); }

  // ── OAuth ──────────────────────────────────────────────────────────────────

  /**
   * Attach an OAuth provider to this server.  Once set, callers can use
   * `callToolWithAuth()` to enforce token validation before dispatch.
   * Returns `this` for fluent chaining.
   */
  requireOAuth(provider: McpOAuthProvider): this {
    this.oauthProvider = provider;
    return this;
  }

  getOAuthProvider(): McpOAuthProvider | null { return this.oauthProvider; }

  /**
   * Validate the supplied bearer token via the attached OAuth provider, then
   * dispatch to `callTool`.  Throws `McpAuthError` when:
   *   • No OAuth provider is attached (UNAUTHORIZED)
   *   • Token is absent or blank (UNAUTHORIZED)
   *   • Provider rejects / token is expired (TOKEN_EXPIRED or UNAUTHORIZED)
   */
  async callToolWithAuth(
    name: string,
    args: Record<string, unknown> = {},
    bearerToken: string | undefined,
    onProgress?: ProgressCallback,
  ): Promise<ToolResult> {
    if (!this.oauthProvider) {
      throw new McpAuthError("UNAUTHORIZED", "No OAuth provider configured on this McpServer");
    }
    if (!bearerToken || bearerToken.trim() === "") {
      throw new McpAuthError("UNAUTHORIZED", "Bearer token is required");
    }

    const token = bearerToken.replace(/^Bearer\s+/i, "").trim();
    const introspected = this.oauthProvider.introspect(token);

    if (!introspected) {
      throw new McpAuthError("TOKEN_EXPIRED", "Bearer token is invalid or expired");
    }

    return this.callTool(name, args, onProgress);
  }
}
