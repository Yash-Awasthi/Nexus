// SPDX-License-Identifier: Apache-2.0
/**
 * local-agent — §7.4: run the coding-agent loop *in-process* in the CLI.
 *
 * `nexus code <task> --local` skips the API/worker dispatch and drives a
 * `ToolAgentRuntime` directly over a workspace-confined `RuntimeToolSet` (the
 * same file + shell tools the worker exposes, minus the Docker sandbox — a
 * local run is on the user's own trusted machine). The LLM is a BYOK
 * `@nexus/llm-drivers` driver; the `llm` seam is injectable so the loop is
 * unit-tested with a mock (a live provider key is only needed for a real run).
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  RuntimeToolSet,
  ToolAgentRuntime,
  llmDriverToToolFn,
  type LlmToolDriver,
  type LlmToolFn,
  type ToolRuntimeResult,
  type ToolStepRecord,
} from "@nexus/agent-runtime";
import { AnthropicDriver, GroqDriver, OpenRouterDriver } from "@nexus/llm-drivers";

import { toolTranscriptEvent, type CouncilTranscript } from "@nexus/council";
import type { BM25SearchAdapter, VectorSearchAdapter } from "@nexus/hybrid-search";
import type { Reranker } from "@nexus/reranker";
import {
  councilRuntimeToolsFromLlm,
  debateRuntimeToolFromLlm,
  hybridSearchRuntimeTools,
} from "./deliberation-tools.js";

const DEFAULT_MAX_OUTPUT = 64 * 1024;
const DEFAULT_CMD_TIMEOUT = 30_000;

/** Env keys safe to forward into a spawned command (no credentials). */
const SAFE_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ"] as const;

/** A scrubbed environment for run_command — forwards only non-credential vars. */
function buildSafeEnv(): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const val = process.env[key];
    if (val !== undefined) safe[key] = val;
  }
  return safe;
}

