#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * nexus CLI — submit objectives, manage tasks, approvals, council, audit
 *
 * Usage:
 *   nexus health
 *   nexus tasks [--status queued] [--limit 20]
 *   nexus tasks submit --type <type> --payload <json>
 *   nexus tasks get <taskId>
 *   nexus tasks cancel <taskId>
 *   nexus approvals [--status pending]
 *   nexus approvals approve <approvalId> --by <actor>
 *   nexus approvals reject <approvalId> --by <actor> [--reason <text>]
 *   nexus council deliberate --title <title> [--desc <text>] [--budget 0.10]
 *   nexus council verdict <verdictId>
 *   nexus ingest event --source <src> --type <type> --payload <json>
 *   nexus models seed [--file <path>]
 *   nexus audit [--limit 50]
 *   nexus audit verify
 *   nexus org status|companies|inbox|ask|approve|reject|wake  (NEXUS_TOKEN = your access token)
 */

import { randomUUID } from "node:crypto";

import chalk from "chalk";
import { Command } from "commander";

import { api, fail } from "./lib/client.js";
import { runLocalAgent } from "./lib/local-agent.js";
import { loadModelsDevSource, seedModelsFromSource } from "./lib/models-seed.js";
import { registerOrgCommands } from "./lib/org.js";
import { streamSse } from "./lib/sse-stream.js";

const program = new Command();

program.name("nexus").description("Nexus autonomous orchestration platform CLI").version("0.1.0");

// ── health ────────────────────────────────────────────────────────────────────

program
  .command("health")
  .description("Check API health")
  .action(async () => {
    try {
      const res = await api.health();
      console.log(chalk.green("✓"), "API is", chalk.bold(res.status));
    } catch (err) {
      fail(err);
    }
  });

// ── code (coding agent) ─────────────────────────────────────────────────────────

/**
 * Render one streamed agent frame; returns true when the stream should close.
 * With `awaitLearnings`, the forked review's `agent.learnings` (which arrives
 * after status) is the terminal event instead of `agent.status`.
 */
function renderAgentFrame(
  event: string | undefined,
  data: Record<string, unknown>,
  awaitLearnings: boolean,
): boolean {
  switch (event) {
    case "agent.run_started":
      console.log(chalk.gray(`  ▸ ${String(data.instruction ?? "").slice(0, 100)}`));
      return false;
    case "agent.step": {
      const tools = Array.isArray(data.toolCalls) ? (data.toolCalls as string[]) : [];
      const label = tools.length ? tools.join(", ") : chalk.gray("(thinking)");
      console.log(`  ${chalk.cyan(`step ${String(data.stepIndex)}`)}  ${label}`);
      return false;
    }
    case "agent.compaction":
      console.log(chalk.gray(`  ~ compacted ${String(data.summarized)} turns`));
      return false;
    case "agent.learnings": {
      const learnings = Array.isArray(data.learnings)
        ? (data.learnings as { type: string; content: string }[])
        : [];
      if (learnings.length) {
        console.log(chalk.magenta("\n✎ learnings:"));
        for (const l of learnings) console.log(`  ${chalk.gray(`[${l.type}]`)} ${l.content}`);
      }
      return true; // learnings is the terminal event when a review was requested
    }
    case "agent.status": {
      const status = String(data.status);
      const color =
        status === "completed" ? chalk.green : status === "error" ? chalk.red : chalk.yellow;
      console.log(
        color(`\n● ${status.toUpperCase()}`),
        data.steps !== undefined ? chalk.gray(`(${String(data.steps)} steps)`) : "",
      );
      if (data.error) console.error(chalk.red(String(data.error)));
      // When a review was requested, keep the stream open for agent.learnings.
      return !awaitLearnings;
    }
    default:
      return false;
  }
}

