// SPDX-License-Identifier: Apache-2.0
/**
 * `nexus org` — run a company of agents from the terminal: see what needs
 * you, ask the org a question, decide approvals and wake agents.
 *
 * The org belongs to a user, so these commands send NEXUS_TOKEN (a personal
 * access token or a sign-in JWT) when set, and fall back to NEXUS_API_KEY.
 */

import chalk from "chalk";
import type { Command } from "commander";

import { fail } from "./client.js";

const BASE_URL = (process.env.NEXUS_API_URL ?? "http://localhost:3000").replace(/\/$/, "");

async function orgRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = process.env.NEXUS_TOKEN ?? process.env.NEXUS_API_KEY ?? "";
  const res = await fetch(`${BASE_URL}/api/org${path}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const d = data as { message?: string; error?: string };
    throw new Error(`HTTP ${res.status}: ${d.message ?? d.error ?? text.slice(0, 200)}`);
  }
  return data as T;
}

export interface CompanyRow {
  id: string;
  name: string;
  status: string;
  running: number;
  agents: number;
  pendingApprovals: number;
  monthUsd: number;
}

/** A company by id, exact name, or unique name prefix; the only one when there is one. */
export function pickCompany(rows: CompanyRow[], ref: string | undefined): CompanyRow {
  if (!ref) {
    if (rows.length === 1) return rows[0]!;
    throw new Error(
      rows.length === 0
        ? "You have no companies yet. Create one in the app."
        : `Several companies; pass --company (${rows.map((r) => r.name).join(", ")}).`,
    );
  }
  const exact = rows.find((r) => r.id === ref || r.name.toLowerCase() === ref.toLowerCase());
  if (exact) return exact;
  const prefix = rows.filter((r) => r.name.toLowerCase().startsWith(ref.toLowerCase()));
  if (prefix.length === 1) return prefix[0]!;
  throw new Error(
    prefix.length ? `"${ref}" matches several companies.` : `No company matches "${ref}".`,
  );
}

interface OverviewShape {
  company: { name: string; status: string };
  needsYou: {
    approvals: { id: string; title: string }[];
    approvalCount: number;
    commandApprovals: number;
    reviews: { title: string }[];
    blocked: { title: string }[];
    failedRuns: { agent: string; error: string }[];
    budgetStops: number;
  };
  workingNow: { agent: string; task: string | null; status: string }[];
  spend: { todayUsd: number; monthUsd: number };
}

/** The overview as terminal lines, needs first. */
export function formatStatus(o: OverviewShape): string[] {
  const n = o.needsYou;
  const lines = [`${o.company.name} (${o.company.status})`];
  const needs: string[] = [];
  for (const a of n.approvals) needs.push(`decide: ${a.title}  [${a.id.slice(0, 8)}]`);
  if (n.approvalCount > n.approvals.length)
    needs.push(`…and ${n.approvalCount - n.approvals.length} more decisions`);
  if (n.commandApprovals) needs.push(`${n.commandApprovals} command(s) waiting to be allowed`);
  if (n.budgetStops) needs.push(`${n.budgetStops} budget stop(s)`);
  for (const r of n.reviews) needs.push(`review: ${r.title}`);
  for (const b of n.blocked) needs.push(`blocked: ${b.title}`);
  for (const f of n.failedRuns) needs.push(`failed: ${f.agent} — ${f.error.slice(0, 80)}`);
  lines.push(needs.length ? "Needs you:" : "Nothing needs you.");
  for (const x of needs) lines.push(`  • ${x}`);
  lines.push(o.workingNow.length ? "Working now:" : "No agent is running.");
  for (const w of o.workingNow)
    lines.push(`  ${w.status === "running" ? "▶" : "…"} ${w.agent}: ${w.task ?? "triage"}`);
  lines.push(
    `Spend: $${o.spend.todayUsd.toFixed(4)} today, $${o.spend.monthUsd.toFixed(4)} this month`,
  );
  return lines;
}

interface InboxItem {
  kind: "review" | "blocked" | "approval" | "budget";
  text: string;
  taskId?: string;
  approvalId?: string;
}

interface InboxDigest {
  companies: {
    name: string;
    items: InboxItem[];
    agents: { id: string; name: string }[];
  }[];
}

/** What can be done to an item, as the app's inbox offers it. */
const ACTIONS: Record<InboxItem["kind"], string[]> = {
  approval: ["approve", "reject"],
  blocked: ["unblock", "reassign"],
  review: ["accept", "reassign"],
  budget: [],
};

/** Every item with a number, counted across companies, so an action can name it. */
export function formatInbox(d: InboxDigest): string[] {
  const lines: string[] = [];
  let n = 0;
  for (const c of d.companies) {
    lines.push(c.name);
    for (const i of c.items) {
      const acts = ACTIONS[i.kind].map((a) => (a === "reassign" ? "reassign <agent>" : a));
      lines.push(`  ${++n}. ${i.text}${acts.length ? chalk.dim(`  (${acts.join(" | ")})`) : ""}`);
    }
  }
  return lines.length ? lines : ["Nothing waits on you."];
}

/** The call the app's inbox makes for `action` on item `n`. */
export function inboxRequest(
  d: InboxDigest,
  action: string,
  n: number,
  agentRef?: string,
): { method: string; path: string; body: unknown } {
  const all = d.companies.flatMap((c) => c.items.map((item) => ({ item, agents: c.agents })));
  const hit = all[n - 1];
  if (!hit) throw new Error(`No item ${n}; run \`nexus org inbox\` to see the list.`);
  const { item, agents } = hit;
  if (!ACTIONS[item.kind].includes(action))
    throw new Error(`Item ${n} takes ${ACTIONS[item.kind].join(" or ") || "no action"}.`);
  if (item.approvalId)
    return { method: "POST", path: `/approvals/${item.approvalId}/${action}`, body: {} };
  if (action === "reassign") {
    const agent = agents.find(
      (a) => a.id === agentRef || a.name.toLowerCase() === (agentRef ?? "").toLowerCase(),
    );
    if (!agent) throw new Error(`No agent "${agentRef ?? ""}" can take it.`);
    return { method: "PATCH", path: `/tasks/${item.taskId}`, body: { assigneeAgentId: agent.id } };
  }
  const status = action === "unblock" ? "todo" : "done";
  return { method: "POST", path: `/tasks/${item.taskId}/status`, body: { status } };
}

