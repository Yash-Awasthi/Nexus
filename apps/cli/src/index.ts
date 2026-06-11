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

// ── Run ───────────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(chalk.red("Error:"), String(err));
  process.exit(1);
});
