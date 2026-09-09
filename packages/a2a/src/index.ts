// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/a2a — A2A (Agent2Agent) protocol client.
 *
 * Connects Nexus TO other autonomous agents as a peer. Where `@nexus/mcp-client`
 * consumes *tool registries*, this package consumes *agents*: it discovers a
 * remote agent's capabilities via its Agent Card and drives task-oriented
 * conversations over JSON-RPC 2.0, with optional Server-Sent-Events streaming.
 *
 * Architecture
 * ────────────
 *   A2AClient        — stateful connection to one remote agent endpoint.
 *   A2AAgentCard     — the agent's self-description (`/.well-known/agent-card.json`).
 *   A2AMessage       — a turn (role + parts) in an agent conversation.
 *   A2ATask          — a unit of work the agent tracks through a lifecycle.
 *   A2AStreamEvent   — one event yielded by `message/stream` over SSE.
 *   A2AClientError   — typed transport / protocol error.
 *
 * Protocol
 * ────────
 *   JSON-RPC 2.0 over HTTP POST to the agent's RPC URL. `message/send`,
 *   `tasks/get`, `tasks/cancel` return a single JSON result. `message/stream`
 *   returns `text/event-stream`; each `data:` frame is a JSON-RPC response whose
 *   `result` is a Task, Message, or an incremental status/artifact update, the
 *   last carrying `final: true`.
 *
 * Security — authenticated, no impersonation
 * ──────────────────────────────────────────
 *   The client authenticates with its OWN bearer credential (`apiKey`). It never
 *   forwards a caller's identity headers: any `Authorization` supplied in
 *   `extraHeaders` is dropped so a caller cannot smuggle a spoofed identity
 *   through the client. Nexus speaks to the peer agent AS Nexus.
 *
 * Usage
 * ─────
 * ```ts
 * const client = new A2AClient({ rpcUrl: "https://agent.example.com/a2a", apiKey: "..." });
 * const card = await client.getAgentCard();
 * if (card.capabilities?.streaming) {
 *   for await (const ev of client.sendMessageStream({ message: A2AClient.textMessage("hi") })) {
 *     // handle status-update / artifact-update / message / task
 *   }
 * } else {
 *   const result = await client.sendMessage({ message: A2AClient.textMessage("hi") });
 * }
 * ```
 */

import { randomUUID } from "node:crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

export type FetchFn = typeof fetch;

// ── Errors ────────────────────────────────────────────────────────────────────

/** Typed A2A client error (transport, protocol, or capability). */
export class A2AClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "A2AClientError";
  }
}

// ── JSON-RPC 2.0 ──────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string;
  result: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcErrorResponse;

function isRpcError(r: JsonRpcResponse): r is JsonRpcErrorResponse {
  return "error" in r;
}

// ── Message / Part types ──────────────────────────────────────────────────────

/** A text segment of a message or artifact. */
export interface A2ATextPart {
  kind: "text";
  text: string;
  metadata?: Record<string, unknown>;
}

/** A file segment — carried inline as base64 `bytes` or referenced by `uri`. */
export interface A2AFilePart {
  kind: "file";
  file: { name?: string; mimeType?: string; bytes?: string; uri?: string };
  metadata?: Record<string, unknown>;
}

