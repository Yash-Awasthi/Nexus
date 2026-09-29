// SPDX-License-Identifier: Apache-2.0
import { Gavel } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { RunList } from "~/components/org/RunList";
import { Button } from "~/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "~/components/ui/sheet";
import { ADAPTERS, StatusPill, orgApi, timeAgo, usd, useCan, type Agent } from "~/lib/org";

interface Record_ {
  runs: number;
  succeeded: number;
  failed: number;
  skipped: number;
  successRate: number | null;
  tasksDone: number;
  totalCostUsd: number;
  costPerDoneTaskUsd: number | null;
  avgDurationSec: number | null;
  review: {
    verdict: "strong" | "weak" | "mixed";
    consensus: number;
    summary: string;
    votes: { member: string; vote: string; reasoning: string }[];
    costUsd: number;
    at: string;
  } | null;
}

interface Scorecard {
  current: string | null;
  models: {
    model: string;
    runs: number;
    doneRate: number | null;
    replayed: number;
    agreement: number | null;
    avgCostUsd: number | null;
  }[];
  recommendation: { model: string; reason: string } | null;
  /** The scorecard's own move to the current model, when it made one. */
  autoSwitch: { from: string; to: string; at: string } | null;
}

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

/** Per model: the agent's runs and replays, and a cheaper model when replays agree with it. */
function ModelScorecard({ agentId, onSwitched }: { agentId: string; onSwitched: () => void }) {
  const manage = useCan("manage");
  const [card, setCard] = useState<Scorecard | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    orgApi<Scorecard>(`/agents/${agentId}/models`)
      .then((c) => {
        setCard(c);
        return undefined;
      })
      .catch((e: Error) => setError(e.message));
  }, [agentId]);
  if (!card || card.models.length === 0) return null;
  const rec = card.recommendation;
  const moved = card.autoSwitch;
  const switchTo = (model: string) =>
    void orgApi(`/agents/${agentId}`, { method: "PATCH", json: { model } })
      .then(onSwitched)
      .catch((e: Error) => setError(e.message));
  return (
    <div className="space-y-2" data-testid="model-scorecard">
      <p className="text-xs font-semibold uppercase text-muted-foreground">Models</p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="pr-2 font-normal">Model</th>
              <th className="pr-2 font-normal">Runs · done</th>
              <th className="pr-2 font-normal">Replays · agree</th>
              <th className="font-normal">Per call</th>
            </tr>
          </thead>
          <tbody>
            {card.models.map((m) => (
              <tr key={m.model} className={m.model === card.current ? "font-medium" : ""}>
                <td className="break-all pr-2 font-mono">{m.model}</td>
                <td className="pr-2">
                  {m.runs} · {pct(m.doneRate)}
                </td>
                <td className="pr-2">
                  {m.replayed} · {pct(m.agreement)}
                </td>
                <td>{m.avgCostUsd === null ? "—" : usd(m.avgCostUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {moved && (
        <div className="rounded-lg border p-2 text-xs" data-testid="auto-switch">
          <p>
            The scorecard moved this agent here from <span className="font-mono">{moved.from}</span>
            .
          </p>
          {manage && moved.from && (
            <Button
              size="sm"
              variant="outline"
              className="mt-1"
              onClick={() => switchTo(moved.from)}
            >
              Switch back to {moved.from}
            </Button>
          )}
        </div>
      )}
      {rec ? (
        <div className="rounded-lg border border-success/30 bg-success/10 p-2 text-xs">
          <p>
            Try <span className="font-mono">{rec.model}</span>: {rec.reason}
          </p>
          {manage && (
            <Button
              size="sm"
              variant="outline"
              className="mt-1"
              onClick={() => switchTo(rec.model)}
            >
              Switch to {rec.model}
            </Button>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Replay this agent's tasks on another model to see whether a cheaper one would do.
        </p>
      )}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

interface Revision {
  id: string;
  createdAt: string;
  config: Record<string, unknown>;
}

/** Earlier configs of this agent, each with the fields that differ from now, and a restore. */
function ConfigHistory({ agent, onRestored }: { agent: Agent; onRestored: () => void }) {
  const manage = useCan("manage");
  const [revs, setRevs] = useState<Revision[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    orgApi<Revision[]>(`/agents/${agent.id}/revisions`)
      .then((r) => {
        setRevs(r);
        return undefined;
      })
      .catch((e: Error) => setError(e.message));
  }, [agent]);
  if (revs.length === 0) return null;
  const current = agent as unknown as Record<string, unknown>;
  const restore = (id: string) =>
    void orgApi(`/agents/${agent.id}/revisions/${id}/rollback`, { method: "POST" })
      .then(onRestored)
      .catch((e: Error) => setError(e.message));
  return (
    <div className="space-y-2" data-testid="config-history">
      <p className="text-xs font-semibold uppercase text-muted-foreground">Config history</p>
      <ul className="space-y-1">
        {revs.slice(0, 10).map((r) => {
          const changed = Object.keys(r.config).filter(
            (k) => JSON.stringify(r.config[k] ?? null) !== JSON.stringify(current[k] ?? null),
          );
          return (
            <li key={r.id} className="flex items-center gap-2 rounded-lg border p-2 text-xs">
              <span className="min-w-0 flex-1 break-words">
                {timeAgo(r.createdAt)} ·{" "}
                {changed.length ? `differs in ${changed.join(", ")}` : "same as now"}
              </span>
              {manage && changed.length > 0 && (
                <Button size="sm" variant="outline" onClick={() => restore(r.id)}>
                  Restore
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const VERDICT = {
  strong: "border-success/30 bg-success/10",
  weak: "border-destructive/30 bg-destructive/10",
  mixed: "border-warning/30 bg-warning/10",
} as const;

/** One agent: who it is, how it has done, and what it ran. */
export function AgentSheet({
  agent,
  agents,
  companyId,
  refreshKey,
  onClose,
  onChanged,
}: {
  agent: Agent | null;
  agents: Agent[];
  companyId: string;
  refreshKey: number;
  onClose: () => void;
  /** The agent changed here, e.g. switched to another model. */
  onChanged?: () => void;
}) {
  const manage = useCan("manage");
  const [rec, setRec] = useState<Record_ | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!agent) return;
    orgApi<Record_>(`/agents/${agent.id}/performance`)
      .then((r) => {
        setRec(r);
        return undefined;
      })
      .catch((e: Error) => setError(e.message));
  }, [agent]);
  useEffect(() => {
    setRec(null);
    setError(null);
    load();
  }, [load, refreshKey]);

  async function review() {
    if (!agent) return;
    setBusy(true);
    setError(null);
    try {
      await orgApi(`/agents/${agent.id}/review`, { method: "POST" });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const manager = agents.find((a) => a.id === agent?.reportsTo);
  return (
    <Sheet open={agent !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto p-4 sm:max-w-lg" aria-describedby={undefined}>
        {agent && (
          <div className="space-y-4 text-sm">
            <SheetHeader className="p-0 pr-8">
              <SheetTitle className="text-base">{agent.name}</SheetTitle>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <StatusPill status={agent.status} />
                <span>{agent.title || agent.role}</span>
                <span>· {ADAPTERS.find((x) => x.id === agent.adapterType)?.label}</span>
                {manager && <span>· reports to {manager.name}</span>}
              </div>
            </SheetHeader>
            {agent.capabilities && <p>{agent.capabilities}</p>}

            {rec && (
              <>
                <div className="grid grid-cols-3 gap-2" aria-label="Record">
                  {[
                    [
                      "Success",
                      rec.successRate === null ? "—" : `${Math.round(rec.successRate * 100)}%`,
                    ],
                    ["Tasks done", String(rec.tasksDone)],
                    ["Spent", usd(rec.totalCostUsd)],
                    [
                      "Per task",
                      rec.costPerDoneTaskUsd === null ? "—" : usd(rec.costPerDoneTaskUsd),
                    ],
                    [
                      "Avg run",
                      rec.avgDurationSec === null ? "—" : `${rec.avgDurationSec.toFixed(1)}s`,
                    ],
                    ["Runs", `${rec.succeeded}/${rec.runs}`],
                  ].map(([label, v]) => (
                    <div key={label} className="rounded-lg border bg-card p-2">
                      <p className="text-[10px] uppercase text-muted-foreground">{label}</p>
                      <p className="font-mono">{v}</p>
                    </div>
                  ))}
                </div>
                <ModelScorecard
                  key={`${agent.id}:${agent.model ?? ""}`}
                  agentId={agent.id}
                  onSwitched={() => onChanged?.()}
                />
                {rec.review ? (
                  <div
                    className={`space-y-1 rounded-lg border p-3 text-xs ${VERDICT[rec.review.verdict]}`}
                    data-testid="agent-review"
                  >
                    <p className="font-medium">
                      Council review: {rec.review.verdict} ({Math.round(rec.review.consensus * 100)}
                      % agreement, {timeAgo(rec.review.at)})
                    </p>
                    <p>{rec.review.summary}</p>
                    {rec.review.votes.map((v, i) => (
                      <p key={i} className="text-muted-foreground">
                        <span className="font-medium text-foreground">{v.member}</span> voted{" "}
                        {v.vote}: {v.reasoning.slice(0, 240)}
                      </p>
                    ))}
                  </div>
                ) : null}
                {manage && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || rec.succeeded === 0}
                    onClick={review}
                  >
                    <Gavel className="size-4" />{" "}
                    {busy ? "The council is reviewing…" : "Ask the council to review this agent"}
                  </Button>
                )}
              </>
            )}
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            <ConfigHistory agent={agent} onRestored={() => onChanged?.()} />
            <div>
              <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Runs</p>
              <RunList
                companyId={companyId}
                agents={agents}
                refreshKey={refreshKey}
                agentId={agent.id}
                compact
              />
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
