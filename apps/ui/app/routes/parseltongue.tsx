/**
 * PARSELTONGUE — Code-aware deliberation
 *
 * Paste code → 5 specialist reviewers (Code Review, Security,
 * Performance, Correctness, Architecture) fire in parallel.
 */

import { useState, useRef, useCallback } from "react";
import { useContextMention } from "~/hooks/useContextMention";
import { ContextPill, type MentionType } from "~/components/ContextPill";
import { DiffViewer } from "~/components/DiffViewer";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Textarea } from "~/components/ui/textarea";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Code2, Send, Loader2, X, AlertTriangle,
  Clock, CheckCircle2,
} from "lucide-react";

interface Mention { type: MentionType; label: string; value: string }

// ── Code block extractor ───────────────────────────────────────────────────────

interface CodeBlock { lang: string; code: string; before: string; after: string }

function extractFirstCodeBlock(text: string): CodeBlock | null {
  const match = text.match(/^([\s\S]*?)```(\w*)\n([\s\S]*?)```([\s\S]*)$/)
  if (!match) return null
  return { before: match[1], lang: match[2] || 'text', code: match[3], after: match[4] }
}

function SpecialistOutput({ text, original, roleId }: { text: string; original: string; roleId: string }) {
  const block = extractFirstCodeBlock(text)

  if (!block || !original.trim() || block.code.trim() === original.trim()) {
    return (
      <div className="text-sm leading-relaxed whitespace-pre-wrap text-foreground/90 font-mono text-xs">
        {text}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {block.before.trim() && (
        <div className="text-sm leading-relaxed whitespace-pre-wrap text-foreground/90 font-mono text-xs">
          {block.before.trim()}
        </div>
      )}
      <div style={{ border: '1px solid #2a2a2a', borderRadius: 6, overflow: 'hidden' }}>
        <div style={{ padding: '4px 10px', background: '#0a0a0a', borderBottom: '1px solid #1e1e1e', fontSize: 10, color: '#555', letterSpacing: '0.1em' }}>
          SUGGESTED DIFF · {roleId.toUpperCase()} · {block.lang}
        </div>
        <DiffViewer
          filename={`input.${block.lang}`}
          original={original}
          modified={block.code}
        />
      </div>
      {block.after.trim() && (
        <div className="text-sm leading-relaxed whitespace-pre-wrap text-foreground/90 font-mono text-xs">
          {block.after.trim()}
        </div>
      )}
    </div>
  )
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface RoleInfo { id: string; label: string; icon: string }

interface RoleResponse {
  roleId:    string;
  roleLabel: string;
  roleIcon:  string;
  text:      string;
  latencyMs: number;
  tokens:    number;
  status:    "pending" | "done" | "error";
  error?:    string;
}

interface InitEvent {
  language:    string;
  linesOfCode: number;
  complexity:  number;
  roles:       RoleInfo[];
}

interface DoneEvent {
  totalMs:         number;
  language:        string;
  linesOfCode:     number;
  complexity:      number;
  issueCount:      number;
  suggestionCount: number;
}

// ── Role colors ───────────────────────────────────────────────────────────────

const ROLE_STYLES: Record<string, { border: string; bg: string; label: string }> = {
  reviewer:    { border: "border-blue-500/40",   bg: "bg-blue-500/5",   label: "text-blue-400"   },
  security:    { border: "border-red-500/40",    bg: "bg-red-500/5",    label: "text-red-400"    },
  performance: { border: "border-yellow-500/40", bg: "bg-yellow-500/5", label: "text-yellow-400" },
  correctness: { border: "border-green-500/40",  bg: "bg-green-500/5",  label: "text-green-400"  },
  architect:   { border: "border-purple-500/40", bg: "bg-purple-500/5", label: "text-purple-400" },
};

const DEFAULT_STYLE = { border: "border-border", bg: "bg-muted/20", label: "text-foreground" };

// ── Component ─────────────────────────────────────────────────────────────────

export default function ParseltonguesPage() {
  const [code, setCode]         = useState("");
  const [mentions, setMentions] = useState<Mention[]>([]);
  const codeRef                 = useRef<HTMLTextAreaElement | null>(null);
  const mention                 = useContextMention(codeRef);
  const [question, setQuestion] = useState("");
  const [responses, setResponses] = useState<RoleResponse[]>([]);
  const [init, setInit]         = useState<InitEvent | null>(null);
  const [done, setDone]         = useState<DoneEvent | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setIsLoading(false);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim() || isLoading) return;

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setIsLoading(true);
    setInit(null);
    setDone(null);
    setResponses([]);

    try {
      const res = await fetch("/api/parseltongue/analyze", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ code: code.trim(), question: question.trim() || undefined }),
        signal:  ctrl.signal,
      });

      if (!res.ok || !res.body) throw new Error(`Server error ${res.status}`);

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
              const info: InitEvent = {
                language:    ev.language,
                linesOfCode: ev.linesOfCode,
                complexity:  ev.complexity,
                roles:       ev.roles,
              };
              setInit(info);
              setResponses(
                ev.roles.map((r: RoleInfo) => ({
                  roleId:    r.id,
                  roleLabel: r.label,
                  roleIcon:  r.icon,
                  text:      "",
                  latencyMs: 0,
                  tokens:    0,
                  status:    "pending" as const,
                }))
              );

            } else if (ev.type === "response") {
              setResponses((prev) =>
                prev.map((r) =>
                  r.roleId === ev.roleId
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
                totalMs:         ev.totalMs,
                language:        ev.language,
                linesOfCode:     ev.linesOfCode,
                complexity:      ev.complexity,
                issueCount:      ev.issueCount,
                suggestionCount: ev.suggestionCount,
              });
              setIsLoading(false);

            } else if (ev.type === "error") {
              throw new Error(ev.message ?? "Analysis failed");
            }
          } catch {
            // skip malformed
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

  const doneCount = responses.filter((r) => r.status === "done").length;


  return (
    <div className="flex h-screen overflow-hidden">
      {/* Left panel — code input */}
      <aside
        className="w-[380px] shrink-0 flex flex-col border-r border-border"
        style={{ background: "hsl(var(--card))" }}
      >
        <div className="border-b border-border px-5 py-4 flex items-center gap-2">
          <Code2 className="size-4 text-green-400" />
          <h1 className="font-semibold tracking-tight">PARSELTONGUE</h1>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 flex flex-col gap-4 p-4">
          <div className="flex-1 flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Code</Label>
            {mentions.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 4 }}>
                {mentions.map((m, i) => (
                  <ContextPill key={i} type={m.type} label={m.label} value={m.value}
                    onRemove={() => setMentions(prev => prev.filter((_, j) => j !== i))} />
                ))}
              </div>
            )}
            <Textarea
              ref={codeRef}
              value={code}
              onChange={(e) => { mention.onTextareaChange(e); setCode(e.target.value); }}
              onKeyDown={(e) => { mention.onKeyDown(e as any); }}
              placeholder={"// paste code here...\nfunction example() {\n  ...\n}"}
              className="flex-1 font-mono text-xs resize-none min-h-[300px]"
              disabled={isLoading}
              style={{ fontFamily: "monospace" }}
            />
            {mention.isOpen && (
              <div style={{ position: "fixed", top: mention.anchorPos.top, left: mention.anchorPos.left, zIndex: 9000, background: "#111", border: "1px solid #333", borderRadius: 8, width: 280, maxHeight: 220, overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.7)" }}>
                <div style={{ padding: "5px 10px", borderBottom: "1px solid #222", fontSize: 11, color: "#888" }}>
                  {mention.mentionType ? mention.mentionType.toUpperCase() : "CONTEXT"} · {mention.query || "type @file: @symbol: @web:"}
                </div>
                <div style={{ padding: "8px 10px", color: "#555", fontSize: 11 }}>
                  Press Esc to close
                </div>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              Specific question <span className="opacity-60">(optional)</span>
            </Label>
            <Input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="e.g. Is the auth logic secure?"
              className="text-xs"
              disabled={isLoading}
            />
          </div>

          {/* Stats from init */}
          {init && (
            <div
              className="rounded-lg px-3 py-2 text-xs space-y-1"
              style={{ background: "hsl(var(--muted)/0.4)", border: "1px solid hsl(var(--border)/0.5)" }}
            >
              {[
                ["Language",   init.language],
                ["Lines",      String(init.linesOfCode)],
                ["Complexity", `${init.complexity}/10`],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span className="text-muted-foreground">{k}</span>
                  <span className="font-medium font-mono capitalize">{v}</span>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={isLoading || !code.trim()}
              className="flex-1 gap-2 text-sm"
            >
              {isLoading
                ? <><Loader2 className="size-3.5 animate-spin" /> Analyzing ({doneCount}/{responses.length})</>
                : <><Send className="size-3.5" /> Analyze</>
              }
            </Button>
            {isLoading && (
              <Button type="button" variant="outline" size="icon" onClick={stop} className="shrink-0">
                <X className="size-4" />
              </Button>
            )}
          </div>
        </form>
      </aside>

      {/* Right panel — specialist responses */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top status bar */}
        <div className="border-b border-border px-5 py-3 flex items-center gap-3 text-xs shrink-0">
          {done ? (
            <>
              <CheckCircle2 className="size-3.5 text-green-400" />
              <span className="font-medium">
                {done.language.toUpperCase()} · {done.linesOfCode} lines · complexity {done.complexity}/10
              </span>
              <span className="text-muted-foreground ml-auto flex items-center gap-1">
                <Clock className="size-3" />
                {(done.totalMs / 1000).toFixed(1)}s total
              </span>
            </>
          ) : isLoading ? (
            <>
              <Loader2 className="size-3.5 animate-spin text-green-400" />
              <span className="text-muted-foreground">
                Analyzing with {responses.length} specialist{responses.length !== 1 ? "s" : ""}…
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">5 specialists ready — paste code and fire</span>
          )}
        </div>

        <ScrollArea className="flex-1">
          {responses.length > 0 ? (
            <div className="p-4 space-y-3">
              {responses.map((r) => {
                const style = ROLE_STYLES[r.roleId] ?? DEFAULT_STYLE;
                return (
                  <div
                    key={r.roleId}
                    className={`border rounded-lg p-4 ${style.border} ${style.bg}`}
                  >
                    {/* Role header */}
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className="text-base">{r.roleIcon}</span>
                        <span className={`text-sm font-semibold ${style.label}`}>{r.roleLabel}</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        {r.status === "pending" && <Loader2 className="size-3 animate-spin" />}
                        {r.status === "done" && (
                          <span className="font-mono">{r.latencyMs}ms · {r.tokens}t</span>
                        )}
                        {r.status === "error" && <AlertTriangle className="size-3.5 text-destructive" />}
                      </div>
                    </div>

                    {/* Content */}
                    {r.status === "pending" && (
                      <div className="space-y-2">
                        {[1, 0.85, 0.7, 0.9, 0.6].map((w, i) => (
                          <div
                            key={i}
                            className="h-2.5 bg-muted/50 rounded animate-pulse"
                            style={{ width: `${w * 100}%` }}
                          />
                        ))}
                      </div>
                    )}
                    {r.status === "done" && (
                      <SpecialistOutput text={r.text} original={code} roleId={r.roleId} />
                    )}
                    {r.status === "error" && (
                      <p className="text-xs text-destructive">{r.error ?? "Analysis failed"}</p>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-10">
              <Code2 className="size-12 text-green-400/20" />
              <div>
                <p className="text-sm font-medium">PARSELTONGUE</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-xs">
                  Paste code on the left. Five specialists fire in parallel:
                  code review, security audit, performance analysis,
                  correctness check, and architecture review.
                </p>
              </div>
              <div className="flex flex-wrap gap-2 justify-center">
                {["🔍 Reviewer", "🛡 Security", "⚡ Performance", "✓ Correctness", "🏗 Architect"].map((r) => (
                  <Badge key={r} variant="outline" className="text-xs">{r}</Badge>
                ))}
              </div>
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}