/** A structured-data segment (arbitrary JSON). */
export interface A2ADataPart {
  kind: "data";
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** One part of a message or artifact. */
export type A2APart = A2ATextPart | A2AFilePart | A2ADataPart;

/** A single conversational turn exchanged with an agent. */
export interface A2AMessage {
  kind?: "message";
  role: "user" | "agent";
  parts: A2APart[];
  messageId: string;
  taskId?: string;
  contextId?: string;
  referenceTaskIds?: string[];
  metadata?: Record<string, unknown>;
}

// ── Task types ────────────────────────────────────────────────────────────────

/** Lifecycle state of a task. */
export type A2ATaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "auth-required"
  | "completed"
  | "canceled"
  | "failed"
  | "rejected"
  | "unknown";

/** Current status of a task, optionally with an agent message and timestamp. */
export interface A2ATaskStatus {
  state: A2ATaskState;
  message?: A2AMessage;
  timestamp?: string;
}

/** A named output produced by the agent while working a task. */
export interface A2AArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

/** A unit of work an agent tracks through its lifecycle. */
export interface A2ATask {
  kind?: "task";
  id: string;
  contextId?: string;
  status: A2ATaskStatus;
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
  metadata?: Record<string, unknown>;
}

// ── Streaming events ──────────────────────────────────────────────────────────

/** Incremental task-status change streamed over SSE. */
export interface A2ATaskStatusUpdateEvent {
  kind: "status-update";
  taskId: string;
  contextId?: string;
  status: A2ATaskStatus;
  final: boolean;
  metadata?: Record<string, unknown>;
}

/** Incremental artifact chunk streamed over SSE. */
export interface A2ATaskArtifactUpdateEvent {
  kind: "artifact-update";
  taskId: string;
  contextId?: string;
  artifact: A2AArtifact;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

/** Any event a `message/stream` may yield. Discriminate on `kind`. */
export type A2AStreamEvent =
  A2ATask | A2AMessage | A2ATaskStatusUpdateEvent | A2ATaskArtifactUpdateEvent;

// ── Agent Card ────────────────────────────────────────────────────────────────

/** Optional capabilities an agent advertises. */
export interface A2AAgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
}

/** A discrete capability the agent offers. */
export interface A2AAgentSkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

/** An agent's self-description, served at `/.well-known/agent-card.json`. */
export interface A2AAgentCard {
  name: string;
  description?: string;
  url: string;
  version: string;
  protocolVersion?: string;
  capabilities?: A2AAgentCapabilities;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  skills?: A2AAgentSkill[];
  securitySchemes?: Record<string, unknown>;
}

// ── Request params ────────────────────────────────────────────────────────────

/** Per-call configuration for `message/send` and `message/stream`. */
export interface A2AMessageSendConfiguration {
  acceptedOutputModes?: string[];
  historyLength?: number;
  blocking?: boolean;
}

/** Params for `message/send` / `message/stream`. */
export interface A2AMessageSendParams {
  message: A2AMessage;
  configuration?: A2AMessageSendConfiguration;
  metadata?: Record<string, unknown>;
}

// ── SSE parsing ───────────────────────────────────────────────────────────────

/**
 * Decode an SSE byte stream into successive `data` payload strings. Events are
 * separated by a blank line; `data:` lines within one event are joined by `\n`.
 * Non-data fields (`event:`, `id:`, comments) are ignored — the A2A payload
 * lives entirely in `data`.
 */
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data.length > 0) yield data;
      idx = buffer.indexOf("\n\n");
    }
  }
}

// ── A2AClient ─────────────────────────────────────────────────────────────────

/** Configuration for {@link A2AClient}. */
export interface A2AClientConfig {
  /** The agent's JSON-RPC endpoint (its Agent Card `url`). */
  rpcUrl: string;
  /** Bearer credential the client authenticates with (its OWN identity). */
  apiKey?: string;
  /** Extra request headers. Any `Authorization` here is dropped (no impersonation). */
  extraHeaders?: Record<string, string>;
  /** Injectable fetch (test seam). Defaults to global `fetch`. */
  fetchFn?: FetchFn;
  /** Timeout (ms) for unary calls. Does not bound a `message/stream` lifetime. */
  timeoutMs?: number;
  /** Override the Agent Card path. Defaults to `/.well-known/agent-card.json`. */
  agentCardPath?: string;
}

/** A2A protocol client — drives one remote agent endpoint. */
export class A2AClient {
  private readonly rpcUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private readonly agentCardPath: string;
  private readonly headers: Record<string, string>;
  private _agentCard?: A2AAgentCard;

  constructor(config: A2AClientConfig) {
    this.rpcUrl = config.rpcUrl;
    this.fetchFn = config.fetchFn ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.agentCardPath = config.agentCardPath ?? "/.well-known/agent-card.json";

    // No impersonation: strip any caller-supplied Authorization, then set OUR bearer.
    const extra: Record<string, string> = {};
    for (const [key, val] of Object.entries(config.extraHeaders ?? {})) {
      if (key.toLowerCase() === "authorization") continue;
      extra[key] = val;
    }
    this.headers = {
      "Content-Type": "application/json",
      ...extra,
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    };
  }

  /** Build a minimal user text message with a fresh `messageId`. */
  static textMessage(text: string, opts: { taskId?: string; contextId?: string } = {}): A2AMessage {
    return {
      kind: "message",
      role: "user",
      parts: [{ kind: "text", text }],
      messageId: randomUUID(),
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
      ...(opts.contextId ? { contextId: opts.contextId } : {}),
    };
  }

