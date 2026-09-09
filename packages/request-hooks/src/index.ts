// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/request-hooks — Before/after request hooks for LLM guardrails.
 *
 * Inspired by Portkey's gateway hook system.
 * Provides extensible hook points for input validation, output sanitization,
 * logging, metrics, and custom guardrails on LLM requests.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface LLMRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens?: number;
  temperature?: number;
  metadata?: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage?: { promptTokens: number; completionTokens: number };
  latencyMs: number;
  metadata?: Record<string, unknown>;
}

export type HookResult<T> = {
  proceed: boolean;
  data: T;
  reason?: string;
};

export type BeforeRequestHook = (
  request: LLMRequest,
) => Promise<HookResult<LLMRequest>> | HookResult<LLMRequest>;
export type AfterRequestHook = (
  request: LLMRequest,
  response: LLMResponse,
) => Promise<HookResult<LLMResponse>> | HookResult<LLMResponse>;

// ── Hook Registry ────────────────────────────────────────────────────────────

export class RequestHookRegistry {
  private beforeHooks: Array<{ name: string; hook: BeforeRequestHook; priority: number }> = [];
  private afterHooks: Array<{ name: string; hook: AfterRequestHook; priority: number }> = [];

  /**
   * Register a before-request hook.
   */
  addBeforeHook(name: string, hook: BeforeRequestHook, priority: number = 10): void {
    this.beforeHooks.push({ name, hook, priority });
    this.beforeHooks.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Register an after-request hook.
   */
  addAfterHook(name: string, hook: AfterRequestHook, priority: number = 10): void {
    this.afterHooks.push({ name, hook, priority });
    this.afterHooks.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Remove a hook by name.
   */
  removeHook(name: string): void {
    this.beforeHooks = this.beforeHooks.filter((h) => h.name !== name);
    this.afterHooks = this.afterHooks.filter((h) => h.name !== name);
  }

  /**
   * Run all before-request hooks.
   */
  async runBeforeHooks(request: LLMRequest): Promise<HookResult<LLMRequest>> {
    let current = { proceed: true, data: request };

    for (const { name, hook } of this.beforeHooks) {
      if (!current.proceed) break;

      try {
        const result = await hook(current.data);
        if (!result.proceed) {
          return {
            proceed: false,
            data: current.data,
            reason: `Blocked by ${name}: ${result.reason}`,
          };
        }
        current = { ...current, data: result.data };
      } catch (err) {
        return {
          proceed: false,
          data: current.data,
          reason: `Hook ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    return current;
  }

  /**
   * Run all after-request hooks.
   */
  async runAfterHooks(
    request: LLMRequest,
    response: LLMResponse,
  ): Promise<HookResult<LLMResponse>> {
    let current = { proceed: true, data: response };

    for (const { name, hook } of this.afterHooks) {
      if (!current.proceed) break;

      try {
        const result = await hook(request, current.data);
        if (!result.proceed) {
          return {
            proceed: false,
            data: current.data,
            reason: `Blocked by ${name}: ${result.reason}`,
          };
        }
        current = { ...current, data: result.data };
      } catch (err) {
        return {
          proceed: false,
          data: current.data,
          reason: `Hook ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    return current;
  }

  /**
   * List all registered hooks.
   */
  list(): { before: string[]; after: string[] } {
    return {
      before: this.beforeHooks.map((h) => h.name),
      after: this.afterHooks.map((h) => h.name),
    };
  }
}

// ── Built-in Hooks ───────────────────────────────────────────────────────────

/**
 * Block requests containing forbidden content.
 */
export function contentFilterHook(forbiddenPatterns: RegExp[]): BeforeRequestHook {
  return (request) => {
    for (const msg of request.messages) {
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(msg.content)) {
          return {
            proceed: false,
            data: request,
            reason: `Content matches forbidden pattern: ${pattern.source}`,
          };
        }
      }
    }
    return { proceed: true, data: request };
  };
}

/**
 * Log all requests and responses.
 */
export function loggingHook(logger: (msg: string) => void = console.log): {
  before: BeforeRequestHook;
  after: AfterRequestHook;
} {
  return {
    before: (request) => {
      logger(`[LLM Request] model=${request.model} messages=${request.messages.length}`);
      return { proceed: true, data: request };
    },
    after: (request, response) => {
      logger(
        `[LLM Response] model=${response.model} latency=${response.latencyMs}ms tokens=${response.usage?.completionTokens ?? "?"}`,
      );
      return { proceed: true, data: response };
    },
  };
}

/**
 * Enforce token limits on requests.
 */
export function tokenLimitHook(maxTokens: number): BeforeRequestHook {
  return (request) => {
    if (request.maxTokens && request.maxTokens > maxTokens) {
      return { proceed: true, data: { ...request, maxTokens } };
    }
    return { proceed: true, data: request };
  };
}

/**
 * Redact PII from responses.
 */
export function piiRedactionHook(): AfterRequestHook {
  const patterns = [
    { regex: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: "[SSN-REDACTED]" },
    { regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, replacement: "[CARD-REDACTED]" },
    {
      regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
      replacement: "[EMAIL-REDACTED]",
    },
  ];

  return (_request, response) => {
    let redacted = response.content;
    for (const { regex, replacement } of patterns) {
      redacted = redacted.replace(regex, replacement);
    }
    return { proceed: true, data: { ...response, content: redacted } };
  };
}

/**
 * Rate limit hook — limit requests per time window.
 */
export function rateLimitHook(maxRequests: number, windowMs: number): BeforeRequestHook {
  const timestamps: number[] = [];

  return (request) => {
    const now = Date.now();
    const cutoff = now - windowMs;

    // Remove old timestamps
    while (timestamps.length > 0 && timestamps[0]! < cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= maxRequests) {
      return {
        proceed: false,
        data: request,
        reason: `Rate limit exceeded: ${timestamps.length}/${maxRequests} requests in ${windowMs}ms`,
      };
    }

    timestamps.push(now);
    return { proceed: true, data: request };
  };
}

export default RequestHookRegistry;