/** Clip a string to at most `max` bytes, appending a truncation marker. */
function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} bytes]` : s;
}

/** Resolve a workspace-relative path, rejecting escapes and out-of-root symlinks. */
async function safeResolve(rootDir: string, p: string): Promise<string> {
  const resolved = path.resolve(rootDir, p);
  const rel = path.relative(rootDir, resolved);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  try {
    const real = await fs.realpath(resolved);
    const realRel = path.relative(rootDir, real);
    if (realRel !== "" && (realRel.startsWith("..") || path.isAbsolute(realRel))) {
      throw new Error(`symlink escapes workspace: ${p} → ${real}`);
    }
    return real;
  } catch (err) {
    // ENOENT is fine (writing a new file); re-throw a genuine escape.
    if (err instanceof Error && err.message.startsWith("symlink escapes")) throw err;
    return resolved;
  }
}

/** Run a shell command in `root` with a scrubbed env; combined stdout/stderr + exit code. */
function runCommand(
  command: string,
  root: string,
  maxOut: number,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: root,
      env: buildSafeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const onData = (b: Buffer): void => {
      if (out.length < maxOut) out += b.toString("utf8");
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(`${clip(out, maxOut)}\n[exit ${code ?? "null"}]`);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(`[spawn error] ${err.message}`);
    });
  });
}

/** Build the workspace-confined coding tool set for a local run. */
export function buildLocalCodingTools(rootDir: string, enableShell = true): RuntimeToolSet {
  const root = path.resolve(rootDir);
  const set = new RuntimeToolSet();

  set.add({
    name: "read_file",
    description: "Read a UTF-8 text file within the workspace (truncated if large).",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    handler: async (args) =>
      clip(
        await fs.readFile(await safeResolve(root, String(args.path ?? "")), "utf8"),
        DEFAULT_MAX_OUTPUT,
      ),
  });

  set.add({
    name: "write_file",
    description:
      "Create or overwrite a UTF-8 text file within the workspace (creates parent dirs).",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    handler: async (args) => {
      const p = await safeResolve(root, String(args.path ?? ""));
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, String(args.content ?? ""), "utf8");
      return `wrote ${path.relative(root, p)}`;
    },
  });

  set.add({
    name: "edit_file",
    description: "Replace the first exact occurrence of old_str with new_str in a workspace file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_str: { type: "string" },
        new_str: { type: "string" },
      },
      required: ["path", "old_str", "new_str"],
    },
    handler: async (args) => {
      const p = await safeResolve(root, String(args.path ?? ""));
      const oldStr = String(args.old_str ?? "");
      const content = await fs.readFile(p, "utf8");
      if (!content.includes(oldStr)) throw new Error("old_str not found in file");
      await fs.writeFile(p, content.replace(oldStr, String(args.new_str ?? "")), "utf8");
      return `edited ${path.relative(root, p)}`;
    },
  });

  set.add({
    name: "list_files",
    description: "List entries directly under a workspace-relative path (non-recursive).",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
    },
    handler: async (args) => {
      const entries = await fs.readdir(await safeResolve(root, String(args.path ?? ".")), {
        withFileTypes: true,
      });
      return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n") || "(empty)";
    },
  });

  if (enableShell) {
    set.add({
      name: "run_command",
      description:
        "Run a shell command in the workspace root; returns combined stdout/stderr + exit code.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      handler: (args) =>
        runCommand(String(args.command ?? ""), root, DEFAULT_MAX_OUTPUT, DEFAULT_CMD_TIMEOUT),
    });
  }

  return set;
}

/** Build a BYOK driver → `LlmToolFn`. Throws `missing_api_key` when no key resolves. */
export function makeLocalLlm(provider: string, model?: string, apiKey?: string): LlmToolFn {
  const p = provider.toLowerCase();
  const envKey =
    p === "groq"
      ? process.env.GROQ_API_KEY
      : p === "openrouter"
        ? process.env.OPENROUTER_API_KEY
        : process.env.ANTHROPIC_API_KEY;
  const key = apiKey ?? envKey ?? "";
  if (!key)
    throw new Error(`missing_api_key (provider=${p}) — set the provider env var or pass --api-key`);
  const driver =
    p === "groq"
      ? new GroqDriver({ apiKey: key, ...(model ? { model } : {}) })
      : p === "openrouter"
        ? new OpenRouterDriver({ apiKey: key, ...(model ? { model } : {}) })
        : new AnthropicDriver({ apiKey: key, ...(model ? { model } : {}) });
  return llmDriverToToolFn(driver satisfies LlmToolDriver);
}

export interface ToolTranscriptEvent {
  level: "info";
  event: "tool.transcript";
  taskId?: string;
  transcript: CouncilTranscript;
}

export interface LocalAgentOptions {
  instruction: string;
  /** Workspace root the tools are confined to. */
  rootDir: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  maxSteps?: number;
  enableShell?: boolean;
  systemPrompt?: string;
  onStep?: (step: ToolStepRecord) => void;
  onText?: (delta: string) => void;
  /** Injectable LLM (test seam). When omitted, a driver is built from provider+key. */
  llm?: LlmToolFn;
  signal?: AbortSignal;
  /** Opt-in: serve the council protocols + converging debate as runtime tools. */
  deliberation?: boolean;
  /**
   * Opt-in: serve the pass-69 hybrid single-query tool (`hybrid__hybrid_search`)
   * over caller-supplied corpus adapters. Not registered by default — a local
   * run has no corpus unless one is provided here.
   */
  retrieval?: {
    /** Dense leg adapter over the caller's vector index. */
    vector: VectorSearchAdapter;
    /** Sparse leg adapter over the caller's BM25 index (e.g. InMemoryBM25). */
    bm25: BM25SearchAdapter;
    /** Optional post-fusion reranker. */
    reranker?: Reranker;
  };
  /** Run id stamped onto emitted tool.transcript events (worker taskId parity). */
  taskId?: string;
  /** Structured tool.transcript emitter (worker-shaped event contract). */
  onToolTranscript?: (event: ToolTranscriptEvent) => void;
}

/** Run the coding agent loop in-process and return the full run result. */
export async function runLocalAgent(opts: LocalAgentOptions): Promise<ToolRuntimeResult> {
  const llm = opts.llm ?? makeLocalLlm(opts.provider ?? "anthropic", opts.model, opts.apiKey);
  const toolSet = buildLocalCodingTools(opts.rootDir, opts.enableShell ?? true);
  const hooks = opts.onToolTranscript
    ? {
        onTranscript: (transcript: CouncilTranscript) =>
          opts.onToolTranscript?.(toolTranscriptEvent(opts.taskId, transcript)),
      }
    : undefined;
  if (opts.deliberation) {
    for (const tool of await councilRuntimeToolsFromLlm(llm, { hooks })) toolSet.add(tool);
    toolSet.add(debateRuntimeToolFromLlm(llm, { hooks }));
  }
  if (opts.retrieval) {
    for (const tool of await hybridSearchRuntimeTools({ ...opts.retrieval, hooks }))
      toolSet.add(tool);
  }
  const runtime = new ToolAgentRuntime({
    llm,
    toolSet,
    workingDir: opts.rootDir,
    ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
    ...(opts.maxSteps ? { maxSteps: opts.maxSteps } : {}),
    ...(opts.onStep ? { onStep: opts.onStep } : {}),
    ...(opts.onText ? { onText: opts.onText } : {}),
  });
  return runtime.run(opts.instruction, opts.signal);
}