  /**
   * Fetch and cache the remote Agent Card from `/.well-known/agent-card.json`
   * (resolved against the RPC URL's origin). Idempotent; pass `force` to refetch.
   */
  async getAgentCard(force = false): Promise<A2AAgentCard> {
    if (this._agentCard && !force) return this._agentCard;
    const url = new URL(this.agentCardPath, this.rpcUrl).toString();
    const res = await this.fetchFn(url, { method: "GET", headers: this.headers });
    if (!res.ok) {
      throw new A2AClientError(`agent card HTTP ${res.status}`, "HTTP_ERROR", {
        status: res.status,
      });
    }
    this._agentCard = (await res.json()) as A2AAgentCard;
    return this._agentCard;
  }

  /** Agent Card from the last {@link getAgentCard} call, if any. */
  get agentCard(): A2AAgentCard | undefined {
    return this._agentCard;
  }

  /**
   * Send a message and await a single result — either a completed/blocking
   * {@link A2ATask} or a direct {@link A2AMessage} reply.
   */
  async sendMessage(params: A2AMessageSendParams): Promise<A2ATask | A2AMessage> {
    return (await this.rpc("message/send", params)) as A2ATask | A2AMessage;
  }

  /**
   * Send a message and stream the agent's progress as {@link A2AStreamEvent}s
   * over SSE. Requires the peer to advertise `capabilities.streaming` when an
   * Agent Card has been loaded; otherwise throws `STREAMING_UNSUPPORTED`.
   */
  async *sendMessageStream(params: A2AMessageSendParams): AsyncGenerator<A2AStreamEvent> {
    if (this._agentCard && this._agentCard.capabilities?.streaming === false) {
      throw new A2AClientError(
        "remote agent does not advertise streaming",
        "STREAMING_UNSUPPORTED",
      );
    }
    const res = await this.postStream("message/stream", params);
    if (!res.body) {
      throw new A2AClientError("streaming response had no body", "NO_STREAM_BODY");
    }
    for await (const data of parseSseStream(res.body)) {
      const parsed = JSON.parse(data) as JsonRpcResponse;
      if (isRpcError(parsed)) {
        throw new A2AClientError(parsed.error.message, "RPC_ERROR", {
          code: parsed.error.code,
          data: parsed.error.data,
        });
      }
      yield (parsed as JsonRpcSuccess).result as A2AStreamEvent;
    }
  }

  /** Fetch the current state of a task by id, optionally trimming history. */
  async getTask(id: string, historyLength?: number): Promise<A2ATask> {
    const params: Record<string, unknown> = { id };
    if (historyLength !== undefined) params["historyLength"] = historyLength;
    return (await this.rpc("tasks/get", params)) as A2ATask;
  }

  /** Request cancellation of a task; returns its updated state. */
  async cancelTask(id: string): Promise<A2ATask> {
    return (await this.rpc("tasks/cancel", { id })) as A2ATask;
  }

