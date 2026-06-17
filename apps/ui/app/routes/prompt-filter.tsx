/**
 * Prompt Filter — check, sanitize, and batch-filter prompts for policy compliance.
 *
 * Tab 1: Check — run a single prompt through the filter
 * Tab 2: Sanitize — clean/redact policy violations from a prompt
 * Tab 3: Batch — check multiple prompts at once
 * Tab 4: Patterns — view active filter patterns/rules
 *
 * API:
 *   POST /api/prompt-filter/check
 *   POST /api/prompt-filter/sanitize
 *   POST /api/prompt-filter/batch
 *   GET  /api/prompt-filter/patterns
 */
import { useState, useEffect, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Textarea } from "~/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import {
  Filter,
  Loader2,
  CheckCircle,
  XCircle,
  Plus,
  Trash2,
  List,
  AlertTriangle,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface FilterResult {
  allowed: boolean;
  action: "allow" | "block" | "warn" | "redact";
  violations?: { rule: string; match?: string; severity: string }[];
  reason?: string;
}

interface SanitizeResult {
  original: string;
  sanitized: string;
  redacted: string[];
  changes?: number;
}

interface FilterPattern {
  id: string;
  name: string;
  pattern?: string;
  category?: string;
  action: "block" | "warn" | "redact";
  enabled: boolean;
}

// ─── Check Tab ────────────────────────────────────────────────────────────────

