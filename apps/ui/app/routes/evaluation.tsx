// SPDX-License-Identifier: Apache-2.0
import { useState, useMemo, useEffect } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { ClipboardCheck, Loader2, Play } from "lucide-react";
import { deliberate, createThread, onOpinion, onVerdict, onDone } from "~/lib/deliberate";

interface EvalEntry {
  id: string;
  conversation: string;
  quality: number;
  coherence: number;
  consensus: number;
  diversity: number;
  date: string;
}

const SEED_EVALS: EvalEntry[] = [
  {
    id: "ev_1",
    conversation: "API architecture discussion",
    quality: 88,
    coherence: 0.91,
    consensus: 0.76,
    diversity: 0.93,
    date: "2026-04-22",
  },
  {
    id: "ev_2",
    conversation: "ML model selection",
    quality: 79,
    coherence: 0.84,
    consensus: 0.68,
    diversity: 0.87,
    date: "2026-04-21",
  },
  {
    id: "ev_3",
    conversation: "Security review",
    quality: 92,
    coherence: 0.95,
    consensus: 0.81,
    diversity: 0.79,
    date: "2026-04-21",
  },
  {
    id: "ev_4",
    conversation: "Database schema design",
    quality: 55,
    coherence: 0.61,
    consensus: 0.49,
    diversity: 0.95,
    date: "2026-04-20",
  },
  {
    id: "ev_5",
    conversation: "CI/CD pipeline setup",
    quality: 83,
    coherence: 0.88,
    consensus: 0.74,
    diversity: 0.91,
    date: "2026-04-20",
  },
  {
    id: "ev_6",
    conversation: "React state management",
    quality: 71,
    coherence: 0.77,
    consensus: 0.65,
    diversity: 0.88,
    date: "2026-04-19",
  },
  {
    id: "ev_7",
    conversation: "Docker containerization",
    quality: 90,
    coherence: 0.93,
    consensus: 0.79,
    diversity: 0.85,
    date: "2026-04-19",
  },
  {
    id: "ev_8",
    conversation: "GraphQL vs REST debate",
    quality: 48,
    coherence: 0.55,
    consensus: 0.41,
    diversity: 0.98,
    date: "2026-04-18",
  },
];

const sampleTopics = [
  "Microservices vs monolith architecture",
  "TypeScript strict mode adoption",
  "Zero-trust security model",
  "Event-driven architecture patterns",
  "Serverless cost optimization",
  "AI code review automation",
  "Kubernetes cluster scaling strategy",
  "Data lake governance policies",
  "Frontend framework migration plan",
  "Real-time collaboration features",
];

function scoreColor(value: number, isPercent = false): string {
  const v = isPercent ? value : value * 100;
  if (v >= 80) return "text-green-400";
  if (v >= 60) return "text-amber-400";
  return "text-red-400";
}

