// SPDX-License-Identifier: Apache-2.0
import { Armchair, Check, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { Route } from "./+types/archetypes";

import { EmptyState, Page, PageHeader } from "~/components/page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { useModelIds } from "~/hooks/use-model-ids";
import {
  loadCouncilMembers,
  newMember,
  saveCouncilMembers,
  syncCouncilFromServer,
  type CouncilMember,
} from "~/lib/council";
import { cn } from "~/lib/utils";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Archetypes · Nexus" }];
}

interface Archetype {
  id: string;
  name: string;
  thinkingStyle: string;
  description?: string;
  asks?: string;
  blindSpot?: string;
  systemPrompt: string;
  model?: string;
  temperature?: number;
  builtin: boolean;
}

type Draft = Pick<Archetype, "name" | "thinkingStyle" | "systemPrompt"> & {
  asks: string;
  blindSpot: string;
  model: string;
  temperature: string;
};

const EMPTY: Draft = {
  name: "",
  thinkingStyle: "",
  asks: "",
  blindSpot: "",
  systemPrompt: "",
  model: "",
  temperature: "",
};

export default function ArchetypesPage() {
  const [list, setList] = useState<Archetype[] | null>(null);
  const [council, setCouncil] = useState<CouncilMember[]>(() => loadCouncilMembers());
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Archetype | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    fetch("/api/archetypes")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { archetypes: Archetype[] }) => setList(d.archetypes))
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void load();
    void syncCouncilFromServer().then(setCouncil);
  }, []);

  const seatedIds = new Set(council.filter((m) => m.enabled).map((m) => m.archetypeId));
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (list ?? []).filter(
      (a) => !q || `${a.name} ${a.thinkingStyle} ${a.asks ?? ""}`.toLowerCase().includes(q),
    );
  }, [list, query]);
  const mine = shown.filter((a) => !a.builtin);
  const builtin = shown.filter((a) => a.builtin);

  // Seat takes the first seated member still on auto; with none free it adds a member.
  const seat = (a: Archetype) => {
    const next = [...council];
    const free = next.findIndex((m) => m.enabled && !m.archetypeId);
    if (free >= 0) next[free] = { ...next[free], archetypeId: a.id };
    else next.push({ ...newMember(), label: a.name.replace(/^The /, ""), archetypeId: a.id });
    setCouncil(next);
    saveCouncilMembers(next);
    void fetch("/api/settings/council", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ members: next }),
    });
  };

  const remove = async (a: Archetype) => {
    if (!confirm(`Delete ${a.name}? Members using it go back to automatic.`)) return;
    await fetch(`/api/archetypes/${a.id}`, { method: "DELETE" });
    void load();
  };

  return (
    <Page width="wide">
      <PageHeader
        title="Archetypes"
        description="The personas council members speak as. Seat one on a member, or write your own with its own model and temperature."
        actions={
          <Button onClick={() => setEditing("new")}>
            <Plus /> New archetype
          </Button>
        }
      >
        <div className="relative max-w-sm">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search archetypes"
            aria-label="Search archetypes"
            className="pl-8"
          />
        </div>
      </PageHeader>

      {error && <p className="text-sm text-destructive">Could not load archetypes: {error}</p>}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Yours</h2>
        {list && mine.length === 0 ? (
          <EmptyState
            title={query ? "No match among yours" : "You have no archetypes of your own yet"}
            description="Write a persona for a lens the built-ins miss — a compliance officer, a customer, your CFO."
            action={
              <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
                <Plus /> New archetype
              </Button>
            }
            className="py-8"
          />
        ) : (
          <Grid
            items={mine}
            seatedIds={seatedIds}
            onSeat={seat}
            onEdit={setEditing}
            onDelete={(a) => void remove(a)}
          />
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Built in</h2>
        {list === null ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="h-40 animate-pulse rounded-xl bg-muted" />
            ))}
          </div>
        ) : (
          <Grid items={builtin} seatedIds={seatedIds} onSeat={seat} onEdit={setEditing} />
        )}
      </section>

      <Editor
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />
    </Page>
  );
}

