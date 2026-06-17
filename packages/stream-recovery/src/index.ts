// SPDX-License-Identifier: Apache-2.0
/**
 * stream-recovery — Production-grade stream failure recovery.
 *
 * Provides:
 *   • HoldbackBuffer      — delayed-emit buffer (prevents premature truncation events)
 *   • ToolJsonRepair      — append-only JSON repair for truncated tool call JSON
 *   • ContinuationSuffix  — injects continuation tokens into truncated streams
 *   • RetryStrategy       — exponential backoff config for mid-stream retries
 *   • StreamRetryHandler  — 5-attempt mid-stream retry with backoff
 *   • SseBlock            — open SSE block (event/data being buffered)
 *   • EmittedSseTracker   — tracks open blocks, closes them on error/stream-end
 *   • StreamRecoveryOrchestrator — assembles all primitives into one facade
 */

// ── HoldbackBuffer ────────────────────────────────────────────────────────────

export interface HoldbackOptions {
  holdMs: number; // default 750ms
}

/** Held chunk interface definition. */
export interface HeldChunk<T> {
  value: T;
  heldAt: number;
}

/** Holdback buffer. */
export class HoldbackBuffer<T> {
  private queue: HeldChunk<T>[] = [];
  private holdMs: number;

  constructor(opts: HoldbackOptions = { holdMs: 750 }) {
    this.holdMs = opts.holdMs;
  }

  push(value: T): void {
    this.queue.push({ value, heldAt: Date.now() });
  }

  /** Return chunks that have been held for >= holdMs and remove them from queue. */
  drain(now = Date.now()): T[] {
    const ready: T[] = [];
    const remaining: HeldChunk<T>[] = [];
    for (const item of this.queue) {
      if (now - item.heldAt >= this.holdMs) ready.push(item.value);
      else remaining.push(item);
    }
    this.queue = remaining;
    return ready;
  }

  /** Force-drain all items regardless of hold time. */
  flush(): T[] {
    const all = this.queue.map((h) => h.value);
    this.queue = [];
    return all;
  }

  size(): number {
    return this.queue.length;
  }
  setHoldMs(ms: number): void {
    this.holdMs = ms;
  }
  getHoldMs(): number {
    return this.holdMs;
  }
}

// ── ToolJsonRepair ────────────────────────────────────────────────────────────

export interface RepairResult {
  repaired: string;
  wasRepaired: boolean;
  error?: string;
}

