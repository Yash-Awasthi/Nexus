/**
 * Verifiable Pipelines — verify AI outputs against rules, constraints, and schemas.
 *
 * Run a text or data payload through a verifiable pipeline to check
 * factual accuracy, format compliance, policy constraints, and more.
 *
 * API:
 *   POST /api/verifiable/verify
 *   GET  /api/verifiable/info
 */
import { useState, useEffect, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Textarea } from "~/components/ui/textarea";
import { Input } from "~/components/ui/input";
import {
  ShieldCheck,
  Loader2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Info,
  Play,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface VerifyResult {
  passed: boolean;
  score?: number;
  checks: {
    name: string;
    passed: boolean;
    message?: string;
    severity?: "error" | "warning" | "info";
  }[];
  summary?: string;
}

interface PipelineInfo {
  availablePipelines?: string[];
  defaultPipeline?: string;
  version?: string;
  checks?: { name: string; description: string }[];
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Verifiable() {
  const [info, setInfo] = useState<PipelineInfo | null>(null);
  const [text, setText] = useState("");
  const [pipeline, setPipeline] = useState("");
  const [context, setContext] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/verifiable/info")
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d) {
          setInfo(d);
          if (d.defaultPipeline) setPipeline(d.defaultPipeline);
        }
      })
      .catch(() => {});
  }, []);

  const verify = useCallback(async () => {
    if (!text.trim()) return;
    setRunning(true); setErr(""); setResult(null);
    const r = await fetch("/api/verifiable/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: text.trim(),
        pipeline: pipeline || undefined,
        context: context.trim() || undefined,
      }),
    }).catch(() => null);
    if (r?.ok) setResult(await r.json());
    else setErr("Verification failed");
    setRunning(false);
  }, [text, pipeline, context]);

  const severityIcon = (severity?: string) => {
    if (severity === "error") return <XCircle className="w-4 h-4 text-red-500 shrink-0" />;
    if (severity === "warning") return <AlertTriangle className="w-4 h-4 text-yellow-500 shrink-0" />;
    return <Info className="w-4 h-4 text-blue-500 shrink-0" />;
  };

  const passRate = result
    ? Math.round((result.checks.filter(c => c.passed).length / result.checks.length) * 100)
    : 0;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ShieldCheck className="w-6 h-6 text-teal-500" />
          Verifiable Pipelines
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Verify AI outputs against factual, format, and policy constraints
        </p>
      </div>

      {/* Info banner */}
      {info && (
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground items-center">
          {info.version && <Badge variant="outline">v{info.version}</Badge>}
          {info.availablePipelines?.map(p => (
            <Badge key={p} variant={p === pipeline ? "default" : "outline"} className="cursor-pointer" onClick={() => setPipeline(p)}>
              {p}
            </Badge>
          ))}
        </div>
      )}

      {/* Input */}
      <Card>
        <CardContent className="pt-4 space-y-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">Text to Verify *</label>
            <Textarea
              rows={5}
              placeholder="Paste the AI-generated text you want to verify…"
              value={text}
              onChange={e => setText(e.target.value)}
              className="resize-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Pipeline</label>
              <Input
                placeholder="e.g. factual, medical, legal…"
                value={pipeline}
                onChange={e => setPipeline(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Source Context <span className="text-muted-foreground font-normal">(optional)</span></label>
              <Input
                placeholder="Ground truth documents for factual check…"
                value={context}
                onChange={e => setContext(e.target.value)}
              />
            </div>
          </div>
          {err && <p className="text-red-500 text-xs">{err}</p>}
          <Button onClick={verify} disabled={running || !text.trim()}>
            {running ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Verifying…</> : <><Play className="w-4 h-4 mr-2" />Verify</>}
          </Button>
        </CardContent>
      </Card>

      {/* Result */}
      {result && (
        <div className="space-y-4">
          {/* Summary bar */}
          <Card className={result.passed ? "border-teal-200 dark:border-teal-800" : "border-red-200 dark:border-red-800"}>
            <CardContent className="pt-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  {result.passed
                    ? <CheckCircle className="w-5 h-5 text-teal-600" />
                    : <XCircle className="w-5 h-5 text-red-500" />}
                  <span className={`font-semibold ${result.passed ? "text-teal-700 dark:text-teal-400" : "text-red-600"}`}>
                    {result.passed ? "Verification Passed" : "Verification Failed"}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-muted-foreground">{passRate}% checks passed</span>
                  {result.score !== undefined && (
                    <Badge variant="outline">{Math.round(result.score * 100)}% score</Badge>
                  )}
                </div>
              </div>
              <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                <div
                  className={`h-2 rounded-full transition-all ${result.passed ? "bg-teal-500" : "bg-red-500"}`}
                  style={{ width: `${passRate}%` }}
                />
              </div>
              {result.summary && <p className="text-sm text-muted-foreground mt-2">{result.summary}</p>}
            </CardContent>
          </Card>

          {/* Individual checks */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                Check Results ({result.checks.filter(c => c.passed).length}/{result.checks.length} passed)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {result.checks.map((check, i) => (
                <div key={i} className={`flex items-start gap-3 p-2.5 rounded-md ${check.passed ? "bg-teal-50/50 dark:bg-teal-950/10" : "bg-red-50/50 dark:bg-red-950/10"}`}>
                  {check.passed
                    ? <CheckCircle className="w-4 h-4 text-teal-600 shrink-0 mt-0.5" />
                    : severityIcon(check.severity)}
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{check.name}</span>
                    {check.message && <p className="text-xs text-muted-foreground mt-0.5">{check.message}</p>}
                  </div>
                  <Badge className={check.passed
                    ? "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-400"
                    : check.severity === "warning"
                      ? "bg-yellow-100 text-yellow-700"
                      : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
                  } variant="secondary">
                    {check.passed ? "PASS" : check.severity?.toUpperCase() ?? "FAIL"}
                  </Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Available checks from info */}
      {info?.checks && info.checks.length > 0 && !result && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Info className="w-4 h-4 text-blue-500" />
              Available Checks
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid sm:grid-cols-2 gap-2">
              {info.checks.map(c => (
                <div key={c.name} className="text-sm">
                  <span className="font-medium">{c.name}</span>
                  <p className="text-xs text-muted-foreground">{c.description}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
