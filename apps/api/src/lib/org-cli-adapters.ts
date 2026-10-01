// SPDX-License-Identifier: Apache-2.0
/**
 * External agent runtimes: Claude Code, Codex, Gemini CLI, OpenCode, any shell
 * command, and an HTTP webhook.
 *
 * Every process adapter gets the whole prompt on stdin, so its command line is
 * fixed per agent — which is what lets the exec gate reason about it. The
 * policy (`@nexus/exec-policy`) classifies the command: a deny rule stops the
 * run; `ask` files an exec approval the first time and, once the owner allows
 * it, remembers that grant for that agent and that exact command, arguments
 * and directory. Changing any of them asks again.
 *
 * The child never inherits the server's environment — only what a CLI needs
 * to find its own login (PATH, home, temp) plus the run's context and the
 * secrets the agent was explicitly given. Each agent works in its own
 * directory under the data dir unless it names one.
 *
 * CLI flags and output shapes were checked against the installed tools; the
 * adapter set and the process/HTTP adapter contracts follow Paperclip's
 * adapters — https://github.com/paperclipai/paperclip, MIT License,
 * Copyright (c) 2025 Paperclip AI.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ExecAction } from "@nexus/exec-policy";
import { pinnedFetch } from "@nexus/runtime";
import spawn from "cross-spawn";

import { priceKey } from "./cost-log.js";
import {
  classifyAction,
  listApprovals,
  redeemApproval,
  requestApproval,
} from "./exec-approvals.js";
import { createNotification } from "./notifications-store.js";
import { addPromptContributor } from "./org-protocol.js";
import {
  enqueueWake,
  registerAdapter,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "./org-runtime.js";
import { onOrgLoad, registerCompanyScoped, type AdapterType } from "./org-store.js";
import { PersistentStore, dataDir } from "./persistent-store.js";
import { resolveSecret } from "./secret-store.js";
import { executeSkillsOnce, skillExecAction, type SkillRecord } from "./skill-runner.js";

// ── Grants ───────────────────────────────────────────────────────────────────

interface ExecGrant {
  id: string;
  ownerId: string;
  companyId: string;
  agentId: string;
  fingerprint: string;
  status: "pending" | "granted";
  approvalId: string | null;
  /** The approval a wake was already sent for, so one grant wakes once. */
  wokeFor: string | null;
  createdAt: string;
}

const grants = new PersistentStore<ExecGrant>("org_exec_grants");
registerCompanyScoped(grants);
onOrgLoad(() => grants.load());

const fingerprint = (a: ExecAction) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify([a.surface, a.command, a.args ?? [], a.cwd ?? ""]))
    .digest("hex")
    .slice(0, 32);

/**
 * Whether this agent may start this command now. Returns null to proceed, or
 * the reason it may not (a deny rule, or an approval still waiting).
 */
export function gateCommand(
  ctx: Pick<AdapterContext, "run" | "agent" | "log">,
  action: ExecAction,
  label: string,
): string | null {
  const verdict = classifyAction(action);
  if (verdict.decision === "deny")
    return `Blocked by exec policy (${verdict.rule}): ${verdict.reason}`;
  if (verdict.decision === "allow") return null;

  const { run, agent } = ctx;
  const fp = fingerprint(action);
  const id = `${agent.id}:${fp}`;
  const grant = grants.get(id);
  if (grant?.status === "granted") return null;
  if (grant?.approvalId) {
    const redeemed = redeemApproval(run.ownerId, grant.approvalId, action);
    if (typeof redeemed !== "string") {
      grants.set(id, { ...grant, status: "granted" });
      ctx.log("system", `Command allowed; remembered for ${agent.name}.`);
      return null;
    }
    const still = listApprovals(run.ownerId).find((x) => x.id === grant.approvalId);
    if (still?.status === "pending")
      return `Waiting for you to allow ${label} for ${agent.name} (Approvals tab).`;
  }
  const record = requestApproval(
    run.ownerId,
    action,
    `Agent ${agent.name} wants to run ${label} in ${action.cwd ?? "its workspace"}. Allowing it lets this agent run the same command on later runs.`,
  );
  grants.set(id, {
    id,
    ownerId: run.ownerId,
    companyId: run.companyId,
    agentId: agent.id,
    fingerprint: fp,
    status: "pending",
    approvalId: record.id,
    wokeFor: null,
    createdAt: new Date().toISOString(),
  });
  void createNotification(run.ownerId, {
    type: "org",
    title: `${agent.name} needs your OK to run ${label}`,
    link: `/org?c=${run.companyId}&tab=approvals`,
  });
  return `Waiting for you to allow ${label} for ${agent.name} (Approvals tab).`;
}

