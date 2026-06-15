// SPDX-License-Identifier: Apache-2.0
/**
 * Research page — submit research queries to the @nexus/researcher agent.
 * Polls job status and renders a structured report with citations.
 */
import { useCallback, useRef, useState } from "react";

import { api } from "../lib/api.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ResearchJob {
  jobId:   string;
  status:  "queued" | "running" | "done" | "error";
  query:   string;
  report?: string;
  sources?: Array<{ url: string; title: string; snippet?: string }>;
  error?:  string;
  startedAt: number;
  elapsed?: number;
}

// ── Status pill ───────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: ResearchJob["status"] }) {
  const map: Record<string, { color: string; bg: string; label: string }> = {
    queued:  { color: "#d97706", bg: "rgba(217,119,6,0.12)",  label: "Queued"  },
    running: { color: "#2563eb", bg: "rgba(37,99,235,0.12)",  label: "Running" },
    done:    { color: "#16a34a", bg: "rgba(22,163,74,0.12)",  label: "Done"    },
    error:   { color: "#dc2626", bg: "rgba(220,38,38,0.12)",  label: "Error"   },
  };
  const { color, bg, label } = map[status] ?? map.queued!;
  return (
    <span
      style={{
        display:      "inline-flex",
        alignItems:   "center",
        gap:          5,
        fontSize:     11,
        fontWeight:   700,
        letterSpacing:"0.06em",
        textTransform:"uppercase",
        color,
        background:   bg,
        border:       `1px solid ${color}33`,
        borderRadius: 6,
        padding:      "2px 8px",
      }}
    >
      <span
        style={{
          width:        6,
          height:       6,
          borderRadius: "50%",
          background:   color,
          animation:    status === "running" ? "pulse 1.2s ease-in-out infinite" : undefined,
        }}
      />
      {label}
    </span>
  );
}

// ── Source card ───────────────────────────────────────────────────────────────

function SourceCard({ source, idx }: { source: NonNullable<ResearchJob["sources"]>[number]; idx: number }) {
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display:      "block",
        background:   "#161b27",
        border:       "1px solid #1e2535",
        borderRadius: 8,
        padding:      "12px 14px",
        textDecoration:"none",
        transition:   "border-color 0.15s",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <span
          style={{
            width:          20,
            height:         20,
            borderRadius:   "50%",
            background:     "rgba(124,58,237,0.15)",
            border:         "1px solid #5b21b6",
            color:          "#c4b5fd",
            fontSize:       10,
            fontWeight:     700,
            display:        "flex",
            alignItems:     "center",
            justifyContent: "center",
            flexShrink:     0,
            marginTop:      1,
          }}
        >
          {idx + 1}
        </span>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize:     13,
              fontWeight:   600,
              color:        "#c4b5fd",
              marginBottom: 3,
              overflow:     "hidden",
              textOverflow: "ellipsis",
              whiteSpace:   "nowrap",
            }}
          >
            {source.title || source.url}
          </div>
          {source.snippet && (
            <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.5 }}>
              {source.snippet.slice(0, 180)}{source.snippet.length > 180 ? "…" : ""}
            </div>
          )}
          <div
            style={{
              fontSize:  11,
              color:     "#334155",
              marginTop: 4,
              overflow:  "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {source.url}
          </div>
        </div>
      </div>
    </a>
  );
}

// ── Job card ──────────────────────────────────────────────────────────────────

