// SPDX-License-Identifier: Apache-2.0
/**
 * Eval Runner — score a single output with a built-in scorer over the existing
 * `@nexus/evals`-backed API.
 *
 * API (all auth'd via authFetch):
 *   GET  /api/v1/evals/scorers  — { scorers: [{ name, params, description }] }
 *   POST /api/v1/evals/score    — { output, scorer, params } → { pass, score, reason? }
 */
import { FlaskConical, Play, Loader2, AlertCircle, CheckCircle2, XCircle } from "lucide-react";
import { useState, useEffect, useCallback } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { authFetch } from "~/lib/api";

interface Scorer {
  name: string;
  params: string[];
  description: string;
}

interface ScoreResult {
  pass: boolean;
  score: number;
  reason?: string;
}

// Parse as JSON; fall back to the raw string (many outputs are plain text).
function parseLoose(raw: string): unknown {
  const t = raw.trim();
  if (!t) return "";
  try {
    return JSON.parse(t);
  } catch {
    return raw;
  }
}

export default function EvalsPage() {
  const [scorers, setScorers] = useState<Scorer[]>([]);
  const [scorer, setScorer] = useState("exact_match");
  const [output, setOutput] = useState("");
  const [paramsText, setParamsText] = useState('{\n  "expected": ""\n}');
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ScoreResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await authFetch("/api/v1/evals/scorers");
      if (res.status === 401) throw new Error("Please sign in to run evals.");
      if (!res.ok) throw new Error(`Failed to load scorers (${res.status})`);
      const data = (await res.json()) as { scorers: Scorer[] };
      setScorers(data.scorers ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load scorers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async () => {
    setRunning(true);
    setError("");
    setResult(null);
    let params: unknown;
    try {
      params = paramsText.trim() ? JSON.parse(paramsText) : {};
    } catch {
      setError("Params must be valid JSON.");
      setRunning(false);
      return;
    }
    try {
      const res = await authFetch("/api/v1/evals/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ output: parseLoose(output), scorer, params }),
      });
      const body = (await res.json().catch(() => ({}))) as ScoreResult & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Score failed (${res.status})`);
      setResult({ pass: body.pass, score: body.score, reason: body.reason });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Score failed");
    } finally {
      setRunning(false);
    }
  };

  const activeScorer = scorers.find((s) => s.name === scorer);

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <FlaskConical className="size-5" /> Eval Runner
        </h1>
        <p className="text-sm text-muted-foreground">Score an output against a built-in scorer.</p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : (
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="space-y-1.5">
              <Label>Scorer</Label>
              <Select value={scorer} onValueChange={setScorer}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {scorers.map((s) => (
                    <SelectItem key={s.name} value={s.name}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {activeScorer && (
                <p className="text-xs text-muted-foreground">
                  {activeScorer.description} · params: {activeScorer.params.join(", ") || "none"}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="eval-output">Output (JSON or plain text)</Label>
              <Textarea
                id="eval-output"
                className="font-mono text-xs"
                placeholder='e.g. {"answer": 42}  or  hello world'
                value={output}
                onChange={(e) => setOutput(e.target.value)}
                rows={4}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="eval-params">Params (JSON)</Label>
              <Textarea
                id="eval-params"
                className="font-mono text-xs"
                value={paramsText}
                onChange={(e) => setParamsText(e.target.value)}
                rows={4}
              />
            </div>

            <Button onClick={run} disabled={running} className="gap-2">
              {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              Run scorer
            </Button>

            {result && (
              <div
                className={`flex items-start gap-2 rounded-md border p-3 text-sm ${
                  result.pass
                    ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "border-destructive/20 bg-destructive/10 text-destructive"
                }`}
              >
                {result.pass ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                ) : (
                  <XCircle className="mt-0.5 size-4 shrink-0" />
                )}
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{result.pass ? "Pass" : "Fail"}</span>
                    <Badge variant="outline" className="tabular-nums">
                      score {result.score.toFixed(2)}
                    </Badge>
                  </div>
                  {result.reason && <p className="text-xs opacity-90">{result.reason}</p>}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {!loading && scorers.length > 0 && (
        <Card>
          <CardHeader className="py-4">
            <CardTitle className="text-sm">Available scorers</CardTitle>
            <CardDescription>Built-in deterministic scorers.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 pb-4 text-xs">
            {scorers.map((s) => (
              <div key={s.name} className="flex items-start gap-2">
                <Badge variant="outline" className="shrink-0 font-mono">
                  {s.name}
                </Badge>
                <span className="text-muted-foreground">{s.description}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