/** Wake agents whose pending command approval was granted. The scheduler calls this each tick. */
export function wakeApprovedGrants(): string[] {
  const woken: string[] = [];
  for (const g of grants.values()) {
    if (g.status !== "pending" || !g.approvalId || g.wokeFor === g.approvalId) continue;
    const rec = listApprovals(g.ownerId).find((x) => x.id === g.approvalId);
    if (rec?.status !== "approved") continue;
    grants.set(g.id, { ...g, wokeFor: g.approvalId });
    try {
      enqueueWake(g.ownerId, g.agentId, { source: "approval", reason: "Command allowed" });
      woken.push(g.agentId);
    } catch {
      /* agent gone */
    }
  }
  return woken;
}

/** Forget every remembered command for an agent (after its config changes, or on request). */
export function revokeGrants(ownerId: string, agentId: string): number {
  let n = 0;
  for (const g of [...grants.values()])
    if (g.ownerId === ownerId && g.agentId === agentId) {
      grants.delete(g.id);
      n++;
    }
  return n;
}

// ── Process plumbing ─────────────────────────────────────────────────────────

/** Variables a CLI needs to find itself and its login. Nothing else from the server leaks. */
const PASS_ENV = [
  "PATH",
  "Path",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "ComSpec",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "TERM",
  "SHELL",
  "USER",
  "USERNAME",
  "XDG_CONFIG_HOME",
];

export function childEnv(ctx: AdapterContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of PASS_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.NEXUS_RUN_ID = ctx.run.id;
  env.NEXUS_AGENT_NAME = ctx.agent.name;
  env.NEXUS_COMPANY = ctx.company.name;
  if (ctx.task) {
    env.NEXUS_TASK_ID = ctx.task.identifier;
    env.NEXUS_TASK_TITLE = ctx.task.title;
  }
  for (const name of ctx.agent.secretNames) {
    try {
      const value = resolveSecret(ctx.run.ownerId, name);
      if (value !== null) env[name] = value;
    } catch {
      ctx.log("stderr", `Secret ${name} could not be read.`);
    }
  }
  return env;
}

/** The agent's own directory under the data dir, or the one its config names. */
export function workspaceFor(ctx: AdapterContext): string {
  const configured = ctx.agent.adapterConfig.cwd;
  if (typeof configured === "string" && configured.trim()) {
    const dir = path.resolve(configured.trim());
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
      throw new Error(`Working directory ${dir} does not exist.`);
    return dir;
  }
  const dir = path.join(dataDir(), "org-workspaces", ctx.company.id, ctx.agent.id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

const OUTPUT_CAP = 2 * 1024 * 1024;

/** Run one command with the prompt on stdin; settle on exit, abort or the output cap. */
export function runProcess(
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdin: string;
    signal: AbortSignal;
    onLine: (s: "stdout" | "stderr", l: string) => void;
  },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let stdout = "";
    let stderr = "";
    const pump = (stream: "stdout" | "stderr") => {
      let pending = "";
      return (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (stream === "stdout") stdout = (stdout + text).slice(-OUTPUT_CAP);
        else stderr = (stderr + text).slice(-OUTPUT_CAP);
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const l of lines) if (l.trim()) opts.onLine(stream, l);
      };
    };
    child.stdout?.on("data", pump("stdout"));
    child.stderr?.on("data", pump("stderr"));
    const onAbort = () => killTree(child);
    opts.signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      opts.signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      opts.signal.removeEventListener("abort", onAbort);
      if (opts.signal.aborted) reject(opts.signal.reason as Error);
      else resolve({ code, stdout, stderr });
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(opts.stdin);
  });
}

