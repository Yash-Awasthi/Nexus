/**
 * ULTRAPLINIAN — Ultra-parallel multi-model query with composite scoring
 *
 * Fires 10 | 24 | 36 | 45 | 51 models simultaneously,
 * scores each by quality + latency + token efficiency, crowns a winner.
 */

import { useState, useRef, useCallback } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Zap,
  Send,
  Loader2,
  Trophy,
  AlertTriangle,
  ChevronDown,
  BarChart3,
  Clock,
  Layers,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────

type Tier = 10 | 24 | 36 | 45 | 51;

interface SlotInfo {
  id: string;
  label: string;
  model: string;
  provider: string;
}

interface ModelResponse {
  id: string;
  label: string;
  model: string;
  text: string;
  latencyMs: number;
  tokens: number;
  compositeScore: number;
  latencyScore: number;
  qualityScore: number;
  tokenScore: number;
  status: "pending" | "done" | "error";
  error?: string;
}

interface DoneEvent {
  tier: number;
  totalMs: number;
  winnerId: string;
  winnerLabel: string;
  winnerScore: number;
  responseCount: number;
  successCount: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const TIERS: Tier[] = [10, 24, 36, 45, 51];

const TIER_LABELS: Record<Tier, string> = {
  10: "10 models",
  24: "24 models",
  36: "36 models",
  45: "45 models",
  51: "51 models",
};

const TIER_COLORS: Record<Tier, string> = {
  10: "text-blue-400 border-blue-400/40 bg-blue-400/10",
  24: "text-purple-400 border-purple-400/40 bg-purple-400/10",
  36: "text-orange-400 border-orange-400/40 bg-orange-400/10",
  45: "text-red-400 border-red-400/40 bg-red-400/10",
  51: "text-yellow-400 border-yellow-400/40 bg-yellow-400/10",
};

const PROVIDER_COLORS: Record<string, string> = {
  openai: "text-emerald-400",
  anthropic: "text-orange-300",
  google: "text-blue-400",
  groq: "text-purple-400",
  mistral: "text-pink-400",
  openrouter: "text-cyan-400",
  cerebras: "text-yellow-300",
  ollama: "text-gray-400",
};

// ── Score bar ──────────────────────────────────────────────────────────────

function ScoreBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <div className="flex-1 h-1.5 bg-muted/60 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${Math.round(value * 100)}%` }}
        />
      </div>
      <span className="text-[9px] text-muted-foreground tabular-nums w-6 text-right shrink-0">
        {Math.round(value * 100)}
      </span>
    </div>
  );
}

// ── Response card ─────────────────────────────────────────────────────────

