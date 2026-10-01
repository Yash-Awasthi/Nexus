// SPDX-License-Identifier: Apache-2.0
import { Check, Gavel, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { selectClass } from "~/components/org/AgentDialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { StatusPill, canManage, orgApi, timeAgo, usd, type Agent, type Company } from "~/lib/org";

interface Review {
  status: "running" | "done" | "failed";
  verdict: "approve" | "reject" | "revise" | null;
  consensus: number;
  summary: string;
  votes: { member: string; vote: string; confidence: number; reasoning: string }[];
  costUsd: number;
  error: string | null;
}

interface Approval {
  id: string;
  type: "hire_agent" | "budget_override" | "plan" | "action";
  status: string;
  title: string;
  body: string;
  decisionNote: string | null;
  review: Review | null;
  requestedBy: { type: "user" | "agent" | "system"; id: string };
  createdAt: string;
  decidedAt: string | null;
}

interface ExecApproval {
  id: string;
  surface: string;
  command: string;
  args: string[];
  reason: string;
  status: string;
  expiresAt: string;
}

const KIND: Record<Approval["type"], string> = {
  hire_agent: "Hire",
  budget_override: "Budget",
  plan: "Plan",
  action: "Agent request",
};

const VERDICT_TONE = {
  approve: "border-success/30 bg-success/10",
  reject: "border-destructive/30 bg-destructive/10",
  revise: "border-warning/30 bg-warning/10",
} as const;

function CouncilPanel({ review }: { review: Review }) {
  if (review.status === "running")
    return <p className="text-xs text-muted-foreground">The council is deliberating…</p>;
  if (review.status === "failed")
    return <p className="text-xs text-destructive">Council review failed: {review.error}</p>;
  return (
    <div
      className={`space-y-1 rounded-md border p-2 text-xs ${review.verdict ? VERDICT_TONE[review.verdict] : ""}`}
      data-testid="council-verdict"
    >
      <p className="font-medium">
        Council recommends {review.verdict ?? "no verdict"} ({Math.round(review.consensus * 100)}%
        agreement, {usd(review.costUsd)})
      </p>
      {review.summary && <p>{review.summary}</p>}
      <ul className="space-y-1">
        {review.votes.map((v, i) => (
          <li key={i} className="text-muted-foreground">
            <span className="font-medium text-foreground">{v.member}</span> voted {v.vote}:{" "}
            {v.reasoning.slice(0, 280)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Card({
  a,
  onChanged,
  agentName,
}: {
  a: Approval;
  onChanged: () => void;
  agentName: (id: string) => string | undefined;
}) {
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function act(path: string, json?: unknown) {
    setError(null);
    try {
      await orgApi(`/approvals/${a.id}/${path}`, { method: "POST", json: json ?? {} });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Follow a running review.
  useEffect(() => {
    if (a.review?.status !== "running") return;
    const t = setInterval(onChanged, 2000);
    return () => clearInterval(t);
  }, [a.review?.status, onChanged]);

  const canRevise = a.type === "plan" || a.type === "action";
  return (
    <li className="space-y-2 rounded-lg border bg-card p-3" data-testid="approval-card">
      <div className="flex items-start gap-2">
        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium uppercase">
          {KIND[a.type]}
        </span>
        <p className="min-w-0 flex-1 font-medium">{a.title}</p>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {timeAgo(a.createdAt)}
        </span>
      </div>
      {a.requestedBy.type === "agent" && (
        <p className="text-xs text-muted-foreground">
          Proposed by {agentName(a.requestedBy.id) ?? "an agent"}
        </p>
      )}
      <button
        type="button"
        className="w-full text-left"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <p
          className={`whitespace-pre-wrap text-sm text-muted-foreground ${open ? "" : "line-clamp-3"}`}
        >
          {a.body}
        </p>
      </button>
      {a.review && <CouncilPanel review={a.review} />}
      {canRevise && (
        <Textarea
          aria-label="Decision note"
          rows={2}
          placeholder="Note for the agent (required to send back)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        {a.type === "budget_override" && (
          <Input
            aria-label="New limit in dollars"
            className="w-28"
            inputMode="decimal"
            placeholder="New limit $"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        )}
        <Button
          size="sm"
          onClick={() => act("approve", { note, ...(amount ? { amountUsd: Number(amount) } : {}) })}
        >
          <Check className="size-4" /> Approve
        </Button>
        <Button size="sm" variant="outline" onClick={() => act("reject", { note })}>
          <X className="size-4" /> Reject
        </Button>
        {canRevise && (
          <Button size="sm" variant="ghost" onClick={() => act("request-revision", { note })}>
            <Undo2 className="size-4" /> Send back
          </Button>
        )}
        {!a.review || a.review.status === "failed" ? (
          <Button size="sm" variant="ghost" onClick={() => act("review")}>
            <Gavel className="size-4" /> Ask the council
          </Button>
        ) : null}
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/** Everything waiting on the board, plus the command approvals the exec gate raised. */
export function ApprovalInbox({
  company,
  agents,
  refreshKey,
  onChanged,
}: {
  company: Company;
  agents: Agent[];
  refreshKey: number;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<Approval[]>([]);
  const [execs, setExecs] = useState<ExecApproval[]>([]);
  const [execError, setExecError] = useState<{ id: string; message: string } | null>(null);
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    fetch("/api/v1/workspaces")
      .then((r) => (r.ok ? r.json() : { workspaces: [] }))
      .then((b: { workspaces?: { id: string; name: string }[] }) => {
        setWorkspaces(b.workspaces ?? []);
        return undefined;
      })
      .catch(() => undefined);
  }, []);

  const load = useCallback(() => {
    orgApi<{ approvals: Approval[] }>(`/companies/${company.id}/approvals`)
      .then((b) => {
        setItems(b.approvals);
        return undefined;
      })
      .catch(() => undefined);
    fetch("/api/v1/exec/approvals")
      .then((r) => (r.ok ? r.json() : { approvals: [] }))
      .then((b: { approvals?: ExecApproval[] }) => {
        setExecs((b.approvals ?? []).filter((x) => x.status === "pending"));
        return undefined;
      })
      .catch(() => undefined);
  }, [company.id]);
  useEffect(load, [load, refreshKey]);

  const changed = useCallback(() => {
    load();
    onChanged();
  }, [load, onChanged]);

  // A refusal (e.g. only an admin may run commands on a shared server) must be seen.
  const decideExec = (id: string, verb: "approve" | "deny") =>
    void fetch(`/api/v1/exec/approvals/${id}/${verb}`, { method: "POST" })
      .then(async (r) => {
        if (r.ok) {
          setExecError(null);
          changed();
          return undefined;
        }
        const b = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
        setExecError({ id, message: b.message ?? b.error ?? `Refused (${r.status})` });
        return undefined;
      })
      .catch(() => setExecError({ id, message: "Could not reach the server" }));

  const setting = (patch: Record<string, boolean | string | null>) =>
    void orgApi(`/companies/${company.id}`, { method: "PATCH", json: patch })
      .then(() => {
        onChanged();
        return undefined;
      })
      .catch(() => undefined);

  const pending = items.filter((a) => a.status === "pending");
  const decided = items.filter((a) => a.status !== "pending");

  return (
    <section className="space-y-4">
      {canManage(company) && (
        <div className="grid gap-2 rounded-lg border p-3 text-sm">
          <label className="flex items-center justify-between gap-3">
            <span>New agents wait for approval before they can run</span>
            <Switch
              aria-label="Require hire approval"
              checked={company.requireHireApproval}
              onCheckedChange={(v) => setting({ requireHireApproval: v })}
            />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span>The council reviews each request before you do</span>
            <Switch
              aria-label="Council reviews approvals"
              checked={company.councilReviewsApprovals ?? false}
              onCheckedChange={(v) => setting({ councilReviewsApprovals: v })}
            />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span>The council checks work before it counts as done</span>
            <Switch
              aria-label="Council checks finished work"
              checked={company.councilGatesDone ?? false}
              onCheckedChange={(v) => setting({ councilGatesDone: v })}
            />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span>Replays run while paused (budgets still apply)</span>
            <Switch
              aria-label="Replays run while paused"
              checked={company.replaysWhilePaused ?? false}
              onCheckedChange={(v) => setting({ replaysWhilePaused: v })}
            />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span>Agents move to the cheaper model their scorecard recommends</span>
            <Switch
              aria-label="Follow the model scorecard"
              checked={company.autoModel ?? false}
              onCheckedChange={(v) => setting({ autoModel: v })}
            />
          </label>
          {workspaces.length > 0 && (
            <label className="flex items-center justify-between gap-3">
              <span>Workspace members can read this company</span>
              <select
                aria-label="Share with workspace"
                className={`${selectClass} w-auto max-w-40`}
                value={company.workspaceId ?? ""}
                onChange={(e) => setting({ workspaceId: e.target.value || null })}
              >
                <option value="">Not shared</option>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {pending.length === 0 && execs.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          Nothing needs you right now.
        </p>
      ) : (
        <ul className="space-y-2" aria-label="Pending approvals">
          {pending.map((a) => (
            <Card
              key={a.id}
              a={a}
              onChanged={changed}
              agentName={(id) => agents.find((x) => x.id === id)?.name}
            />
          ))}
          {execs.map((x) => (
            <li
              key={x.id}
              className="space-y-2 rounded-lg border bg-card p-3"
              data-testid="exec-approval"
            >
              <div className="flex items-center gap-2">
                <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium uppercase">
                  Command
                </span>
                <code className="min-w-0 flex-1 truncate text-sm">
                  {[x.command, ...x.args].join(" ")}
                </code>
              </div>
              <p className="text-xs text-muted-foreground">
                {x.surface} · {x.reason} · expires {timeAgo(x.expiresAt).replace(" ago", "")}
              </p>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => decideExec(x.id, "approve")}>
                  Allow once
                </Button>
                <Button size="sm" variant="outline" onClick={() => decideExec(x.id, "deny")}>
                  Deny
                </Button>
              </div>
              {execError?.id === x.id && (
                <p role="alert" className="text-xs text-destructive">
                  {execError.message}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {decided.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            Decided ({decided.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {decided.map((a) => (
              <li key={a.id} className="flex items-center gap-2">
                <StatusPill
                  status={
                    a.status === "approved"
                      ? "succeeded"
                      : a.status === "rejected"
                        ? "failed"
                        : "paused"
                  }
                />
                <span className="min-w-0 flex-1 truncate">{a.title}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {timeAgo(a.decidedAt)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
