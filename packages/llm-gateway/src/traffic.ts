// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/llm-gateway — traffic logging with sensitive-data masking
 * (LLM Interceptor / LLI parity slice).
 *
 * The gateway forwards, caches, rate-limits, and retries — but nothing
 * observes the traffic. LLI's distinctive mechanic is the proxy-layer
 * microscope: record every request/response pair, mask API keys and
 * secrets, and group records into sessions. This module provides the
 * masking primitives, a session id resolver, and a `TrafficLogger` that
 * emits masked `TrafficRecord`s to an injectable sink — wired into
 * `LLMGateway` via `GatewayConfig.onTraffic`.
 *
 * Masking contract: header names and body keys matching
 * /authorization|api[_-]?key|token|secret|password|credential/i have
 * their values replaced with "***", and string values containing bearer
 * tokens or sk-* keys are masked at the value level. The masked key
 * names are listed on the record so operators can audit what was hidden.
 *
 * Usage
 * ─────
 * ```ts
 * const gateway = new LLMGateway({
 *   upstreams: [...],
 *   onTraffic: (record) => db.insertTraffic(record),
 * });
 * ```
 */

export interface TrafficRecord {
  sessionId: string;
  timestamp: string;
  method: string;
  path: string;
  upstream: string;
  status: number;
  cached: boolean;
  latencyMs: number;
  request: { headers: Record<string, string>; body?: unknown };
  response: { headers: Record<string, string>; body?: unknown };
  /** Header/body keys whose values were masked. */
  maskedKeys: string[];
}

export type TrafficSink = (record: TrafficRecord) => void | Promise<void>;

const SECRET_KEY_RE = /authorization|api[_-]?key|token|secret|password|credential/i;
const SECRET_VALUE_RE = /Bearer\s+\S+|sk-[A-Za-z0-9_-]+/g;
const MASK = "***";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Mask header values whose names look sensitive. Returns the masked keys. */
export function maskSensitiveHeaders(headers: Record<string, string>): {
  headers: Record<string, string>;
  masked: string[];
} {
  const out: Record<string, string> = {};
  const masked: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = MASK;
      masked.push(key);
    } else {
      out[key] = value;
    }
  }
  return { headers: out, masked };
}

/** Mask sensitive body keys recursively plus bearer/sk-* values. */
export function maskSensitiveBody(body: unknown): { body: unknown; masked: string[] } {
  const masked: string[] = [];
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (isRecord(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        if (SECRET_KEY_RE.test(key)) {
          out[key] = MASK;
          masked.push(key);
        } else {
          out[key] = walk(val);
        }
      }
      return out;
    }
    if (typeof value === "string" && SECRET_VALUE_RE.test(value)) {
      return value.replace(SECRET_VALUE_RE, MASK);
    }
    return value;
  };
  return { body: walk(body), masked };
}

/** Resolve a session id from request headers (LLI's session grouping). */
export function sessionIdFor(headers: Record<string, string>): string {
  const raw =
    headers["x-lli-session"] ?? headers["x-session-id"] ?? headers["x-request-id"] ?? "default";
  return raw.trim() || "default";
}

/**
 * Emits masked traffic records to a sink. Sink failures are swallowed so
 * observation never breaks the gateway itself.
 */
export class TrafficLogger {
  constructor(private readonly sink: TrafficSink) {}

  record(input: {
    request: { method: string; path: string; headers: Record<string, string>; body?: unknown };
    response: { status: number; headers: Record<string, string>; body?: unknown };
    upstream: string;
    cached: boolean;
    latencyMs: number;
  }): void {
    const reqMask = maskSensitiveHeaders(input.request.headers);
    const resMask = maskSensitiveHeaders(input.response.headers);
    const reqBody = maskSensitiveBody(input.request.body);
    const resBody = maskSensitiveBody(input.response.body);

    const record: TrafficRecord = {
      sessionId: sessionIdFor(input.request.headers),
      timestamp: new Date().toISOString(),
      method: input.request.method,
      path: input.request.path,
      upstream: input.upstream,
      status: input.response.status,
      cached: input.cached,
      latencyMs: input.latencyMs,
      request: { headers: reqMask.headers, body: reqBody.body },
      response: { headers: resMask.headers, body: resBody.body },
      maskedKeys: [...reqMask.masked, ...resMask.masked, ...reqBody.masked, ...resBody.masked],
    };
    try {
      void Promise.resolve(this.sink(record)).catch(() => {});
    } catch {
      // Synchronous throw from the sink — observation never breaks the gateway.
    }
  }
}
