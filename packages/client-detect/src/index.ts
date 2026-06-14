// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/client-detect — Gateway client-type detection.
 *
 * Detects whether the gateway caller is Claude Code, Cursor, VS Code extension,
 * a browser, or a raw API call based on User-Agent and custom header patterns.
 * Enables per-client response formatting (e.g. compact JSON for IDEs, rich markdown
 * for browsers, tool-call format for code agents).
 *
 * Detection priority:
 *   1. x-nexus-client header (explicit, highest confidence)
 *   2. user-agent string matching (heuristic)
 *   3. Accept header hints
 *   4. Default: "unknown"
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ClientType =
  | "claude-code"   // Anthropic Claude Code agent
  | "cursor"        // Cursor IDE
  | "vscode"        // VS Code extension
  | "browser"       // Web browser (Chat UI)
  | "cli"           // curl / httpie / raw CLI
  | "sdk"           // Nexus SDK / programmatic
  | "unknown";      // Unrecognised

export interface DetectionResult {
  clientType: ClientType;
  confidence: "high" | "medium" | "low";
  /** Raw signal that triggered detection. */
  signal: string;
  /** Recommended response format for this client. */
  responseFormat: ResponseFormat;
}

export type ResponseFormat = "markdown" | "plain" | "json" | "tool-calls";

const FORMAT_MAP: Record<ClientType, ResponseFormat> = {
  "claude-code":  "tool-calls",
  "cursor":       "tool-calls",
  "vscode":       "plain",
  "browser":      "markdown",
  "cli":          "plain",
  "sdk":          "json",
  "unknown":      "markdown",
};

// ── Detection patterns ────────────────────────────────────────────────────────

interface UAPattern { pattern: RegExp; clientType: ClientType; confidence: "high" | "medium" | "low" }

const UA_PATTERNS: UAPattern[] = [
  { pattern: /claude[-_]code/i,      clientType: "claude-code", confidence: "high" },
  { pattern: /cursor\//i,            clientType: "cursor",      confidence: "high" },
  { pattern: /vscode\//i,            clientType: "vscode",      confidence: "high" },
  { pattern: /visual studio code/i,  clientType: "vscode",      confidence: "high" },
  { pattern: /nexus[-_]sdk/i,        clientType: "sdk",         confidence: "high" },
  { pattern: /\bcurl\//i,            clientType: "cli",         confidence: "medium" },
  { pattern: /httpie\//i,            clientType: "cli",         confidence: "medium" },
  { pattern: /python-httpx/i,        clientType: "sdk",         confidence: "medium" },
  { pattern: /node-fetch/i,          clientType: "sdk",         confidence: "medium" },
  { pattern: /axios\//i,             clientType: "sdk",         confidence: "medium" },
  { pattern: /mozilla\/5\.0/i,       clientType: "browser",     confidence: "medium" },
  { pattern: /chrome\//i,            clientType: "browser",     confidence: "medium" },
  { pattern: /firefox\//i,           clientType: "browser",     confidence: "medium" },
  { pattern: /safari\//i,            clientType: "browser",     confidence: "low" },
];

// ── detectClient ──────────────────────────────────────────────────────────────

export interface RequestHeaders {
  [key: string]: string | string[] | undefined;
}

function headerVal(headers: RequestHeaders, key: string): string {
  const v = headers[key] ?? headers[key.toLowerCase()];
  return Array.isArray(v) ? v[0] ?? "" : (v ?? "");
}

export function detectClient(headers: RequestHeaders): DetectionResult {
  // 1. Explicit header
  const explicit = headerVal(headers, "x-nexus-client") || headerVal(headers, "x-client-type");
  if (explicit) {
    const ct = explicit.toLowerCase() as ClientType;
    const validTypes: ClientType[] = ["claude-code", "cursor", "vscode", "browser", "cli", "sdk", "unknown"];
    if (validTypes.includes(ct)) {
      return { clientType: ct, confidence: "high", signal: `x-nexus-client: ${explicit}`, responseFormat: FORMAT_MAP[ct] };
    }
  }

  // 2. User-Agent heuristics
  const ua = headerVal(headers, "user-agent") || headerVal(headers, "User-Agent");
  if (ua) {
    for (const { pattern, clientType, confidence } of UA_PATTERNS) {
      if (pattern.test(ua)) {
        return { clientType, confidence, signal: `user-agent: ${ua}`, responseFormat: FORMAT_MAP[clientType] };
      }
    }
  }

  // 3. Accept header hints
  const accept = headerVal(headers, "accept");
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    return { clientType: "sdk", confidence: "low", signal: `accept: ${accept}`, responseFormat: "json" };
  }

  return { clientType: "unknown", confidence: "low", signal: "no signal", responseFormat: "markdown" };
}

// ── Fastify middleware ────────────────────────────────────────────────────────

export interface ClientDetectMiddlewareOptions {
  /** Attach detection result to request object under this key. Default: "nexusClient" */
  attachAs?: string;
}

export function makeClientDetectMiddleware(opts?: ClientDetectMiddlewareOptions) {
  const attachAs = opts?.attachAs ?? "nexusClient";
  return function clientDetectMiddleware(request: unknown, _reply: unknown, done?: () => void): void {
    const req = request as { headers?: RequestHeaders; [key: string]: unknown };
    const result = detectClient(req.headers ?? {});
    (req as Record<string, unknown>)[attachAs] = result;
    done?.();
  };
}
