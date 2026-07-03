// SPDX-License-Identifier: Apache-2.0
/**
 * Fine-Tune Pipeline — Phase 2.11
 *
 * Export rated council responses as JSONL training data and
 * optionally initiate an OpenAI fine-tune job.
 *
 * API:
 *   GET  /api/fine-tune/dataset   — stats + eligibility
 *   GET  /api/fine-tune/export    — download JSONL
 *   POST /api/fine-tune/initiate  — start fine-tune job
 */
import { useState, useEffect, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Cpu,
  Download,
  Play,
  CheckCircle,
  XCircle,
  AlertCircle,
  Loader2,
  RefreshCw,
  Database,
  FileJson,
  Zap,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface DatasetStats {
  success: boolean;
  count: number;
  eligible: boolean;
  message: string;
}

interface JobResult {
  success: boolean;
  jobId?: string;
  status?: string;
  error?: string;
  message?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_MODELS = ["gpt-4o-mini-2024-07-18", "gpt-3.5-turbo-0125", "gpt-4o-2024-08-06"];

const MIN_EXAMPLES = 50;

// ─── Component ────────────────────────────────────────────────────────────────

export default function FineTune() {
  const [dataset, setDataset] = useState<DatasetStats | null>(null);
  const [baseModel, setBaseModel] = useState(BASE_MODELS[0]);
  const [loading, setLoading] = useState(false);
  const [initiating, setInitiating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [jobResult, setJobResult] = useState<JobResult | null>(null);
  const [err, setErr] = useState("");

  const fetchDataset = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/fine-tune/dataset");
      if (r.ok) setDataset(await r.json());
      else setErr("Failed to load dataset stats");
    } catch {
      setErr("Could not reach server");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDataset();
  }, [fetchDataset]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const r = await fetch("/api/fine-tune/export");
      if (!r.ok) {
        const e = await r.json();
        setErr(e.error ?? "Export failed");
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "nexus-finetune.jsonl";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setErr("Export failed");
    } finally {
      setExporting(false);
    }
  }, []);

  const handleInitiate = useCallback(async () => {
    setInitiating(true);
    setJobResult(null);
    setErr("");
    try {
      const r = await fetch("/api/fine-tune/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseModel }),
      });
      const data = await r.json();
      if (!r.ok) setErr(data.error ?? "Job failed to start");
      else setJobResult(data);
    } catch {
      setErr("Failed to initiate fine-tune");
    } finally {
      setInitiating(false);
    }
  }, [baseModel]);

  const progressPct = dataset ? Math.min(100, Math.round((dataset.count / MIN_EXAMPLES) * 100)) : 0;

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Cpu className="w-6 h-6 text-violet-500" />
            Fine-Tune Pipeline
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Export rated council responses as JSONL and kick off an OpenAI fine-tune job
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={fetchDataset} disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Dataset Stats */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Database className="w-4 h-4" />
            Training Dataset
          </CardTitle>
          <CardDescription>
            Nexus collects rated deliberation responses to build a personalised training set
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading && !dataset ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">Loading dataset stats…</span>
            </div>
          ) : dataset ? (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Examples</p>
                  <p className="text-3xl font-bold">{dataset.count}</p>
                  <p className="text-xs text-muted-foreground">of {MIN_EXAMPLES} needed</p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Status</p>
                  <div className="flex items-center gap-2 mt-1">
                    {dataset.eligible ? (
                      <Badge className="bg-green-100 text-green-700 border-green-300 dark:bg-green-900/30 dark:text-green-400">
                        <CheckCircle className="w-3 h-3 mr-1" />
                        Ready
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-orange-600 border-orange-400">
                        <AlertCircle className="w-3 h-3 mr-1" />
                        Collecting
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{dataset.message}</p>
                </div>
              </div>

              {/* Progress bar */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Progress to fine-tune eligibility</span>
                  <span>{progressPct}%</span>
                </div>
                <div className="w-full bg-muted rounded-full h-3">
                  <div
                    className={`h-3 rounded-full transition-all ${
                      dataset.eligible ? "bg-green-500" : "bg-violet-500"
                    }`}
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>

              {!dataset.eligible && (
                <div className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
                  <p className="font-medium text-foreground mb-1">
                    How to collect examples faster:
                  </p>
                  <ul className="list-disc list-inside space-y-1 text-xs">
                    <li>Run deliberations and upvote/downvote model responses</li>
                    <li>Use GODMODE CLASSIC to rate parallel responses</li>
                    <li>Run Parseltongue reviews and mark the best verdict</li>
                  </ul>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{err || "No dataset data"}</p>
          )}
        </CardContent>
      </Card>

      {/* Export JSONL */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileJson className="w-4 h-4" />
            Export Training Data
          </CardTitle>
          <CardDescription>
            Download your rated examples as JSONL — compatible with OpenAI and many fine-tune
            frameworks
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            onClick={handleExport}
            disabled={exporting || !dataset?.eligible}
            variant={dataset?.eligible ? "default" : "outline"}
            className="w-full"
          >
            {exporting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Generating JSONL…
              </>
            ) : (
              <>
                <Download className="w-4 h-4 mr-2" />
                Download nexus-finetune.jsonl
              </>
            )}
          </Button>
          {!dataset?.eligible && (
            <p className="text-xs text-muted-foreground mt-2 text-center">
              Need {Math.max(0, MIN_EXAMPLES - (dataset?.count ?? 0))} more rated examples to export
            </p>
          )}
        </CardContent>
      </Card>

      {/* Initiate Job */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Zap className="w-4 h-4" />
            Start Fine-Tune Job
          </CardTitle>
          <CardDescription>
            Uploads your JSONL and initiates an OpenAI fine-tune job. Never runs automatically —
            your decision only.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Base model</label>
            <Select value={baseModel} onValueChange={setBaseModel}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BASE_MODELS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              gpt-4o-mini is recommended — lowest cost, fast iteration
            </p>
          </div>

          {err && (
            <div className="flex items-start gap-2 text-red-600 text-sm bg-red-50 dark:bg-red-950/30 p-3 rounded-lg">
              <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
              {err}
            </div>
          )}

          {jobResult && (
            <div
              className={`flex items-start gap-2 text-sm p-3 rounded-lg ${
                jobResult.success
                  ? "bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400"
                  : "bg-red-50 dark:bg-red-950/30 text-red-600"
              }`}
            >
              {jobResult.success ? (
                <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" />
              ) : (
                <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
              )}
              <div>
                <p className="font-medium">{jobResult.success ? "Job started!" : "Job failed"}</p>
                {jobResult.jobId && (
                  <p className="text-xs mt-1 font-mono">Job ID: {jobResult.jobId}</p>
                )}
                {jobResult.status && <p className="text-xs mt-1">Status: {jobResult.status}</p>}
                {jobResult.message && <p className="text-xs mt-1">{jobResult.message}</p>}
              </div>
            </div>
          )}

          <Button
            onClick={handleInitiate}
            disabled={initiating || !dataset?.eligible}
            className="w-full"
          >
            {initiating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Starting job…
              </>
            ) : (
              <>
                <Play className="w-4 h-4 mr-2" />
                Initiate Fine-Tune Job
              </>
            )}
          </Button>

          <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs text-amber-700 dark:text-amber-400">
            ⚠ This will upload your training data to OpenAI and incur fine-tuning costs (~$3–8 for a
            typical 100-example dataset). The job runs asynchronously — check OpenAI dashboard for
            status.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
