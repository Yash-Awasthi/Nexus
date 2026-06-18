/**
 * Fallback Chains — configure ordered provider fallback chains.
 *
 * When a provider fails (rate limit, timeout, error), the system
 * tries the next provider in the chain. This page lets you view,
 * create, edit, and test fallback chains.
 *
 * API:
 *   GET  /api/fallback-chains
 *   POST /api/fallback-chains
 *   POST /api/fallback-chains/test
 */
import { useState, useEffect, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "~/components/ui/dialog";
import {
  GitBranch,
  Plus,
  Loader2,
  RefreshCw,
  ArrowRight,
  CheckCircle,
  XCircle,
  Play,
  ChevronRight,
  Zap,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface FallbackStep {
  provider: string;
  model?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

interface FallbackChain {
  id: string;
  name: string;
  steps: FallbackStep[];
  enabled: boolean;
  createdAt: string;
}

interface TestResult {
  success: boolean;
  usedStep?: number;
  usedProvider?: string;
  attempts?: { step: number; provider: string; success: boolean; error?: string; latencyMs?: number }[];
  totalLatencyMs?: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function FallbackChains() {
  const [chains, setChains] = useState<FallbackChain[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSteps, setNewSteps] = useState<FallbackStep[]>([
    { provider: "", model: "" },
    { provider: "", model: "" },
  ]);
  const [creating, setCreating] = useState(false);

  // Test
  const [testChainId, setTestChainId] = useState<string | null>(null);
  const [testPrompt, setTestPrompt] = useState("Hello, world!");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const [err, setErr] = useState("");

  const loadChains = useCallback(async () => {
    setLoading(true);
    const r = await fetch("/api/fallback-chains").catch(() => null);
    if (r?.ok) {
      const d = await r.json();
      setChains(d.chains ?? d);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadChains(); }, [loadChains]);

  const createChain = useCallback(async () => {
    const validSteps = newSteps.filter(s => s.provider.trim());
    if (!newName.trim() || validSteps.length < 2) {
      setErr("Name required and at least 2 providers");
      return;
    }
    setCreating(true); setErr("");
    const r = await fetch("/api/fallback-chains", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), steps: validSteps }),
    }).catch(() => null);
    if (r?.ok) {
      setShowCreate(false);
      setNewName("");
      setNewSteps([{ provider: "", model: "" }, { provider: "", model: "" }]);
      loadChains();
    } else setErr("Create failed");
    setCreating(false);
  }, [newName, newSteps, loadChains]);

  const testChain = useCallback(async (chainId: string) => {
    setTestChainId(chainId); setTesting(true); setTestResult(null);
    const r = await fetch("/api/fallback-chains/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chainId, prompt: testPrompt }),
    }).catch(() => null);
    if (r?.ok) setTestResult(await r.json());
    setTesting(false);
  }, [testPrompt]);

  const addStep = () => setNewSteps(prev => [...prev, { provider: "", model: "" }]);
  const removeStep = (i: number) => setNewSteps(prev => prev.filter((_, j) => j !== i));

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <GitBranch className="w-6 h-6 text-indigo-500" />
            Fallback Chains
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Ordered provider fallback sequences — if one fails, the next is tried automatically
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={loadChains}>
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="w-4 h-4 mr-1" />New chain
          </Button>
        </div>
      </div>

      {/* Test prompt input */}
      <Card className="bg-muted/30">
        <CardContent className="pt-3 pb-3">
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium shrink-0">Test prompt:</label>
            <Input
              value={testPrompt}
              onChange={e => setTestPrompt(e.target.value)}
              className="flex-1 h-8 text-sm"
              placeholder="Enter a prompt to use when testing chains…"
            />
          </div>
        </CardContent>
      </Card>

      {/* Chain list */}
      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
          <Loader2 className="w-5 h-5 animate-spin" />Loading chains…
        </div>
      ) : chains.length === 0 ? (
        <Card>
          <CardContent className="pt-8 pb-8 text-center space-y-3">
            <GitBranch className="w-12 h-12 mx-auto text-muted-foreground opacity-40" />
            <p className="text-muted-foreground">No fallback chains configured</p>
            <Button size="sm" onClick={() => setShowCreate(true)}>Create first chain</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {chains.map(chain => (
            <Card key={chain.id} className={chain.enabled ? "" : "opacity-60"}>
              <CardContent className="pt-4 space-y-3">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{chain.name}</span>
                      <Badge className={chain.enabled ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400" : "bg-slate-100 text-slate-600"}>
                        {chain.enabled ? "active" : "disabled"}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {chain.steps.length} steps · created {new Date(chain.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => testChain(chain.id)} disabled={testing && testChainId === chain.id}>
                    {testing && testChainId === chain.id
                      ? <Loader2 className="w-3 h-3 animate-spin mr-1" />
                      : <Play className="w-3 h-3 mr-1" />}
                    Test
                  </Button>
                </div>

                {/* Steps visualization */}
                <div className="flex items-center flex-wrap gap-1.5">
                  {chain.steps.map((step, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-muted text-sm">
                        <Zap className="w-3 h-3 text-indigo-500" />
                        <span className="font-medium">{step.provider}</span>
                        {step.model && <span className="text-muted-foreground text-xs">/ {step.model}</span>}
                      </div>
                      {i < chain.steps.length - 1 && <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                    </div>
                  ))}
                </div>

                {/* Test result for this chain */}
                {testChainId === chain.id && testResult && (
                  <div className={`p-3 rounded-lg border text-sm space-y-2 ${testResult.success ? "border-green-200 bg-green-50 dark:bg-green-950/20" : "border-red-200 bg-red-50 dark:bg-red-950/20"}`}>
                    <div className="flex items-center gap-2">
                      {testResult.success
                        ? <CheckCircle className="w-4 h-4 text-green-600" />
                        : <XCircle className="w-4 h-4 text-red-500" />}
                      <span className={`font-medium ${testResult.success ? "text-green-700 dark:text-green-400" : "text-red-600"}`}>
                        {testResult.success ? `Succeeded via ${testResult.usedProvider}` : "All steps failed"}
                      </span>
                      {testResult.totalLatencyMs && (
                        <Badge variant="outline">{testResult.totalLatencyMs}ms</Badge>
                      )}
                    </div>
                    {testResult.attempts && (
                      <div className="space-y-1">
                        {testResult.attempts.map((a, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                            {a.success
                              ? <CheckCircle className="w-3 h-3 text-green-500" />
                              : <XCircle className="w-3 h-3 text-red-400" />}
                            <span>Step {a.step + 1}: {a.provider}</span>
                            {a.latencyMs && <span>{a.latencyMs}ms</span>}
                            {a.error && <span className="text-red-500">({a.error})</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New Fallback Chain</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">Name *</label>
              <Input placeholder="e.g. Primary with OpenAI fallback" value={newName} onChange={e => setNewName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Steps (in order)</label>
              {newSteps.map((step, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground w-4 shrink-0">{i + 1}.</span>
                  <Input
                    placeholder="Provider (e.g. anthropic)"
                    value={step.provider}
                    onChange={e => setNewSteps(prev => prev.map((s, j) => j === i ? { ...s, provider: e.target.value } : s))}
                    className="flex-1"
                  />
                  <Input
                    placeholder="Model (optional)"
                    value={step.model ?? ""}
                    onChange={e => setNewSteps(prev => prev.map((s, j) => j === i ? { ...s, model: e.target.value } : s))}
                    className="flex-1"
                  />
                  {newSteps.length > 2 && (
                    <Button size="icon" variant="ghost" className="h-8 w-8 text-red-400 shrink-0" onClick={() => removeStep(i)}>
                      <XCircle className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={addStep}>
                <Plus className="w-4 h-4 mr-1" />Add step
              </Button>
            </div>
            {err && <p className="text-red-500 text-xs">{err}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={createChain} disabled={creating}>
              {creating ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
