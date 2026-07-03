// SPDX-License-Identifier: Apache-2.0
/**
 * Deep Research — multi-step agentic research UI
 *
 * POST /api/research → job created
 * GET  /api/research/:id/stream → SSE stream of research phases
 *
 * Phases: clarification → planning → researching (cycles) → generating_report → complete
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Badge } from "~/components/ui/badge";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Search,
  Send,
  Loader2,
  X,
  CheckCircle2,
  AlertCircle,
  FileText,
  ChevronDown,
  ChevronRight,
  BookOpen,
  BarChart3,
} from "lucide-react";
import { CitationRenderer } from "~/components/CitationRenderer";
import { CitationsSidebar } from "~/components/CitationsSidebar";
import { RelatedQuestions } from "~/components/RelatedQuestions";
import type { Citation as CardCitation } from "~/components/CitationCard";

// ── Types ─────────────────────────────────────────────────────────────────────

type JobStatus = "idle" | "pending" | "running" | "done" | "failed";

type ResearchPhase =
  | "clarification"
  | "planning"
  | "researching"
  | "thinking"
  | "generating_report"
  | "complete"
  | "failed"
  | "timed_out";

interface ResearchStep {
  id: string;
  phase: ResearchPhase;
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

// ── Phase colors ──────────────────────────────────────────────────────────────

const PHASE_COLORS: Partial<Record<ResearchPhase, string>> = {
  clarification: "text-blue-400",
  planning: "text-purple-400",
  researching: "text-yellow-400",
  thinking: "text-cyan-400",
  generating_report: "text-orange-400",
  complete: "text-green-400",
  failed: "text-destructive",
};

// ── Past jobs list hook ────────────────────────────────────────────────────────

function usePastJobs() {
  const [jobs, setJobs] = useState<
    Array<{ id: string; query: string; status: string; createdAt: string }>
  >([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/research");
      if (res.ok) {
        const data = await res.json();
        setJobs(data.jobs ?? []);
      }
    } catch {
      /* ignore */
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { jobs, loading, refresh };
}

// ── Normalize Citation for CitationCard ────────────────────────────────────────