/** Tool json repair. */
export class ToolJsonRepair {
  /**
   * Attempt to repair truncated JSON by appending missing closers.
   * Strategy: append-only (never remove characters).
   */
  repair(partialJson: string): RepairResult {
    // First try: it's already valid
    try {
      JSON.parse(partialJson);
      return { repaired: partialJson, wasRepaired: false };
    } catch {
      // continue
    }

    let text = partialJson.trimEnd();

    // Count open structures
    let openBraces = 0;
    let openBrackets = 0;
    let inString = false;
    let escape = false;

    // eslint-disable-next-line @typescript-eslint/prefer-for-of
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\" && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") openBraces++;
      else if (ch === "}") openBraces--;
      else if (ch === "[") openBrackets++;
      else if (ch === "]") openBrackets--;
    }

    // If we're in an unclosed string, close it
    if (inString) text += '"';

    // Append missing closers
    const closers = "]".repeat(Math.max(0, openBrackets)) + "}".repeat(Math.max(0, openBraces));
    const candidate = text + closers;

    try {
      JSON.parse(candidate);
      return { repaired: candidate, wasRepaired: true };
    } catch (err) {
      return {
        repaired: partialJson,
        wasRepaired: false,
        error: `Repair failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

// ── ContinuationSuffix ────────────────────────────────────────────────────────

export const DEFAULT_CONTINUATION_SUFFIXES: Record<string, string> = {
  markdown: "\n\n*[Stream interrupted — continuing...]*\n\n",
  json: ',"_continuation":true}',
  plain: " [...]",
};

/** Continuation suffix. */
export class ContinuationSuffix {
  private suffixes: Record<string, string>;

  constructor(suffixes?: Record<string, string>) {
    this.suffixes = suffixes ?? DEFAULT_CONTINUATION_SUFFIXES;
  }

  inject(text: string, mode = "plain"): string {
    const suffix = this.suffixes[mode] ?? this.suffixes["plain"] ?? " [...]";
    return text + suffix;
  }

  getSuffix(mode: string): string {
    return this.suffixes[mode] ?? this.suffixes["plain"] ?? " [...]";
  }
}

// ── RetryStrategy ─────────────────────────────────────────────────────────────

export interface RetryStrategyOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs?: number;
  backoffFactor?: number;
}

/** Retry strategy. */
export class RetryStrategy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly backoffFactor: number;

  constructor(opts: RetryStrategyOptions) {
    this.maxAttempts = opts.maxAttempts;
    this.initialDelayMs = opts.initialDelayMs;
    this.maxDelayMs = opts.maxDelayMs ?? 30_000;
    this.backoffFactor = opts.backoffFactor ?? 2;
  }

  delayFor(attempt: number): number {
    const delay = this.initialDelayMs * Math.pow(this.backoffFactor, attempt);
    return Math.min(delay, this.maxDelayMs);
  }

  shouldRetry(attempt: number): boolean {
    return attempt < this.maxAttempts;
  }
}

/** Default retry strategy. */
export const DEFAULT_RETRY_STRATEGY = new RetryStrategy({
  maxAttempts: 5,
  initialDelayMs: 100,
  maxDelayMs: 5_000,
  backoffFactor: 2,
});

// ── StreamRetryHandler ────────────────────────────────────────────────────────

export type StreamFn<T> = () => AsyncIterable<T>;

/** Retry result interface definition. */
export interface RetryResult<T> {
  values: T[];
  attempts: number;
  succeeded: boolean;
  error?: string;
}

/** Stream retry handler. */
export class StreamRetryHandler<T = string> {
  private strategy: RetryStrategy;

  constructor(strategy: RetryStrategy = DEFAULT_RETRY_STRATEGY) {
    this.strategy = strategy;
  }

  async collect(
    streamFn: StreamFn<T>,
    delayFn?: (ms: number) => Promise<void>,
  ): Promise<RetryResult<T>> {
    const delay = delayFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let attempt = 0;
    let lastError: string | undefined;

    while (this.strategy.shouldRetry(attempt)) {
      try {
        const values: T[] = [];
        for await (const chunk of streamFn()) {
          values.push(chunk);
        }
        return { values, attempts: attempt + 1, succeeded: true };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        attempt++;
        if (this.strategy.shouldRetry(attempt)) {
          await delay(this.strategy.delayFor(attempt));
        }
      }
    }

    return { values: [], attempts: attempt, succeeded: false, error: lastError };
  }
}

// ── EmittedSseTracker ─────────────────────────────────────────────────────────

export type SseBlockType = "block" | "updateBlock" | "researchComplete" | string;

/** Sse block interface definition. */
export interface SseBlock {
  id: string;
  type: SseBlockType;
  openedAt: number;
  data?: unknown;
}

/** Close event interface definition. */
export interface CloseEvent {
  blockId: string;
  type: SseBlockType;
  reason: "error" | "end";
  closedAt: string;
}

/** Emitted sse tracker. */
export class EmittedSseTracker {
  private openBlocks = new Map<string, SseBlock>();
  readonly closeEvents: CloseEvent[] = [];

  open(block: SseBlock): void {
    this.openBlocks.set(block.id, block);
  }

  close(blockId: string, reason: "error" | "end"): void {
    const block = this.openBlocks.get(blockId);
    if (!block) return;
    this.openBlocks.delete(blockId);
    this.closeEvents.push({
      blockId,
      type: block.type,
      reason,
      closedAt: new Date().toISOString(),
    });
  }

  /** Close all open blocks (called on stream error or forced termination). */
  closeAll(reason: "error" | "end"): CloseEvent[] {
    const events: CloseEvent[] = [];
    for (const [id, block] of this.openBlocks.entries()) {
      const ev: CloseEvent = {
        blockId: id,
        type: block.type,
        reason,
        closedAt: new Date().toISOString(),
      };
      events.push(ev);
      this.closeEvents.push(ev);
    }
    this.openBlocks.clear();
    return events;
  }

  hasOpen(blockId: string): boolean {
    return this.openBlocks.has(blockId);
  }
  openCount(): number {
    return this.openBlocks.size;
  }
  getOpen(): SseBlock[] {
    return [...this.openBlocks.values()];
  }
  clear(): void {
    this.openBlocks.clear();
    this.closeEvents.length = 0;
  }
}

// ── StreamRecoveryOrchestrator ────────────────────────────────────────────────

export interface OrchestratorOptions {
  holdMs?: number;
  maxRetries?: number;
  initialDelayMs?: number;
}

/** Stream recovery orchestrator. */
export class StreamRecoveryOrchestrator {
  readonly holdback: HoldbackBuffer<string>;
  readonly jsonRepair: ToolJsonRepair;
  readonly continuation: ContinuationSuffix;
  readonly retryHandler: StreamRetryHandler;
  readonly sseTracker: EmittedSseTracker;

  constructor(opts: OrchestratorOptions = {}) {
    this.holdback = new HoldbackBuffer({ holdMs: opts.holdMs ?? 750 });
    this.jsonRepair = new ToolJsonRepair();
    this.continuation = new ContinuationSuffix();
    this.retryHandler = new StreamRetryHandler<string>(
      new RetryStrategy({
        maxAttempts: opts.maxRetries ?? 5,
        initialDelayMs: opts.initialDelayMs ?? 100,
      }),
    );
    this.sseTracker = new EmittedSseTracker();
  }

  /** Recover from stream failure: close all open SSE blocks + inject continuation. */
  handleError(lastText: string, mode = "plain"): { text: string; closedBlocks: CloseEvent[] } {
    const closedBlocks = this.sseTracker.closeAll("error");
    const text = this.continuation.inject(lastText, mode);
    return { text, closedBlocks };
  }
}

// ── WebSocket Channel primitives (from iii SDK) ───────────────────────────────
//
// Extracted from iii-hq/iii iii-browser SDK. Worker-to-worker binary/text
// streaming over WebSocket with 64 KB binary framing, lazy connect, and
// a pending-message queue for pre-connect sends.
//
// ChannelItem     — discriminated text | binary item with factory helpers
// ChannelDirection — 'read' | 'write' enum
// ChannelWriter   — write end (sendMessage / sendBinary / close)
// ChannelReader   — read end (onMessage / onBinary / readAll / close)
// Channel         — paired writer+reader with serializable refs
// buildChannelUrl — URL builder for engine WebSocket channel endpoints

/** Direction of a streaming channel endpoint. */
export const ChannelDirection = {
  Read: "read",
  Write: "write",
} as const;
export type ChannelDirection =
  (typeof ChannelDirection)[keyof typeof ChannelDirection];

/**
 * Discriminated runtime tag for a streaming channel item.
 * Use factory helpers to construct; use `.type` to discriminate.
 */
export type ChannelItem =
  | { type: "text"; value: string }
  | { type: "binary"; value: Uint8Array };

export const ChannelItem = {
  Text(value: string): ChannelItem {
    return { type: "text", value };
  },
  Binary(value: Uint8Array): ChannelItem {
    return { type: "binary", value };
  },
} as const;

/** Serializable reference to one end of a streaming channel. */
export interface StreamChannelRef {
  channel_id: string;
  access_key: string;
  direction: ChannelDirection;
}

/** Build the WebSocket URL for a channel endpoint. */
export function buildChannelUrl(
  engineWsBase: string,
  channelId: string,
  accessKey: string,
  direction: "read" | "write",
): string {
  const base = engineWsBase.replace(/\/$/, "");
  return `${base}/ws/channels/${channelId}?key=${encodeURIComponent(accessKey)}&dir=${direction}`;
}

/**
 * Write end of a streaming channel over native browser WebSocket.
 * Connects lazily on first send; queues messages sent before open.
 *
 * @example
 * ```ts
 * const writer = new ChannelWriter(engineWsBase, writerRef);
 * writer.sendMessage(JSON.stringify({ type: 'event' }));
 * writer.sendBinary(new Uint8Array([1, 2, 3]));
 * writer.close();
 * ```
 */
export class ChannelWriter {
  private static readonly FRAME_SIZE = 64 * 1024;
  private ws: WebSocket | null = null;
  private wsReady = false;
  private readonly pendingMessages: {
    data: ArrayBuffer | string;
    resolve: () => void;
    reject: (err: Error) => void;
  }[] = [];
  private readonly url: string;

  constructor(engineWsBase: string, ref: StreamChannelRef) {
    this.url = buildChannelUrl(
      engineWsBase,
      ref.channel_id,
      ref.access_key,
      "write",
    );
  }

  private ensureConnected(): void {
    if (this.ws) return;

    this.ws = new WebSocket(this.url);
    this.ws.binaryType = "arraybuffer";

    this.ws.addEventListener("open", () => {
      this.wsReady = true;
      for (const { data, resolve, reject } of this.pendingMessages) {
        try {
          this.ws?.send(data);
          resolve();
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
      this.pendingMessages.length = 0;
    });

    this.ws.addEventListener("error", () => {
      for (const { reject } of this.pendingMessages) {
        reject(new Error("WebSocket error"));
      }
      this.pendingMessages.length = 0;
    });
  }

  /** Send a text message. */
  sendMessage(msg: string): void {
    this.ensureConnected();
    this._sendRaw(msg);
  }

  /** Send binary data, chunked to FRAME_SIZE bytes. */
  sendBinary(data: Uint8Array): void {
    this.ensureConnected();
    let offset = 0;
    while (offset < data.length) {
      const end = Math.min(offset + ChannelWriter.FRAME_SIZE, data.length);
      const chunk = data.subarray(offset, end);
      const buffer =
        chunk.buffer instanceof ArrayBuffer
          ? chunk.buffer
          : new ArrayBuffer(chunk.byteLength);
      if (!(chunk.buffer instanceof ArrayBuffer)) {
        new Uint8Array(buffer).set(chunk);
      }
      this._sendRaw(
        buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
      );
      offset = end;
    }
  }

  /** Close the writer. */
  close(): void {
    if (!this.ws) return;
    const doClose = () => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.close(1000, "channel_close");
      }
    };
    if (this.wsReady) {
      doClose();
    } else {
      this.ws.addEventListener("open", () => doClose());
    }
  }

  private _sendRaw(data: ArrayBuffer | string): void {
    if (this.wsReady && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      this.ensureConnected();
      this.pendingMessages.push({
        data,
        resolve: () => undefined,
        reject: () => undefined,
      });
    }
  }
}

/**
 * Read end of a streaming channel over native browser WebSocket.
 * Connects lazily on first callback registration.
 *
 * @example
 * ```ts
 * const reader = new ChannelReader(engineWsBase, readerRef);
 * reader.onMessage((msg) => console.log('text:', msg));
 * reader.onBinary((buf) => console.log('bytes:', buf.byteLength));
 * const all = await reader.readAll(); // collect until close
 * ```
 */
export class ChannelReader {
  private ws: WebSocket | null = null;
  private connected = false;
  private readonly messageCallbacks: Array<(msg: string) => void> = [];
  private readonly binaryCallbacks: Array<(data: Uint8Array) => void> = [];
  private readonly url: string;

  constructor(engineWsBase: string, ref: StreamChannelRef) {
    this.url = buildChannelUrl(
      engineWsBase,
      ref.channel_id,
      ref.access_key,
      "read",
    );
  }

  private ensureConnected(): void {
    if (this.connected) return;
    this.connected = true;

    this.ws = new WebSocket(this.url);
    this.ws.binaryType = "arraybuffer";

    this.ws.addEventListener("message", (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        const data = new Uint8Array(event.data);
        for (const cb of this.binaryCallbacks) cb(data);
      } else if (typeof event.data === "string") {
        for (const cb of this.messageCallbacks) cb(event.data);
      }
    });

    this.ws.addEventListener("close", () => {
      this.ws = null;
    });
    this.ws.addEventListener("error", () => {
      this.ws = null;
    });
  }

  /** Register a callback for text messages. Connects lazily. */
  onMessage(callback: (msg: string) => void): void {
    this.messageCallbacks.push(callback);
    this.ensureConnected();
  }

  /** Register a callback for binary messages. Connects lazily. */
  onBinary(callback: (data: Uint8Array) => void): void {
    this.binaryCallbacks.push(callback);
    this.ensureConnected();
  }

  /** Collect all binary data until the channel closes. */
  async readAll(): Promise<Uint8Array> {
    this.ensureConnected();
    const chunks: Uint8Array[] = [];

    return new Promise<Uint8Array>((resolve) => {
      this.binaryCallbacks.push((data) => chunks.push(data));
      this.ws?.addEventListener("close", () => {
        const total = chunks.reduce((s, c) => s + c.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          out.set(c, off);
          off += c.length;
        }
        resolve(out);
      });
    });
  }

  /** Close the reader. */
  close(): void {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.ws.close(1000, "channel_close");
    }
  }
}

/** Paired WebSocket channel (writer + reader + serializable refs). */
export interface Channel {
  writer: ChannelWriter;
  reader: ChannelReader;
  writerRef: StreamChannelRef;
  readerRef: StreamChannelRef;
}

// ── Channel utilities (from iii SDK) ─────────────────────────────────────────
//
// isChannelRef    — type guard for StreamChannelRef
// extractChannelRefs — recursive extraction of all StreamChannelRefs from JSON
// http()          — wraps Express-style (req, res) handler into SDK function format

/**
 * Type guard: returns true if `value` is a valid `StreamChannelRef`.
 */
export function isChannelRef(value: unknown): value is StreamChannelRef {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Partial<StreamChannelRef>;
  return (
    typeof m.channel_id === "string" &&
    typeof m.access_key === "string" &&
    (m.direction === "read" || m.direction === "write")
  );
}

/**
 * Recursively extract all `StreamChannelRef` values from an arbitrary JSON-like
 * input, returning each paired with its dotted/bracketed path string.
 * Mirrors the Rust SDK's `extract_channel_refs`.
 *
 * @example
 * ```ts
 * const refs = extractChannelRefs(payload);
 * // [["result.channel", { channel_id: "...", access_key: "...", direction: "read" }]]
 * ```
 */
export function extractChannelRefs(
  data: unknown,
): Array<[string, StreamChannelRef]> {
  const refs: Array<[string, StreamChannelRef]> = [];
  _extractRefsRecursive(data, "", refs);
  return refs;
}

function _extractRefsRecursive(
  data: unknown,
  prefix: string,
  refs: Array<[string, StreamChannelRef]>,
): void {
  if (isChannelRef(data)) {
    refs.push([prefix, data]);
    return;
  }
  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      _extractRefsRecursive(data[i], prefix === "" ? `[${i}]` : `${prefix}[${i}]`, refs);
    }
    return;
  }
  if (typeof data !== "object" || data === null) return;
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    _extractRefsRecursive(value, prefix === "" ? key : `${prefix}.${key}`, refs);
  }
}

/** HTTP request received by a function registered with an HTTP trigger. */
export interface HttpRequest<TBody = unknown> {
  path_params: Record<string, string>;
  query_params: Record<string, string | string[]>;
  body: TBody;
  headers: Record<string, string | string[]>;
  method: string;
}

/** Response control surface passed to `http()` handlers. */
export interface HttpResponse {
  status(statusCode: number): void;
  headers(headers: Record<string, string>): void;
  stream: { end(data: string): void };
  close(): void;
}

/**
 * Wrap an Express-style `(req, res)` handler into the SDK function handler format.
 *
 * @example
 * ```ts
 * sdk.registerFunction('my-api', http(async (req, res) => {
 *   res.status(200);
 *   res.headers({ 'content-type': 'application/json' });
 *   res.stream.end(JSON.stringify({ hello: 'world' }));
 *   res.close();
 * }));
 * ```
 */
export function http<TBody = unknown>(
  callback: (req: HttpRequest<TBody>, res: HttpResponse) => Promise<void | unknown>,
): (req: HttpRequest<TBody> & { response: ChannelWriter }) => Promise<unknown> {
  return async (req) => {
    const { response, ...request } = req as HttpRequest<TBody> & { response: ChannelWriter };
    const res: HttpResponse = {
      status: (code) => response.sendMessage(JSON.stringify({ type: "set_status", status_code: code })),
      headers: (h) => response.sendMessage(JSON.stringify({ type: "set_headers", headers: h })),
      stream: { end: (data) => response.sendMessage(data) },
      close: () => response.close(),
    };
    return callback(request as HttpRequest<TBody>, res);
  };
}
