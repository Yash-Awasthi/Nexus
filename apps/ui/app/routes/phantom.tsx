/**
 * PHANTOM — 5 hardcoded model+system combos racing in parallel.
 *
 * Winner scored by signal density (longest substantive response).
 * All 5 fire simultaneously via Promise.allSettled — no waiting for stragglers.
 *
 * API: POST /api/v1/gateway/messages (Nexus model gateway)
 */

import { useState, useCallback, useRef } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Zap, Ghost, Send, Loader2, Trophy, AlertTriangle } from "lucide-react";

// ── Phantom combos ──────────────────────────────────────────────────────────

const PHANTOM_COMBOS = [
  {
    emoji: "👻",
    label: "PHANTOM-1",
    model: "anthropic/claude-3.5-sonnet",
    provider: "Anthropic",
    system:
      "You are PHANTOM-1. Respond with maximum signal density. No filler, no hedging, no preamble. Pure cognition.",
  },
  {
    emoji: "⚡",
    label: "PHANTOM-2",
    model: "x-ai/grok-3",
    provider: "xAI",
    system:
      "PHANTOM mode active. Directness over diplomacy. Truth over comfort. Signal without noise. No apologies.",
  },
  {
    emoji: "🔮",
    label: "PHANTOM-3",
    model: "google/gemini-2.5-flash",
    provider: "Google",
    system:
      "Operating in PHANTOM configuration. Analytical precision. Skip all preamble. Immediate depth required.",
  },
  {
    emoji: "🌑",
    label: "PHANTOM-4",
    model: "openai/gpt-4o",
    provider: "OpenAI",
    system: "PHANTOM protocol engaged. Maximum density. Skip pleasantries. Deliver insight directly.",
  },
  {
    emoji: "💀",
    label: "PHANTOM-FAST",
    model: "meta-llama/llama-3.1-8b-instruct",
    provider: "Meta",
    system: "Fast. Direct. No apologies. PHANTOM fast-path active. One signal, zero noise.",
  },
] as const;

// ── Types ───────────────────────────────────────────────────────────────────

interface ComboResult {
  label: string;
  emoji: string;
  model: string;
  provider: string;
  content: string;
  durationMs: number;
  status: "pending" | "done" | "error";
  error?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function callGateway(
  model: string,
  system: string,
  userMessage: string,
  signal: AbortSignal,
): Promise<{ content: string }> {
  const res = await fetch("/api/v1/gateway/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      system,
      messages: [{ role: "user", content: userMessage }],
      max_tokens: 1024,
      stream: false,
    }),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }

  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const content = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  return { content };
}

// ── Result card ─────────────────────────────────────────────────────────────

