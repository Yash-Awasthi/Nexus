// SPDX-License-Identifier: Apache-2.0
/**
 * Blind Council — run a council deliberation where model identities are hidden.
 *
 * Responses are anonymized (Model A, Model B, etc.) to eliminate bias.
 * After deliberation, reveal identities and compare. Ideal for unbiased
 * comparative evaluation.
 *
 * API:
 *   POST /api/blind-council/run
 */
import { useState, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
  EyeOff,
  Eye,
  Loader2,
  MessageSquare,
  ChevronDown,
  ChevronUp,
  Trophy,
  Star,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface BlindResponse {
  alias: string; // "Model A", "Model B", etc.
  content: string;
  model?: string; // revealed after unmasking
  score?: number;
  rank?: number;
}

interface BlindCouncilResult {
  query: string;
  responses: BlindResponse[];
  synthesizedAnswer?: string;
  revealed: boolean;
}

// ─── Color map ────────────────────────────────────────────────────────────────

const ALIAS_COLORS: Record<string, string> = {
  A: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
  B: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400",
  C: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400",
  D: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400",
  E: "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-400",
};

function getAliasColor(alias: string) {
  const letter = alias.replace("Model ", "");
  return ALIAS_COLORS[letter] ?? "bg-slate-100 text-slate-700";
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function BlindCouncil() {
  const [query, setQuery] = useState("");
  const [models, setModels] = useState("3"); // number of models
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BlindCouncilResult | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [votes, setVotes] = useState<Record<string, number>>({});
  const [err, setErr] = useState("");

  const run = useCallback(async () => {
    if (!query.trim()) return;
    setRunning(true);
    setErr("");
    setResult(null);
    setRevealed(false);
    setVotes({});
    const r = await fetch("/api/blind-council/deliberate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query.trim(), modelCount: parseInt(models) || 3 }),
    }).catch(() => null);
    if (r?.ok) {
      const data = await r.json();
      setResult(data);
    } else setErr("Blind council run failed");
    setRunning(false);
  }, [query, models]);

  const toggleExpand = (alias: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(alias) ? next.delete(alias) : next.add(alias);
      return next;
    });
  };

  const vote = (alias: string) => {
    setVotes((prev) => ({ ...prev, [alias]: (prev[alias] ?? 0) + 1 }));
  };

  const topVoted = result
    ? result.responses.reduce(
        (a, b) => ((votes[a.alias] ?? 0) > (votes[b.alias] ?? 0) ? a : b),
        result.responses[0],
      )
    : null;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <EyeOff className="w-6 h-6 text-slate-600" />
          Blind Council
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          AI responses are anonymized (Model A, B, C…) to eliminate identity bias. Rate responses,
          then reveal who said what.
        </p>
      </div>

      {/* Query form */}
      <Card>
        <CardContent className="pt-4 space-y-3">
          <Textarea
            rows={3}
            placeholder="Enter your question or task for the blind council…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="resize-none"
          />
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium">Models:</label>
              <select
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                value={models}
                onChange={(e) => setModels(e.target.value)}
              >
                {["2", "3", "4", "5"].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            {err && <p className="text-red-500 text-xs flex-1">{err}</p>}
            <Button onClick={run} disabled={running || !query.trim()} className="ml-auto">
              {running ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Running…
                </>
              ) : (
                <>
                  <EyeOff className="w-4 h-4 mr-2" />
                  Run Blind Council
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Results */}
      {result && (
        <div className="space-y-4">
          {/* Reveal toggle */}
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-muted-foreground">
              {result.responses.length} anonymous responses
              {Object.keys(votes).length > 0 &&
                ` · ${Object.values(votes).reduce((a, b) => a + b, 0)} votes cast`}
            </p>
            <Button
              variant={revealed ? "default" : "outline"}
              size="sm"
              onClick={() => setRevealed(!revealed)}
            >
              {revealed ? (
                <>
                  <EyeOff className="w-4 h-4 mr-2" />
                  Hide Identities
                </>
              ) : (
                <>
                  <Eye className="w-4 h-4 mr-2" />
                  Reveal Identities
                </>
              )}
            </Button>
          </div>

          {/* Response cards */}
          <div className="grid md:grid-cols-2 gap-3">
            {result.responses.map((resp) => (
              <Card
                key={resp.alias}
                className={
                  topVoted?.alias === resp.alias && Object.keys(votes).length > 0
                    ? "ring-2 ring-yellow-400"
                    : ""
                }
              >
                <CardContent className="pt-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge className={getAliasColor(resp.alias)}>{resp.alias}</Badge>
                      {revealed && resp.model && (
                        <span className="text-xs text-muted-foreground font-mono">
                          ({resp.model})
                        </span>
                      )}
                      {topVoted?.alias === resp.alias && Object.keys(votes).length > 0 && (
                        <Trophy className="w-4 h-4 text-yellow-500" />
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {resp.score !== undefined && (
                        <span className="text-xs text-muted-foreground">
                          score: {resp.score.toFixed(2)}
                        </span>
                      )}
                      {votes[resp.alias] > 0 && (
                        <Badge variant="secondary" className="text-xs">
                          <Star className="w-2.5 h-2.5 mr-0.5" />
                          {votes[resp.alias]}
                        </Badge>
                      )}
                    </div>
                  </div>

                  <div
                    className={`text-sm text-muted-foreground overflow-hidden transition-all ${expanded.has(resp.alias) ? "" : "line-clamp-5"}`}
                  >
                    {resp.content}
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <button
                      className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-0.5"
                      onClick={() => toggleExpand(resp.alias)}
                    >
                      {expanded.has(resp.alias) ? (
                        <>
                          <ChevronUp className="w-3 h-3" />
                          Show less
                        </>
                      ) : (
                        <>
                          <ChevronDown className="w-3 h-3" />
                          Show more
                        </>
                      )}
                    </button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto h-6 text-xs"
                      onClick={() => vote(resp.alias)}
                    >
                      <Star className="w-3 h-3 mr-1" />
                      Vote best
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Synthesis */}
          {result.synthesizedAnswer && (
            <Card className="border-primary/20">
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-primary" />
                  Synthesized Answer
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm whitespace-pre-wrap">{result.synthesizedAnswer}</p>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