/** §7.4 — run the agent loop in-process, rendering each step to the console. */
async function runCodeLocal(
  task: string,
  opts: {
    provider?: string;
    model?: string;
    dir?: string;
    apiKey?: string;
    maxSteps?: string;
    shell?: boolean;
    deliberate?: boolean;
  },
): Promise<void> {
  console.log(chalk.gray(`  ▸ ${task.slice(0, 100)} ${chalk.dim("(local)")}\n`));
  const result = await runLocalAgent({
    instruction: task,
    rootDir: opts.dir ?? process.cwd(),
    ...(opts.deliberate ? { deliberation: true } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.maxSteps ? { maxSteps: Number(opts.maxSteps) } : {}),
    enableShell: opts.shell !== false,
    onStep: (step) => {
      const tools = step.toolCalls.map((c) => c.name);
      const label = tools.length ? tools.join(", ") : chalk.gray("(thinking)");
      console.log(`  ${chalk.cyan(`step ${step.stepIndex}`)}  ${label}`);
    },
    onToolTranscript: (event) => {
      // Worker-shaped artifact contract (pass 62): the structured JSON event is
      // the primary emission; the console line is presentation on top.
      console.log(JSON.stringify(event));
      const t = event.transcript;
      console.log(
        chalk.gray("  ⌘ deliberation transcript"),
        chalk.cyan(t.protocol ?? ""),
        chalk.gray(`degraded=${String(t.degraded ?? false)} warnings=${(t.warnings ?? []).length}`),
      );
    },
  });
  const status = result.aborted ? "aborted" : result.stopReason ? result.stopReason : "completed";
  const color = status === "completed" ? chalk.green : chalk.yellow;
  console.log(color(`\n● ${status.toUpperCase()}`), chalk.gray(`(${result.steps.length} steps)`));
  if (result.finalContent) console.log(`\n${result.finalContent}`);
}

program
  .command("code <task>")
  .description("Launch a coding-agent run and stream its progress")
  .option("--provider <p>", "LLM provider (anthropic|groq|openrouter)")
  .option("--model <m>", "Model id")
  .option("--repo <path>", "Run inside a git-worktree workspace cut from this repo")
  .option("--base <branch>", "Base branch for the worktree", "main")
  .option("--start-run", "Start the .nexus run server during the agent run")
  .option("--yes", "Approve the run's shell commands without asking")
  .option("--max-steps <n>", "Max agent steps")
  .option("--review", "Run a forked post-run learning review")
  .option("--no-wait", "Return after launch without streaming")
  .option("--local", "Run the agent loop in-process (BYOK key from env) instead of via the API")
  .option("--dir <path>", "Workspace root for --local runs (default: cwd)")
  .option("--api-key <key>", "Provider API key for --local runs (else the provider env var)")
  .option("--no-shell", "Disable the run_command tool for --local runs")
  .option("--deliberate", "Serve council + debate deliberation tools on --local runs")
  .action(async (task: string, opts) => {
    // §7.4 — in-process loop over the RuntimeToolSet; no API/worker involved.
    if (opts.local) {
      try {
        await runCodeLocal(task, opts);
      } catch (err) {
        fail(err);
      }
      return;
    }
    try {
      // Named here so the shell approval, which the server binds to this id, matches on the retry.
      const body: Record<string, unknown> = { instruction: task, sessionId: randomUUID() };
      if (opts.provider) body.provider = opts.provider;
      if (opts.model) body.model = opts.model;
      if (opts.maxSteps) body.maxSteps = Number(opts.maxSteps);
      if (opts.review) body.review = true;
      if (opts.repo) {
        body.worktree = {
          repoPath: opts.repo,
          baseBranch: opts.base,
          ...(opts.startRun ? { startRun: true } : {}),
        };
      }

      type Launch = { sessionId: string; stream: string; approvalId?: string };
      let launched = await api.post<Launch>("/agent/run", body);
      if (launched.approvalId) {
        if (!opts.yes) {
          console.log(
            chalk.yellow("!"),
            "This run's shell needs your approval. Run again with --yes to allow it once.",
          );
          return;
        }
        await api.post(`/exec/approvals/${launched.approvalId}/approve`, {});
        launched = await api.post<Launch>("/agent/run", {
          ...body,
          approvalId: launched.approvalId,
        });
      }
      console.log(chalk.green("✓"), "Launched:", chalk.bold(launched.sessionId));
      if (!opts.wait) return;

      console.log(chalk.gray("  streaming… (Ctrl-C to detach)\n"));
      const controller = new AbortController();
      try {
        for await (const frame of streamSse(
          api.sseUrl(`/sse/agent/${launched.sessionId}`),
          api.authHeaders(),
          controller.signal,
        )) {
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(frame.data) as Record<string, unknown>;
          } catch {
            /* keepalive or non-JSON frame */
          }
          if (renderAgentFrame(frame.event, data, Boolean(opts.review))) {
            controller.abort();
            break;
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) throw err;
      }
    } catch (err) {
      fail(err);
    }
  });

// ── tasks ─────────────────────────────────────────────────────────────────────