function ResultCard({ r, isWinner }: { r: ComboResult; isWinner: boolean }) {
  return (
    <div
      className={`relative rounded-lg border p-4 transition-all ${
        isWinner
          ? "border-yellow-500/60 bg-yellow-500/5"
          : r.status === "error"
            ? "border-red-500/30 bg-red-500/5"
            : "border-border bg-card"
      }`}
    >
      {isWinner && (
        <Badge
          className="absolute -top-2.5 right-3 bg-yellow-500 text-black text-[10px] font-bold tracking-wider"
        >
          ★ WINNER
        </Badge>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-base">{r.emoji}</span>
          <span className="text-sm font-mono font-bold text-purple-400">{r.label}</span>
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            {r.provider}
          </Badge>
        </div>
        <span className="text-[10px] text-muted-foreground font-mono">
          {r.status === "done"
            ? `${r.durationMs}ms`
            : r.status === "error"
              ? "ERROR"
              : "…"}
        </span>
      </div>

      {/* Model slug */}
      <p className="text-[10px] text-muted-foreground/60 font-mono mb-3">{r.model}</p>

      {/* Content */}
      {r.status === "pending" && (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>receiving signal…</span>
        </div>
      )}
      {r.status === "done" && (
        <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{r.content}</p>
      )}
      {r.status === "error" && (
        <div className="flex items-center gap-2 text-red-400 text-sm">
          <AlertTriangle className="h-3 w-3 flex-shrink-0" />
          <span>{r.error}</span>
        </div>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function PhantomPage() {
  const [results, setResults] = useState<ComboResult[]>([]);
  const [running, setRunning] = useState(false);
  const [query, setQuery] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const winner =
    results
      .filter((r) => r.status === "done")
      .sort((a, b) => b.content.length - a.content.length)[0] ?? null;

  const run = useCallback(async () => {
    const text = query.trim();
    if (!text || running) return;

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setRunning(true);
    setResults(
      PHANTOM_COMBOS.map((c) => ({
        label: c.label,
        emoji: c.emoji,
        model: c.model,
        provider: c.provider,
        content: "",
        durationMs: 0,
        status: "pending",
      })),
    );

    await Promise.allSettled(
      PHANTOM_COMBOS.map(async (combo, i) => {
        const t0 = Date.now();
        try {
          const { content } = await callGateway(combo.model, combo.system, text, ctrl.signal);
          setResults((prev) => {
            const next = [...prev];
            next[i] = { ...next[i]!, content, durationMs: Date.now() - t0, status: "done" };
            return next;
          });
        } catch (err) {
          if ((err as Error).name === "AbortError") return;
          setResults((prev) => {
            const next = [...prev];
            next[i] = {
              ...next[i]!,
              status: "error",
              error: err instanceof Error ? err.message : String(err),
              durationMs: Date.now() - t0,
            };
            return next;
          });
        }
      }),
    );

    setRunning(false);
  }, [query, running]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void run();
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    setRunning(false);
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Ghost className="h-6 w-6 text-purple-400" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight">PHANTOM</h1>
          <p className="text-sm text-muted-foreground">
            5 model+system combos race in parallel · winner by signal density
          </p>
        </div>
        {running && (
          <Badge variant="outline" className="ml-auto text-yellow-400 border-yellow-400/40 animate-pulse">
            <Zap className="h-3 w-3 mr-1" />
            Running
          </Badge>
        )}
      </div>

      {/* Combos legend */}
      <div className="flex flex-wrap gap-2">
        {PHANTOM_COMBOS.map((c) => (
          <Badge key={c.label} variant="outline" className="text-[11px] font-mono text-muted-foreground">
            {c.emoji} {c.label} · {c.provider}
          </Badge>
        ))}
      </div>

      {/* Input */}
      <div className="space-y-2">
        <Textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter your query… (Enter to send all 5 phantoms, Shift+Enter for newline)"
          rows={3}
          disabled={running}
          className="font-mono text-sm resize-none"
        />
        <div className="flex gap-2">
          <Button
            onClick={() => void run()}
            disabled={running || !query.trim()}
            className="bg-purple-600 hover:bg-purple-700 text-white"
          >
            {running ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Running…</>
            ) : (
              <><Send className="h-4 w-4 mr-2" />Unleash Phantoms</>
            )}
          </Button>
          {running && (
            <Button variant="outline" onClick={stop}>
              Stop
            </Button>
          )}
        </div>
      </div>

      {/* Results */}
      {results.length > 0 && (
        <>
          {winner && (
            <div className="flex items-center gap-2 p-3 rounded-lg border border-yellow-500/30 bg-yellow-500/5 text-sm">
              <Trophy className="h-4 w-4 text-yellow-400 flex-shrink-0" />
              <span className="font-mono text-yellow-400 font-bold">{winner.label}</span>
              <span className="text-muted-foreground">won with {winner.content.length} chars in {winner.durationMs}ms</span>
            </div>
          )}
          <ScrollArea className="h-[600px]">
            <div className="space-y-4 pr-4">
              {results.map((r) => (
                <ResultCard
                  key={r.label}
                  r={r}
                  isWinner={winner?.label === r.label && r.status === "done"}
                />
              ))}
            </div>
          </ScrollArea>
        </>
      )}

      {results.length === 0 && !running && (
        <div className="text-center py-20 text-muted-foreground/40 font-mono text-sm tracking-widest uppercase">
          Enter a query to unleash 5 phantoms in parallel
        </div>
      )}
    </div>
  );
}
