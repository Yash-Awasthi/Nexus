// SPDX-License-Identifier: Apache-2.0
import { Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { selectClass } from "~/components/org/AgentDialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { StatusPill, orgApi, type Goal } from "~/lib/org";

/** The goal hierarchy, with inline add, status change and delete. */
export function GoalTree({ companyId, refreshKey }: { companyId: string; refreshKey: number }) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [title, setTitle] = useState("");
  const [parentId, setParentId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    orgApi<{ goals: Goal[] }>(`/companies/${companyId}/goals`)
      .then((b) => {
        setGoals(b.goals);
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const children = (id: string | null) => goals.filter((g) => g.parentId === id);
  const render = (g: Goal, depth: number): React.ReactNode => (
    <li key={g.id}>
      <div
        className="flex items-center gap-2 rounded-lg border bg-card p-2.5"
        data-testid="goal-row"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{g.title}</p>
          <p className="text-[11px] uppercase text-muted-foreground">{g.level}</p>
        </div>
        <StatusPill status={g.status} />
        <select
          aria-label={`Status of ${g.title}`}
          className={`${selectClass} w-28`}
          value={g.status}
          onChange={(e) =>
            run(() =>
              orgApi(`/goals/${g.id}`, { method: "PATCH", json: { status: e.target.value } }),
            )
          }
        >
          {["planned", "active", "achieved", "cancelled"].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <Button
          size="icon"
          variant="ghost"
          aria-label={`Delete ${g.title}`}
          onClick={() => run(() => orgApi(`/goals/${g.id}`, { method: "DELETE" }))}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
      {children(g.id).length > 0 && depth < 20 && (
        <ul className="ml-4 mt-2 space-y-2 border-l pl-3">
          {children(g.id).map((c) => render(c, depth + 1))}
        </ul>
      )}
    </li>
  );

  return (
    <section className="space-y-3">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await orgApi(`/companies/${companyId}/goals`, {
              method: "POST",
              json: { title, parentId: parentId || null },
            });
            setTitle("");
          });
        }}
      >
        <Input
          aria-label="Goal title"
          className="min-w-48 flex-1"
          placeholder={goals.length ? "Add a goal" : "Your company's top goal"}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <select
          aria-label="Parent goal"
          className={`${selectClass} w-auto`}
          value={parentId}
          onChange={(e) => setParentId(e.target.value)}
        >
          <option value="">Top level</option>
          {goals.map((g) => (
            <option key={g.id} value={g.id}>
              under {g.title}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" disabled={!title.trim()}>
          <Plus className="size-4" /> Add goal
        </Button>
      </form>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {goals.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No goals yet. Tasks that link to a goal carry its whole chain into every agent run.
        </p>
      ) : (
        <ul className="space-y-2" aria-label="Goals">
          {children(null).map((g) => render(g, 0))}
        </ul>
      )}
    </section>
  );
}