const tasks = program.command("tasks").description("Manage runtime tasks");

tasks
  .command("list")
  .alias("ls")
  .description("List tasks")
  .option("--status <status>", "Filter by status")
  .option("--priority <priority>", "Filter by priority")
  .option("--limit <n>", "Max results", "20")
  .option("--offset <n>", "Offset", "0")
  .action(async (opts) => {
    const params = new URLSearchParams({ limit: opts.limit, offset: opts.offset });
    if (opts.status) params.set("status", opts.status);
    if (opts.priority) params.set("priority", opts.priority);
    const data = await api.get<{ tasks: unknown[] }>(`/runtime/tasks?${params}`);
    console.log(JSON.stringify(data.tasks, null, 2));
  });

tasks
  .command("submit")
  .description("Submit a new task")
  .requiredOption("--type <type>", "Task type, e.g. github.create-issue")
  .requiredOption("--payload <json>", "JSON payload string")
  .option("--priority <priority>", "low | medium | high", "medium")
  .action(async (opts) => {
    const payload = JSON.parse(opts.payload) as unknown;
    const data = await api.post("/runtime/tasks", {
      type: opts.type,
      payload,
      priority: opts.priority,
    });
    console.log(chalk.green("✓ Task created:"));
    console.log(JSON.stringify(data, null, 2));
  });

tasks
  .command("get <taskId>")
  .description("Get task by ID")
  .action(async (taskId) => {
    const data = await api.get(`/runtime/tasks/${taskId}`);
    console.log(JSON.stringify(data, null, 2));
  });

tasks
  .command("cancel <taskId>")
  .description("Cancel a queued task")
  .action(async (taskId) => {
    const data = await api.patch(`/runtime/tasks/${taskId}`, { action: "cancel" });
    console.log(chalk.yellow("⊘ Task cancelled:"));
    console.log(JSON.stringify(data, null, 2));
  });

// ── approvals ─────────────────────────────────────────────────────────────────

const approvals = program.command("approvals").description("Manage governance approvals");

approvals
  .command("list")
  .alias("ls")
  .description("List approval requests")
  .option("--status <status>", "Filter by status (pending|approved|rejected|expired)", "pending")
  .option("--limit <n>", "Max results", "20")
  .action(async (opts) => {
    const params = new URLSearchParams({ status: opts.status, limit: opts.limit });
    const data = await api.get<{ approvals: unknown[] }>(`/governance/approvals?${params}`);
    console.log(JSON.stringify(data.approvals, null, 2));
  });

approvals
  .command("approve <approvalId>")
  .description("Approve a pending request")
  .requiredOption("--by <actor>", "Your identity (name or email)")
  .option("--reason <text>", "Optional reason")
  .action(async (approvalId, opts) => {
    const data = await api.post(`/governance/approvals/${approvalId}/approve`, {
      resolved_by: opts.by,
      reason: opts.reason,
    });
    console.log(chalk.green("✓ Approved:"));
    console.log(JSON.stringify(data, null, 2));
  });

approvals
  .command("reject <approvalId>")
  .description("Reject a pending request")
  .requiredOption("--by <actor>", "Your identity")
  .option("--reason <text>", "Optional reason")
  .action(async (approvalId, opts) => {
    const data = await api.post(`/governance/approvals/${approvalId}/reject`, {
      resolved_by: opts.by,
      reason: opts.reason,
    });
    console.log(chalk.yellow("⊘ Rejected:"));
    console.log(JSON.stringify(data, null, 2));
  });

// ── council ───────────────────────────────────────────────────────────────────

const council = program.command("council").description("Council deliberation commands");

