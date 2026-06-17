/**
 * GODMODE CLASSIC
 *
 * Raw parallel compare — fire all council members simultaneously,
 * stream each response as it lands. No scoring, no synthesis.
 * Pure speed. Fastest first.
 */

import { useState, useRef, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Badge } from "~/components/ui/badge";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Zap, Send, Loader2, AlertTriangle, Trophy, Clock, X } from "lucide-react";
import { loadCouncilMembers } from "~/lib/council";

// ── Types ────────────────────────────────────────────────────────────────────

interface MemberResponse {
  id:        string;
  label:     string;
  model:     string;
  text:      string;
  latencyMs: number;
  tokens:    number;
  status:    "pending" | "done" | "error";
  error?:    string;
}

interface DoneEvent {
  totalMs:       number;
  responseCount: number;
  successCount:  number;
  fastestId:     string;
  fastestLabel:  string;
}

// ── Color palette ─────────────────────────────────────────────────────────────

const COLORS = [
  { border: "border-blue-500/40",   bg: "bg-blue-500/5",   text: "text-blue-400"   },
  { border: "border-purple-500/40", bg: "bg-purple-500/5", text: "text-purple-400" },
  { border: "border-green-500/40",  bg: "bg-green-500/5",  text: "text-green-400"  },
  { border: "border-orange-500/40", bg: "bg-orange-500/5", text: "text-orange-400" },
  { border: "border-pink-500/40",   bg: "bg-pink-500/5",   text: "text-pink-400"   },
  { border: "border-cyan-500/40",   bg: "bg-cyan-500/5",   text: "text-cyan-400"   },
  { border: "border-yellow-500/40", bg: "bg-yellow-500/5", text: "text-yellow-400" },
  { border: "border-red-500/40",    bg: "bg-red-500/5",    text: "text-red-400"    },
];

// ── Component ─────────────────────────────────────────────────────────────────

