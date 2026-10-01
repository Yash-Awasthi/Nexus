// SPDX-License-Identifier: Apache-2.0
import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { selectClass } from "~/components/org/AgentDialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { StatusPill, orgApi, timeAgo, usd, useCan, type Agent, type Goal } from "~/lib/org";

interface PolicyRow {
  id: string;
  scopeType: "company" | "agent" | "goal";
  scopeId: string;
  scopeName: string;
  windowKind: "day" | "month" | "lifetime";
  amountMicros: number;
  warnPercent: number;
  hardStop: boolean;
  observedMicros: number;
  state: "ok" | "warning" | "hard_stop";
}

interface IncidentRow {
  id: string;
  scopeName: string;
  threshold: "soft" | "hard";
  limitMicros: number;
  observedMicros: number;
  status: "open" | "resolved" | "dismissed";
  createdAt: string;
}

interface Overview {
  forecast: {
    perDayUsd: number;
    projectedMonthUsd: number;
    exhaustion: { policyId: string; scopeName: string; windowKind: string; at: string | null }[];
  };
  policies: PolicyRow[];
  incidents: IncidentRow[];
  spend: {
    dayMicros: number;
    monthMicros: number;
    lifetimeMicros: number;
    byAgent: { agentId: string; name: string; monthMicros: number; lifetimeMicros: number }[];
  };
}

const m = (micros: number) => usd(micros / 1_000_000);
const BAR: Record<PolicyRow["state"], string> = {
  ok: "bg-success",
  warning: "bg-warning",
  hard_stop: "bg-destructive",
};