function CheckTab() {
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<FilterResult | null>(null);
  const [err, setErr] = useState("");

  const check = useCallback(async () => {
    if (!prompt.trim()) return;
    setLoading(true); setErr(""); setResult(null);
    const r = await fetch("/api/prompt-filter/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt.trim() }),
    }).catch(() => null);
    if (r?.ok) setResult(await r.json());
    else setErr("Filter check failed");
    setLoading(false);
  }, [prompt]);

  const actionColor = (action: string) => {
    if (action === "block") return "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400";
    if (action === "warn") return "bg-yellow-100 text-yellow-700";
    if (action === "redact") return "bg-orange-100 text-orange-700";
    return "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400";
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4 space-y-3">
          <Textarea rows={5} placeholder="Enter a prompt to check against filters…" value={prompt} onChange={e => setPrompt(e.target.value)} className="resize-none" />
          {err && <p className="text-red-500 text-xs">{err}</p>}
          <Button onClick={check} disabled={loading || !prompt.trim()}>
            {loading ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Checking…</> : <><Filter className="w-4 h-4 mr-2" />Check Prompt</>}
          </Button>
        </CardContent>
      </Card>
      {result && (
        <Card className={result.allowed ? "border-green-200 dark:border-green-800" : "border-red-200 dark:border-red-800"}>
          <CardContent className="pt-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {result.allowed ? <CheckCircle className="w-5 h-5 text-green-500" /> : <XCircle className="w-5 h-5 text-red-500" />}
                <span className="font-semibold">{result.allowed ? "Prompt Allowed" : "Prompt Blocked"}</span>
              </div>
              <Badge className={actionColor(result.action)}>{result.action.toUpperCase()}</Badge>
            </div>
            {result.reason && <p className="text-sm text-muted-foreground">{result.reason}</p>}
            {result.violations && result.violations.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Violations</p>
                {result.violations.map((v, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <AlertTriangle className="w-3.5 h-3.5 text-orange-500 shrink-0" />
                    <span>{v.rule}</span>
                    {v.match && <code className="text-xs bg-muted px-1 rounded">{v.match}</code>}
                    <Badge variant="secondary" className="text-xs ml-auto">{v.severity}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Sanitize Tab ─────────────────────────────────────────────────────────────

function SanitizeTab() {
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setSanitizeResult] = useState<SanitizeResult | null>(null);
  const [err, setErr] = useState("");

  const sanitize = useCallback(async () => {
    if (!prompt.trim()) return;
    setLoading(true); setErr(""); setSanitizeResult(null);
    const r = await fetch("/api/prompt-filter/sanitize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt.trim() }),
    }).catch(() => null);
    if (r?.ok) setSanitizeResult(await r.json());
    else setErr("Sanitize failed");
    setLoading(false);
  }, [prompt]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4 space-y-3">
          <Textarea rows={5} placeholder="Enter a prompt with potential violations to sanitize…" value={prompt} onChange={e => setPrompt(e.target.value)} className="resize-none" />
          {err && <p className="text-red-500 text-xs">{err}</p>}
          <Button onClick={sanitize} disabled={loading || !prompt.trim()} variant="outline">
            {loading ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Sanitizing…</> : "Sanitize"}
          </Button>
        </CardContent>
      </Card>
      {result && (
        <div className="grid md:grid-cols-2 gap-3">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Original</CardTitle></CardHeader>
            <CardContent><p className="text-sm text-muted-foreground">{result.original}</p></CardContent>
          </Card>
          <Card className="border-primary/20">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center justify-between">
                Sanitized
                {result.changes !== undefined && <Badge variant="secondary">{result.changes} changes</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm">{result.sanitized}</p>
              {result.redacted.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {result.redacted.map((r, i) => (
                    <Badge key={i} variant="outline" className="text-xs line-through text-muted-foreground">{r}</Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

// ─── Batch Tab ────────────────────────────────────────────────────────────────

function BatchTab() {
  const [items, setItems] = useState([{ id: "1", prompt: "" }, { id: "2", prompt: "" }]);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<{ id: string; result: FilterResult }[]>([]);
  const [err, setErr] = useState("");

  const run = useCallback(async () => {
    const valid = items.filter(i => i.prompt.trim());
    if (!valid.length) return;
    setLoading(true); setErr(""); setResults([]);
    const r = await fetch("/api/prompt-filter/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompts: valid.map(i => ({ id: i.id, prompt: i.prompt })) }),
    }).catch(() => null);
    if (r?.ok) {
      const d = await r.json();
      setResults(d.results ?? []);
    } else setErr("Batch failed");
    setLoading(false);
  }, [items]);

  return (
    <div className="space-y-3">
      {items.map((item, idx) => {
        const res = results.find(r => r.id === item.id);
        return (
          <Card key={item.id}>
            <CardContent className="pt-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">#{idx + 1}</span>
                <div className="flex items-center gap-2">
                  {res && (
                    res.result.allowed
                      ? <Badge className="bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400 text-xs"><CheckCircle className="w-3 h-3 mr-0.5" />OK</Badge>
                      : <Badge className="bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400 text-xs"><XCircle className="w-3 h-3 mr-0.5" />{res.result.action}</Badge>
                  )}
                  <Button size="icon" variant="ghost" className="h-6 w-6 text-red-400" onClick={() => setItems(prev => prev.filter(i => i.id !== item.id))}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              </div>
              <Textarea rows={2} placeholder="Prompt…" value={item.prompt} onChange={e => setItems(prev => prev.map(i => i.id === item.id ? { ...i, prompt: e.target.value } : i))} className="resize-none text-sm" />
            </CardContent>
          </Card>
        );
      })}
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => setItems(prev => [...prev, { id: String(Date.now()), prompt: "" }])}>
          <Plus className="w-4 h-4 mr-1" />Add
        </Button>
        <Button size="sm" onClick={run} disabled={loading}>
          {loading ? <><Loader2 className="w-4 h-4 animate-spin mr-1" />Checking…</> : "Check All"}
        </Button>
      </div>
      {err && <p className="text-red-500 text-xs">{err}</p>}
    </div>
  );
}

// ─── Patterns Tab ─────────────────────────────────────────────────────────────

function PatternsTab() {
  const [patterns, setPatterns] = useState<FilterPattern[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/prompt-filter/patterns").then(r => r.ok ? r.json() : { patterns: [] }).then(d => {
      setPatterns(d.patterns ?? d);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center"><Loader2 className="w-4 h-4 animate-spin" />Loading…</div>;
  if (!patterns.length) return <Card><CardContent className="pt-8 pb-8 text-center text-muted-foreground">No patterns configured</CardContent></Card>;

  return (
    <div className="grid sm:grid-cols-2 gap-3">
      {patterns.map(p => (
        <Card key={p.id} className={!p.enabled ? "opacity-50" : ""}>
          <CardContent className="pt-3 pb-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-medium">{p.name}</span>
              <Badge className={
                p.action === "block" ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
                : p.action === "warn" ? "bg-yellow-100 text-yellow-700"
                : "bg-orange-100 text-orange-700"
              }>{p.action}</Badge>
            </div>
            {p.category && <Badge variant="secondary" className="text-xs">{p.category}</Badge>}
            {p.pattern && <code className="text-xs text-muted-foreground block mt-1 truncate">{p.pattern}</code>}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function PromptFilter() {
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Filter className="w-6 h-6 text-rose-500" />
          Prompt Filter
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Check, sanitize, and batch-filter prompts for policy and safety compliance
        </p>
      </div>
      <Tabs defaultValue="check">
        <TabsList>
          <TabsTrigger value="check"><Filter className="w-4 h-4 mr-1" />Check</TabsTrigger>
          <TabsTrigger value="sanitize">Sanitize</TabsTrigger>
          <TabsTrigger value="batch">Batch</TabsTrigger>
          <TabsTrigger value="patterns"><List className="w-4 h-4 mr-1" />Patterns</TabsTrigger>
        </TabsList>
        <TabsContent value="check" className="mt-4"><CheckTab /></TabsContent>
        <TabsContent value="sanitize" className="mt-4"><SanitizeTab /></TabsContent>
        <TabsContent value="batch" className="mt-4"><BatchTab /></TabsContent>
        <TabsContent value="patterns" className="mt-4"><PatternsTab /></TabsContent>
      </Tabs>
    </div>
  );
}
