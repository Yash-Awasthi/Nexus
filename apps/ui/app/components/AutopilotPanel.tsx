// SPDX-License-Identifier: Apache-2.0
/**
 * AutopilotPanel — launch + watch autonomous project runs.
 *
 * A run is an unattended loop executed by the API: architect → researcher →
 * coder → reviewer (with rework iterations). Each role is mapped to a
 * provider/model from the user's keys (BYOK) or the server's env keys. This
 * panel lets you pick the cast (e.g. ChatGPT codes, Gemini investigates,
 * Claude architects, DeepSeek reviews) or keep the defaults, launch the run,
 * and follow the live event stream.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "~/components/ui/dialog";
import { Loader2, Rocket, Ban, CircleDot, CheckCircle2, XCircle } from "lucide-react";

// ── Types (mirror of the /api/v1 autopilot contract) ─────────────────────────

interface AutopilotPhase {
  role: string;
  label: string;
  provider: string;
  model: string;
  status: "queued" | "running" | "done" | "failed" | "skipped";
  summary?: string;
  error?: string;
}

interface AutopilotEvent {
  ts: string;
  kind: "run" | "phase" | "note" | "artifact";
  role?: string;
  text: string;
}

interface AutopilotRun {
  id: string;
  projectId: string;
  objective: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  roles: Record<string, { provider: string; model: string }>;
  maxIterations: number;
  phases: AutopilotPhase[];
  events: AutopilotEvent[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Role / provider catalogue ────────────────────────────────────────────────

const ROLES: { id: string; hint: string; provider: string; model: string }[] = [
  {
    id: "architect",
    hint: "Plans the work (PLAN.md)",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
  },
  {
    id: "researcher",
    hint: "Finds the facts (RESEARCH.md)",
    provider: "gemini",
    model: "gemini-3.6-flash",
  },
  { id: "coder", hint: "Implements (ChatGPT default)", provider: "openai", model: "gpt-5.6-sol" },
  {
    id: "reviewer",
    hint: "Verifies + demands rework",
    provider: "deepseek",
    model: "deepseek-v4-flash",
  },
];

const PROVIDER_MODELS: Record<string, string> = {
  openai: "gpt-5.6-sol",
  anthropic: "claude-sonnet-4-6",
  gemini: "gemini-3.6-flash",
  deepseek: "deepseek-v4-flash",
  groq: "openai/gpt-oss-120b",
  openrouter: "openai/gpt-4o",
  mistral: "mistral-large-latest",
  ollama: "qwen2.5:7b",
};

const STATUS_META: Record<
  AutopilotRun["status"],
  { label: string; icon: typeof CircleDot; cls: string }
> = {
  queued: { label: "Queued", icon: CircleDot, cls: "text-muted-foreground" },
  running: { label: "Running", icon: Loader2, cls: "text-blue-500" },
  done: { label: "Done", icon: CheckCircle2, cls: "text-green-500" },
  failed: { label: "Failed", icon: XCircle, cls: "text-red-500" },
  cancelled: { label: "Cancelled", icon: Ban, cls: "text-amber-500" },
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(body.error ?? body.message ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

interface RoleOverride {
  provider?: string;
  model?: string;
}

export function AutopilotPanel({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const [runs, setRuns] = useState<AutopilotRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [objective, setObjective] = useState("");
  const [maxIterations, setMaxIterations] = useState("2");
  const [overrides, setOverrides] = useState<Record<string, RoleOverride>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [liveEvents, setLiveEvents] = useState<AutopilotEvent[]>([]);
  const streamAbort = useRef<AbortController | null>(null);

  const loadRuns = useCallback(() => {
    api<{ runs: AutopilotRun[] }>(`/api/v1/projects/${projectId}/autopilot/runs`)
      .then(({ runs: list }) => {
        setRuns(list);
        setSelectedId((prev) => prev ?? list[0]?.id ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    return () => streamAbort.current?.abort();
  }, []);

  const selected = runs.find((r) => r.id === selectedId) ?? null;

  // Follow a run's SSE stream when it is not terminal.
  useEffect(() => {
    if (
      !selected ||
      selected.status === "done" ||
      selected.status === "failed" ||
      selected.status === "cancelled"
    ) {
      setLiveEvents([]);
      return;
    }
    setLiveEvents(selected.events);
    const abort = new AbortController();
    streamAbort.current = abort;
    void (async () => {
      try {
        const res = await fetch(`/api/v1/autopilot/runs/${selected.id}/stream`, {
          signal: abort.signal,
        });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const ev = JSON.parse(line.slice(6)) as AutopilotEvent & { replay?: boolean };
              setLiveEvents((prev) => [...prev.slice(-799), ev]);
              if (ev.text === "END") {
                abort.abort();
                loadRuns();
                return;
              }
            } catch {
              /* skip malformed line */
            }
          }
        }
      } catch {
        /* aborted or stream ended */
      }
    })();
    return () => abort.abort();
  }, [selectedId, loadRuns]); // eslint-disable-line react-hooks/exhaustive-deps

  const setRoleProvider = (role: string, provider: string) => {
    setOverrides((prev) => ({
      ...prev,
      [role]: { ...(prev[role] ?? {}), provider, model: PROVIDER_MODELS[provider] ?? "" },
    }));
  };

  const startRun = async () => {
    if (!objective.trim() || starting) return;
    setStarting(true);
    setError(null);
    try {
      const created = await api<AutopilotRun>(`/api/v1/projects/${projectId}/autopilot/runs`, {
        method: "POST",
        body: JSON.stringify({
          objective: objective.trim(),
          maxIterations: Number(maxIterations),
          roles: overrides,
        }),
      });
      setRuns((prev) => [created, ...prev]);
      setSelectedId(created.id);
      setStartOpen(false);
      setObjective("");
      setOverrides({});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const cancelRun = async (id: string) => {
    try {
      await api<{ ok: boolean }>(`/api/v1/autopilot/runs/${id}`, { method: "DELETE" });
      loadRuns();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const events = selected
    ? selected.status === "running" || selected.status === "queued"
      ? liveEvents
      : selected.events
    : [];

  return (
    <div className="space-y-4">
      {error && (
        <div className="text-xs text-red-500 bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
          {error}
          <button className="ml-2 font-bold" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Rocket className="size-4 text-muted-foreground" /> Autonomous runs
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Unattended agent loop: Architect plans → Researcher gathers facts → Coder implements →
            Reviewer verifies (and requests rework). Runs in an isolated workspace per run.
          </p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => setStartOpen(true)}>
          <Rocket className="size-3.5" /> Start run
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : runs.length === 0 ? (
        <Card>
          <CardContent className="text-center py-10 text-sm text-muted-foreground">
            No runs yet. Start one to let ChatGPT, Gemini, Claude (or your pick of models) build
            toward an objective on their own.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4 items-start">
          {/* Run list */}
          <div className="space-y-2">
            {runs.map((run) => {
              const meta = STATUS_META[run.status] ?? STATUS_META.queued;
              const Icon = meta.icon;
              return (
                <button
                  key={run.id}
                  onClick={() => setSelectedId(run.id)}
                  className={`w-full text-left rounded-lg border p-3 transition-colors ${
                    selectedId === run.id
                      ? "border-primary/40 bg-primary/5"
                      : "border-border hover:border-muted-foreground/40"
                  }`}
                >
                  <div className="flex items-center gap-2 text-xs">
                    <Icon
                      className={`size-3.5 ${run.status === "running" ? "animate-spin" : ""} ${meta.cls}`}
                    />
                    <span className={`font-medium ${meta.cls}`}>{meta.label}</span>
                    <span className="text-muted-foreground ml-auto">
                      {run.createdAt.slice(0, 16).replace("T", " ")}
                    </span>
                  </div>
                  <p className="text-xs mt-1.5 line-clamp-2">{run.objective}</p>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {run.phases.map((p, i) => (
                      <Badge
                        key={`${p.role}-${i}`}
                        variant="outline"
                        className={`text-[10px] px-1.5 py-0 ${
                          p.status === "done"
                            ? "text-green-600"
                            : p.status === "failed"
                              ? "text-red-500"
                              : ""
                        }`}
                      >
                        {p.role}
                      </Badge>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Detail: timeline */}
          {selected ? (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="text-sm">Run detail</CardTitle>
                    <CardDescription className="text-xs mt-1 line-clamp-2">
                      {selected.objective}
                    </CardDescription>
                  </div>
                  {selected.status === "running" || selected.status === "queued" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs gap-1"
                      onClick={() => cancelRun(selected.id)}
                    >
                      <Ban className="size-3" /> Cancel
                    </Button>
                  ) : null}
                </div>
                {/* Phases */}
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {selected.phases.map((p, i) => (
                    <Badge
                      key={`${p.role}-${i}`}
                      variant="outline"
                      title={p.error ?? p.summary ?? `${p.provider}/${p.model}`}
                      className={`text-[10px] ${
                        p.status === "done"
                          ? "border-green-500/40 text-green-600"
                          : p.status === "failed"
                            ? "border-red-500/40 text-red-500"
                            : p.status === "running"
                              ? "border-blue-500/40 text-blue-500"
                              : "text-muted-foreground"
                      }`}
                    >
                      {p.label} · {p.provider}/{p.model}
                    </Badge>
                  ))}
                </div>
              </CardHeader>
              <CardContent className="max-h-[380px] overflow-y-auto space-y-1 text-xs font-mono">
                {events.length === 0 ? (
                  <p className="text-muted-foreground py-6 text-center">No events yet.</p>
                ) : (
                  events.map((ev, i) => (
                    <div key={i} className="flex gap-2 border-b border-border/40 pb-1">
                      <span className="text-muted-foreground shrink-0">
                        {(ev.ts ?? "").slice(11, 19)}
                      </span>
                      <span
                        className={`shrink-0 w-16 ${
                          ev.kind === "phase"
                            ? "text-blue-500"
                            : ev.kind === "note"
                              ? "text-amber-500"
                              : "text-foreground"
                        }`}
                      >
                        {ev.kind === "run" ? "" : (ev.role ?? ev.kind)}
                      </span>
                      <span className="whitespace-pre-wrap break-words">{ev.text}</span>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}

      {/* Start-run dialog */}
      <Dialog open={startOpen} onOpenChange={(open) => !open && !starting && setStartOpen(open)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Start an autonomous run in “{projectName}”</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="ap-objective">Objective</Label>
              <Textarea
                id="ap-objective"
                placeholder="e.g. Build a Python package that fetches exchange rates and prints a summary; include tests."
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                rows={4}
              />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Agent roles (provider/model)</Label>
                <div className="flex items-center gap-2 text-xs">
                  <Label htmlFor="ap-iter" className="text-muted-foreground">
                    Max rework iterations
                  </Label>
                  <Select value={maxIterations} onValueChange={setMaxIterations}>
                    <SelectTrigger id="ap-iter" className="w-20 h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {["1", "2", "3"].map((n) => (
                        <SelectItem key={n} value={n}>
                          {n}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {ROLES.map((role) => {
                  const ov = overrides[role.id];
                  const provider = ov?.provider ?? role.provider;
                  return (
                    <div
                      key={role.id}
                      className="rounded-lg border border-border p-2.5 space-y-1.5"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium capitalize">{role.id}</span>
                        <span className="text-[10px] text-muted-foreground">{role.hint}</span>
                      </div>
                      <Select value={provider} onValueChange={(p) => setRoleProvider(role.id, p)}>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="openai">OpenAI (ChatGPT API)</SelectItem>
                          <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                          <SelectItem value="gemini">Google Gemini</SelectItem>
                          <SelectItem value="deepseek">DeepSeek</SelectItem>
                          <SelectItem value="groq">Groq (free tier)</SelectItem>
                          <SelectItem value="openrouter">OpenRouter</SelectItem>
                          <SelectItem value="mistral">Mistral</SelectItem>
                          <SelectItem value="ollama">Ollama (local)</SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        className="h-8 text-xs font-mono"
                        placeholder={PROVIDER_MODELS[provider] ?? "model id"}
                        value={ov?.model ?? ""}
                        onChange={(e) =>
                          setOverrides((prev) => ({
                            ...prev,
                            [role.id]: { ...(prev[role.id] ?? {}), model: e.target.value },
                          }))
                        }
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStartOpen(false)} disabled={starting}>
              Cancel
            </Button>
            <Button onClick={startRun} disabled={!objective.trim() || starting} className="gap-2">
              {starting && <Loader2 className="size-3.5 animate-spin" />}
              <Rocket className="size-3.5" /> Launch run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
