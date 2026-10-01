// SPDX-License-Identifier: Apache-2.0
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Inbox,
  Loader2,
  ShieldAlert,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { selectClass } from "~/components/org/AgentDialog";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { orgApi, timeAgo, usd, useVisibleInterval, type Activity, type Agent } from "~/lib/org";

interface Item {
  id: string;
  title: string;
}

interface Overview {
  needsYou: {
    approvals: (Item & { type: string })[];
    approvalCount: number;
    commandApprovals: number;
    reviews: Item[];
    blocked: Item[];
    failedRuns: { id: string; agent: string; error: string }[];
    budgetStops: number;
  };
  workingNow: {
    id: string;
    agent: string;
    task: string | null;
    status: string;
    startedAt: string;
  }[];
  agents: Record<string, number>;
  tasks: Record<string, number>;
  spend: { todayUsd: number; monthUsd: number; lifetimeUsd: number };
  days: { day: string; runs: number; failed: number; costUsd: number }[];
  activity: Activity[];
}

function NeedCard({
  icon: Icon,
  label,
  count,
  items,
  tone,
  onOpen,
}: {
  icon: typeof Inbox;
  label: string;
  count: number;
  items: string[];
  tone: string;
  onOpen: () => void;
}) {
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`w-full rounded-lg border p-3 text-left ${tone}`}
      data-testid="need-card"
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        <Icon className="size-4" aria-hidden /> {label}
        <span className="ml-auto font-mono">{count}</span>
      </p>
      {items.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
          {items.slice(0, 3).map((t, i) => (
            <li key={i} className="truncate">
              {t}
            </li>
          ))}
        </ul>
      )}
    </button>
  );
}