// ── CLI specs ────────────────────────────────────────────────────────────────

interface Parsed {
  output: string;
  sessionId?: string | null;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  error?: string;
}

interface CliSpec {
  label: string;
  bin: string;
  /** The provider the tool bills through; OpenCode's models name theirs. */
  vendor?: string;
  /** Arguments that define the command; the grant is keyed on these. */
  args: (cfg: Record<string, unknown>, model: string | null) => string[];
  /** Per-run arguments outside the grant (a session to resume). */
  runArgs?: (cfg: Record<string, unknown>, sessionId: string | null) => string[];
  parse: (stdout: string) => Parsed;
  /** One streamed stdout event as a progress line for the live run log, or null. */
  progress: (event: Record<string, unknown>) => string | null;
}

function jsonLines(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      out.push(JSON.parse(t) as Record<string, unknown>);
    } catch {
      /* not a JSON line */
    }
  }
  return out;
}

function lastJson(stdout: string): Record<string, unknown> | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start)) as Record<string, unknown>;
  } catch {
    return jsonLines(stdout).at(-1) ?? null;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const blocks = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : [];

const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"];
const SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];

export const CLI_SPECS: Record<"claude_code" | "codex" | "gemini" | "opencode", CliSpec> = {
  claude_code: {
    label: "Claude Code",
    bin: "claude",
    vendor: "anthropic",
    args: (cfg, model) => [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      ...(model ? ["--model", model] : []),
      ...(PERMISSION_MODES.includes(str(cfg.permissionMode))
        ? ["--permission-mode", str(cfg.permissionMode)]
        : []),
      ...(num(cfg.maxTurns) > 0 ? ["--max-turns", String(num(cfg.maxTurns))] : []),
    ],
    runArgs: (cfg, sessionId) =>
      cfg.resumeSession !== false && sessionId && /^[0-9a-f-]{36}$/i.test(sessionId)
        ? ["--resume", sessionId]
        : [],
    parse: (stdout) => {
      const j = lastJson(stdout);
      if (!j) return { output: stdout.trim() };
      const usage = (j.usage ?? {}) as Record<string, unknown>;
      return {
        output: str(j.result),
        sessionId: str(j.session_id) || null,
        model: Object.keys((j.modelUsage ?? {}) as object)[0],
        inputTokens:
          num(usage.input_tokens) +
          num(usage.cache_creation_input_tokens) +
          num(usage.cache_read_input_tokens),
        outputTokens: num(usage.output_tokens),
        costUsd: num(j.total_cost_usd),
        ...(j.is_error === true
          ? { error: str(j.result) || "Claude Code reported an error." }
          : {}),
      };
    },
    progress: (e) => {
      if (e.type !== "assistant") return null;
      const content = blocks((e.message as Record<string, unknown> | undefined)?.content);
      const lines = content.map((b) =>
        b.type === "tool_use" ? `tool: ${str(b.name)}` : str(b.text),
      );
      return lines.filter(Boolean).join("\n") || null;
    },
  },
  codex: {
    label: "Codex",
    bin: "codex",
    vendor: "openai",
    args: (cfg, model) => [
      "exec",
      "--json",
      "--skip-git-repo-check",
      ...(SANDBOXES.includes(str(cfg.sandbox)) ? ["-s", str(cfg.sandbox)] : []),
      ...(model ? ["-m", model] : []),
    ],
    parse: (stdout) => {
      const events = jsonLines(stdout);
      const texts: string[] = [];
      let sessionId: string | null = null;
      let inputTokens = 0;
      let outputTokens = 0;
      let error = "";
      for (const e of events) {
        if (e.type === "thread.started") sessionId = str(e.thread_id) || null;
        const item = (e.item ?? {}) as Record<string, unknown>;
        if (e.type === "item.completed" && item.type === "agent_message")
          texts.push(str(item.text));
        if (e.type === "turn.completed") {
          const u = (e.usage ?? {}) as Record<string, unknown>;
          inputTokens += num(u.input_tokens);
          outputTokens += num(u.output_tokens);
        }
        if (e.type === "error" || e.type === "turn.failed")
          error = str(e.message) || JSON.stringify(e).slice(0, 300);
      }
      return {
        output: texts.join("\n\n"),
        sessionId,
        inputTokens,
        outputTokens,
        ...(error && !texts.length ? { error } : {}),
      };
    },
    progress: (e) => {
      const item = (e.item ?? {}) as Record<string, unknown>;
      if (e.type === "item.started" && item.type === "command_execution")
        return `$ ${str(item.command)}`;
      if (e.type === "item.completed" && item.type === "agent_message") return str(item.text);
      return null;
    },
  },
  gemini: {
    label: "Gemini CLI",
    bin: "gemini",
    vendor: "gemini",
    args: (_cfg, model) => [
      "-p",
      "Follow the instructions above.",
      "-o",
      "stream-json",
      ...(model ? ["-m", model] : []),
    ],
    parse: (stdout) => {
      const texts: string[] = [];
      const out: Parsed = { output: "", sessionId: null };
      for (const e of jsonLines(stdout)) {
        if (e.type === "init") out.sessionId = str(e.session_id) || null;
        if (e.type === "message" && e.role === "assistant") texts.push(str(e.content));
        if (e.type !== "result") continue;
        const stats = (e.stats ?? {}) as Record<string, unknown>;
        out.model = Object.keys((stats.models ?? {}) as object)[0];
        out.inputTokens = num(stats.input_tokens);
        out.outputTokens = num(stats.output_tokens);
        if (e.status !== "success") {
          const err = (e.error ?? {}) as Record<string, unknown>;
          out.error = str(err.message) || "Gemini CLI reported an error.";
        }
      }
      if (!texts.length && !out.model) return { output: stdout.trim() };
      return { ...out, output: texts.join("") };
    },
    progress: (e) => {
      if (e.type === "tool_use") return `tool: ${str(e.tool_name)}`;
      return e.type === "message" && e.role === "assistant" ? str(e.content) || null : null;
    },
  },
  opencode: {
    label: "OpenCode",
    bin: "opencode",
    args: (_cfg, model) => ["run", "--format", "json", ...(model ? ["-m", model] : [])],
    parse: (stdout) => {
      const texts: string[] = [];
      let sessionId: string | null = null;
      let inputTokens = 0;
      let outputTokens = 0;
      let costUsd = 0;
      for (const e of jsonLines(stdout)) {
        sessionId = str(e.sessionID) || sessionId;
        const part = (e.part ?? {}) as Record<string, unknown>;
        if (e.type === "text") texts.push(str(part.text));
        if (e.type === "step_finish") {
          const t = (part.tokens ?? {}) as Record<string, unknown>;
          inputTokens += num(t.input);
          outputTokens += num(t.output);
          costUsd += num(part.cost);
        }
      }
      return { output: texts.join(""), sessionId, inputTokens, outputTokens, costUsd };
    },
    progress: (e) => {
      const part = (e.part ?? {}) as Record<string, unknown>;
      if (e.type === "tool_use") return `tool: ${str(part.tool)}`;
      return e.type === "text" ? str(part.text) || null : null;
    },
  },
};