function ResponseCard({
  resp,
  isWinner,
  rank,
}: {
  resp: ModelResponse;
  isWinner: boolean;
  rank: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const providerColor = PROVIDER_COLORS[resp.id.split("-")[0]] ?? "text-muted-foreground";

  return (
    <article
      className={`border rounded-lg p-3 transition-all duration-300 ${
        isWinner
          ? "border-yellow-500/60 bg-yellow-500/5 ring-1 ring-yellow-500/20"
          : resp.status === "error"
          ? "border-destructive/40 bg-destructive/5"
          : resp.status === "pending"
          ? "border-border/50 bg-muted/10 animate-pulse"
          : "border-border/50 bg-muted/5 hover:border-border"
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-[10px] text-muted-foreground/60 tabular-nums w-4 shrink-0">
          #{rank}
        </span>
        {isWinner && <Trophy className="size-3 text-yellow-400 shrink-0" />}
        <span className={`text-xs font-semibold truncate flex-1 ${isWinner ? "text-yellow-300" : ""}`}>
          {resp.label}
        </span>
        {resp.status === "pending" && (
          <Loader2 className="size-3 animate-spin text-muted-foreground shrink-0" />
        )}
        {resp.status === "error" && (
          <AlertTriangle className="size-3 text-destructive shrink-0" />
        )}
        {resp.status === "done" && (
          <Badge
            variant="outline"
            className={`text-[9px] h-4 px-1 shrink-0 tabular-nums ${
              isWinner ? "border-yellow-500/40 text-yellow-400" : ""
            }`}
          >
            {Math.round(resp.compositeScore * 100)}
          </Badge>
        )}
      </div>

      {/* Score bars */}
      {resp.status === "done" && (
        <div className="space-y-1 mb-2">
          <ScoreBar value={resp.compositeScore} color="bg-yellow-400" />
          <div className="grid grid-cols-3 gap-1">
            <div>
              <p className="text-[9px] text-muted-foreground/60 mb-0.5">quality</p>
              <ScoreBar value={resp.qualityScore} color="bg-blue-400" />
            </div>
            <div>
              <p className="text-[9px] text-muted-foreground/60 mb-0.5">latency</p>
              <ScoreBar value={resp.latencyScore} color="bg-green-400" />
            </div>
            <div>
              <p className="text-[9px] text-muted-foreground/60 mb-0.5">tokens</p>
              <ScoreBar value={resp.tokenScore} color="bg-purple-400" />
            </div>
          </div>
        </div>
      )}

      {/* Meta */}
      {resp.status === "done" && (
        <div className="flex items-center gap-2 text-[9px] text-muted-foreground/60 mb-1.5">
          <span className="flex items-center gap-0.5">
            <Clock className="size-2.5" />
            {(resp.latencyMs / 1000).toFixed(1)}s
          </span>
          <span className="flex items-center gap-0.5">
            <Layers className="size-2.5" />
            {resp.tokens}t
          </span>
        </div>
      )}

      {/* Response text */}
      {resp.status === "done" && resp.text && (
        <div>
          <p
            className={`text-[11px] text-foreground/80 leading-relaxed ${
              expanded ? "" : "line-clamp-4"
            }`}
          >
            {resp.text}
          </p>
          {resp.text.length > 200 && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-[9px] text-muted-foreground hover:text-foreground mt-1 flex items-center gap-0.5"
            >
              <ChevronDown className={`size-2.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
              {expanded ? "collapse" : "expand"}
            </button>
          )}
        </div>
      )}

      {resp.status === "error" && (
        <p className="text-[10px] text-destructive">{resp.error || "Request failed"}</p>
      )}
    </article>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function UltraplinianPage() {
  const [question, setQuestion] = useState("");
  const [tier, setTier] = useState<Tier>(10);
  const [showTierPicker, setShowTierPicker] = useState(false);
  const [responses, setResponses] = useState<ModelResponse[]>([]);
  const [done, setDone] = useState<DoneEvent | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const totalSlots = responses.length;
  const doneCount = responses.filter((r) => r.status === "done").length;
  const errorCount = responses.filter((r) => r.status === "error").length;
  const pendingCount = responses.filter((r) => r.status === "pending").length;

  const handleStop = () => {
    abortRef.current?.abort();
    setIsRunning(false);
  };

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!question.trim() || isRunning) return;

      abortRef.current = new AbortController();
      setIsRunning(true);
      setDone(null);
      setResponses([]);

      try {
        const res = await fetch("/api/gauntlet/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: question.trim(), tier }),
          signal: abortRef.current.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`Server error ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        while (true) {
          const { done: streamDone, value } = await reader.read();
          if (streamDone) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const ev = JSON.parse(line.slice(6));
              const type: string = ev.type;

              if (type === "init") {
                // Seed pending placeholders
                const slots: SlotInfo[] = ev.slots ?? [];
                setResponses(
                  slots.map((s) => ({
                    id: s.id,
                    label: s.label,
                    model: s.model,
                    text: "",
                    latencyMs: 0,
                    tokens: 0,
                    compositeScore: 0,
                    latencyScore: 0,
                    qualityScore: 0,
                    tokenScore: 0,
                    status: "pending",
                  }))
                );
              } else if (type === "response") {
                setResponses((prev) => {
                  const exists = prev.find((r) => r.id === ev.id);
                  const updated: ModelResponse = {
                    id: ev.id,
                    label: ev.label,
                    model: ev.model,
                    text: ev.text ?? "",
                    latencyMs: ev.latencyMs ?? 0,
                    tokens: ev.tokens ?? 0,
                    compositeScore: ev.compositeScore ?? 0,
                    latencyScore: ev.latencyScore ?? 0,
                    qualityScore: ev.qualityScore ?? 0,
                    tokenScore: ev.tokenScore ?? 0,
                    status: ev.status === "error" ? "error" : "done",
                    error: ev.error,
                  };
                  if (exists) {
                    return prev
                      .map((r) => (r.id === ev.id ? updated : r))
                      .sort((a, b) => b.compositeScore - a.compositeScore);
                  }
                  return [...prev, updated].sort(
                    (a, b) => b.compositeScore - a.compositeScore
                  );
                });
              } else if (type === "done") {
                setDone(ev as DoneEvent);
                setIsRunning(false);
              } else if (type === "error") {
                console.error("[ULTRAPLINIAN]", ev.message);
                setIsRunning(false);
              }
            } catch {
              // malformed event
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.error("[ULTRAPLINIAN]", err);
        }
      } finally {
        setIsRunning(false);
      }
    },
    [question, tier, isRunning]
  );

  const sortedResponses = [...responses].sort(
    (a, b) => b.compositeScore - a.compositeScore
  );
  const winnerId = done?.winnerId ?? sortedResponses[0]?.id;

  // Responsive grid columns based on tier
  const cols = tier <= 10 ? 2 : tier <= 24 ? 3 : tier <= 36 ? 4 : 5;

  return (
    <main className="flex flex-col h-screen overflow-hidden bg-background" aria-label="ULTRAPLINIAN">
      {/* Header */}
      <header className="border-b border-border px-6 py-3.5 flex items-center gap-3 shrink-0">
        <Zap className="size-5 text-yellow-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-bold tracking-tight">
            ULTRAPLINIAN
          </h1>
          <p className="text-[11px] text-muted-foreground">
            Fire every model in parallel. Score by quality + latency + tokens. Crown the winner.
          </p>
        </div>

        {/* Tier picker */}
        <div className="relative shrink-0">
          <button
            onClick={() => setShowTierPicker((v) => !v)}
            disabled={isRunning}
            className={`flex items-center gap-1.5 h-8 px-3 rounded-md border text-xs font-semibold transition-colors ${TIER_COLORS[tier]} hover:opacity-80`}
          >
            <BarChart3 className="size-3.5" />
            {TIER_LABELS[tier]}
            <ChevronDown className="size-3" />
          </button>
          {showTierPicker && (
            <div className="absolute right-0 top-full mt-1 bg-popover border border-border rounded-md shadow-xl z-50 min-w-36 py-1">
              {TIERS.map((t) => (
                <button
                  key={t}
                  onClick={() => { setTier(t); setShowTierPicker(false); }}
                  className={`w-full text-left px-3 py-2 text-xs font-semibold hover:bg-muted transition-colors flex items-center gap-2 ${
                    t === tier ? "text-foreground" : "text-muted-foreground"
                  }`}
                >
                  <span className={`size-2 rounded-full ${t === tier ? "bg-yellow-400" : "bg-muted-foreground/30"}`} />
                  {TIER_LABELS[t]}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Progress */}
        {isRunning && totalSlots > 0 && (
          <div className="text-xs text-muted-foreground tabular-nums shrink-0">
            {doneCount}/{totalSlots}
          </div>
        )}
      </header>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        className="border-b border-border px-4 py-3 flex gap-2 shrink-0 bg-muted/10"
      >
        <Input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask the entire model pantheon in parallel…"
          disabled={isRunning}
          className="flex-1 text-sm"
          autoFocus
        />
        {isRunning ? (
          <Button type="button" variant="destructive" size="sm" onClick={handleStop} className="gap-1.5 shrink-0">
            <span className="size-2 rounded-full bg-white animate-pulse" />
            Stop
          </Button>
        ) : (
          <Button
            type="submit"
            size="sm"
            disabled={!question.trim()}
            className="gap-1.5 shrink-0 bg-yellow-500 hover:bg-yellow-400 text-black font-semibold"
          >
            <Zap className="size-3.5" />
            Run
          </Button>
        )}
      </form>

      {/* Progress bar */}
      {isRunning && totalSlots > 0 && (
        <div className="h-0.5 bg-muted shrink-0">
          <div
            className="h-full bg-yellow-400 transition-all duration-300"
            style={{ width: `${Math.round((doneCount + errorCount) / totalSlots * 100)}%` }}
          />
        </div>
      )}

      {/* Done banner */}
      {done && (
        <div className="border-b border-yellow-500/30 bg-yellow-500/5 px-4 py-2 flex items-center gap-3 shrink-0 text-xs">
          <Trophy className="size-4 text-yellow-400 shrink-0" />
          <span className="font-semibold text-yellow-300">{done.winnerLabel}</span>
          <span className="text-muted-foreground">
            wins with score {Math.round(done.winnerScore * 100)}/100
          </span>
          <span className="text-muted-foreground ml-auto">
            {done.successCount}/{done.responseCount} succeeded · {(done.totalMs / 1000).toFixed(1)}s total
          </span>
        </div>
      )}

      {/* Grid */}
      <ScrollArea className="flex-1">
        {responses.length > 0 ? (
          <div
            className="p-3 grid gap-2"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          >
            {sortedResponses.map((resp, i) => (
              <ResponseCard
                key={resp.id}
                resp={resp}
                isWinner={resp.id === winnerId && resp.status === "done"}
                rank={i + 1}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-64 text-center p-6">
            <div className="mb-4 flex items-center gap-1 text-yellow-400/30">
              {TIERS.map((t) => (
                <div
                  key={t}
                  className="rounded-sm bg-yellow-400/20 transition-all"
                  style={{ width: 8, height: 8 + t / 8 }}
                />
              ))}
            </div>
            <p className="text-sm text-muted-foreground">
              Select a tier, ask a question, watch the models race.
            </p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              Currently set to <span className="text-yellow-400 font-semibold">{TIER_LABELS[tier]}</span>
            </p>
          </div>
        )}
      </ScrollArea>

      {showTierPicker && (
        <div className="fixed inset-0 z-40" onClick={() => setShowTierPicker(false)} />
      )}
    </main>
  );
}
