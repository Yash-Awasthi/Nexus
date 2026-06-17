/**
 * Reasoning — multi-mode reasoning and symbolic logic tools.
 *
 * Tab 1: Reasoning Depth — run a prompt with configurable reasoning mode
 *   (fast, balanced, deep, exhaustive) and see step-by-step chain-of-thought.
 *
 * Tab 2: Symbolic — forward-chain rule inference and consistency checking.
 *
 * API:
 *   GET  /api/reasoning/modes
 *   POST /api/reasoning/run
 *   POST /api/symbolic/forward-chain
 *   POST /api/symbolic/check-consistency
 */
import { useState, useEffect, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import {
  Brain,
  Loader2,
  Play,
  CheckCircle,
  XCircle,
  ChevronRight,
  Plus,
  Trash2,
  Lightbulb,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReasoningMode {
  id: string;
  name: string;
  description?: string;
  depth: number;
  avgTokens?: number;
}

interface ReasoningResult {
  answer: string;
  steps?: { stepNumber: number; thought: string; conclusion?: string }[];
  mode: string;
  tokensUsed?: number;
  durationMs?: number;
  confidence?: number;
}

interface ForwardChainResult {
  derivedFacts: string[];
  steps?: { rule: string; input: string[]; derived: string }[];
  iterations?: number;
}

interface ConsistencyResult {
  consistent: boolean;
  conflicts?: { fact1: string; fact2: string; explanation: string }[];
}

// ─── Reasoning Depth Tab ──────────────────────────────────────────────────────

function ReasoningTab() {
  const [modes, setModes] = useState<ReasoningMode[]>([]);
  const [selectedMode, setSelectedMode] = useState("");
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ReasoningResult | null>(null);
  const [err, setErr] = useState("");
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set());

  useEffect(() => {
    fetch("/api/reasoning/modes")
      .then(r => r.ok ? r.json() : { modes: [] })
      .then(d => {
        const modeList = d.modes ?? d;
        setModes(modeList);
        if (modeList.length) setSelectedMode(modeList[0].id);
      })
      .catch(() => {});
  }, []);

  const run = useCallback(async () => {
    if (!prompt.trim()) return;
    setRunning(true); setErr(""); setResult(null); setExpandedSteps(new Set());
    const r = await fetch("/api/reasoning/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt.trim(), mode: selectedMode || undefined }),
    }).catch(() => null);
    if (r?.ok) setResult(await r.json());
    else setErr("Reasoning run failed");
    setRunning(false);
  }, [prompt, selectedMode]);

  const toggleStep = (n: number) => {
    setExpandedSteps(prev => {
      const next = new Set(prev);
      next.has(n) ? next.delete(n) : next.add(n);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      {/* Mode selector */}
      {modes.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {modes.map(m => (
            <button
              key={m.id}
              onClick={() => setSelectedMode(m.id)}
              className={`px-3 py-1.5 rounded-lg border text-sm transition-colors ${selectedMode === m.id ? "bg-primary text-primary-foreground border-primary" : "hover:bg-muted"}`}
            >
              <span className="font-medium">{m.name}</span>
              {m.avgTokens && <span className="ml-1 text-xs opacity-70">~{m.avgTokens}tok</span>}
            </button>
          ))}
        </div>
      )}

      <Card>
        <CardContent className="pt-4 space-y-3">
          <Textarea
            rows={4}
            placeholder="Enter a problem or question that requires deep reasoning…"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            className="resize-none"
          />
          {err && <p className="text-red-500 text-xs">{err}</p>}
          <Button onClick={run} disabled={running || !prompt.trim()}>
            {running ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Reasoning…</> : <><Brain className="w-4 h-4 mr-2" />Run</>}
          </Button>
        </CardContent>
      </Card>

      {result && (
        <div className="space-y-3">
          {/* Metadata */}
          <div className="flex flex-wrap gap-2 items-center text-sm">
            <Badge variant="outline">mode: {result.mode}</Badge>
            {result.tokensUsed && <Badge variant="outline">{result.tokensUsed.toLocaleString()} tokens</Badge>}
            {result.durationMs && <Badge variant="outline">{(result.durationMs / 1000).toFixed(1)}s</Badge>}
            {result.confidence !== undefined && (
              <Badge className={result.confidence > 0.7 ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400" : "bg-yellow-100 text-yellow-700"}>
                {Math.round(result.confidence * 100)}% confidence
              </Badge>
            )}
          </div>

          {/* Chain-of-thought steps */}
          {result.steps && result.steps.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                  Reasoning chain ({result.steps.length} steps)
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {result.steps.map(step => (
                  <div key={step.stepNumber} className="border rounded-md overflow-hidden">
                    <button
                      onClick={() => toggleStep(step.stepNumber)}
                      className="w-full flex items-center gap-2 p-2.5 text-left hover:bg-muted/50 transition-colors"
                    >
                      <span className="w-5 h-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center shrink-0 font-medium">
                        {step.stepNumber}
                      </span>
                      <span className="text-sm flex-1 truncate">{step.thought}</span>
                      <ChevronRight className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform ${expandedSteps.has(step.stepNumber) ? "rotate-90" : ""}`} />
                    </button>
                    {expandedSteps.has(step.stepNumber) && (
                      <div className="px-3 pb-3 pt-1 text-sm text-muted-foreground border-t bg-muted/20">
                        <p>{step.thought}</p>
                        {step.conclusion && (
                          <p className="mt-1 text-foreground font-medium">→ {step.conclusion}</p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Final answer */}
          <Card className="border-primary/20">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Lightbulb className="w-4 h-4 text-yellow-500" />Final Answer
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm whitespace-pre-wrap">{result.answer}</p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

// ─── Symbolic Tab ─────────────────────────────────────────────────────────────

function SymbolicTab() {
  const [mode, setMode] = useState<"chain" | "consistency">("chain");

  // Forward chain
  const [facts, setFacts] = useState<string[]>(["birds can fly", "tweety is a bird"]);
  const [rules, setRules] = useState<string[]>(["IF X is a bird THEN X can fly"]);
  const [chaining, setChaining] = useState(false);
  const [chainResult, setChainResult] = useState<ForwardChainResult | null>(null);

  // Consistency check
  const [consistFacts, setConsistFacts] = useState<string[]>(["all cats are mammals", "some mammals can't breathe underwater"]);
  const [checking, setChecking] = useState(false);
  const [consistResult, setConsistResult] = useState<ConsistencyResult | null>(null);

  const [err, setErr] = useState("");

  const runChain = useCallback(async () => {
    const validFacts = facts.filter(f => f.trim());
    const validRules = rules.filter(r => r.trim());
    if (!validFacts.length) return;
    setChaining(true); setErr(""); setChainResult(null);
    const r = await fetch("/api/symbolic/forward-chain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ facts: validFacts, rules: validRules }),
    }).catch(() => null);
    if (r?.ok) setChainResult(await r.json());
    else setErr("Forward chain failed");
    setChaining(false);
  }, [facts, rules]);

  const checkConsistency = useCallback(async () => {
    const valid = consistFacts.filter(f => f.trim());
    if (valid.length < 2) return;
    setChecking(true); setErr(""); setConsistResult(null);
    const r = await fetch("/api/symbolic/check-consistency", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ facts: valid }),
    }).catch(() => null);
    if (r?.ok) setConsistResult(await r.json());
    else setErr("Consistency check failed");
    setChecking(false);
  }, [consistFacts]);

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Button size="sm" variant={mode === "chain" ? "default" : "outline"} onClick={() => setMode("chain")}>
          Forward Chain
        </Button>
        <Button size="sm" variant={mode === "consistency" ? "default" : "outline"} onClick={() => setMode("consistency")}>
          Consistency Check
        </Button>
      </div>

      {mode === "chain" && (
        <div className="grid md:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Facts</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {facts.map((f, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={f}
                    onChange={e => setFacts(prev => prev.map((x, j) => j === i ? e.target.value : x))}
                    className="text-sm"
                    placeholder="Enter a fact…"
                  />
                  <Button size="icon" variant="ghost" className="h-8 w-8 text-red-400 shrink-0" onClick={() => setFacts(prev => prev.filter((_, j) => j !== i))}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={() => setFacts(prev => [...prev, ""])}>
                <Plus className="w-4 h-4 mr-1" />Add fact
              </Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Rules</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {rules.map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={r}
                    onChange={e => setRules(prev => prev.map((x, j) => j === i ? e.target.value : x))}
                    className="text-sm font-mono"
                    placeholder="IF ... THEN ..."
                  />
                  <Button size="icon" variant="ghost" className="h-8 w-8 text-red-400 shrink-0" onClick={() => setRules(prev => prev.filter((_, j) => j !== i))}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={() => setRules(prev => [...prev, ""])}>
                <Plus className="w-4 h-4 mr-1" />Add rule
              </Button>
            </CardContent>
          </Card>
          <div className="md:col-span-2 space-y-3">
            {err && <p className="text-red-500 text-xs">{err}</p>}
            <Button onClick={runChain} disabled={chaining}>
              {chaining ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Chaining…</> : <><Play className="w-4 h-4 mr-2" />Run Forward Chain</>}
            </Button>
            {chainResult && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Derived Facts ({chainResult.derivedFacts.length})</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1">
                  {chainResult.derivedFacts.map((f, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      <CheckCircle className="w-3.5 h-3.5 text-green-500 shrink-0" />
                      <span>{f}</span>
                    </div>
                  ))}
                  {chainResult.iterations && (
                    <p className="text-xs text-muted-foreground pt-1">{chainResult.iterations} iterations</p>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}

      {mode === "consistency" && (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Facts to Check</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {consistFacts.map((f, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={f}
                    onChange={e => setConsistFacts(prev => prev.map((x, j) => j === i ? e.target.value : x))}
                    className="text-sm"
                    placeholder="Enter a fact…"
                  />
                  <Button size="icon" variant="ghost" className="h-8 w-8 text-red-400 shrink-0" onClick={() => setConsistFacts(prev => prev.filter((_, j) => j !== i))}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={() => setConsistFacts(prev => [...prev, ""])}>
                <Plus className="w-4 h-4 mr-1" />Add fact
              </Button>
            </CardContent>
          </Card>
          {err && <p className="text-red-500 text-xs">{err}</p>}
          <Button onClick={checkConsistency} disabled={checking}>
            {checking ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Checking…</> : "Check Consistency"}
          </Button>
          {consistResult && (
            <Card className={consistResult.consistent ? "border-green-200 dark:border-green-800" : "border-red-200 dark:border-red-800"}>
              <CardContent className="pt-4 space-y-3">
                <div className="flex items-center gap-2">
                  {consistResult.consistent
                    ? <CheckCircle className="w-5 h-5 text-green-500" />
                    : <XCircle className="w-5 h-5 text-red-500" />}
                  <span className={`font-semibold ${consistResult.consistent ? "text-green-600 dark:text-green-400" : "text-red-600"}`}>
                    {consistResult.consistent ? "Facts are consistent" : "Inconsistencies detected"}
                  </span>
                </div>
                {consistResult.conflicts && consistResult.conflicts.length > 0 && (
                  <div className="space-y-2">
                    {consistResult.conflicts.map((c, i) => (
                      <div key={i} className="text-sm bg-red-50 dark:bg-red-950/20 p-2.5 rounded-md">
                        <p className="text-red-600 dark:text-red-400 text-xs font-medium mb-1">Conflict {i + 1}</p>
                        <p>"{c.fact1}" ↔ "{c.fact2}"</p>
                        <p className="text-muted-foreground text-xs mt-1">{c.explanation}</p>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function Reasoning() {
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Brain className="w-6 h-6 text-blue-500" />
          Reasoning
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Multi-depth chain-of-thought reasoning and symbolic logic tools
        </p>
      </div>

      <Tabs defaultValue="depth">
        <TabsList>
          <TabsTrigger value="depth"><Brain className="w-4 h-4 mr-1" />Reasoning Depth</TabsTrigger>
          <TabsTrigger value="symbolic">Symbolic Logic</TabsTrigger>
        </TabsList>
        <TabsContent value="depth" className="mt-4"><ReasoningTab /></TabsContent>
        <TabsContent value="symbolic" className="mt-4"><SymbolicTab /></TabsContent>
      </Tabs>
    </div>
  );
}