function promptText(ctx: AdapterContext): string {
  return `${ctx.prompt.system}\n\n---\n\n${ctx.prompt.user}`;
}

function cliAdapter(spec: CliSpec): Adapter {
  return async (ctx) => {
    const cfg = ctx.agent.adapterConfig;
    const bin =
      typeof cfg.command === "string" && cfg.command.trim() ? cfg.command.trim() : spec.bin;
    const cwd = workspaceFor(ctx);
    const args = spec.args(cfg, ctx.agent.model);
    const action: ExecAction = { surface: "pty", command: bin, args, cwd };
    const label = `${spec.label} (${bin})`;

    const why = gateCommand(ctx, action, label);
    if (why) return { ok: false, refused: true, output: "", error: why };
    const budget = ctx.guardCall(
      priceKey(ctx.agent.model ?? bin, spec.vendor),
      promptText(ctx).length,
      4096,
    );
    if (budget) return { ok: false, refused: true, output: "", error: budget };

    const full = [...args, ...(spec.runArgs?.(cfg, ctx.agent.sessionId) ?? [])];
    ctx.log("system", `$ ${bin} ${full.join(" ")}  (in ${cwd})`);
    const res = await runProcess(bin, full, {
      cwd,
      env: childEnv(ctx),
      stdin: promptText(ctx),
      signal: ctx.signal,
      onLine: (stream, line) => {
        if (stream === "stderr") return ctx.log("stderr", line);
        const event = jsonLines(line)[0];
        const text = event && spec.progress(event);
        if (text) ctx.log("stdout", text);
      },
    });
    const parsed = spec.parse(res.stdout);
    if (parsed.output) ctx.log("agent", parsed.output);
    const result: AdapterResult = {
      ok: res.code === 0 && !parsed.error && !!parsed.output,
      output: parsed.output,
      sessionId: parsed.sessionId ?? null,
      usage: {
        inputTokens: parsed.inputTokens ?? 0,
        outputTokens: parsed.outputTokens ?? 0,
        model: priceKey(parsed.model ?? ctx.agent.model ?? bin, spec.vendor),
        ...(parsed.costUsd !== undefined ? { costUsd: parsed.costUsd } : {}),
      },
    };
    if (!result.ok)
      result.error =
        parsed.error ||
        (res.code !== 0
          ? `${spec.label} exited with code ${res.code}: ${res.stderr.slice(-500)}`
          : `${spec.label} returned no output.`);
    return result;
  };
}