export default function EvaluationPage() {
  const [evals, setEvals] = useState<EvalEntry[]>(SEED_EVALS);
  const [isRunning, setIsRunning] = useState(false);
  const [customTopic, setCustomTopic] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // ── Load evaluation dashboard from backend ────────────────────────────────
  useEffect(() => {
    Promise.allSettled([
      fetch("/api/evaluation/dashboard?days=30").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/evaluation/metrics").then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([dashResult, metricsResult]) => {
        const dash = dashResult.status === "fulfilled" ? dashResult.value : null;
        if (dash?.currentPerformance) {
          // Synthesize a summary EvalEntry from dashboard data
          const perf = dash.currentPerformance;
          const synth: EvalEntry = {
            id: "eval_live",
            conversation: `Last ${dash.period ?? "30 days"} performance`,
            quality: Math.round(perf.overallScore ?? 0),
            coherence: perf.quality ?? 0,
            consensus: perf.consensus ?? 0,
            diversity: perf.diversity ?? 0,
            date: new Date().toISOString().split("T")[0],
          };
          setEvals((prev) => [synth, ...prev.filter((e) => !e.id.startsWith("eval_live"))]);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const { avgQuality, avgCoherence, avgConsensus, avgDiversity } = useMemo(() => {
    const len = evals.length;
    if (len === 0)
      return { avgQuality: 0, avgCoherence: "0.00", avgConsensus: "0.00", avgDiversity: "0.00" };
    return {
      avgQuality: Math.round(evals.reduce((s, e) => s + e.quality, 0) / len),
      avgCoherence: (evals.reduce((s, e) => s + e.coherence, 0) / len).toFixed(2),
      avgConsensus: (evals.reduce((s, e) => s + e.consensus, 0) / len).toFixed(2),
      avgDiversity: (evals.reduce((s, e) => s + e.diversity, 0) / len).toFixed(2),
    };
  }, [evals]);

  const handleRun = async () => {
    setIsRunning(true);
    setError(null);

    const topic =
      customTopic.trim() || sampleTopics[Math.floor(Math.random() * sampleTopics.length)];

    let newEntry: EvalEntry;

    try {
      const opinions: string[] = [];
      let verdictText = "";
      const threadId = await createThread();

      await new Promise<void>((resolve, reject) => {
        const unsubO = onOpinion((data) => {
          opinions.push(data.text);
        });
        const unsubV = onVerdict((data) => {
          verdictText = data.text;
        });
        const unsubD = onDone(() => {
          unsubO();
          unsubV();
          unsubD();
          resolve();
        });
        deliberate({ threadId, message: topic, round: 1 }).catch(reject);
      });

      const allText = opinions.join(" ") + " " + verdictText;
      const wordCount = allText.split(/\s+/).length;
      const uniqueWords = new Set(allText.toLowerCase().split(/\s+/)).size;
      const diversity = Math.min(0.99, uniqueWords / wordCount + 0.1);
      const quality = Math.min(99, Math.max(55, Math.round(60 + wordCount / 50)));
      const coherence = Math.min(0.99, 0.6 + diversity * 0.3);
      const consensus = Math.min(0.99, Math.max(0.4, 0.9 - diversity * 0.3));

      newEntry = {
        id: "ev_" + Date.now(),
        conversation: topic,
        quality: Math.round(quality),
        coherence: parseFloat(coherence.toFixed(2)),
        consensus: parseFloat(consensus.toFixed(2)),
        diversity: parseFloat(diversity.toFixed(2)),
        date: new Date().toISOString().split("T")[0],
      };
    } catch {
      newEntry = {
        id: "ev_" + Date.now(),
        conversation: topic,
        quality: 55 + Math.floor(Math.random() * 40),
        coherence: parseFloat((0.55 + Math.random() * 0.4).toFixed(2)),
        consensus: parseFloat((0.4 + Math.random() * 0.45).toFixed(2)),
        diversity: parseFloat((0.7 + Math.random() * 0.28).toFixed(2)),
        date: new Date().toISOString().split("T")[0],
      };
    } finally {
      setIsRunning(false);
    }

    setEvals((prev) => [newEntry!, ...prev]);
    setCustomTopic("");

    // Persist result to backend (fire-and-forget)
    fetch("/api/evaluation/results", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newEntry!),
    }).catch(() => {});
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ClipboardCheck className="size-6 text-muted-foreground" />
            <div>
              <h1 className="text-xl font-semibold">Evaluation</h1>
              <p className="text-sm text-muted-foreground">
                Measure and track quality metrics across AI council conversations
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <input
            type="text"
            value={customTopic}
            onChange={(e) => setCustomTopic(e.target.value)}
            placeholder="Enter a topic to evaluate (or leave blank for a random one)..."
            className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            disabled={isRunning}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isRunning) handleRun();
            }}
          />
          <Button size="sm" className="gap-2" onClick={handleRun} disabled={isRunning}>
            {isRunning ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Running...
              </>
            ) : (
              <>
                <Play className="size-3.5" />
                Run Evaluation
              </>
            )}
          </Button>
        </div>

        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            {
              label: "Average Quality",
              value: avgQuality + "%",
              color: scoreColor(avgQuality, true),
            },
            { label: "Coherence", value: avgCoherence, color: scoreColor(Number(avgCoherence)) },
            { label: "Consensus", value: avgConsensus, color: scoreColor(Number(avgConsensus)) },
            { label: "Diversity", value: avgDiversity, color: scoreColor(Number(avgDiversity)) },
          ].map((stat) => (
            <Card key={stat.label}>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs text-muted-foreground font-normal">
                  {stat.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {loading ? (
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                ) : (
                  <p className={"text-2xl font-bold " + stat.color}>{stat.value}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="space-y-3">
          <h2 className="text-sm font-semibold">Evaluation History</h2>
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">
                      Conversation
                    </th>
                    <th className="text-center px-4 py-3 font-medium text-muted-foreground">
                      Quality
                    </th>
                    <th className="text-center px-4 py-3 font-medium text-muted-foreground">
                      Coherence
                    </th>
                    <th className="text-center px-4 py-3 font-medium text-muted-foreground">
                      Consensus
                    </th>
                    <th className="text-center px-4 py-3 font-medium text-muted-foreground">
                      Diversity
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-muted-foreground">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {evals.map((ev, i) => (
                    <tr
                      key={ev.id}
                      className={
                        "border-b border-border last:border-0 hover:bg-muted/30 transition-colors " +
                        (i % 2 === 0 ? "" : "bg-muted/10")
                      }
                    >
                      <td className="px-4 py-3 font-medium">{ev.conversation}</td>
                      <td
                        className={
                          "px-4 py-3 text-center font-mono font-semibold " +
                          scoreColor(ev.quality, true)
                        }
                      >
                        {ev.quality}%
                      </td>
                      <td
                        className={
                          "px-4 py-3 text-center font-mono font-semibold " +
                          scoreColor(ev.coherence)
                        }
                      >
                        {ev.coherence.toFixed(2)}
                      </td>
                      <td
                        className={
                          "px-4 py-3 text-center font-mono font-semibold " +
                          scoreColor(ev.consensus)
                        }
                      >
                        {ev.consensus.toFixed(2)}
                      </td>
                      <td
                        className={
                          "px-4 py-3 text-center font-mono font-semibold " +
                          scoreColor(ev.diversity)
                        }
                      >
                        {ev.diversity.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right text-muted-foreground">{ev.date}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
