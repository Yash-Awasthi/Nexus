// SPDX-License-Identifier: Apache-2.0
/**
 * Deep research — a multi-step research run with cited sources.
 *
 * POST /api/research → job created
 * GET  /api/research/:id/stream → SSE stream of research phases
 */

import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  Search,
  Send,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import { EmptyState, Page, PageHeader } from "~/components/page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Markdown } from "~/lib/markdown";
import { cn } from "~/lib/utils";

type JobStatus = "idle" | "pending" | "running" | "done" | "failed" | "error";

interface ResearchStep {
  id: string;
  phase: string;
  label: string;
  detail?: string;
  status: "running" | "done" | "error";
  startedAt: number;
  completedAt?: number;
}

interface Citation {
  id: string;
  title: string;
  url: string;
  excerpt: string;
  cycleIndex: number;
}

interface ResearchJob {
  id: string;
  query: string;
  status: JobStatus;
  steps: ResearchStep[];
  report?: string;
  citations: Citation[];
  cycleCount: number;
  totalMs?: number;
  error?: string;
}

interface JobRecord {
  query?: string;
  status?: string;
  citations?: Citation[];
  cycles?: number;
  report?: string;
  durationMs?: number;
  error?: string;
  milestones?: ResearchMilestones;
  relatedQuestions?: string[];
}

/** One frame of the research stream. */
interface StreamEvent extends Partial<Citation> {
  type: string;
  stepId?: string;
  phase?: string;
  label?: string;
  detail?: string;
  content?: string;
  totalMs?: number;
  message?: string;
}

/** Milestones persisted on the job record by the stream handler (lib/research-jobs.ts). */
type ResearchMilestones = Record<
  string,
  { startedAt?: string; finishedAt?: string; detail?: string }
>;

const PHASE_ORDER = ["planning", "researching", "synthesis", "complete"];

const isTerminal = (s: string | undefined) => s === "done" || s === "error" || s === "failed";

/** The phase list rebuilt from a job record, for a job opened from history or a link. */
function milestonesToSteps(jobStatus: string | undefined, milestones?: ResearchMilestones) {
  if (!milestones) return [];
  const rank = (p: string) => {
    const i = PHASE_ORDER.indexOf(p);
    return i < 0 ? PHASE_ORDER.length : i;
  };
  return Object.entries(milestones)
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([phase, m]): ResearchStep => ({
      id: phase,
      phase,
      label: phase.charAt(0).toUpperCase() + phase.slice(1),
      detail: m.detail,
      // An interrupted job keeps its unfinished phases visibly not done.
      status:
        m.finishedAt || (jobStatus === "done" && m.startedAt)
          ? "done"
          : isTerminal(jobStatus)
            ? "error"
            : "running",
      startedAt: m.startedAt ? new Date(m.startedAt).getTime() : Date.now(),
      completedAt: m.finishedAt ? new Date(m.finishedAt).getTime() : undefined,
    }));
}

function usePastJobs() {
  const [jobs, setJobs] = useState<{ id: string; query: string; status: string }[]>([]);
  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/research");
      if (res.ok) {
        const data = (await res.json()) as {
          jobs?: { id: string; query: string; status: string }[];
        };
        setJobs(data.jobs ?? []);
      }
    } catch {
      /* the list keeps its rows */
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { jobs, refresh };
}

async function fetchRelated(query: string): Promise<string[]> {
  const r = await fetch("/api/research/related-questions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, report_summary: "" }),
  });
  if (!r.ok) return [];
  return ((await r.json()) as { questions?: string[] }).questions ?? [];
}

const statusTone = (s: string) =>
  s === "done" ? "text-success" : isTerminal(s) ? "text-destructive" : "text-warning";