/** Any command: the prompt on stdin, stdout as the agent's reply. */
const shellAdapter: Adapter = async (ctx) => {
  const cfg = ctx.agent.adapterConfig;
  const command = typeof cfg.command === "string" ? cfg.command.trim() : "";
  if (!command) return { ok: false, output: "", error: "Shell agents need adapterConfig.command." };
  const args = Array.isArray(cfg.args)
    ? cfg.args.filter((a): a is string => typeof a === "string")
    : [];
  const cwd = workspaceFor(ctx);
  const action: ExecAction = { surface: "pty", command, args, cwd };
  const why = gateCommand(ctx, action, `\`${[command, ...args].join(" ")}\``);
  if (why) return { ok: false, refused: true, output: "", error: why };
  ctx.log("system", `$ ${[command, ...args].join(" ")}  (in ${cwd})`);
  const res = await runProcess(command, args, {
    cwd,
    env: childEnv(ctx),
    stdin: promptText(ctx),
    signal: ctx.signal,
    onLine: (stream, line) => ctx.log(stream, line),
  });
  return res.code === 0
    ? { ok: true, output: res.stdout.trim() }
    : {
        ok: false,
        output: res.stdout.trim(),
        error: `Exited with code ${res.code}: ${res.stderr.slice(-500)}`,
      };
};

