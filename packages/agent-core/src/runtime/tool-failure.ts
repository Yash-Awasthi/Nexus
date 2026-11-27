// SPDX-License-Identifier: Apache-2.0
/**
 * One taxonomy for a tool call that did not work.
 *
 * Tools fail in ways a model and a person need described differently. A timeout means "the work may
 * have happened, check before retrying"; a 429 means "wait, then retry, do not change the request";
 * a schema error means "your arguments were wrong" and is the model's fault to fix; a partial stream
 * means "you are looking at half an answer, do not save it". Collapsing all four into
 * `Error: something went wrong` makes the model retry the wrong thing and tells the user nothing.
 *
 * The classification is deliberately message-based: tools in this tree are a mixture of our own
 * handlers, child processes, HTTP clients and MCP servers, and none of them share an error class.
 * The raw text stays available in `detail` (the model still sees it); `userMessage` is the sentence a
 * person can act on.
 */

export type ToolFailureKind =
  | "timeout"
  | "rate_limited"
  | "schema"
  | "partial_stream"
  | "permission"
  | "not_found"
  | "unknown";

export interface ToolFailure {
  kind: ToolFailureKind;
  /** True when repeating the same call could plausibly succeed. */
  retryable: boolean;
  /** Milliseconds to wait before retrying, when the tool said so. */
  retryAfterMs?: number;
  /** A sentence for a person: what happened and what to do about it. */
  userMessage: string;
  /** The tool's own words, unfiltered. Fed to the model, not shown as the headline. */
  detail: string;
}

const TIMEOUT =
  /timed?\s?out|timeout|etimedout|deadline exceeded|took too long|aborted by timeout/i;
const RATE_LIMITED = /\b429\b|rate[\s-]?limit|too many requests|quota|throttl/i;
const SCHEMA =
  /zod|schema|validation|invalid (?:argument|input|parameter|value)|expected .*(?:but|received)|missing required|must be (?:a|an|of|one|provided)|unexpected property|not a valid/i;
const PARTIAL_STREAM =
  /unexpected end of (?:json|input|stream|data)|premature close|stream (?:closed|ended|reset)|econnreset|truncated|incomplete (?:json|response|stream)|partial (?:result|response)/i;
const PERMISSION = /permission_denied|not approved|requires? approval|forbidden/i;
const NOT_FOUND = /not found|enoent|unknown tool|no such (?:file|tool|command)/i;

/** `retry-after: 30` or `after 30s` in the tool's own message. */
function retryAfterFrom(detail: string): number | undefined {
  const header = /retry[\s-]?after["':\s]*(\d+)\s*(ms|s|sec|seconds|m|min|minutes)?/i.exec(detail);
  if (header) {
    const value = Number(header[1]);
    const unit = (header[2] ?? "s").toLowerCase();
    if (unit.startsWith("ms")) return value;
    if (unit.startsWith("m")) return value * 60_000;
    return value * 1000;
  }
  return undefined;
}

/**
 * Classify a tool failure. `toolName` is used in the sentence so the user knows which capability
 * failed; `error` may be an Error, a string, or anything a handler threw.
 */
export function classifyToolFailure(toolName: string, error: unknown): ToolFailure {
  const detail = error instanceof Error ? error.message : String(error);
  const base = { detail };

  if (PERMISSION.test(detail)) {
    return {
      ...base,
      kind: "permission",
      retryable: false,
      userMessage: `“${toolName}” needs approval before it can run.`,
    };
  }
  if (TIMEOUT.test(detail)) {
    return {
      ...base,
      kind: "timeout",
      // The call may have done its work before it was cut off, so a retry is reasonable but is not
      // safe to do blindly.
      retryable: true,
      userMessage: `“${toolName}” took too long and was stopped. Its work may be incomplete — check before retrying.`,
    };
  }
  if (RATE_LIMITED.test(detail)) {
    const retryAfterMs = retryAfterFrom(detail);
    return {
      ...base,
      kind: "rate_limited",
      retryable: true,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      userMessage:
        retryAfterMs !== undefined
          ? `“${toolName}” is rate limited. Try again in ${Math.ceil(retryAfterMs / 1000)}s.`
          : `“${toolName}” is rate limited. Wait a moment and try again.`,
    };
  }
  if (SCHEMA.test(detail)) {
    return {
      ...base,
      kind: "schema",
      // Repeating the same arguments produces the same rejection; the arguments have to change.
      retryable: false,
      userMessage: `“${toolName}” rejected its arguments: ${firstClause(detail)}.`,
    };
  }
  if (PARTIAL_STREAM.test(detail)) {
    return {
      ...base,
      kind: "partial_stream",
      retryable: true,
      userMessage: `“${toolName}” was cut off before it finished. Treat what arrived as partial and do not save it.`,
    };
  }
  if (NOT_FOUND.test(detail)) {
    return {
      ...base,
      kind: "not_found",
      retryable: false,
      userMessage: `“${toolName}” could not find what it was asked for: ${firstClause(detail)}.`,
    };
  }
  return {
    ...base,
    kind: "unknown",
    retryable: false,
    userMessage: `“${toolName}” failed: ${firstClause(detail)}.`,
  };
}

/** The first sentence, clipped, so a stack trace does not become the headline. */
function firstClause(detail: string): string {
  const line = detail.split("\n")[0]!.trim();
  const sentence = line.split(/(?<=[.!?])\s+/)[0] ?? line;
  return sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence || "no detail given";
}