function JobCard({ job }: { job: ResearchJob }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div
      style={{
        background:   "#161b27",
        border:       "1px solid #1e2535",
        borderRadius: 10,
        overflow:     "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          display:        "flex",
          alignItems:     "center",
          justifyContent: "space-between",
          padding:        "14px 18px",
          cursor:         "pointer",
          borderBottom:   expanded ? "1px solid #1e2535" : undefined,
        }}
        onClick={() => setExpanded((v) => !v)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <StatusPill status={job.status} />
          <span
            style={{
              fontSize:     14,
              fontWeight:   600,
              color:        "#e2e8f0",
              overflow:     "hidden",
              textOverflow: "ellipsis",
              whiteSpace:   "nowrap",
            }}
          >
            {job.query}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          {job.elapsed !== undefined && (
            <span style={{ fontSize: 11, color: "#334155" }}>
              {(job.elapsed / 1000).toFixed(1)}s
            </span>
          )}
          <span style={{ color: "#475569", fontSize: 12 }}>{expanded ? "▲" : "▼"}</span>
        </div>
      </div>

      {/* Body */}
      {expanded && (
        <div style={{ padding: "18px" }}>
          {job.status === "error" && (
            <div
              style={{
                background:   "#1c0a0a",
                border:       "1px solid #7f1d1d",
                borderRadius: 8,
                padding:      "12px 14px",
                color:        "#f87171",
                fontSize:     13,
              }}
            >
              ⚠ {job.error ?? "Research failed"}
            </div>
          )}

          {(job.status === "queued" || job.status === "running") && (
            <div style={{ color: "#64748b", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: "#7c3aed" }}>●●●</span>
              Researching…
            </div>
          )}

          {job.report && (
            <>
              <div
                style={{
                  fontSize:   14,
                  color:      "#e2e8f0",
                  lineHeight: 1.75,
                  whiteSpace: "pre-wrap",
                  marginBottom: job.sources?.length ? 20 : 0,
                }}
              >
                {job.report}
              </div>

              {job.sources && job.sources.length > 0 && (
                <>
                  <div
                    style={{
                      fontSize:     11,
                      fontWeight:   700,
                      letterSpacing:"0.08em",
                      textTransform:"uppercase",
                      color:        "#475569",
                      marginBottom: 10,
                    }}
                  >
                    Sources ({job.sources.length})
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {job.sources.map((src, i) => (
                      <SourceCard key={src.url + i} source={src} idx={i} />
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Research() {
  const [query, setQuery]   = useState("");
  const [jobs, setJobs]     = useState<ResearchJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const pollRefs            = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  const pollJob = useCallback((jobId: string, startedAt: number) => {
    const interval = setInterval(async () => {
      try {
        const res = await api.get<{
          jobId: string;
          status: ResearchJob["status"];
          report?: string;
          sources?: ResearchJob["sources"];
          error?: string;
        }>(`/researcher/jobs/${jobId}`);

        const elapsed = Date.now() - startedAt;

        setJobs((prev) =>
          prev.map((j) =>
            j.jobId === jobId
              ? { ...j, ...res, elapsed }
              : j,
          ),
        );

        if (res.status === "done" || res.status === "error") {
          clearInterval(interval);
          pollRefs.current.delete(jobId);
        }
      } catch {
        clearInterval(interval);
        pollRefs.current.delete(jobId);
        setJobs((prev) =>
          prev.map((j) =>
            j.jobId === jobId
              ? { ...j, status: "error", error: "Status check failed" }
              : j,
          ),
        );
      }
    }, 2000);

    pollRefs.current.set(jobId, interval);
  }, []);

  const submit = useCallback(async () => {
    const q = query.trim();
    if (!q || loading) return;

    setLoading(true);
    setError(null);

    try {
      const res = await api.post<{ jobId: string }>("/researcher/jobs", { query: q });
      const startedAt = Date.now();

      const job: ResearchJob = {
        jobId:     res.jobId,
        status:    "queued",
        query:     q,
        startedAt,
      };
      setJobs((prev) => [job, ...prev]);
      setQuery("");
      pollJob(res.jobId, startedAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start research");
    } finally {
      setLoading(false);
    }
  }, [query, loading, pollJob]);

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 6 }}>🔬 Research</h1>
        <p style={{ color: "#64748b", fontSize: 14 }}>
          Deep-search the web and synthesise a structured report with citations.
        </p>
      </div>

      {/* Query input */}
      <div
        style={{
          background:   "#161b27",
          border:       "1px solid #1e2535",
          borderRadius: 12,
          padding:      "18px 20px",
          marginBottom: 24,
        }}
      >
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder="What do you want to research? (Enter to submit)"
            rows={3}
            style={{
              flex:       1,
              background: "#0f1117",
              border:     "1px solid #1e2535",
              borderRadius: 8,
              color:      "#e2e8f0",
              fontSize:   14,
              padding:    "10px 14px",
              resize:     "vertical",
              lineHeight: 1.5,
              fontFamily: "inherit",
              outline:    "none",
              minHeight:  72,
            }}
            disabled={loading}
          />
          <button
            onClick={() => void submit()}
            disabled={loading || !query.trim()}
            style={{
              background:  loading || !query.trim() ? "#1e2535" : "#7c3aed",
              border:      "none",
              borderRadius: 10,
              color:       loading || !query.trim() ? "#475569" : "#fff",
              cursor:      loading || !query.trim() ? "not-allowed" : "pointer",
              fontSize:    14,
              fontWeight:  600,
              padding:     "12px 20px",
              height:      72,
              transition:  "background 0.15s",
              flexShrink:  0,
            }}
          >
            {loading ? "Submitting…" : "Research"}
          </button>
        </div>
        {error && (
          <div style={{ marginTop: 12, color: "#f87171", fontSize: 13 }}>⚠ {error}</div>
        )}
      </div>

      {/* Jobs */}
      {jobs.length === 0 ? (
        <div
          style={{
            textAlign:  "center",
            color:      "#334155",
            padding:    "60px 0",
            fontSize:   14,
          }}
        >
          <div style={{ fontSize: 40, marginBottom: 12 }}>🔬</div>
          No research jobs yet. Submit a query above to start.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {jobs.map((job) => (
            <JobCard key={job.jobId} job={job} />
          ))}
        </div>
      )}
    </div>
  );
}