council
  .command("deliberate")
  .description("Run a council deliberation")
  .requiredOption("--title <title>", "Proposal title")
  .option("--desc <text>", "Optional description")
  .option("--budget <usd>", "LLM cost budget in USD", "0.10")
  .option("--signal-id <id>", "Link to an existing signal ID")
  .option("--mode <mode>", "majority | unanimous | weighted", "majority")
  .action(async (opts) => {
    console.log(chalk.cyan("⚙ Deliberating..."), chalk.bold(opts.title));
    const data = await api.post("/council/deliberate", {
      proposal: { title: opts.title, description: opts.desc },
      budgetUsd: parseFloat(opts.budget),
      mode: opts.mode,
      councilSize: 14,
      signal_id: opts.signalId,
    });
    const res = data as {
      ok: boolean;
      verdictId?: string | null;
      result?: { outcome: string; consensus: number; summary: string };
    };
    if (res.ok && res.result) {
      const outcome = res.result.outcome;
      const color =
        outcome === "approved" ? chalk.green : outcome === "rejected" ? chalk.red : chalk.yellow;
      console.log(color(`\n● Outcome: ${outcome.toUpperCase()}`));
      console.log(`  Consensus: ${(res.result.consensus * 100).toFixed(0)}%`);
      console.log(`  Summary:   ${res.result.summary}`);
      if (res.verdictId) console.log(`  Verdict:   ${res.verdictId}`);
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
  });

council
  .command("verdict <verdictId>")
  .description("Get a council verdict")
  .action(async (verdictId) => {
    const data = await api.get(`/council/verdicts/${verdictId}`);
    console.log(JSON.stringify(data, null, 2));
  });

// ── ingest ────────────────────────────────────────────────────────────────────

const ingest = program.command("ingest").description("Ingest events");

ingest
  .command("event")
  .description("Submit a raw event for ingestion")
  .requiredOption("--source <source>", "Adapter source, e.g. github")
  .requiredOption("--type <type>", "Event type, e.g. pr.opened")
  .requiredOption("--payload <json>", "JSON payload string")
  .option("--priority <tier>", "high | medium | low", "medium")
  .option("--key <key>", "Idempotency key")
  .action(async (opts) => {
    const data = await api.post("/ingest/events", {
      source: opts.source,
      event_type: opts.type,
      payload: JSON.parse(opts.payload) as unknown,
      priority: opts.priority,
      idempotency_key: opts.key,
    });
    console.log(chalk.green("✓ Event accepted:"));
    console.log(JSON.stringify(data, null, 2));
  });

// ── audit ─────────────────────────────────────────────────────────────────────

const audit = program.command("audit").description("Audit log commands");

audit
  .command("log")
  .description("View audit log entries")
  .option("--limit <n>", "Max results", "50")
  .option("--offset <n>", "Offset", "0")
  .action(async (opts) => {
    const params = new URLSearchParams({ limit: opts.limit, offset: opts.offset });
    const data = await api.get<{ entries: unknown[] }>(`/audit/log?${params}`);
    console.log(JSON.stringify(data.entries, null, 2));
  });

audit
  .command("verify")
  .description("Verify HMAC chain integrity")
  .action(async () => {
    const data = await api.get<{ valid: boolean; checked_count: number; message: string }>(
      "/audit/log/verify",
    );
    const icon = data.valid ? chalk.green("✓") : chalk.red("✗");
    console.log(
      icon,
      `Chain ${data.valid ? "intact" : "COMPROMISED"} — ${data.checked_count} entries checked`,
    );
    if (!data.valid) {
      fail(data.message);
    }
  });

// ── gateway ───────────────────────────────────────────────────────────────────

const gateway = program.command("gateway").description("Model Gateway commands");

gateway
  .command("models")
  .description("List available model aliases")
  .action(async () => {
    try {
      const data = await api.get<{
        models: { id: string; provider: string; backend_model: string; available: boolean }[];
        providers: string[];
      }>("/gateway/models");
      console.log(
        chalk.bold(`\n${data.models.length} model aliases (${data.providers.length} providers)\n`),
      );
      for (const m of data.models) {
        const icon = m.available ? chalk.green("✓") : chalk.gray("○");
        console.log(` ${icon} ${chalk.cyan(m.id.padEnd(24))} → ${m.provider}/${m.backend_model}`);
      }
    } catch (err) {
      fail(err);
    }
  });

gateway
  .command("chat <message>")
  .description("Send a one-shot message through the gateway")
  .option("-m, --model <model>", "Model alias", "nexus/fast")
  .action(async (message: string, opts: { model: string }) => {
    try {
      const data = await api.post<{
        type: string;
        content: { type: string; text: string }[];
        usage: { input_tokens: number; output_tokens: number };
        model: string;
      }>("/gateway/messages", {
        model: opts.model,
        messages: [{ role: "user", content: message }],
        stream: false,
      });
      const text = data.content.map((b: { type: string; text: string }) => b.text).join("");
      console.log(chalk.bold("\nAssistant:"), "\n");
      console.log(text);
      console.log(
        chalk.gray(
          `\n[${data.model} | ${data.usage.input_tokens}↑ ${data.usage.output_tokens}↓ tokens]`,
        ),
      );
    } catch (err) {
      fail(err);
    }
  });

gateway
  .command("cost-report")
  .description("Show what your model calls have cost")
  .option("--limit <n>", "Most recent calls to list", "10")
  .action(async (opts: { limit: string }) => {
    try {
      const data = await api.get<{
        totalRuns: number;
        totalUsd: number;
        runs: { ts: string; model: string; costUsd: number }[];
      }>(`/gateway/cost-report?limit=${opts.limit}`);
      console.log(
        chalk.bold(`\nCost Report — ${data.totalRuns} calls, $${data.totalUsd.toFixed(4)} total\n`),
      );
      for (const run of data.runs) {
        console.log(
          ` ${chalk.gray(run.ts.slice(0, 19))}  $${run.costUsd.toFixed(4)}  ${chalk.gray(run.model)}`,
        );
      }
    } catch (err) {
      fail(err);
    }
  });

// ── memory ────────────────────────────────────────────────────────────────────

const memory = program.command("memory").description("Memory store commands");

memory
  .command("list")
  .description("List stored memories")
  .option("--limit <n>", "Max memories", "20")
  .option("--category <cat>", "Only memories stored with this category")
  .action(async (opts: { limit: string; category?: string }) => {
    try {
      const data = await api.get<{
        results: { id: string; text: string; metadata?: { category?: string } }[];
      }>(`/memory?${new URLSearchParams({ limit: opts.limit })}`);
      const shown = data.results.filter(
        (m) => !opts.category || m.metadata?.category === opts.category,
      );
      console.log(
        chalk.bold(`
${shown.length} memories
`),
      );
      for (const m of shown) {
        const cat = m.metadata?.category ? chalk.yellow(` #${m.metadata.category}`) : "";
        console.log(` ${chalk.gray(m.id.slice(0, 8))}…${cat}`);
        console.log(`   ${m.text.slice(0, 120)}${m.text.length > 120 ? "…" : ""}`);
      }
    } catch (err) {
      fail(err);
    }
  });

memory
  .command("store <content>")
  .description("Store a new memory")
  .option("--category <cat>", "Memory category")
  .option("--tags <tags>", "Comma-separated tags")
  .action(async (content: string, opts: { category?: string; tags?: string }) => {
    try {
      const metadata: Record<string, unknown> = {};
      if (opts.category) metadata.category = opts.category;
      if (opts.tags) metadata.tags = opts.tags.split(",").map((t) => t.trim());
      const data = await api.post<{ id: string }>("/memory", { text: content, metadata });
      console.log(chalk.green("✓"), "Memory stored:", chalk.gray(data.id));
    } catch (err) {
      fail(err);
    }
  });

// ── research ──────────────────────────────────────────────────────────────────

const research = program.command("research").description("Research agent commands");

research
  .command("submit <query>")
  .description("Research a question and print the report")
  .option("--no-wait", "Create the job without running it here")
  .action(async (query: string, opts: { wait: boolean }) => {
    try {
      const job = await api.unversioned<{ id: string }>("POST", "/api/research", { query });
      console.log(chalk.green("✓"), `Job: ${chalk.bold(job.id)}`);
      if (!opts.wait) return;
      // The run happens while its stream is open, as it does for the web page.
      for await (const frame of streamSse(
        api.url(`/api/research/${job.id}/stream`),
        api.authHeaders(),
      )) {
        let data: { type?: string; label?: string; content?: string; message?: string } = {};
        try {
          data = JSON.parse(frame.data) as typeof data;
        } catch {
          continue;
        }
        if (data.type === "phase_start" && data.label) console.log(chalk.gray(`  ${data.label}`));
        if (data.type === "report")
          console.log(`
${data.content ?? ""}`);
        if (data.type === "error") throw new Error(data.message ?? "Research failed");
        if (data.type === "done") break;
      }
    } catch (err) {
      fail(err);
    }
  });

research
  .command("list")
  .description("List recent research jobs")
  .option("--limit <n>", "Max jobs", "10")
  .action(async (opts: { limit: string }) => {
    try {
      const { jobs = [] } = await api.unversioned<{
        jobs?: { id: string; status: string; query: string }[];
      }>("GET", "/api/research");
      const shown = jobs.slice(0, Number(opts.limit) || 10);
      console.log(
        chalk.bold(`
${shown.length} research jobs
`),
      );
      for (const j of shown) {
        const icon =
          j.status === "done"
            ? chalk.green("✓")
            : j.status === "error"
              ? chalk.red("✗")
              : chalk.yellow("◌");
        console.log(
          ` ${icon} ${chalk.gray(j.id.slice(0, 12))}  ${j.query.slice(0, 60)}${j.query.length > 60 ? "…" : ""}`,
        );
      }
    } catch (err) {
      fail(err);
    }
  });

// ── admin ─────────────────────────────────────────────────────────────────────

const admin = program.command("admin").description("Admin gateway management");

admin
  .command("routes")
  .description("List all model alias routes")
  .action(async () => {
    try {
      const data = await api.get<{
        routes: { alias: string; model: string; provider: string; overridden: boolean }[];
        total: number;
      }>("/admin/routes");
      console.log(chalk.bold(`\n${data.total} routes\n`));
      for (const r of data.routes) {
        const override = r.overridden ? chalk.yellow(" [overridden]") : "";
        console.log(` ${chalk.cyan(r.alias.padEnd(24))} → ${r.provider}/${r.model}${override}`);
      }
    } catch (err) {
      fail(err);
    }
  });

admin
  .command("stats")
  .description("Show gateway usage stats per alias")
  .action(async () => {
    try {
      const data = await api.get<{
        stats: {
          alias: string;
          requests: number;
          totalTokens: number;
          errors: number;
          avgLatencyMs: number;
        }[];
      }>("/admin/stats");
      console.log(chalk.bold("\nGateway stats\n"));
      console.log(
        ` ${"Alias".padEnd(24)} ${"Requests".padEnd(10)} ${"Tokens".padEnd(12)} ${"Errors".padEnd(8)} Latency`,
      );
      console.log(" " + "─".repeat(70));
      for (const s of data.stats) {
        if (s.requests === 0) continue;
        const errColor = s.errors > 0 ? chalk.red : chalk.green;
        console.log(
          ` ${chalk.cyan(s.alias.padEnd(24))} ${String(s.requests).padEnd(10)} ${String(s.totalTokens).padEnd(12)} ${errColor(String(s.errors).padEnd(8))} ${s.avgLatencyMs.toFixed(0)}ms`,
        );
      }
    } catch (err) {
      fail(err);
    }
  });

admin
  .command("traces")
  .description("Query the gateway request log")
  .option("--provider <provider>", "Filter by provider")
  .option("--model <model>", "Filter by model")
  .option("--status <status>", "Filter: success | error | cached")
  .option("--limit <n>", "Max entries", "20")
  .action(async (opts: { provider?: string; model?: string; status?: string; limit: string }) => {
    try {
      const qs = new URLSearchParams({ limit: opts.limit });
      if (opts.provider) qs.set("provider", opts.provider);
      if (opts.model) qs.set("model", opts.model);
      if (opts.status) qs.set("status", opts.status);
      const data = await api.get<{
        entries: {
          provider: string;
          model: string;
          status: string;
          latencyMs: number;
          inputTokens?: number;
          outputTokens?: number;
          ts: number;
        }[];
        total: number;
      }>(`/admin/traces?${qs}`);
      console.log(chalk.bold(`\n${data.total} trace entries\n`));
      for (const e of data.entries.slice(0, 20)) {
        const statusColor =
          e.status === "success" ? chalk.green : e.status === "cached" ? chalk.cyan : chalk.red;
        const time = new Date(e.ts).toISOString().slice(11, 23);
        console.log(
          ` ${chalk.gray(time)}  ${statusColor(e.status.padEnd(8))}  ${e.provider}/${e.model.slice(0, 24)}  ${e.latencyMs}ms`,
        );
      }
    } catch (err) {
      fail(err);
    }
  });

// ── models (§1.5 models.dev seed) ───────────────────────────────────────────

const models = program.command("models").description("Model catalog commands");

models
  .command("seed")
  .description("Seed the provider_models table from models.dev data (no network)")
  .option(
    "--file <path>",
    "Path to a models.dev api.json-shaped JSON file (default: built-in fixture)",
  )
  .action(async (opts: { file?: string }) => {
    try {
      const source = await loadModelsDevSource(opts.file);
      const written = await seedModelsFromSource(source);
      console.log(
        chalk.green("✓"),
        `provider_models seeded: ${written} model(s) from ${source.source}`,
      );
    } catch (err) {
      fail(err);
    }
  });

registerOrgCommands(program);

// ── Run ───────────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err: unknown) => {
  fail(err);
});