async function company(ref: string | undefined): Promise<CompanyRow> {
  const { companies } = await orgRequest<{ companies: CompanyRow[] }>("GET", "/portfolio");
  return pickCompany(companies, ref);
}

export function registerOrgCommands(program: Command): void {
  const org = program.command("org").description("Run a company of agents");

  org
    .command("companies")
    .description("List your companies")
    .action(async () => {
      try {
        const { companies } = await orgRequest<{ companies: CompanyRow[] }>("GET", "/portfolio");
        for (const c of companies)
          console.log(
            `${c.name}  ${chalk.dim(c.status)}  ${c.running}/${c.agents} running  $${c.monthUsd.toFixed(4)}/mo` +
              (c.pendingApprovals ? chalk.magenta(`  ${c.pendingApprovals} waiting on you`) : ""),
          );
      } catch (err) {
        fail(err);
      }
    });

  org
    .command("status")
    .description("What is happening and what needs you")
    .option("-c, --company <ref>", "Company id or name")
    .action(async (opts: { company?: string }) => {
      try {
        const c = await company(opts.company);
        const o = await orgRequest<OverviewShape>("GET", `/companies/${c.id}/overview`);
        for (const l of formatStatus(o)) console.log(l);
      } catch (err) {
        fail(err);
      }
    });

  org
    .command("ask <question>")
    .description("Ask the org; the top agent answers (or delegates)")
    .option("-c, --company <ref>", "Company id or name")
    .option("--no-wait", "Return at once instead of waiting for the answer")
    .action(async (question: string, opts: { company?: string; wait: boolean }) => {
      try {
        const c = await company(opts.company);
        const res = await orgRequest<{
          task: { id: string; identifier: string };
          agent: { name: string };
        }>("POST", `/companies/${c.id}/ask`, { question });
        console.log(chalk.dim(`${res.task.identifier} → ${res.agent.name}`));
        if (!opts.wait) return;
        for (let i = 0; i < 120; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const d = await orgRequest<{
            task: { status: string };
            comments: { author: { type: string }; body: string }[];
          }>("GET", `/tasks/${res.task.id}`);
          const answer = d.comments.filter((x) => x.author.type === "agent").at(-1);
          if (answer) {
            console.log(answer.body);
            return;
          }
          if (["cancelled", "blocked"].includes(d.task.status)) {
            console.log(chalk.yellow(`The task is ${d.task.status}; see it in the app.`));
            return;
          }
        }
        console.log(chalk.yellow("Still working; check `nexus org status` later."));
      } catch (err) {
        fail(err);
      }
    });

  for (const [verb, path] of [
    ["approve", "approve"],
    ["reject", "reject"],
  ] as const) {
    org
      .command(`${verb} <approvalId>`)
      .description(
        `${verb === "approve" ? "Approve" : "Reject"} a pending decision (id or its first 8 characters)`,
      )
      .option("-c, --company <ref>", "Company id or name")
      .option("-n, --note <text>", "Why")
      .option("--amount <usd>", "New limit, for a budget approval")
      .action(async (ref: string, opts: { company?: string; note?: string; amount?: string }) => {
        try {
          const c = await company(opts.company);
          const { approvals } = await orgRequest<{ approvals: { id: string; title: string }[] }>(
            "GET",
            `/companies/${c.id}/approvals?status=pending`,
          );
          const hit = approvals.filter((a) => a.id === ref || a.id.startsWith(ref));
          if (hit.length !== 1)
            throw new Error(
              hit.length
                ? "That prefix matches several approvals."
                : "No pending approval with that id.",
            );
          await orgRequest("POST", `/approvals/${hit[0]!.id}/${path}`, {
            note: opts.note,
            ...(opts.amount ? { amountUsd: Number(opts.amount) } : {}),
          });
          console.log(
            chalk.green("✓"),
            `${verb === "approve" ? "Approved" : "Rejected"}: ${hit[0]!.title}`,
          );
        } catch (err) {
          fail(err);
        }
      });
  }

  org
    .command("inbox [action] [n] [agent]")
    .description(
      "What waits on you across companies; act with approve|reject|unblock|accept|reassign <n> [agent]",
    )
    .action(async (action?: string, n?: string, agent?: string) => {
      try {
        const digest = await orgRequest<InboxDigest>("GET", "/inbox");
        if (!action) {
          for (const l of formatInbox(digest)) console.log(l);
          return;
        }
        const req = inboxRequest(digest, action, Number(n), agent);
        await orgRequest(req.method, req.path, req.body);
        console.log(chalk.green("✓"), `${action}: item ${n}`);
      } catch (err) {
        fail(err);
      }
    });

  org
    .command("wake <agent>")
    .description("Start a run for an agent now (name or id)")
    .option("-c, --company <ref>", "Company id or name")
    .option("-t, --task <identifier>", "Work on this task, e.g. ACME-12")
    .action(async (agentRef: string, opts: { company?: string; task?: string }) => {
      try {
        const c = await company(opts.company);
        const { agents } = await orgRequest<{ agents: { id: string; name: string }[] }>(
          "GET",
          `/companies/${c.id}/agents`,
        );
        const agent = agents.find(
          (a) => a.id === agentRef || a.name.toLowerCase() === agentRef.toLowerCase(),
        );
        if (!agent) throw new Error(`No agent "${agentRef}" in ${c.name}.`);
        let taskId: string | undefined;
        if (opts.task) {
          const { tasks } = await orgRequest<{ tasks: { id: string; identifier: string }[] }>(
            "GET",
            `/companies/${c.id}/tasks`,
          );
          taskId = tasks.find((t) => t.identifier.toLowerCase() === opts.task!.toLowerCase())?.id;
          if (!taskId) throw new Error(`No task ${opts.task}.`);
        }
        const run = await orgRequest<{ id: string }>("POST", `/agents/${agent.id}/wake`, {
          taskId,
        });
        console.log(chalk.green("✓"), `${agent.name} woken (run ${run.id.slice(0, 8)})`);
      } catch (err) {
        fail(err);
      }
    });
}
