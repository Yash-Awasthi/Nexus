// SPDX-License-Identifier: Apache-2.0
/**
 * Per-request LLM traces for the admin Traces page.
 *
 * The caching driver reports every completion into the current request's
 * step list (lib/user-context.ts); when a request that made model calls
 * finishes, its steps become one trace here. The newest MAX_TRACES are kept,
 * since they are for debugging recent runs, and survive a restart: one
 * nexus_kv row per trace on Postgres, or one appended JSONL line on the file
 * backing, which is compacted only once it holds twice the cap.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { priceOf } from "./cost-log.js";
import { PersistentStore, dataDir } from "./persistent-store.js";
import { getPgPool } from "./pg-pool.js";

export interface LlmStep {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  cached: boolean;
  error?: string;
}

interface RequestTrace {
  id: string;
  type: string;
  method: string;
  path: string;
  status: number;
  userId: string | null;
  totalLatencyMs: number;
  totalTokens: number;
  totalCostUsd: number;
  steps: LlmStep[];
  createdAt: string;
}

const MAX_TRACES = 1000;
const traces: RequestTrace[] = [];

const rows = new PersistentStore<RequestTrace>("request_traces");
const file = () => path.join(dataDir("stores"), "request-traces.jsonl");
let fileLines = 0;
let loaded: Promise<void> | null = null;
let pending: Promise<void> = Promise.resolve();

function readStored(): RequestTrace[] {
  try {
    const lines = fs.readFileSync(file(), "utf8").split("\n").filter(Boolean);
    fileLines = lines.length;
    return lines.flatMap((l) => {
      try {
        return [JSON.parse(l) as RequestTrace];
      } catch {
        return []; // a line torn by a crash mid-append
      }
    });
  } catch {
    return [];
  }
}

function load(): Promise<void> {
  loaded ??= (async () => {
    let stored: RequestTrace[];
    if (getPgPool()) {
      await rows.load();
      stored = [...rows.values()];
    } else stored = readStored();
    const seen = new Set(traces.map((t) => t.id));
    traces.unshift(...stored.filter((t) => !seen.has(t.id)));
    traces.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const gone of traces.splice(0, Math.max(0, traces.length - MAX_TRACES))) {
      if (getPgPool()) rows.delete(gone.id);
    }
  })();
  return loaded;
}

type Write = { trace: RequestTrace; evicted: RequestTrace[] };
let queue: Write[] = [];

async function writeBatch(batch: Write[]): Promise<void> {
  await load();
  if (getPgPool()) {
    for (const { trace, evicted } of batch) {
      rows.set(trace.id, trace);
      for (const gone of evicted) rows.delete(gone.id);
    }
    return;
  }
  await fs.promises.mkdir(path.dirname(file()), { recursive: true });
  fileLines += batch.length;
  if (fileLines > 2 * MAX_TRACES) {
    await fs.promises.writeFile(file(), traces.map((t) => JSON.stringify(t) + "\n").join(""));
    fileLines = traces.length;
  } else {
    await fs.promises.appendFile(file(), batch.map((w) => JSON.stringify(w.trace) + "\n").join(""));
  }
}

// Traces recorded while a write is in flight go out together in the next one.
function persist(trace: RequestTrace, evicted: RequestTrace[]): void {
  queue.push({ trace, evicted });
  if (queue.length > 1) return;
  pending = pending
    .then(() => {
      const batch = queue;
      queue = [];
      return writeBatch(batch);
    })
    .catch(() => undefined);
}

/** Resolves once every trace recorded so far has reached the backing store. */
export function flushTraces(): Promise<void> {
  return pending;
}

function typeFor(path: string): string {
  if (/deliberat|council|discussion/.test(path)) return "deliberate";
  if (path.includes("research")) return "research";
  if (path.includes("embed")) return "embedding";
  if (path.includes("chat")) return "chat";
  return path.replace(/^\/api\/(v1\/)?/, "").split(/[/?]/)[0] || "other";
}

export function recordTrace(t: {
  method: string;
  url: string;
  status: number;
  userId: string | null;
  latencyMs: number;
  steps: LlmStep[];
}): void {
  const url = t.url.split("?")[0] ?? t.url;
  const trace: RequestTrace = {
    id: randomUUID(),
    type: typeFor(url),
    method: t.method,
    path: url,
    status: t.status,
    userId: t.userId,
    totalLatencyMs: Math.round(t.latencyMs),
    totalTokens: t.steps.reduce((n, s) => n + s.inputTokens + s.outputTokens, 0),
    totalCostUsd: t.steps.reduce((sum, s) => {
      const [pi, po] = priceOf(s.model, s.provider);
      return sum + (s.inputTokens * pi + s.outputTokens * po) / 1_000_000;
    }, 0),
    steps: t.steps,
    createdAt: new Date().toISOString(),
  };
  traces.push(trace);
  persist(trace, traces.splice(0, Math.max(0, traces.length - MAX_TRACES)));
}

/** Newest first. */
export async function listTraces(opts: { type?: string; page: number; limit: number }) {
  await load();
  const all = traces.filter((t) => !opts.type || t.type === opts.type).reverse();
  const start = (opts.page - 1) * opts.limit;
  return {
    traces: all.slice(start, start + opts.limit),
    total: all.length,
    page: opts.page,
    limit: opts.limit,
    pages: Math.max(1, Math.ceil(all.length / opts.limit)),
  };
}

export async function getTrace(id: string): Promise<RequestTrace | undefined> {
  await load();
  return traces.find((t) => t.id === id);
}
