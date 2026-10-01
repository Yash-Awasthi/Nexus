// SPDX-License-Identifier: Apache-2.0
import { Plus, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { orgApi, timeAgo } from "~/lib/org";

interface Lesson {
  id: string;
  kind: "outcome" | "feedback" | "note" | "decision";
  text: string;
  source: string | null;
  uses: number;
  createdAt: string;
}

const KIND_TONE: Record<Lesson["kind"], string> = {
  outcome: "bg-success/10 text-success ",
  feedback: "bg-primary/10 text-primary ",
  decision: "bg-warning/10 text-warning ",
  note: "bg-muted text-muted-foreground",
};

/** What the company has learned; agents recall the relevant parts on every run. */
export function MemoryPanel({ companyId, refreshKey }: { companyId: string; refreshKey: number }) {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [q, setQ] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(() => {
    orgApi<{ lessons: Lesson[] }>(
      `/companies/${companyId}/memory${q.trim() ? `?q=${encodeURIComponent(q)}` : ""}`,
    )
      .then((b) => {
        setLessons(b.lessons);
        return undefined;
      })
      .catch(() => undefined);
  }, [companyId, q]);
  useEffect(load, [load, refreshKey]);

  return (
    <section className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Finished work and your comments become lessons. Each run is shown the ones relevant to its
        task.
      </p>
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
        <Input
          aria-label="Search memory"
          className="pl-8"
          placeholder="What does the company know about…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void orgApi(`/companies/${companyId}/memory`, { method: "POST", json: { text: note } })
            .then(() => {
              setNote("");
              load();
              return undefined;
            })
            .catch(() => undefined);
        }}
      >
        <Input
          aria-label="New note"
          placeholder="Teach the company something (e.g. our audience is students)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={note.trim().length < 3}>
          <Plus className="size-4" /> Add
        </Button>
      </form>
      {lessons.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {q ? "Nothing relevant yet." : "Nothing learned yet. Finish a task or leave a comment."}
        </p>
      ) : (
        <ul className="space-y-2" aria-label="Lessons">
          {lessons.map((l) => (
            <li
              key={l.id}
              className="flex items-start gap-2 rounded-lg border bg-card p-3 text-sm"
              data-testid="lesson"
            >
              <div className="min-w-0 flex-1">
                <p className="mb-1 flex flex-wrap items-center gap-2 text-[11px]">
                  <span className={`rounded px-1.5 py-0.5 font-medium ${KIND_TONE[l.kind]}`}>
                    {l.kind}
                  </span>
                  {l.source && <span className="font-mono text-muted-foreground">{l.source}</span>}
                  <span className="text-muted-foreground">
                    recalled {l.uses}× · {timeAgo(l.createdAt)}
                  </span>
                </p>
                <p className="whitespace-pre-wrap">{l.text}</p>
              </div>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Forget this lesson"
                onClick={() =>
                  void orgApi(`/memory/${l.id}`, { method: "DELETE" })
                    .then(() => {
                      load();
                      return undefined;
                    })
                    .catch(() => undefined)
                }
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