/** Origins the operator lets webhook agents reach on a private network. */
function privateOrigins(): Set<string> {
  return new Set(
    (process.env.NEXUS_ORG_HTTP_PRIVATE_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** POST the run to a URL; the reply's `output` (or its text) is the agent's answer. */
const httpAdapter: Adapter = async (ctx) => {
  const cfg = ctx.agent.adapterConfig;
  let url: URL;
  try {
    url = new URL(String(cfg.url ?? ""));
  } catch {
    return { ok: false, output: "", error: "HTTP agents need a valid adapterConfig.url." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return { ok: false, output: "", error: "Only http and https URLs are allowed." };
  if (url.username || url.password)
    return { ok: false, output: "", error: "Put credentials in a header secret, not in the URL." };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.headers && typeof cfg.headers === "object")
    for (const [k, v] of Object.entries(cfg.headers as Record<string, unknown>))
      if (typeof v === "string") headers[k] = v;
  // A header value "secret:NAME" is filled from the owner's secret store, never stored inline.
  for (const [k, v] of Object.entries(headers)) {
    const m = /^secret:([A-Z][A-Z0-9_]*)$/.exec(v);
    if (m) headers[k] = resolveSecret(ctx.run.ownerId, m[1]!) ?? "";
  }
  const body = JSON.stringify({
    runId: ctx.run.id,
    agent: { id: ctx.agent.id, name: ctx.agent.name, role: ctx.agent.role },
    company: { id: ctx.company.id, name: ctx.company.name, mission: ctx.company.mission },
    task: ctx.task
      ? {
          id: ctx.task.id,
          identifier: ctx.task.identifier,
          title: ctx.task.title,
          description: ctx.task.description,
        }
      : null,
    prompt: ctx.prompt,
  });
  const doFetch = privateOrigins().has(url.origin.toLowerCase()) ? fetch : pinnedFetch;
  ctx.log("system", `POST ${url.origin}${url.pathname}`);
  const res = await doFetch(url, { method: "POST", headers, body, signal: ctx.signal });
  const text = (await res.text()).slice(0, 200_000);
  if (!res.ok)
    return {
      ok: false,
      output: "",
      error: `Webhook answered ${res.status}: ${text.slice(0, 300)}`,
    };
  let output = text;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (typeof j.output === "string") output = j.output;
  } catch {
    /* plain text reply */
  }
  return { ok: true, output };
};

const CLI_TYPES: AdapterType[] = ["claude_code", "codex", "gemini", "opencode"];

export function registerExternalAdapters(): void {
  for (const t of CLI_TYPES) registerAdapter(t, cliAdapter(CLI_SPECS[t as keyof typeof CLI_SPECS]));
  registerAdapter("shell", shellAdapter);
  registerAdapter("http", httpAdapter);
}

// ── Skills ───────────────────────────────────────────────────────────────────

let skillsFor: (ownerId: string, ids: string[]) => SkillRecord[] = () => [];
/** How an agent's skill ids become skill records; the route module injects the skill store. */
export function setSkillResolver(fn: (ownerId: string, ids: string[]) => SkillRecord[]): void {
  skillsFor = fn;
}

/**
 * Run each skill attached to the agent once, before its turn, and hand it the
 * real results. Skill code is code: it passes the exec gate like any process,
 * keyed on the skill and a hash of its code, so an edited skill asks again.
 */
addPromptContributor(async ({ agent, run, log }) => {
  const skills = skillsFor(run.ownerId, agent.skills).filter((s) => s.enabled !== false);
  if (skills.length === 0) return null;
  const lines: string[] = [];
  for (const s of skills) {
    const why = gateCommand({ run, agent, log }, skillExecAction(s), `the skill "${s.name}"`);
    if (why) return { refuse: why };
  }
  for (const r of await executeSkillsOnce(skills)) {
    log(
      r.ok ? "system" : "stderr",
      `Skill ${r.skillName}: ${r.ok ? "ran" : (r.error ?? "failed")}`,
    );
    const out = r.output.trim() ? `\n  output: ${r.output.trim().slice(0, 2000)}` : "";
    lines.push(
      `- ${r.skillName}: ${r.ok ? "OK" : `FAILED (${r.error ?? `exit ${r.exitCode}`})`}${out}`,
    );
  }
  return `Your skills, already run once for this turn (real results; build on them):\n${lines.join("\n")}`;
});
