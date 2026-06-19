// SPDX-License-Identifier: Apache-2.0
/**
 * AUTOTUNE — Iterative system prompt optimizer
 *
 * Give it a prompt + test inputs. It runs the prompt, critiques outputs,
 * generates an improved version, validates it, and shows you a scored diff.
 */

import { useState, useRef, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Badge } from "~/components/ui/badge";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Sliders,
  Plus,
  Trash2,
  Send,
  Loader2,
  X,
  ArrowUp,
  ArrowDown,
  Minus,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TestInput {
  id: string;
  user: string;
  expected: string;
}

interface StepEvent {
  phase: number;
  message: string;
}
interface EvalEvent {
  inputIndex: number;
  phase: number;
  score: number;
  originalScore?: number;
  output: string;
}
interface ResultEvent {
  originalPrompt: string;
  optimizedPrompt: string;
  originalScore: number;
  optimizedScore: number;
  overallImprovement: number;
  diff: { linesAdded: number; linesRemoved: number };
  testResults: Array<{
    input: string;
    originalScore: number;
    optimizedScore: number;
    delta: number;
  }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function ScoreBadge({ score }: { score: number }) {
  const color = score >= 8 ? "text-green-400" : score >= 6 ? "text-yellow-400" : "text-red-400";
  return <span className={`font-mono text-xs font-semibold ${color}`}>{score.toFixed(1)}</span>;
}

function DeltaBadge({ delta }: { delta: number }) {
  if (delta > 0)
    return (
      <span className="text-green-400 text-xs flex items-center gap-0.5">
        <ArrowUp className="size-3" />+{delta.toFixed(1)}
      </span>
    );
  if (delta < 0)
    return (
      <span className="text-red-400 text-xs flex items-center gap-0.5">
        <ArrowDown className="size-3" />
        {delta.toFixed(1)}
      </span>
    );
  return (
    <span className="text-muted-foreground text-xs flex items-center gap-0.5">
      <Minus className="size-3" />0
    </span>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AutoTunePage() {
  const [systemPrompt, setSystemPrompt] = useState(
    "You are a helpful AI assistant. Answer the user's question accurately.",
  );
  const [goal, setGoal] = useState("Be concise, confident, and direct. No hedging.");
  const [iterations, setIterations] = useState(1);
  const [testInputs, setTestInputs] = useState<TestInput[]>([
    { id: uid(), user: "", expected: "" },
  ]);

  const [steps, setSteps] = useState<StepEvent[]>([]);
  const [evals, setEvals] = useState<EvalEvent[]>([]);
  const [result, setResult] = useState<ResultEvent | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  const addInput = () => setTestInputs((p) => [...p, { id: uid(), user: "", expected: "" }]);

  const removeInput = (id: string) => setTestInputs((p) => p.filter((i) => i.id !== id));

  const updateInput = (id: string, field: "user" | "expected", value: string) =>
    setTestInputs((p) => p.map((i) => (i.id === id ? { ...i, [field]: value } : i)));

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setIsLoading(false);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const validInputs = testInputs.filter((i) => i.user.trim());
    if (!systemPrompt.trim() || validInputs.length === 0 || isLoading) return;

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setIsLoading(true);
    setSteps([]);
    setEvals([]);
    setResult(null);

    try {
      const res = await fetch("/api/drift/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemPrompt: systemPrompt.trim(),
          testInputs: validInputs.map(({ user, expected }) => ({
            user,
            expected: expected.trim() || undefined,
          })),
          goal: goal.trim() || undefined,
          iterations,
        }),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) throw new Error(`Server error ${res.status}`);

      const reader = res.body.getReader();
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
            if (ev.type === "step")
              setSteps((p) => [...p, { phase: ev.phase, message: ev.message }]);
            if (ev.type === "eval") setEvals((p) => [...p, ev as EvalEvent]);
            if (ev.type === "result") {
              setResult(ev as ResultEvent);
              setIsLoading(false);
            }
            if (ev.type === "error") throw new Error(ev.message);
          } catch {
            /* skip */
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") console.error(err);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Left — configuration */}
      <aside
        className="w-[400px] shrink-0 flex flex-col border-r border-border overflow-hidden"
        style={{ background: "hsl(var(--card))" }}
      >
        <div className="border-b border-border px-5 py-4 flex items-center gap-2">
          <Sliders className="size-4 text-primary" />
          <h1 className="font-semibold tracking-tight">AUTOTUNE</h1>
          <Badge variant="outline" className="ml-auto text-xs">
            Prompt optimizer
          </Badge>
        </div>

        <ScrollArea className="flex-1">
          <form onSubmit={handleSubmit} className="p-4 space-y-5">
            {/* System prompt */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">System prompt to optimize</Label>
              <Textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="You are a helpful AI assistant…"
                className="text-xs font-mono min-h-[120px] resize-none"
                disabled={isLoading}
              />
            </div>

            {/* Goal */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Optimization goal</Label>
              <Input
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="e.g. Be concise and direct, no hedging"
                className="text-xs"
                disabled={isLoading}
              />
            </div>

            {/* Iterations */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Iterations</Label>
              <div className="flex gap-2">
                {[1, 2].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setIterations(n)}
                    className="flex-1 py-1.5 rounded-md text-xs font-medium transition-colors"
                    style={{
                      background:
                        iterations === n ? "hsl(var(--primary))" : "hsl(var(--muted)/0.5)",
                      color:
                        iterations === n
                          ? "hsl(var(--primary-foreground))"
                          : "hsl(var(--muted-foreground))",
                      border: "1px solid hsl(var(--border)/0.5)",
                    }}
                    disabled={isLoading}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                2 iterations = better results but ~2× cost.
              </p>
            </div>

            {/* Test inputs */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">
                  Test inputs ({testInputs.length}/10)
                </Label>
                {testInputs.length < 10 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-6 text-xs px-2 gap-1"
                    onClick={addInput}
                    disabled={isLoading}
                  >
                    <Plus className="size-3" /> Add
                  </Button>
                )}
              </div>

              {testInputs.map((input, i) => (
                <div
                  key={input.id}
                  className="rounded-lg p-3 space-y-2"
                  style={{
                    background: "hsl(var(--muted)/0.3)",
                    border: "1px solid hsl(var(--border)/0.4)",
                  }}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">Test {i + 1}</span>
                    {testInputs.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeInput(input.id)}
                        disabled={isLoading}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    )}
                  </div>
                  <Input
                    value={input.user}
                    onChange={(e) => updateInput(input.id, "user", e.target.value)}
                    placeholder="User message…"
                    className="text-xs h-7"
                    disabled={isLoading}
                  />
                  <Input
                    value={input.expected}
                    onChange={(e) => updateInput(input.id, "expected", e.target.value)}
                    placeholder="Expected output (optional)"
                    className="text-xs h-7 text-muted-foreground"
                    disabled={isLoading}
                  />
                </div>
              ))}
            </div>

            {/* Submit */}
            <div className="flex gap-2 pb-4">
              <Button
                type="submit"
                disabled={
                  isLoading || !systemPrompt.trim() || !testInputs.some((i) => i.user.trim())
                }
                className="flex-1 gap-2 text-sm"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" /> Running…
                  </>
                ) : (
                  <>
                    <Send className="size-3.5" /> Run AutoTune
                  </>
                )}
              </Button>
              {isLoading && (
                <Button type="button" variant="outline" size="icon" onClick={stop}>
                  <X className="size-4" />
                </Button>
              )}
            </div>
          </form>
        </ScrollArea>
      </aside>

      {/* Right — live log + results */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="border-b border-border px-5 py-3 text-xs text-muted-foreground shrink-0">
          {result ? (
            <span className="flex items-center gap-2 text-green-400 font-medium">
              <CheckCircle2 className="size-3.5" />
              Done — improvement: {result.overallImprovement >= 0 ? "+" : ""}
              {result.overallImprovement.toFixed(1)} pts
            </span>
          ) : isLoading ? (
            <span className="flex items-center gap-2">
              <Loader2 className="size-3 animate-spin" /> Optimizing…
            </span>
          ) : (
            "Live log + results will appear here"
          )}
        </div>

        <ScrollArea className="flex-1">
          <div className="p-5 space-y-5">
            {/* Live step log */}
            {steps.length > 0 && (
              <div className="space-y-1">
                {steps.map((s, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span
                      className="shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono"
                      style={{
                        background:
                          s.phase === 1
                            ? "hsl(var(--blue-500, 220 90% 56%)/0.15)"
                            : "hsl(var(--primary)/0.12)",
                        color: s.phase === 1 ? "hsl(220, 90%, 70%)" : "hsl(var(--primary))",
                      }}
                    >
                      P{s.phase}
                    </span>
                    <span className="text-muted-foreground">{s.message}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Per-input eval scores */}
            {evals.length > 0 && (
              <div
                className="rounded-lg overflow-hidden"
                style={{ border: "1px solid hsl(var(--border)/0.5)" }}
              >
                <div
                  className="px-3 py-2 text-xs font-medium"
                  style={{ background: "hsl(var(--muted)/0.4)" }}
                >
                  Evaluation scores
                </div>
                <div className="divide-y divide-border/30">
                  {testInputs
                    .filter((i) => i.user.trim())
                    .map((input, idx) => {
                      const p1 = evals.find((e) => e.inputIndex === idx && e.phase === 1);
                      const p2 = evals.find((e) => e.inputIndex === idx && e.phase === 2);
                      return (
                        <div key={input.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                          <span className="text-muted-foreground truncate flex-1 min-w-0">
                            {input.user.slice(0, 50)}
                            {input.user.length > 50 ? "…" : ""}
                          </span>
                          <div className="flex items-center gap-3 shrink-0">
                            {p1 && (
                              <>
                                <span className="text-muted-foreground">orig</span>{" "}
                                <ScoreBadge score={p1.score} />
                              </>
                            )}
                            {p2 && (
                              <>
                                <span className="text-muted-foreground">opt</span>{" "}
                                <ScoreBadge score={p2.score} />
                              </>
                            )}
                            {p1 && p2 && <DeltaBadge delta={p2.score - p1.score} />}
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>
            )}

            {/* Final result */}
            {result && (
              <div className="space-y-4">
                {/* Score summary */}
                <div
                  className="rounded-lg p-4 grid grid-cols-3 gap-3 text-center"
                  style={{
                    background: "hsl(var(--muted)/0.4)",
                    border: "1px solid hsl(var(--border)/0.5)",
                  }}
                >
                  {[
                    {
                      label: "Original",
                      value: result.originalScore,
                      color: "text-muted-foreground",
                    },
                    { label: "Optimized", value: result.optimizedScore, color: "text-green-400" },
                    {
                      label: "Δ",
                      value: result.overallImprovement,
                      color: result.overallImprovement >= 0 ? "text-green-400" : "text-red-400",
                      prefix: result.overallImprovement >= 0 ? "+" : "",
                    },
                  ].map(({ label, value, color, prefix = "" }) => (
                    <div key={label}>
                      <p className="text-xs text-muted-foreground mb-1">{label}</p>
                      <p className={`text-xl font-bold font-mono ${color}`}>
                        {prefix}
                        {value.toFixed(1)}
                      </p>
                    </div>
                  ))}
                </div>

                {/* Diff stats */}
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="text-green-400">+{result.diff.linesAdded} lines added</span>
                  <span className="text-red-400">−{result.diff.linesRemoved} lines removed</span>
                </div>

                {/* Optimized prompt */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-semibold text-green-400">Optimized prompt</Label>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 text-xs px-2"
                      onClick={() => navigator.clipboard.writeText(result.optimizedPrompt)}
                    >
                      Copy
                    </Button>
                  </div>
                  <pre
                    className="text-xs font-mono rounded-lg p-3 leading-relaxed overflow-x-auto whitespace-pre-wrap"
                    style={{
                      background: "hsl(var(--green-500, 145 60% 45%)/0.06)",
                      border: "1px solid hsl(145, 60%, 45%, 0.2)",
                    }}
                  >
                    {result.optimizedPrompt}
                  </pre>
                </div>

                {/* Original (collapsed) */}
                <div>
                  <button
                    className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => setShowOriginal((v) => !v)}
                  >
                    {showOriginal ? (
                      <ChevronUp className="size-3" />
                    ) : (
                      <ChevronDown className="size-3" />
                    )}
                    Original prompt
                  </button>
                  {showOriginal && (
                    <pre
                      className="mt-2 text-xs font-mono rounded-lg p-3 leading-relaxed overflow-x-auto whitespace-pre-wrap"
                      style={{
                        background: "hsl(var(--muted)/0.3)",
                        border: "1px solid hsl(var(--border)/0.5)",
                      }}
                    >
                      {result.originalPrompt}
                    </pre>
                  )}
                </div>
              </div>
            )}

            {/* Empty state */}
            {steps.length === 0 && !isLoading && !result && (
              <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
                <Sliders className="size-10 text-primary/20" />
                <div>
                  <p className="text-sm font-medium">AUTOTUNE</p>
                  <p className="text-xs text-muted-foreground mt-1 max-w-xs">
                    Paste a system prompt, add test inputs, and let AutoTune iterate toward a better
                    version. Live scoring throughout.
                  </p>
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