function normalizeCitations(citations: Citation[]): CardCitation[] {
  return citations.map((c, i) => {
    let domain = "";
    try {
      domain = new URL(c.url).hostname.replace("www.", "");
    } catch {}
    return {
      id: i + 1,
      url: c.url,
      title: c.title,
      domain,
      snippet: c.excerpt,
      confidence_score: 0.75 - i * 0.02, // decay slightly per source
    };
  });
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function DeepResearchPage() {
  const [query, setQuery] = useState("");
  const [job, setJob] = useState<ResearchJob | null>(null);
  const [expandedSteps, setExpanded] = useState<Set<string>>(new Set());
  const [expandCitations, setExpandCitations] = useState(false);
  const [showCitationsSidebar, setShowCitationsSidebar] = useState(false);
  const [relatedQuestions, setRelatedQuestions] = useState<string[]>([]);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const { jobs: pastJobs, refresh: refreshPast } = usePastJobs();

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setJob((j) => (j ? { ...j, status: "failed", error: "Cancelled by user" } : j));
  }, []);

  const toggleStep = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function startResearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim() || job?.status === "running" || job?.status === "pending") return;

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Create job
    const newJob: ResearchJob = {
      id: "",
      query: query.trim(),
      status: "pending",
      steps: [],
      citations: [],
      cycleCount: 0,
    };
    setJob(newJob);

    try {
      // POST to create
      const createRes = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim() }),
        signal: ctrl.signal,
      });

      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({}));
        throw new Error((err as any).message ?? `Failed to start (${createRes.status})`);
      }

      const { id } = await createRes.json();
      setJob((j) => (j ? { ...j, id, status: "running" } : j));

      // Stream updates
      const streamRes = await fetch(`/api/research/${id}/stream`, { signal: ctrl.signal });
      if (!streamRes.ok || !streamRes.body) throw new Error("Stream failed");

      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(line.slice(6));

            if (ev.type === "step_start" || ev.type === "phase_start") {
              const step: ResearchStep = {
                id: ev.stepId ?? `${ev.phase}_${Date.now()}`,
                phase: ev.phase as ResearchPhase,
                label: ev.label ?? ev.phase,
                detail: ev.detail,
                status: "running",
                startedAt: Date.now(),
              };
              setJob((j) => (j ? { ...j, steps: [...j.steps, step] } : j));
            } else if (ev.type === "step_done" || ev.type === "phase_done") {
              setJob((j) => {
                if (!j) return j;
                return {
                  ...j,
                  steps: j.steps.map((s) =>
                    s.id === ev.stepId || s.phase === ev.phase
                      ? {
                          ...s,
                          status: "done",
                          completedAt: Date.now(),
                          detail: ev.detail ?? s.detail,
                        }
                      : s,
                  ),
                  cycleCount: ev.cycleIndex != null ? ev.cycleIndex + 1 : j.cycleCount,
                };
              });
            } else if (ev.type === "citation") {
              setJob((j) => (j ? { ...j, citations: [...j.citations, ev as Citation] } : j));
            } else if (ev.type === "report") {
              setJob((j) => (j ? { ...j, report: ev.content } : j));
            } else if (ev.type === "done") {
              setJob((j) =>
                j
                  ? {
                      ...j,
                      status: "done",
                      totalMs: ev.totalMs,
                    }
                  : j,
              );
              refreshPast();
              // Fetch related questions after report is complete (non-blocking)
              if (job?.query) {
                setRelatedLoading(true);
                fetch("/api/research/related-questions", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ query: job.query, report_summary: "" }),
                })
                  .then((r) => (r.ok ? r.json() : { questions: [] }))
                  .then((d) => {
                    setRelatedQuestions(d.questions ?? []);
                    setRelatedLoading(false);
                  })
                  .catch(() => setRelatedLoading(false));
              }
            } else if (ev.type === "error") {
              throw new Error(ev.message ?? "Research failed");
            }
          } catch {
            /* skip malformed */
          }
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
    <div className="flex h-screen overflow-hidden">
      {/* Left sidebar — past jobs */}
      <aside
        className="w-64 shrink-0 flex flex-col border-r border-border"
        style={{ background: "hsl(var(--card))" }}
      >
        <div className="border-b border-border px-4 py-4 flex items-center gap-2">
          <BookOpen className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Research History</h2>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            {pastJobs.length === 0 ? (
              <p className="text-xs text-muted-foreground px-2 py-3 text-center">
                No past research
              </p>
            ) : (
              pastJobs.map((j) => (
                <button
                  key={j.id}
                  onClick={async () => {
                    const res = await fetch(`/api/research/${j.id}`);
                    if (res.ok) {
                      const data = await res.json();
                      setJob({
                        id: j.id,
                        query: j.query,
                        status: j.status as JobStatus,
                        steps: [],
                        citations: data.citations ?? [],
                        cycleCount: data.cycles ?? 0,
                        report: data.report,
                        totalMs: data.durationMs,
                      });
                      setQuery(j.query);
                    }
                  }}
                  className="w-full text-left px-2.5 py-2 rounded-md text-xs hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    <span
                      className={`text-[10px] ${j.status === "done" ? "text-green-400" : j.status === "failed" ? "text-destructive" : "text-yellow-400"}`}
                    >
                      ● {j.status}
                    </span>
                  </div>
                  <p className="text-foreground/80 truncate">{j.query}</p>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </aside>

      {/* Main area + Citations sidebar */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Header */}
          <header className="border-b border-border px-6 py-4 flex items-center gap-3 shrink-0">
            <Search className="size-5 text-primary" />
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Deep Research</h1>
              <p className="text-xs text-muted-foreground">
                Multi-step agentic research with citations
              </p>
            </div>
            {job && (
              <div className="ml-auto flex items-center gap-2">
                {isActive && (
                  <>
                    <Badge variant="outline" className="text-xs gap-1">
                      <Loader2 className="size-2.5 animate-spin" />
                      {job.cycleCount > 0 ? `Cycle ${job.cycleCount}` : "Starting…"}
                    </Badge>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs gap-1.5"
                      onClick={stop}
                    >
                      <X className="size-3" /> Cancel
                    </Button>
                  </>
                )}
                <button
                  onClick={() => setShowCitationsSidebar((v) => !v)}
                  className={`text-xs px-2 py-1 rounded border transition-colors ${showCitationsSidebar ? "bg-primary/10 border-primary/40 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
                >
                  Sources {job.citations.length > 0 ? `(${job.citations.length})` : ""}
                </button>
                {job.status === "done" && (
                  <Badge
                    variant="outline"
                    className="text-xs gap-1 text-green-400 border-green-400/30"
                  >
                    <CheckCircle2 className="size-2.5" />
                    {job.totalMs ? `${(job.totalMs / 1000).toFixed(0)}s` : "Done"}
                  </Badge>
                )}
              </div>
            )}
          </header>

          {/* Query input */}
          <form
            onSubmit={startResearch}
            className="border-b border-border px-6 py-3 flex gap-2 shrink-0"
          >
            <Textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="What do you want to research? Be specific — e.g. 'Impact of LLM agents on software development productivity in 2024–2025'"
              disabled={isActive}
              className="flex-1 min-h-[60px] max-h-[120px] text-sm resize-none"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  (e.target as HTMLFormElement).form?.requestSubmit();
                }
              }}
            />
            <Button
              type="submit"
              disabled={isActive || !query.trim()}
              className="self-end gap-1.5 text-sm"
            >
              {isActive ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            </Button>
          </form>

          <ScrollArea className="flex-1">
            {job ? (
              <div className="p-6 space-y-6">
                {/* Phase progress */}
                {job.steps.length > 0 && (
                  <div className="space-y-1">
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                      Research phases
                    </h3>
                    {job.steps.map((step) => {
                      const phaseColor = PHASE_COLORS[step.phase] ?? "text-foreground";
                      const expanded = expandedSteps.has(step.id);
                      return (
                        <div key={step.id}>
                          <button
                            className="w-full flex items-center gap-2.5 py-1.5 px-2 rounded-md text-left hover:bg-muted/30 transition-colors"
                            onClick={() => step.detail && toggleStep(step.id)}
                          >
                            <span className={phaseColor}>
                              {step.status === "running" ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : step.status === "done" ? (
                                <CheckCircle2 className="size-3.5 text-green-400" />
                              ) : (
                                <AlertCircle className="size-3.5 text-destructive" />
                              )}
                            </span>
                            <span className={`text-xs font-medium ${phaseColor}`}>
                              {step.label}
                            </span>
                            {step.completedAt && step.startedAt && (
                              <span className="ml-auto text-[10px] text-muted-foreground font-mono">
                                {((step.completedAt - step.startedAt) / 1000).toFixed(1)}s
                              </span>
                            )}
                            {step.detail &&
                              (expanded ? (
                                <ChevronDown className="size-3 text-muted-foreground ml-1" />
                              ) : (
                                <ChevronRight className="size-3 text-muted-foreground ml-1" />
                              ))}
                          </button>
                          {expanded && step.detail && (
                            <p className="ml-8 text-xs text-muted-foreground py-1 pr-2">
                              {step.detail}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Citations summary */}
                {job.citations.length > 0 && (
                  <div>
                    <button
                      className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 hover:text-foreground transition-colors"
                      onClick={() => setExpandCitations((v) => !v)}
                    >
                      <BarChart3 className="size-3.5" />
                      Citations ({job.citations.length})
                      {expandCitations ? (
                        <ChevronDown className="size-3" />
                      ) : (
                        <ChevronRight className="size-3" />
                      )}
                    </button>
                    {expandCitations && (
                      <div className="space-y-2">
                        {job.citations.map((c) => (
                          <div
                            key={c.id}
                            className="rounded-lg p-3 text-xs"
                            style={{
                              background: "hsl(var(--muted)/0.3)",
                              border: "1px solid hsl(var(--border)/0.4)",
                            }}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <span className="font-medium">{c.title}</span>
                              <Badge variant="outline" className="text-[10px] shrink-0">
                                Cycle {c.cycleIndex + 1}
                              </Badge>
                            </div>
                            {c.url && (
                              <a
                                href={c.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary hover:underline truncate block mt-1"
                              >
                                {c.url}
                              </a>
                            )}
                            {c.excerpt && (
                              <p className="text-muted-foreground mt-1 line-clamp-2">{c.excerpt}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Final report */}
                {job.report && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold flex items-center gap-2">
                        <FileText className="size-4 text-primary" />
                        Research Report
                      </h3>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1.5"
                        onClick={() => navigator.clipboard.writeText(job.report ?? "")}
                      >
                        Copy
                      </Button>
                    </div>
                    <div
                      className="rounded-xl p-5 text-sm leading-relaxed"
                      style={{
                        background: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                      }}
                    >
                      <CitationRenderer
                        content={job.report}
                        citations={normalizeCitations(job.citations)}
                      />
                    </div>
                    {job.status === "done" && (
                      <RelatedQuestions
                        questions={relatedQuestions}
                        isLoading={relatedLoading}
                        onSelect={(q) => {
                          setQuery(q);
                          setRelatedQuestions([]);
                        }}
                      />
                    )}
                  </div>
                )}

                {/* Error state */}
                {job.status === "failed" && (
                  <div
                    className="rounded-lg p-4 flex items-start gap-3"
                    style={{
                      background: "hsl(var(--destructive)/0.1)",
                      border: "1px solid hsl(var(--destructive)/0.3)",
                    }}
                  >
                    <AlertCircle className="size-4 text-destructive mt-0.5 shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-destructive">Research failed</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {job.error ?? "Unknown error"}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-10">
                <Search className="size-12 text-primary/20" />
                <div>
                  <p className="text-sm font-medium">Deep Research</p>
                  <p className="text-xs text-muted-foreground mt-2 max-w-sm">
                    Multi-step agentic research with web search, reasoning cycles, and cited
                    synthesis. Enter a research question above.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 justify-center text-xs text-muted-foreground">
                  {["Clarification", "Planning", "Research cycles", "Synthesis", "Citations"].map(
                    (s) => (
                      <Badge key={s} variant="outline" className="text-xs">
                        {s}
                      </Badge>
                    ),
                  )}
                </div>
              </div>
            )}
          </ScrollArea>
        </div>
      </div>
      {showCitationsSidebar && (
        <CitationsSidebar
          citations={normalizeCitations(job?.citations ?? [])}
          isOpen={showCitationsSidebar}
          onClose={() => setShowCitationsSidebar(false)}
        />
      )}
    </div>
  );
}
