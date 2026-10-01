// SPDX-License-Identifier: Apache-2.0
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { Textarea } from "~/components/ui/textarea";

interface MemoryEntry {
  id: string;
  text: string;
  /** Unix epoch seconds. */
  createdAt?: number;
}

export function ProjectMemoryPanel({ projectId }: { projectId: string }) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    fetch(`/api/memory/entries?project_id=${encodeURIComponent(projectId)}&limit=200`)
      .then((r) => (r.ok ? (r.json() as Promise<{ entries?: MemoryEntry[] }>) : { entries: [] }))
      .then((d) => setEntries(d.entries ?? []))
      .catch(() => setError("Could not load this project's memories."))
      .finally(() => setLoading(false));
  }, [projectId]);

  const forget = async (id: string) => {
    const r = await fetch(`/api/memory/entries/${id}`, { method: "DELETE" }).catch(() => null);
    if (r?.ok) setEntries((prev) => prev.filter((e) => e.id !== id));
    else setError("Could not forget that memory.");
  };

  const add = async () => {
    const text = draft.trim();
    if (!text) return;
    setSaving(true);
    setError("");
    const r = await fetch("/api/memory/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text, project_id: projectId }),
    }).catch(() => null);
    setSaving(false);
    if (!r?.ok) {
      setError("Could not save the memory.");
      return;
    }
    const saved = (await r.json()) as MemoryEntry;
    setEntries((prev) => [saved, ...prev]);
    setDraft("");
    setAdding(false);
  };

  return (
    <div className="space-y-3">
      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No memories for this project yet.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {entries.map((e) => (
            <li key={e.id} className="flex items-start gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="line-clamp-3 text-sm">{e.text}</p>
                {e.createdAt && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {new Date(e.createdAt * 1000).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </p>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Forget"
                onClick={() => void forget(e.id)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {adding ? (
        <div className="space-y-2">
          <Textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="What should this project remember?"
            aria-label="New memory"
          />
          <div className="flex gap-2">
            <Button onClick={() => void add()} disabled={saving || !draft.trim()}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setAdding(false);
                setDraft("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" className="w-full border-dashed" onClick={() => setAdding(true)}>
          <Plus /> Add memory
        </Button>
      )}
    </div>
  );
}
