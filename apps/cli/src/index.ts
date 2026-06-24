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
 *   nexus audit [--limit 50]
 *   nexus audit verify
 */

import chalk from "chalk";
import { Command } from "commander";

import { api } from "./lib/client.js";
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
      console.error(chalk.red("✗"), String(err));
      process.exit(1);
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

program
  .command("code <task>")
  .description("Launch a coding-agent run and stream its progress")
  .option("--provider <p>", "LLM provider (anthropic|groq|openrouter)")
  .option("--model <m>", "Model id")
  .option("--repo <path>", "Run inside a git-worktree workspace cut from this repo")
  .option("--base <branch>", "Base branch for the worktree", "main")
  .option("--start-run", "Start the .nexus run server during the agent run")
  .option("--max-steps <n>", "Max agent steps")
  .option("--review", "Run a forked post-run learning review")
  .option("--no-wait", "Return after launch without streaming")
  .action(async (task: string, opts) => {
    try {
      const body: Record<string, unknown> = { instruction: task };
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

      const launched = await api.post<{ sessionId: string; stream: string }>("/agent/run", body);
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
      console.error(chalk.red("✗"), String(err));
      process.exit(1);
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
  .action(async (opts) => {
    console.log(chalk.cyan("⚙ Deliberating..."), chalk.bold(opts.title));
    const data = await api.post("/council/deliberate", {
      proposal: { title: opts.title, description: opts.desc },
      budgetUsd: parseFloat(opts.budget),
      signal_id: opts.signalId,
    });
    const res = data as {
      ok: boolean;
      result?: { outcome: string; consensus: number; summary: string };
    };
    if (res.ok && res.result) {
      const outcome = res.result.outcome;
      const color =
        outcome === "approved" ? chalk.green : outcome === "rejected" ? chalk.red : chalk.yellow;
      console.log(color(`\n● Outcome: ${outcome.toUpperCase()}`));
      console.log(`  Consensus: ${(res.result.consensus * 100).toFixed(0)}%`);
      console.log(`  Summary:   ${res.result.summary}`);
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
      console.error(chalk.red(data.message));
      process.exit(1);
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
      console.error(chalk.red("✗"), String(err));
      process.exit(1);
    }
  });

gateway
  .command("chat <message>")
  .description("Send a one-shot message through the gateway")
  .option("-m, --model <model>", "Model alias", "nexus/fast")
  .option("--stream", "Stream the response (SSE)")
  .action(async (message: string, opts: { model: string; stream: boolean }) => {
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
      console.error(chalk.red("✗"), String(err));
      process.exit(1);
    }
  });

gateway
  .command("cost-report")
  .description("Show gateway cost report")
  .option("--limit <n>", "Max runs to include", "20")
  .action(async (opts: { limit: string }) => {
    try {
      const data = await api.get<{
        totalRuns: number;
        totalUsd: number;
        limit: number;
        runs: { taskId: string; totalCostUsd: number; model?: string }[];
      }>(`/gateway/cost-report?limit=${opts.limit}`);
      console.log(
        chalk.bold(`\nCost Report — ${data.totalRuns} runs, $${data.totalUsd.toFixed(4)} total\n`),
      );
      for (const run of data.runs.slice(0, 10)) {
        console.log(
          ` ${chalk.gray(run.taskId.slice(0, 16))}…  $${run.totalCostUsd.toFixed(4)}  ${chalk.gray(run.model ?? "")}`,
        );
      }
    } catch (err) {
      console.error(chalk.red("✗"), String(err));
      process.exit(1);
    }
  });

// ── memory ────────────────────────────────────────────────────────────────────

const memory = program.command("memory").description("Memory store commands");

memory
  .command("list")
  .description("List stored memories")
  .option("--limit <n>", "Max memories", "20")
  .option("--category <cat>", "Filter by category")
  .action(async (opts: { limit: string; category?: string }) => {
    try {
      const qs = new URLSearchParams({ limit: opts.limit });
      if (opts.category) qs.set("category", opts.category);
      const data = await api.get<{
        memories: {
          id: string;
          content: string;
          category?: string;
          confidence?: number;
          createdAt: string;
        }[];
        total: number;
      }>(`/memory?${qs}`);
      console.log(chalk.bold(`\n${data.total} memories\n`));
      for (const m of data.memories) {
        const conf =
          m.confidence !== undefined ? chalk.gray(` [${(m.confidence * 100).toFixed(0)}%]`) : "";
        const cat = m.category ? chalk.yellow(` #${m.category}`) : "";
        console.log(` ${chalk.gray(m.id.slice(0, 8))}…${cat}${conf}`);
        console.log(`   ${m.content.slice(0, 120)}${m.content.length > 120 ? "…" : ""}`);
      }
    } catch (err) {
      console.error(chalk.red("✗"), String(err));
      process.exit(1);
    }
  });

memory
  .command("store <content>")
  .description("Store a new memory")
  .option("--category <cat>", "Memory category")
  .option("--tags <tags>", "Comma-separated tags")
  .action(async (content: string, opts: { category?: string; tags?: string }) => {
    try {
      const body: Record<string, unknown> = { content };
      if (opts.category) body.category = opts.category;
      if (opts.tags) body.tags = opts.tags.split(",").map((t) => t.trim());
      const data = await api.post<{ id: string; content: string; category?: string }>(
        "/memory",
        body,
      );
      console.log(chalk.green("✓"), "Memory stored:", chalk.gray(data.id));
    } catch (err) {
      console.error(chalk.red("✗"), String(err));
      process.exit(1);
    }
  });

// ── research ──────────────────────────────────────────────────────────────────

const research = program.command("research").description("Research agent commands");

research
  .command("submit <query>")
  .description("Submit a research query and poll until done")
  .option("--no-wait", "Return immediately without polling")
  .action(async (query: string, opts: { wait: boolean }) => {
    try {
      const job = await api.post<{ jobId: string; status: string }>("/researcher/jobs", { query });
      console.log(chalk.green("✓"), `Job submitted: ${chalk.bold(job.jobId)}`);

      if (!opts.wait) return;

      // Poll until done
      process.stdout.write("  Researching");
      let status = job.status;
      while (status === "queued" || status === "running") {
        await new Promise((r) => setTimeout(r, 2000));
        process.stdout.write(".");
        const res = await api.get<{ status: string; report?: string; sources?: unknown[] }>(
          `/researcher/jobs/${job.jobId}`,
        );
        status = res.status;
        if (status === "done") {
          process.stdout.write("\n\n");
          console.log(chalk.bold("Report:"));
          console.log(res.report ?? "(empty)");
          if (res.sources?.length) {
            console.log(chalk.bold(`\nSources (${res.sources.length}):`));
            (res.sources as { url: string; title: string }[]).forEach((s, i) => {
              console.log(` [${i + 1}] ${chalk.cyan(s.title ?? s.url)}`);
              console.log(`     ${chalk.gray(s.url)}`);
            });
          }
        } else if (status === "error") {
          process.stdout.write("\n");
          console.error(chalk.red("✗"), "Research failed");
        }
      }
    } catch (err) {
      console.error(chalk.red("✗"), String(err));
      process.exit(1);
    }
  });

research
  .command("list")
  .description("List recent research jobs")
  .option("--limit <n>", "Max jobs", "10")
  .action(async (opts: { limit: string }) => {
    try {
      const data = await api.get<{
        jobs: { jobId: string; status: string; query: string; createdAt: string }[];
      }>(`/researcher/jobs?limit=${opts.limit}`);
      const jobs = data.jobs ?? [];
      console.log(chalk.bold(`\n${jobs.length} research jobs\n`));
      for (const j of jobs) {
        const icon =
          j.status === "done"
            ? chalk.green("✓")
            : j.status === "error"
              ? chalk.red("✗")
              : chalk.yellow("◌");
        console.log(
          ` ${icon} ${chalk.gray(j.jobId.slice(0, 12))}…  ${j.query.slice(0, 60)}${j.query.length > 60 ? "…" : ""}`,
        );
      }
    } catch (err) {
      console.error(chalk.red("✗"), String(err));
      process.exit(1);
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
      console.error(chalk.red("✗"), String(err));
      process.exit(1);
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
      console.error(chalk.red("✗"), String(err));
      process.exit(1);
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
      console.error(chalk.red("✗"), String(err));
      process.exit(1);
    }
  });

// ── Run ───────────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(chalk.red("Error:"), String(err));
  process.exit(1);
});