export default function DeepResearchPage() {
  const [query, setQuery] = useState("");
  const [job, setJob] = useState<ResearchJob | null>(null);
  const [expandedSteps, setExpanded] = useState<Set<string>>(new Set());
  const [related, setRelated] = useState<string[]>([]);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // A job opened from history has no live stream; a running one is polled instead.
  const [seeded, setSeeded] = useState(false);
  const { jobs: pastJobs, refresh: refreshPast } = usePastJobs();

  const loadRelated = useCallback((q: string) => {
    setRelatedLoading(true);
    fetchRelated(q)
      .then(setRelated)
      .catch(() => setRelated([]))
      .finally(() => setRelatedLoading(false));
  }, []);

  const loadJob = useCallback(async (id: string) => {
    const res = await fetch(`/api/research/${id}`);
    if (!res.ok) return;
    const data = (await res.json()) as JobRecord;
    const status = (data.status as JobStatus | undefined) ?? "done";
    setJob({
      id,
      query: data.query ?? "",
      status,
      steps: milestonesToSteps(status, data.milestones),
      citations: data.citations ?? [],
      cycleCount: data.cycles ?? 0,
      report: data.report,
      totalMs: data.durationMs,
      error: data.error,
    });
    setQuery(data.query ?? "");
    setSeeded(true);
    setRelated(isTerminal(status) ? (data.relatedQuestions ?? []) : []);
  }, []);

  useEffect(() => {
    if (!seeded || !job?.id || job.status !== "running") return;
    const t = setInterval(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/research/${job.id}`);
          if (!res.ok) return;
          const data = (await res.json()) as JobRecord;
          const status = (data.status as JobStatus | undefined) ?? "running";
          setJob((j) => {
            if (!j) return j;
            const next = { ...j, steps: milestonesToSteps(status, data.milestones) };
            if (isTerminal(status)) {
              next.status = status === "failed" ? "error" : status;
              next.report = data.report;
              next.citations = data.citations ?? j.citations;
              next.totalMs = data.durationMs;
              next.error = data.error;
            }
            return next;
          });
          if (isTerminal(status)) {
            void refreshPast();
            if (status === "done") loadRelated(job.query);
          }
        } catch {
          /* transient — keep polling */
        }
      })();
    }, 2500);
    return () => clearInterval(t);
  }, [seeded, job?.id, job?.status, job?.query, refreshPast, loadRelated]);

  const [searchParams] = useSearchParams();
  const linkedId = searchParams.get("id");
  useEffect(() => {
    if (linkedId) void loadJob(linkedId);
  }, [linkedId, loadJob]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setJob((j) => (j ? { ...j, status: "failed", error: "Cancelled." } : j));
  }, []);

  const toggleStep = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Applies one stream frame; returns an error message when the run failed. */
  const apply = (ev: StreamEvent, q: string): string | null => {
    if (ev.type === "step_start" || ev.type === "phase_start") {
      const step: ResearchStep = {
        id: ev.stepId ?? `${ev.phase}_${Date.now()}`,
        phase: ev.phase ?? "",
        label: ev.label ?? ev.phase ?? "",
        detail: ev.detail,
        status: "running",
        startedAt: Date.now(),
      };
      setJob((j) => (j ? { ...j, steps: [...j.steps, step] } : j));
    } else if (ev.type === "step_done" || ev.type === "phase_done") {
      setJob((j) =>
        j
          ? {
              ...j,
              steps: j.steps.map((s) =>
                s.id === ev.stepId || s.phase === ev.phase
                  ? { ...s, status: "done", completedAt: Date.now(), detail: ev.detail ?? s.detail }
                  : s,
              ),
              cycleCount: ev.cycleIndex != null ? ev.cycleIndex + 1 : j.cycleCount,
            }
          : j,
      );
    } else if (ev.type === "citation") {
      setJob((j) => (j ? { ...j, citations: [...j.citations, ev as Citation] } : j));
    } else if (ev.type === "report") {
      setJob((j) => (j ? { ...j, report: ev.content } : j));
    } else if (ev.type === "done") {
      setJob((j) => (j ? { ...j, status: "done", totalMs: ev.totalMs } : j));
      void refreshPast();
      loadRelated(q);
    } else if (ev.type === "error") {
      return ev.message ?? "Research failed.";
    }
    return null;
  };

  async function startResearch(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = query.trim();
    if (!q || job?.status === "running" || job?.status === "pending") return;

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setSeeded(false);
    setRelated([]);
    setJob({ id: "", query: q, status: "pending", steps: [], citations: [], cycleCount: 0 });

    try {
      const createRes = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
        signal: ctrl.signal,
      });
      if (!createRes.ok) {
        const err = (await createRes.json().catch(() => ({}))) as { message?: string };
        throw new Error(err.message ?? `Could not start (${createRes.status}).`);
      }
      const { id } = (await createRes.json()) as { id: string };
      setJob((j) => (j ? { ...j, id, status: "running" } : j));

      const streamRes = await fetch(`/api/research/${id}/stream`, { signal: ctrl.signal });
      if (!streamRes.ok || !streamRes.body) throw new Error("The research stream did not open.");

      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let ev: StreamEvent;
          try {
            ev = JSON.parse(line.slice(6)) as StreamEvent;
          } catch {
            continue;
          }
          const failed = apply(ev, q);
          if (failed) throw new Error(failed);
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setJob((j) => (j ? { ...j, status: "failed", error: (err as Error).message } : j));
      }
    }
  }

  const isActive = job?.status === "running" || job?.status === "pending";

  return (
    <Page width="wide">
      <PageHeader
        title="Deep research"
        description="Searches the web in cycles, reasons over what it finds and writes a cited report on your own model."
        actions={
          job &&
          (isActive ? (
            <>
              <Badge variant="outline" className="gap-1">
                <Loader2 className="size-3 animate-spin" />
                {job.cycleCount > 0 ? `Cycle ${job.cycleCount}` : "Starting"}
              </Badge>
              <Button size="sm" variant="outline" onClick={stop}>
                <X />
                Cancel
              </Button>
            </>
          ) : job.status === "done" ? (
            <Badge variant="outline" className="gap-1 border-success/30 text-success">
              <CheckCircle2 className="size-3" />
              {job.totalMs ? `Done in ${(job.totalMs / 1000).toFixed(0)}s` : "Done"}
            </Badge>
          ) : null)
        }
      />

      <form onSubmit={(e) => void startResearch(e)} className="flex gap-2">
        <Textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="What should be researched? Be specific, e.g. the effect of LLM coding agents on developer productivity since 2024."
          aria-label="Research question"
          disabled={isActive}
          className="max-h-32 min-h-16 flex-1 resize-none"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
              e.currentTarget.form?.requestSubmit();
          }}
        />
        <Button
          type="submit"
          disabled={isActive || !query.trim()}
          className="self-end"
          aria-label="Research"
        >
          {isActive ? <Loader2 className="animate-spin" /> : <Send />}
        </Button>
      </form>

      <div className="grid items-start gap-4 lg:grid-cols-[16rem_1fr]">
        <div className="order-last overflow-hidden rounded-xl border bg-card lg:order-first">
          <p className="border-b px-4 py-3 text-sm font-semibold">History</p>
          <div className="max-h-64 space-y-0.5 overflow-y-auto p-1.5 lg:max-h-[65vh]">
            {pastJobs.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No research yet.</p>
            ) : (
              pastJobs.map((j) => (
                <button
                  key={j.id}
                  onClick={() => void loadJob(j.id)}
                  className={cn(
                    "w-full rounded-md px-3 py-2 text-left transition-colors hover:bg-muted",
                    job?.id === j.id && "bg-primary/10",
                  )}
                >
                  <p className="truncate text-sm">{j.query}</p>
                  <p className={cn("text-xs", statusTone(j.status))}>{j.status}</p>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="min-w-0 space-y-4">
          {!job ? (
            <EmptyState
              icon={Search}
              title="Ask a research question"
              description="Each run plans the question, searches in cycles and writes a report that cites its sources."
            />
          ) : (
            <>
              {job.steps.length > 0 && (
                <div className="rounded-xl border bg-card p-3">
                  {job.steps.map((step) => {
                    const expanded = expandedSteps.has(step.id);
                    return (
                      <div key={step.id}>
                        <button
                          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-muted/50"
                          onClick={() => step.detail && toggleStep(step.id)}
                        >
                          {step.status === "running" ? (
                            <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
                          ) : step.status === "done" ? (
                            <CheckCircle2 className="size-3.5 shrink-0 text-success" />
                          ) : (
                            <AlertCircle className="size-3.5 shrink-0 text-destructive" />
                          )}
                          <span className="text-sm">{step.label}</span>
                          {step.completedAt && (
                            <span className="ml-auto font-mono text-xs text-muted-foreground">
                              {((step.completedAt - step.startedAt) / 1000).toFixed(1)}s
                            </span>
                          )}
                          {step.detail &&
                            (expanded ? (
                              <ChevronDown className="size-3.5 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="size-3.5 text-muted-foreground" />
                            ))}
                        </button>
                        {expanded && step.detail && (
                          <p className="py-1 pr-2 pl-8 text-sm text-muted-foreground">
                            {step.detail}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {job.report && (
                <div className="rounded-xl border bg-card">
                  <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
                    <p className="text-sm font-semibold">Report</p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void navigator.clipboard.writeText(job.report ?? "")}
                    >
                      <Copy />
                      Copy
                    </Button>
                  </div>
                  <div className="px-4 py-4 text-sm leading-relaxed">
                    <Markdown text={job.report} />
                  </div>
                </div>
              )}

              {job.citations.length > 0 && (
                <div className="rounded-xl border bg-card">
                  <p className="border-b px-4 py-3 text-sm font-semibold">
                    Sources ({job.citations.length})
                  </p>
                  <ol className="divide-y">
                    {job.citations.map((c, i) => (
                      <li key={c.id ?? i} className="flex gap-3 px-4 py-3 text-sm">
                        <span className="w-5 shrink-0 text-right font-mono text-xs text-muted-foreground">
                          {i + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <a
                            href={c.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium hover:underline"
                          >
                            {c.title || c.url}
                          </a>
                          <p className="truncate text-xs text-muted-foreground">{c.url}</p>
                          {c.excerpt && (
                            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                              {c.excerpt}
                            </p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {job.status === "done" && (relatedLoading || related.length > 0) && (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">Related questions</p>
                  {relatedLoading ? (
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {related.slice(0, 6).map((q) => (
                        <Button
                          key={q}
                          variant="outline"
                          size="sm"
                          className="h-auto rounded-full py-1.5 text-left whitespace-normal"
                          onClick={() => {
                            setQuery(q);
                            setRelated([]);
                          }}
                        >
                          {q}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {(job.status === "failed" || job.status === "error") && (
                <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/10 p-4">
                  <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <div>
                    <p className="text-sm font-medium text-destructive">Research failed</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {job.error ?? "Unknown error."}
                    </p>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Page>
  );
}