export default function GodModePage() {
  const [question, setQuestion]   = useState("");
  const [responses, setResponses] = useState<MemberResponse[]>([]);
  const [done, setDone]           = useState<DoneEvent | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const council = loadCouncilMembers().filter((m) => m.enabled);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setIsLoading(false);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim() || isLoading) return;

    // Abort any in-flight request
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setIsLoading(true);
    setDone(null);

    // Build member payload from council config
    const members = council.map((m) => ({
      id:       m.id,
      label:    m.label,
      provider: m.provider,
      model:    m.model,
      apiKey:   m.apiKey || undefined,
      baseUrl:  m.baseUrl || undefined,
    }));

    try {
      const res = await fetch("/api/godmode/stream", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ question: question.trim(), members }),
        signal:  ctrl.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`Server error ${res.status}`);
      }

      const reader  = res.body.getReader();
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

            if (ev.type === "init") {
              // Pre-populate pending slots in order
              const slots: MemberResponse[] = ev.members.map((m: { id: string; label: string; model: string }) => ({
                id:        m.id,
                label:     m.label,
                model:     m.model,
                text:      "",
                latencyMs: 0,
                tokens:    0,
                status:    "pending" as const,
              }));
              setResponses(slots);

            } else if (ev.type === "response") {
              setResponses((prev) =>
                prev.map((r) =>
                  r.id === ev.id
                    ? {
                        ...r,
                        text:      ev.text ?? "",
                        latencyMs: ev.latencyMs ?? 0,
                        tokens:    ev.tokens ?? 0,
                        status:    ev.status as "done" | "error",
                        error:     ev.error,
                      }
                    : r
                )
              );

            } else if (ev.type === "done") {
              setDone({
                totalMs:       ev.totalMs,
                responseCount: ev.responseCount,
                successCount:  ev.successCount,
                fastestId:     ev.fastestId,
                fastestLabel:  ev.fastestLabel,
              });
              setIsLoading(false);

            } else if (ev.type === "error") {
              throw new Error(ev.message ?? "Stream error");
            }
          } catch {
            // malformed line — skip
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        const msg = err instanceof Error ? err.message : "Request failed";
        setResponses((prev) =>
          prev.map((r) => r.status === "pending" ? { ...r, status: "error", error: msg } : r)
        );
      }
    } finally {
      setIsLoading(false);
    }
  }

  const cols = Math.min(responses.length || 3, 3);
  const doneCount = responses.filter((r) => r.status === "done").length;

  return (
    <main className="flex flex-col h-screen overflow-hidden">

      {/* Header */}
      <header className="border-b border-border px-6 py-4 flex items-center gap-3 shrink-0">
        <Zap className="size-5 text-yellow-500" />
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            GODMODE <span className="text-muted-foreground font-normal text-sm">CLASSIC</span>
          </h1>
          <p className="text-xs text-muted-foreground">
            Raw parallel compare — {council.length} member{council.length !== 1 ? "s" : ""}, no scoring, no synthesis
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {isLoading && (
            <>
              <Badge variant="outline" className="text-xs gap-1">
                <Loader2 className="size-2.5 animate-spin" />
                {doneCount}/{responses.length}
              </Badge>
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={stop}>
                <X className="size-3" /> Stop
              </Button>
            </>
          )}
          {done && !isLoading && (
            <Badge variant="outline" className="text-xs gap-1">
              <Clock className="size-2.5" />
              {(done.totalMs / 1000).toFixed(1)}s · {done.successCount}/{done.responseCount} ok
            </Badge>
          )}
        </div>
      </header>

      {/* Input bar */}
      <form
        onSubmit={handleSubmit}
        className="border-b border-border px-6 py-3 flex gap-2 shrink-0"
      >
        <Input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask all council members in parallel…"
          disabled={isLoading}
          className="flex-1 font-mono text-sm"
          aria-label="Question"
        />
        <Button type="submit" disabled={isLoading || !question.trim()}>
          {isLoading
            ? <Loader2 className="size-4 animate-spin" />
            : <Send className="size-4" />
          }
        </Button>
      </form>

      {/* Response grid */}
      <ScrollArea className="flex-1">
        {responses.length > 0 ? (
          <div
            className="p-4 gap-3"
            style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          >
            {responses.map((r, i) => {
              const color = COLORS[i % COLORS.length];
              const isFastest = done?.fastestId === r.id;

              return (
                <article
                  key={r.id}
                  className={`border rounded-lg p-4 flex flex-col gap-3 ${color.border} ${color.bg}`}
                >
                  {/* Member header */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {isFastest && <Trophy className="size-3.5 text-yellow-400 shrink-0" />}
                      <span className={`text-xs font-semibold truncate ${color.text}`}>
                        {r.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {r.status === "pending" && (
                        <Loader2 className="size-3 animate-spin text-muted-foreground" />
                      )}
                      {r.status === "done" && (
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {r.latencyMs}ms · {r.tokens}t
                        </span>
                      )}
                      {r.status === "error" && (
                        <AlertTriangle className="size-3.5 text-destructive" />
                      )}
                    </div>
                  </div>

                  {/* Content */}
                  {r.status === "pending" && (
                    <div className="space-y-2 flex-1">
                      <div className="h-2.5 bg-muted/60 rounded animate-pulse w-full" />
                      <div className="h-2.5 bg-muted/60 rounded animate-pulse w-4/5" />
                      <div className="h-2.5 bg-muted/60 rounded animate-pulse w-3/5" />
                    </div>
                  )}
                  {r.status === "done" && (
                    <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground/90 flex-1">
                      {r.text}
                    </p>
                  )}
                  {r.status === "error" && (
                    <p className="text-xs text-destructive flex-1">
                      {r.error ?? "Failed"}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-64 gap-3 text-center p-8">
            <Zap className="size-10 text-yellow-500/20" />
            <div>
              <p className="text-sm font-medium">GODMODE CLASSIC</p>
              <p className="text-xs text-muted-foreground mt-1">
                Submit a question to fire all council members simultaneously.
                <br />No scoring. No synthesis. Fastest response wins.
              </p>
            </div>
          </div>
        )}
      </ScrollArea>
    </main>
  );
}