function Grid({
  items,
  seatedIds,
  onSeat,
  onEdit,
  onDelete,
}: {
  items: Archetype[];
  seatedIds: Set<string | undefined>;
  onSeat: (a: Archetype) => void;
  onEdit: (a: Archetype) => void;
  onDelete?: (a: Archetype) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((a) => {
        const seated = seatedIds.has(a.id);
        return (
          <article key={a.id} className="flex flex-col rounded-xl border bg-card p-4">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-sm font-semibold text-primary">
                {a.name.replace(/^The /, "").slice(0, 1)}
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="truncate font-medium">{a.name}</h3>
                <p className="truncate text-xs text-muted-foreground">{a.thinkingStyle}</p>
              </div>
              {seated && (
                <Badge variant="secondary" className="shrink-0">
                  <Check /> Seated
                </Badge>
              )}
            </div>
            <dl className="mt-3 flex-1 space-y-2 text-sm">
              {a.asks && (
                <div>
                  <dt className="text-xs text-muted-foreground">Always asks</dt>
                  <dd>“{a.asks.replace(/^["“]|["”]$/g, "")}”</dd>
                </div>
              )}
              {a.blindSpot && (
                <div>
                  <dt className="text-xs text-muted-foreground">Blind spot</dt>
                  <dd className="text-muted-foreground">{a.blindSpot}</dd>
                </div>
              )}
              {!a.asks && !a.blindSpot && (
                <dd className="line-clamp-3 text-muted-foreground">
                  {a.description || a.systemPrompt}
                </dd>
              )}
              {(a.model || a.temperature !== undefined) && (
                <p className="text-xs text-muted-foreground">
                  {a.model ?? "Council model"}
                  {a.temperature !== undefined ? ` · temperature ${a.temperature}` : ""}
                </p>
              )}
            </dl>
            <div className="mt-4 flex items-center gap-1">
              <Button
                variant={seated ? "ghost" : "outline"}
                size="sm"
                onClick={() => onSeat(a)}
                disabled={seated}
              >
                <Armchair /> {seated ? "On the council" : "Seat on council"}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto"
                aria-label={a.builtin ? `View ${a.name}` : `Edit ${a.name}`}
                title={a.builtin ? "View prompt" : "Edit"}
                onClick={() => onEdit(a)}
              >
                <Pencil />
              </Button>
              {onDelete && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${a.name}`}
                  title="Delete"
                  onClick={() => onDelete(a)}
                >
                  <Trash2 />
                </Button>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function Editor({
  target,
  onClose,
  onSaved,
}: {
  target: Archetype | "new" | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modelIds = useModelIds();
  const readOnly = target !== null && target !== "new" && target.builtin;

  useEffect(() => {
    setError(null);
    if (!target) return;
    setDraft(
      target === "new"
        ? EMPTY
        : {
            name: target.name,
            thinkingStyle: target.thinkingStyle,
            asks: target.asks ?? "",
            blindSpot: target.blindSpot ?? "",
            systemPrompt: target.systemPrompt,
            model: target.model ?? "",
            temperature: target.temperature === undefined ? "" : String(target.temperature),
          },
    );
  }, [target]);

  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));

  const temperature = draft.temperature.trim() === "" ? undefined : Number(draft.temperature);
  const valid =
    draft.name.trim() &&
    draft.systemPrompt.trim() &&
    (temperature === undefined || (temperature >= 0 && temperature <= 2));

  const save = async () => {
    if (!valid || !target) return;
    setSaving(true);
    setError(null);
    const body = {
      name: draft.name.trim(),
      thinkingStyle: draft.thinkingStyle.trim(),
      asks: draft.asks.trim(),
      blindSpot: draft.blindSpot.trim(),
      systemPrompt: draft.systemPrompt.trim(),
      ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    };
    const res = await fetch(target === "new" ? "/api/archetypes" : `/api/archetypes/${target.id}`, {
      method: target === "new" ? "POST" : "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);
    if (res.ok) onSaved();
    else
      setError(
        ((await res.json().catch(() => ({}))) as { message?: string }).message ??
          `HTTP ${res.status}`,
      );
  };

  // A built-in can't change, so "Save a copy" makes it the user's own.
  const saveCopy = async () => {
    setSaving(true);
    const res = await fetch("/api/archetypes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `${draft.name} (mine)`,
        thinkingStyle: draft.thinkingStyle,
        asks: draft.asks,
        blindSpot: draft.blindSpot,
        systemPrompt: draft.systemPrompt,
      }),
    });
    setSaving(false);
    if (res.ok) onSaved();
    else setError(`HTTP ${res.status}`);
  };

  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {target === "new" ? "New archetype" : readOnly ? draft.name : `Edit ${draft.name}`}
          </DialogTitle>
          <DialogDescription>
            {readOnly
              ? "Built-in personas can't be changed. Save a copy to make your own version."
              : "The system prompt is what the member is told. Model and temperature are optional — the member's own model wins when it has one."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Labelled label="Name">
              <Input value={draft.name} onChange={set("name")} placeholder="The Auditor" />
            </Labelled>
            <Labelled label="Thinking style">
              <Input
                value={draft.thinkingStyle}
                onChange={set("thinkingStyle")}
                placeholder="Ledger-first, sceptical"
              />
            </Labelled>
            <Labelled label="Always asks">
              <Input
                value={draft.asks}
                onChange={set("asks")}
                placeholder="Where does the money go?"
              />
            </Labelled>
            <Labelled label="Blind spot">
              <Input
                value={draft.blindSpot}
                onChange={set("blindSpot")}
                placeholder="Undervalues what can't be counted"
              />
            </Labelled>
          </div>
          <Labelled label="System prompt">
            <Textarea
              value={draft.systemPrompt}
              onChange={set("systemPrompt")}
              rows={6}
              className="min-h-32"
              placeholder="You are The Auditor. You follow the money and question every cost…"
            />
          </Labelled>
          <div className="grid gap-3 sm:grid-cols-2">
            <Labelled label="Model (optional)">
              <Input value={draft.model} onChange={set("model")} list="archetype-models" />
              <datalist id="archetype-models">
                {modelIds.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Labelled>
            <Labelled label="Temperature 0–2 (optional)">
              <Input
                value={draft.temperature}
                onChange={set("temperature")}
                inputMode="decimal"
                placeholder="0.7"
                aria-invalid={temperature !== undefined && !(temperature >= 0 && temperature <= 2)}
              />
            </Labelled>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {readOnly ? "Close" : "Cancel"}
          </Button>
          {readOnly ? (
            <Button onClick={() => void saveCopy()} disabled={saving}>
              Save a copy
            </Button>
          ) : (
            <Button onClick={() => void save()} disabled={!valid || saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className={cn("grid gap-1.5")}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