  /**
   * Delegate a message to this agent and wait for the final result. Requests
   * the peer's blocking path (`configuration.blocking: true`). When the peer
   * still answers with a non-terminal task (state `working`/`submitted`/
   * `input-required`), polls `tasks/get` until the task reaches a terminal
   * state (`completed` / `failed` / `canceled` / `rejected`) or the poll budget
   * is exhausted. Convenience for callers that need the FINAL result.
   */
  async delegate(
    message: A2AMessage,
    opts: { pollIntervalMs?: number; maxPolls?: number } = {},
  ): Promise<A2ATask | A2AMessage> {
    const pollIntervalMs = opts.pollIntervalMs ?? 500;
    const maxPolls = opts.maxPolls ?? 60;
    const result = await this.sendMessage({
      message,
      configuration: { blocking: true },
    });
    if (result.kind !== "task") return result; // direct reply — nothing to poll
    let task = result;
    for (let poll = 0; poll < maxPolls && !isTerminalTaskState(task.status.state); poll++) {
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
      task = await this.getTask(task.id);
    }
    return task;
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /** Perform a unary JSON-RPC call and return its `result` (throws on error). */
  private async rpc(method: string, params: unknown): Promise<unknown> {
    const request: JsonRpcRequest = { jsonrpc: "2.0", id: randomUUID(), method, params };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.rpcUrl, {
        method: "POST",
        headers: { ...this.headers, Accept: "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new A2AClientError(`HTTP ${res.status}`, "HTTP_ERROR", { status: res.status });
      }
      const response = (await res.json()) as JsonRpcResponse;
      if (isRpcError(response)) {
        throw new A2AClientError(response.error.message, "RPC_ERROR", {
          code: response.error.code,
          data: response.error.data,
        });
      }
      return (response as JsonRpcSuccess).result;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * POST a streaming JSON-RPC request and return the raw response for SSE
   * consumption. No total-lifetime timeout — a stream may run arbitrarily long.
   */
  private async postStream(method: string, params: unknown): Promise<Response> {
    const request: JsonRpcRequest = { jsonrpc: "2.0", id: randomUUID(), method, params };
    const res = await this.fetchFn(this.rpcUrl, {
      method: "POST",
      headers: { ...this.headers, Accept: "text/event-stream" },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      throw new A2AClientError(`HTTP ${res.status}`, "HTTP_ERROR", { status: res.status });
    }
    return res as Response;
  }
}

// ── Delegation orchestration (§15.2) ─────────────────────────────────────────

/** A single delegated call: peer client + message. */
export interface DelegationTarget {
  client: A2AClient;
  message: A2AMessage;
  /** Optional per-target label for results/errors. */
  label?: string;
}

/** Outcome of one delegated call. */
/** True when an A2A task state is terminal (no further polling needed). */
export function isTerminalTaskState(state: A2ATaskState): boolean {
  return (
    state === "completed" || state === "failed" || state === "canceled" || state === "rejected"
  );
}

export interface DelegationOutcome {
  label?: string;
  ok: boolean;
  /** The final task when the peer completed (state `completed`). */
  task?: A2ATask;
  /** The direct message reply when the peer answered without a task. */
  reply?: A2AMessage;
  error?: A2AClientError | Error;
}

/** Options for {@link delegateWithRetry}. */
export interface DelegateRetryOptions {
  /** Max attempts (including the first). Default 3. */
  maxAttempts?: number;
  /** Base delay between attempts in ms. Default 250. */
  baseDelayMs?: number;
  /** Backoff multiplier per retry. Default 2 (250 → 500 → 1000). */
  backoffMultiplier?: number;
  /** Injectable sleep for tests. Defaults to a real setTimeout. */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Delegate a message with retry + backoff. Retries only on *transport*
 * failures (network, HTTP, RPC errors) — never on a completed-but-failed
 * task, which is a peer decision, not a transport glitch. Returns the last
 * outcome after exhausting attempts.
 */
export async function delegateWithRetry(
  target: DelegationTarget,
  opts: DelegateRetryOptions = {},
): Promise<DelegationOutcome> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 250;
  const backoff = opts.backoffMultiplier ?? 2;
  const sleep = opts.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let last: DelegationOutcome = { ok: false, error: new Error("no attempts made") };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await target.client.delegate(target.message);
      // A2ATask has `status.state`; A2AMessage has `role`. Discriminate on the
      // required fields (both `kind` fields are optional, so they cannot narrow).
      if ("status" in result) {
        if (result.status.state === "failed") {
          // Peer rejected the work — not a transport error; do not retry.
          return { label: target.label, ok: false, task: result };
        }
        return { label: target.label, ok: true, task: result };
      }
      return { label: target.label, ok: true, reply: result };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      last = { label: target.label, ok: false, error: err };
      if (attempt < maxAttempts) {
        await sleep(baseDelayMs * Math.pow(backoff, attempt - 1));
      }
    }
  }
  return last;
}

/**
 * Fan out one message to several peers and collect every outcome — the
 * "federated council" primitive. All peers run concurrently; failures are
 * isolated per peer (one dead peer does not fail the fan-out).
 */
export async function delegateFanOut(
  targets: DelegationTarget[],
  opts: DelegateRetryOptions = {},
): Promise<DelegationOutcome[]> {
  return Promise.all(targets.map((t) => delegateWithRetry(t, opts)));
}

/**
 * A delegation coordinator: tracks a named delegation session, fans out to
 * peers, and exposes the aggregated results. Useful for federation flows
 * that need a stable handle on a multi-peer delegation.
 */
export class A2ADelegationCoordinator {
  private readonly outcomes: DelegationOutcome[] = [];
  readonly sessionId: string;
  readonly startedAt: string;

  constructor(sessionId?: string) {
    this.sessionId = sessionId ?? `delegation-${randomUUID()}`;
    this.startedAt = new Date().toISOString();
  }

  /** Fan out to every target and record the outcomes. */
  async delegate(
    targets: DelegationTarget[],
    opts: DelegateRetryOptions = {},
  ): Promise<DelegationOutcome[]> {
    const results = await delegateFanOut(targets, opts);
    this.outcomes.push(...results);
    return results;
  }

  /** Every recorded outcome. */
  all(): DelegationOutcome[] {
    return [...this.outcomes];
  }

  /** Outcomes that completed successfully. */
  succeeded(): DelegationOutcome[] {
    return this.outcomes.filter((o) => o.ok);
  }

  /** Outcomes that failed (transport or peer rejection). */
  failed(): DelegationOutcome[] {
    return this.outcomes.filter((o) => !o.ok);
  }

  /** True when every peer succeeded. */
  get allSucceeded(): boolean {
    return this.outcomes.length > 0 && this.failed().length === 0;
  }
}

// ── Federated council (§15.2) ────────────────────────────────────────────────

/** One peer's contribution to a council decision. */
export interface CouncilVote {
  /** Peer label (or its index when unlabeled). */
  peer: string;
  /** True when the peer answered successfully. */
  ok: boolean;
  /** The peer's text answer: the first text part of its reply/final artifact. */
  answer?: string;
}

/** Aggregated result of a federated council round. */
export interface CouncilDecision {
  /** Extracted peer answers (ok peers only). */
  votes: CouncilVote[];
  /** Peers that failed (label + error message). */
  errors: { peer: string; error: string }[];
  /** True when at least one peer answered. */
  reachedQuorum: boolean;
  /** Peer count that answered / was asked. */
  quorum: { answered: number; asked: number };
}

/** First non-empty text part of a message or task artifact set. */
function firstTextPart(parts: A2APart[] | undefined): string | undefined {
  for (const p of parts ?? []) {
    if (p.kind === "text" && p.text.trim().length > 0) return p.text;
  }
  return undefined;
}

/** Extract a peer's answer from a delegation outcome. */
export function outcomeAnswer(outcome: DelegationOutcome): string | undefined {
  if (!outcome.ok) return undefined;
  if (outcome.reply) return firstTextPart(outcome.reply.parts);
  if (outcome.task) {
    // Prefer the final artifact, then the status message.
    const fromArtifacts = outcome.task.artifacts
      ?.map((a) => firstTextPart(a.parts))
      .find((t) => t !== undefined);
    if (fromArtifacts) return fromArtifacts;
    return firstTextPart(outcome.task.status.message?.parts);
  }
  return undefined;
}

/**
 * Aggregate a fan-out into a council decision: extract each peer's answer,
 * isolate failures, and report quorum. Pure — the caller decides how to weigh
 * or merge the answers (majority vote, judge LLM, synthesis, …).
 */
export function aggregateCouncilDecision(outcomes: DelegationOutcome[]): CouncilDecision {
  const votes: CouncilVote[] = [];
  const errors: { peer: string; error: string }[] = [];
  outcomes.forEach((o, i) => {
    const peer = o.label ?? `peer-${i}`;
    const answer = outcomeAnswer(o);
    if (o.ok && answer !== undefined) {
      votes.push({ peer, ok: true, answer });
    } else {
      errors.push({
        peer,
        error: o.error?.message ?? (o.ok ? "no answer content" : "peer failed"),
      });
    }
  });
  return {
    votes,
    errors,
    reachedQuorum: votes.length > 0,
    quorum: { answered: votes.length, asked: outcomes.length },
  };
}

/**
 * One-shot federated council: fan the message out to every peer, aggregate
 * into a {@link CouncilDecision}. Failure-isolated — a dead peer lands in
 * `errors`, never breaks the round.
 */
export async function federatedCouncil(
  targets: DelegationTarget[],
  opts: DelegateRetryOptions = {},
): Promise<CouncilDecision> {
  const outcomes = await delegateFanOut(targets, opts);
  return aggregateCouncilDecision(outcomes);
}
