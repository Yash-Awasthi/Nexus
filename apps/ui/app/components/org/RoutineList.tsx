// SPDX-License-Identifier: Apache-2.0
import { Play, Plus, Trash2, Webhook } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { selectClass } from "~/components/org/AgentDialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { orgApi, timeAgo, type Agent } from "~/lib/org";

interface Routine {
  id: string;
  title: string;
  description: string;
  assigneeAgentId: string;
  cron: string | null;
  enabled: boolean;
  concurrency: "skip_if_active" | "always";
  webhookId: string | null;
  lastFiredAt: string | null;
  nextRunAt: string | null;
  history: { at: string; source: string; result: string }[];
}

const PRESETS: [string, string][] = [
  ["", "Manual or webhook only"],
  ["0 9 * * 1-5", "Weekdays at 09:00"],
  ["0 9 * * *", "Every day at 09:00"],
  ["0 * * * *", "Every hour"],
  ["0 9 * * 1", "Mondays at 09:00"],
];

/** Recurring work: each firing files a task for its agent. */
export function RoutineList({
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
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({
    title: "",
    description: "",
    assigneeAgentId: "",
    cron: "0 9 * * 1-5",
    concurrency: "skip_if_active",
  });
  const [hook, setHook] = useState<{ id: string; url: string; secret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    orgApi<{ routines: Routine[] }>(`/companies/${companyId}/routines`)
      .then((b) => {
        setRoutines(b.routines);
        return undefined;
      })
      .catch((e: Error) => setError(e.message));
  }, [companyId]);
  useEffect(load, [load, refreshKey]);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const live = agents.filter((a) => a.status !== "terminated");
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? "unknown";

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Recurring work. Each firing files a task for its agent and wakes it.
        </p>
        <Button size="sm" onClick={() => setCreating((v) => !v)}>
          <Plus className="size-4" /> New routine
        </Button>
      </div>

      {creating && (
        <form
          className="grid gap-3 rounded-lg border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await orgApi(`/companies/${companyId}/routines`, {
                method: "POST",
                json: { ...draft, cron: draft.cron || null },
              });
              setCreating(false);
              setDraft((d) => ({ ...d, title: "", description: "" }));
            });
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="routine-title">Title</Label>
            <Input
              id="routine-title"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="Weekly competitor digest"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="routine-description">What to do each time</Label>
            <Textarea
              id="routine-description"
              rows={2}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="routine-agent">Agent</Label>
              <select
                id="routine-agent"
                className={selectClass}
                value={draft.assigneeAgentId}
                onChange={(e) => setDraft({ ...draft, assigneeAgentId: e.target.value })}
              >
                <option value="">Choose…</option>
                {live.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="routine-when">When</Label>
              <select
                id="routine-when"
                className={selectClass}
                value={PRESETS.some(([v]) => v === draft.cron) ? draft.cron : "custom"}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    cron: e.target.value === "custom" ? "*/30 * * * *" : e.target.value,
                  })
                }
              >
                {PRESETS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
                <option value="custom">Custom cron…</option>
              </select>
            </div>
          </div>
          {!PRESETS.some(([v]) => v === draft.cron) && (
            <Input
              aria-label="Cron expression"
              className="font-mono"
              value={draft.cron}
              onChange={(e) => setDraft({ ...draft, cron: e.target.value })}
            />
          )}
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Skip a firing while the previous task is still open</span>
            <Switch
              aria-label="Skip while active"
              checked={draft.concurrency === "skip_if_active"}
              onCheckedChange={(v) =>
                setDraft({ ...draft, concurrency: v ? "skip_if_active" : "always" })
              }
            />
          </label>
          <Button type="submit" disabled={!draft.title.trim() || !draft.assigneeAgentId}>
            Create routine
          </Button>
        </form>
      )}

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {hook && (
        <div
          className="space-y-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm"
          role="status"
        >
          <p className="font-medium">Webhook on. Copy the secret now; it is not shown again.</p>
          <p className="break-all font-mono text-xs">POST {window.location.origin + hook.url}</p>
          <p className="break-all font-mono text-xs" data-testid="webhook-secret">
            secret: {hook.secret}
          </p>
          <p className="text-xs text-muted-foreground">
            Send <code>x-nexus-timestamp</code> (ms) and{" "}
            <code>x-nexus-signature: sha256=HMAC(secret, &quot;timestamp.body&quot;)</code>. Calls
            older than five minutes are refused.
          </p>
          <Button size="sm" variant="ghost" onClick={() => setHook(null)}>
            Done
          </Button>
        </div>
      )}

      {routines.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          No routines yet.
        </p>
      ) : (
        <ul className="space-y-2" aria-label="Routines">
          {routines.map((r) => (
            <li key={r.id} className="rounded-lg border bg-card p-3" data-testid="routine-row">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{r.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {name(r.assigneeAgentId)} ·{" "}
                    {r.cron ? <span className="font-mono">{r.cron}</span> : "manual"}
                    {r.webhookId ? " · webhook" : ""}
                    {r.nextRunAt ? ` · next ${new Date(r.nextRunAt).toLocaleString()}` : ""}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Last fired {timeAgo(r.lastFiredAt)}
                    {r.history[0] ? ` (${r.history[0].result.replace("_", " ")})` : ""}
                  </p>
                </div>
                <Switch
                  aria-label={`Enable ${r.title}`}
                  checked={r.enabled}
                  onCheckedChange={(enabled) =>
                    void run(() =>
                      orgApi(`/routines/${r.id}`, { method: "PATCH", json: { enabled } }),
                    )
                  }
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void run(() => orgApi(`/routines/${r.id}/fire`, { method: "POST" }))
                  }
                >
                  <Play className="size-4" /> Run now
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void run(async () => {
                      const res = await orgApi<{ url: string | null; secret: string | null }>(
                        `/routines/${r.id}/webhook`,
                        { method: "POST", json: { enabled: !r.webhookId } },
                      );
                      setHook(
                        res.secret && res.url
                          ? { id: r.id, url: res.url, secret: res.secret }
                          : null,
                      );
                    })
                  }
                >
                  <Webhook className="size-4" /> {r.webhookId ? "Turn webhook off" : "Add webhook"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Delete ${r.title}`}
                  onClick={() => void run(() => orgApi(`/routines/${r.id}`, { method: "DELETE" }))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