function Incident({ inc, onDone }: { inc: IncidentRow; onDone: () => void }) {
  const manage = useCan("manage");
  const [amount, setAmount] = useState(((inc.observedMicros / 1_000_000) * 2).toFixed(2));
  const [error, setError] = useState<string | null>(null);
  async function resolve(action: string) {
    setError(null);
    try {
      await orgApi(`/budget-incidents/${inc.id}/resolve`, {
        method: "POST",
        json: { action, amountUsd: Number(amount) },
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <li
      className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3"
      data-testid="incident"
    >
      <p className="text-sm font-medium">
        {inc.scopeName} hit its budget: {m(inc.observedMicros)} of {m(inc.limitMicros)}
      </p>
      {manage && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">Raise to $</span>
          <Input
            aria-label="New budget in dollars"
            className="w-24"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <Button size="sm" onClick={() => resolve("raise_and_resume")}>
            Raise and resume
          </Button>
          <Button size="sm" variant="ghost" onClick={() => resolve("dismiss")}>
            Keep paused
          </Button>
        </div>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/** Spend, limits and incidents for one company. */
export function BudgetPanel({
  companyId,
  agents,
  refreshKey,
  onChanged,
}: {
  companyId: string;
  agents: Agent[];
  refreshKey: number;
  onChanged: () => void;
}) {
  const manage = useCan("manage");
  const [view, setView] = useState<Overview | null>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [scope, setScope] = useState("company");
  const [windowKind, setWindowKind] = useState("month");
  const [amount, setAmount] = useState("5");
  const [warn, setWarn] = useState("80");
  const [hardStop, setHardStop] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void Promise.all([
      orgApi<Overview>(`/companies/${companyId}/budgets`),
      orgApi<{ goals: Goal[] }>(`/companies/${companyId}/goals`),
    ])
      .then(([o, g]) => {
        setView(o);
        setGoals(g.goals);
        return undefined;
      })
      .catch((e: Error) => setError(e.message));
  }, [companyId]);
  useEffect(load, [load, refreshKey]);

  async function save() {
    setError(null);
    const [scopeType, scopeId] = scope.split(":");
    try {
      await orgApi(`/companies/${companyId}/budgets`, {
        method: "PUT",
        json: {
          scopeType,
          scopeId,
          windowKind,
          amountUsd: Number(amount),
          warnPercent: Number(warn),
          hardStop,
        },
      });
      load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!view) return <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>;
  const open = view.incidents.filter((i) => i.status === "open" && i.threshold === "hard");

  return (
    <section className="space-y-5">
      <div className="grid grid-cols-3 gap-2">
        {[
          ["Today", view.spend.dayMicros],
          ["This month", view.spend.monthMicros],
          ["All time", view.spend.lifetimeMicros],
        ].map(([label, v]) => (
          <div key={label} className="rounded-lg border bg-card p-3">
            <p className="text-[11px] uppercase text-muted-foreground">{label}</p>
            <p className="font-mono text-lg" data-testid={`spend-${label}`}>
              {m(v as number)}
            </p>
          </div>
        ))}
      </div>

      <p className="text-sm text-muted-foreground" data-testid="forecast">
        At the last week&apos;s pace ({usd(view.forecast.perDayUsd)} a day), this month ends near{" "}
        <span className="font-mono text-foreground">{usd(view.forecast.projectedMonthUsd)}</span>.
      </p>

      {open.length > 0 && (
        <ul className="space-y-2" aria-label="Budget incidents">
          {open.map((i) => (
            <Incident
              key={i.id}
              inc={i}
              onDone={() => {
                load();
                onChanged();
              }}
            />
          ))}
        </ul>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Limits</h3>
        {view.policies.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No limits yet. Without one, agents can spend as much as your keys allow.
          </p>
        )}
        <ul className="space-y-2" aria-label="Budget limits">
          {view.policies.map((p) => {
            const pct =
              p.amountMicros > 0 ? Math.min(100, (p.observedMicros / p.amountMicros) * 100) : 0;
            return (
              <li key={p.id} className="rounded-lg border bg-card p-3" data-testid="budget-row">
                <div className="flex items-center gap-2">
                  <p className="min-w-0 flex-1 truncate text-sm font-medium">
                    {p.scopeName}{" "}
                    <span className="font-normal text-muted-foreground">· {p.windowKind}</span>
                  </p>
                  <StatusPill
                    status={
                      p.state === "hard_stop"
                        ? "paused"
                        : p.state === "warning"
                          ? "pending_approval"
                          : "active"
                    }
                  />
                  {manage && (
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove limit for ${p.scopeName}`}
                      onClick={() =>
                        void orgApi(`/budgets/${p.id}`, { method: "DELETE" })
                          .then(() => {
                            load();
                            return undefined;
                          })
                          .catch(() => undefined)
                      }
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                  <div className={`h-full ${BAR[p.state]}`} style={{ width: `${pct}%` }} />
                </div>
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  {m(p.observedMicros)} of {m(p.amountMicros)} · warn at {p.warnPercent}% ·{" "}
                  {p.hardStop ? "hard stop" : "warn only"}
                </p>
                {(() => {
                  const at = view.forecast.exhaustion.find((x) => x.policyId === p.id)?.at;
                  return at && p.state !== "hard_stop" ? (
                    <p className="text-xs text-warning">
                      Runs out around {new Date(at).toLocaleDateString()} at this pace.
                    </p>
                  ) : null;
                })()}
              </li>
            );
          })}
        </ul>
      </div>

      {manage && (
        <form
          className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <p className="text-sm font-semibold sm:col-span-2">Set a limit</p>
          <div className="grid gap-1.5">
            <Label htmlFor="budget-scope">Applies to</Label>
            <select
              id="budget-scope"
              className={selectClass}
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="company">The whole company</option>
              {agents
                .filter((a) => a.status !== "terminated")
                .map((a) => (
                  <option key={a.id} value={`agent:${a.id}`}>
                    Agent: {a.name}
                  </option>
                ))}
              {goals.map((g) => (
                <option key={g.id} value={`goal:${g.id}`}>
                  Goal: {g.title}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="budget-window">Per</Label>
            <select
              id="budget-window"
              className={selectClass}
              value={windowKind}
              onChange={(e) => setWindowKind(e.target.value)}
            >
              <option value="day">Day (UTC)</option>
              <option value="month">Month (UTC)</option>
              <option value="lifetime">All time</option>
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="budget-amount">Limit ($)</Label>
            <Input
              id="budget-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="budget-warn">Warn at (%)</Label>
            <Input
              id="budget-warn"
              inputMode="numeric"
              value={warn}
              onChange={(e) => setWarn(e.target.value)}
            />
          </div>
          <label className="flex items-center justify-between gap-3 text-sm sm:col-span-2">
            <span>Pause when the limit is reached</span>
            <Switch checked={hardStop} onCheckedChange={setHardStop} aria-label="Hard stop" />
          </label>
          {error && (
            <p className="text-sm text-destructive sm:col-span-2" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" className="sm:col-span-2">
            Save limit
          </Button>
        </form>
      )}

      {view.spend.byAgent.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">Spend by agent</h3>
          <ul className="divide-y rounded-lg border text-sm">
            {view.spend.byAgent.map((a) => (
              <li key={a.agentId} className="flex justify-between p-2">
                <span>{a.name}</span>
                <span className="font-mono text-muted-foreground">
                  {m(a.monthMicros)} month · {m(a.lifetimeMicros)} total
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {view.incidents.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Incident history</summary>
          <ul className="mt-2 space-y-1">
            {view.incidents.map((i) => (
              <li key={i.id} className="flex justify-between gap-2">
                <span>
                  {i.scopeName} · {i.threshold} · {i.status}
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {timeAgo(i.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