/** Runs per day, one series; each bar has a tooltip and the numbers are in a table for screen readers. */
function RunBars({ days }: { days: Overview["days"] }) {
  const max = Math.max(1, ...days.map((d) => d.runs));
  if (days.every((d) => d.runs === 0))
    return <p className="text-sm text-muted-foreground">No runs in the last 14 days.</p>;
  return (
    <figure className="space-y-1">
      <figcaption className="text-xs font-semibold uppercase text-muted-foreground">
        Runs, last 14 days
      </figcaption>
      <div className="flex h-24 items-end gap-0.5" aria-hidden>
        {days.map((d) => (
          <div
            key={d.day}
            className="group relative flex-1"
            style={{ height: "100%" }}
            title={`${d.day}: ${d.runs} runs, ${d.failed} failed, ${usd(d.costUsd)}`}
          >
            <div
              className="absolute bottom-0 w-full rounded-t bg-primary/80 group-hover:bg-primary"
              style={{ height: `${d.runs ? Math.max(4, (d.runs / max) * 100) : 0}%` }}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between font-mono text-[10px] text-muted-foreground" aria-hidden>
        <span>{days[0]?.day.slice(5)}</span>
        <span>today</span>
      </div>
      <table className="sr-only">
        <caption>Runs per day</caption>
        <thead>
          <tr>
            <th>Day</th>
            <th>Runs</th>
            <th>Failed</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <td>{d.day}</td>
              <td>{d.runs}</td>
              <td>{d.failed}</td>
              <td>{usd(d.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** What is happening, whether it needs you, and what to do about it. */
export function OverviewPanel({
  companyId,
  refreshKey,
  goTo,
  agents,
}: {
  companyId: string;
  refreshKey: number;
  goTo: (tab: string) => void;
  agents: Agent[];
}) {
  const [o, setO] = useState<Overview | null>(null);
  const load = useCallback(() => {
    orgApi<Overview>(`/companies/${companyId}/overview`)
      .then((v) => {
        setO(v);
        return undefined;
      })
      .catch(() => undefined);
  }, [companyId]);
  useEffect(load, [load, refreshKey]);
  useVisibleInterval(load, 5000);

  if (!o) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const n = o.needsYou;
  const needsCount =
    n.approvalCount +
    n.commandApprovals +
    n.reviews.length +
    n.blocked.length +
    n.failedRuns.length +
    n.budgetStops;
  const totalTasks = Object.values(o.tasks).reduce((a, b) => a + b, 0);

  return (
    <section className="space-y-5">
      <AskBox companyId={companyId} agents={agents} />
      <div>
        <h3 className="mb-2 text-sm font-semibold">Needs you</h3>
        {needsCount === 0 ? (
          <p
            className="flex items-center gap-2 rounded-lg border p-3 text-sm text-muted-foreground"
            data-testid="all-clear"
          >
            <CheckCircle2 className="size-4 text-success" aria-hidden /> Nothing needs you. The org
            is working on its own.
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            <NeedCard
              icon={Inbox}
              label="Decisions waiting"
              count={n.approvalCount + n.commandApprovals}
              items={n.approvals.map((a) => a.title)}
              tone="border-primary/30 bg-primary/10"
              onOpen={() => goTo("approvals")}
            />
            <NeedCard
              icon={ShieldAlert}
              label="Budget stops"
              count={n.budgetStops}
              items={[]}
              tone="border-destructive/30 bg-destructive/10"
              onOpen={() => goTo("budgets")}
            />
            <NeedCard
              icon={CheckCircle2}
              label="Ready for review"
              count={n.reviews.length}
              items={n.reviews.map((r) => r.title)}
              tone="border-primary/30 bg-primary/10"
              onOpen={() => goTo("tasks")}
            />
            <NeedCard
              icon={AlertTriangle}
              label="Blocked"
              count={n.blocked.length}
              items={n.blocked.map((r) => r.title)}
              tone="border-warning/30 bg-warning/10"
              onOpen={() => goTo("tasks")}
            />
            <NeedCard
              icon={AlertTriangle}
              label="Failed runs (24h)"
              count={n.failedRuns.length}
              items={n.failedRuns.map((r) => `${r.agent}: ${r.error}`)}
              tone="border-destructive/30 bg-destructive/10"
              onOpen={() => goTo("runs")}
            />
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Working now</h3>
        {o.workingNow.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agent is running.</p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm" aria-label="Working now">
            {o.workingNow.map((w) => (
              <li key={w.id} className="flex items-center gap-2 p-2">
                {w.status === "running" ? (
                  <Loader2 className="size-4 animate-spin text-primary" aria-label="running" />
                ) : (
                  <Clock className="size-4 text-muted-foreground" aria-label="queued" />
                )}
                <span className="font-medium">{w.agent}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {w.task ?? "triage"}
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {timeAgo(w.startedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ["Agents idle", o.agents.idle ?? 0],
          ["Agents running", o.agents.running ?? 0],
          ["Open tasks", totalTasks - (o.tasks.done ?? 0) - (o.tasks.cancelled ?? 0)],
          ["Tasks done", o.tasks.done ?? 0],
        ].map(([label, v]) => (
          <div key={label} className="rounded-lg border bg-card p-3">
            <p className="text-[11px] uppercase text-muted-foreground">{label}</p>
            <p className="font-mono text-xl">{v}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <RunBars days={o.days} />
        <div className="space-y-2">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
            <Wallet className="size-4" aria-hidden /> Spend
          </p>
          <dl className="grid grid-cols-3 gap-2 font-mono text-sm">
            <div>
              <dt className="text-[11px] text-muted-foreground">Today</dt>
              <dd>{usd(o.spend.todayUsd)}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-muted-foreground">Month</dt>
              <dd>{usd(o.spend.monthUsd)}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-muted-foreground">Total</dt>
              <dd>{usd(o.spend.lifetimeUsd)}</dd>
            </div>
          </dl>
        </div>
      </div>

      {o.activity.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">Latest</h3>
          <ul className="space-y-1 text-sm">
            {o.activity.map((a) => (
              <li key={a.id} className="flex justify-between gap-2">
                <span className="truncate">
                  {a.action.replace(/[._]/g, " ")}
                  {typeof a.details.name === "string" ? ` · ${a.details.name}` : ""}
                  {typeof a.details.title === "string" ? ` · ${a.details.title}` : ""}
                </span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {timeAgo(a.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

interface PortfolioRow {
  id: string;
  name: string;
  status: string;
  running: number;
  agents: number;
  pendingApprovals: number;
  monthUsd: number;
}

/** Every company at a glance, for owners running more than one. */
export function PortfolioStrip({
  current,
  refreshKey,
  onPick,
}: {
  current: string;
  refreshKey: number;
  onPick: (id: string) => void;
}) {
  const [rows, setRows] = useState<PortfolioRow[]>([]);
  useEffect(() => {
    orgApi<{ companies: PortfolioRow[] }>("/portfolio")
      .then((b) => {
        setRows(b.companies);
        return undefined;
      })
      .catch(() => undefined);
  }, [refreshKey]);
  if (rows.length < 2) return null;
  return (
    <div
      className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0"
      aria-label="Your companies"
    >
      {[...rows]
        .sort((a, b) => Number(b.id === current) - Number(a.id === current))
        .map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onPick(r.id)}
            className={`w-44 shrink-0 snap-start rounded-lg border p-2 text-left text-xs ${r.id === current ? "border-primary bg-primary/5" : "bg-card"}`}
          >
            <p className="truncate text-sm font-medium">{r.name}</p>
            <p className="text-muted-foreground">
              {r.running}/{r.agents} running · {usd(r.monthUsd)}
            </p>
            {r.pendingApprovals > 0 && (
              <p className="text-primary">{r.pendingApprovals} waiting on you</p>
            )}
          </button>
        ))}
    </div>
  );
}

interface Ask {
  task: {
    id: string;
    identifier: string;
    title: string;
    status: string;
    assigneeAgentId: string | null;
  };
  answer: string | null;
}

/** Ask the org a question; the top agent answers in the task's thread, or delegates. */
function AskBox({ companyId, agents }: { companyId: string; agents: Agent[] }) {
  const [asks, setAsks] = useState<Ask[]>([]);
  const [question, setQuestion] = useState("");
  const [agentId, setAgentId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    orgApi<{ asks: Ask[] }>(`/companies/${companyId}/asks`)
      .then((b) => {
        setAsks(b.asks);
        return undefined;
      })
      .catch(() => undefined);
  }, [companyId]);
  useEffect(load, [load]);
  useVisibleInterval(() => {
    if (asks.some((a) => !a.answer && a.task.status !== "cancelled")) load();
  }, 3000);

  const live = agents.filter((a) => a.status !== "terminated" && a.status !== "pending_approval");
  if (live.length === 0) return null;
  const names = new Map(agents.map((a) => [a.id, a.name]));
  return (
    <section className="space-y-2">
      <form
        className="space-y-2 rounded-lg border bg-card p-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          void orgApi(`/companies/${companyId}/ask`, {
            method: "POST",
            json: { question, ...(agentId ? { agentId } : {}) },
          })
            .then(() => {
              setQuestion("");
              load();
              return undefined;
            })
            .catch((err: Error) => setError(err.message));
        }}
      >
        <Textarea
          aria-label="Ask the org"
          rows={2}
          placeholder="Ask your org anything: what should we build next? what did we ship this week?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <div className="flex gap-2">
          <select
            aria-label="Who answers"
            className={`${selectClass} flex-1`}
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
          >
            <option value="">Top of the org</option>
            {live.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <Button type="submit" size="sm" disabled={!question.trim()}>
            Ask
          </Button>
        </div>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </form>
      {asks.length > 0 && (
        <ul className="space-y-2" aria-label="Questions">
          {asks.slice(0, 5).map((a) => (
            <li key={a.task.id} className="rounded-lg border p-3 text-sm" data-testid="ask">
              <p className="font-medium">{a.task.title}</p>
              <p className="text-[11px] text-muted-foreground">
                {a.task.identifier} · {names.get(a.task.assigneeAgentId ?? "") ?? "agent"} ·{" "}
                {a.task.status.replace("_", " ")}
              </p>
              {a.answer ? (
                <p className="mt-1 line-clamp-6 whitespace-pre-wrap">{a.answer}</p>
              ) : (
                <p className="mt-1 flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden /> Thinking…
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface InboxItem {
  kind: "review" | "blocked" | "approval" | "budget";
  text: string;
  taskId?: string;
  approvalId?: string;
}

interface Inbox {
  companies: {
    companyId: string;
    name: string;
    items: InboxItem[];
    agents: { id: string; name: string }[];
  }[];
  total: number;
}

/** The actions an inbox item offers, as label and request. */
function itemActions(i: InboxItem): [string, string, unknown][] {
  if (i.approvalId)
    return [
      ["Approve", `/approvals/${i.approvalId}/approve`, {}],
      ["Reject", `/approvals/${i.approvalId}/reject`, {}],
    ];
  if (i.kind === "blocked") return [["Unblock", `/tasks/${i.taskId}/status`, { status: "todo" }]];
  if (i.kind === "review") return [["Accept", `/tasks/${i.taskId}/status`, { status: "done" }]];
  return [];
}

/** What waits on you across companies: the digest the daily notification carries, actionable here. */
export function InboxCard({ refreshKey, open }: { refreshKey: number; open?: boolean }) {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    orgApi<Inbox>("/inbox")
      .then((b) => {
        setInbox(b);
        return undefined;
      })
      .catch(() => undefined);
  }, []);
  useEffect(load, [load, refreshKey]);
  // Something decided elsewhere meanwhile answers with an error; show it and refresh.
  const act = (path: string, init: { method: string; json: unknown }) => {
    setError(null);
    orgApi(path, init)
      .catch((e: Error) => setError(e.message))
      .finally(load);
  };
  if (!inbox?.total) return null;
  return (
    <details className="rounded-lg border bg-card p-3 text-sm" data-testid="org-inbox" open={open}>
      <summary className="cursor-pointer font-medium">
        Inbox: {inbox.total} item{inbox.total === 1 ? "" : "s"} waiting across your companies
      </summary>
      <div className="mt-2 space-y-2">
        {inbox.companies.map((c) => (
          <div key={c.companyId}>
            <p className="text-xs font-semibold uppercase text-muted-foreground">{c.name}</p>
            <ul className="space-y-2">
              {c.items.map((i) => (
                <li key={i.text} className="rounded border p-2" data-testid="inbox-item">
                  <p>{i.text}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {itemActions(i).map(([label, path, json]) => (
                      <Button
                        key={label}
                        size="sm"
                        variant="outline"
                        onClick={() => act(path, { method: "POST", json })}
                      >
                        {label}
                      </Button>
                    ))}
                    {i.taskId && c.agents.length > 0 && (
                      <select
                        aria-label={`Reassign ${i.text.split(" ")[0]}`}
                        className={selectClass}
                        value=""
                        onChange={(e) =>
                          act(`/tasks/${i.taskId}`, {
                            method: "PATCH",
                            json: { assigneeAgentId: e.target.value },
                          })
                        }
                      >
                        <option value="">Reassign to...</option>
                        {c.agents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {error && (
          <p className="text-destructive" role="alert">
            {error}
          </p>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={sent}
          onClick={() =>
            void orgApi("/inbox/send", { method: "POST" })
              .then(() => {
                setSent(true);
                return undefined;
              })
              .catch(() => undefined)
          }
        >
          {sent ? "Sent to your notifications" : "Send to my notifications"}
        </Button>
      </div>
    </details>
  );
}
