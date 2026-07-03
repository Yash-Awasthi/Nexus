// SPDX-License-Identifier: Apache-2.0
/**
 * RLHF — feedback pipeline dashboard over the existing `@nexus/rlhf-pipeline`
 * API (thumbs feedback → preference pairs → export).
 *
 * API (all auth'd via authFetch):
 *   GET /api/v1/rlhf/stats            — { totalFeedback, totalPairs, ratingBreakdown }
 *   GET /api/v1/rlhf/feedback?rating= — { feedback, total }
 */
import {
  ThumbsUp,
  ThumbsDown,
  Minus,
  Loader2,
  AlertCircle,
  RefreshCw,
  GitCompare,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardDescription } from "~/components/ui/card";
import { authFetch } from "~/lib/api";

type Rating = "thumbs_up" | "thumbs_down" | "neutral";

interface Stats {
  totalFeedback: number;
  totalPairs: number;
  ratingBreakdown: Record<Rating, number>;
}

interface FeedbackEntry {
  id: string;
  sessionId: string;
  promptText: string;
  responseText: string;
  model: string;
  rating: Rating;
  comment?: string;
  createdAt: string;
}

const RATING_FILTERS: { value: "" | Rating; label: string }[] = [
  { value: "", label: "All" },
  { value: "thumbs_up", label: "👍 Up" },
  { value: "thumbs_down", label: "👎 Down" },
  { value: "neutral", label: "Neutral" },
];

function RatingIcon({ rating }: { rating: Rating }) {
  if (rating === "thumbs_up") return <ThumbsUp className="size-4 text-emerald-500" />;
  if (rating === "thumbs_down") return <ThumbsDown className="size-4 text-destructive" />;
  return <Minus className="size-4 text-muted-foreground" />;
}

export default function RlhfPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [feedback, setFeedback] = useState<FeedbackEntry[]>([]);
  const [ratingFilter, setRatingFilter] = useState<"" | Rating>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (ratingFilter) params.set("rating", ratingFilter);
      const [sRes, fRes] = await Promise.all([
        authFetch("/api/v1/rlhf/stats"),
        authFetch(`/api/v1/rlhf/feedback${params.toString() ? `?${params.toString()}` : ""}`),
      ]);
      if (sRes.status === 401 || fRes.status === 401)
        throw new Error("Please sign in to view RLHF data.");
      if (sRes.ok) setStats((await sRes.json()) as Stats);
      if (fRes.ok) {
        const data = (await fRes.json()) as { feedback: FeedbackEntry[] };
        setFeedback(data.feedback ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load RLHF data");
    } finally {
      setLoading(false);
    }
  }, [ratingFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <GitCompare className="size-5" /> RLHF Pipeline
          </h1>
          <p className="text-sm text-muted-foreground">
            Thumbs feedback feeding preference-pair generation for reward modeling.
          </p>
        </div>
        <Button variant="outline" onClick={() => void load()} className="gap-2" disabled={loading}>
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">Feedback</p>
              <p className="text-2xl font-bold tabular-nums">{stats.totalFeedback}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <ThumbsUp className="size-3" /> Up
              </p>
              <p className="text-2xl font-bold tabular-nums text-emerald-500">
                {stats.ratingBreakdown.thumbs_up}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <ThumbsDown className="size-3" /> Down
              </p>
              <p className="text-2xl font-bold tabular-nums text-destructive">
                {stats.ratingBreakdown.thumbs_down}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">Pairs</p>
              <p className="text-2xl font-bold tabular-nums">{stats.totalPairs}</p>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="flex items-center gap-1.5">
        {RATING_FILTERS.map((f) => (
          <Button
            key={f.value || "all"}
            variant={ratingFilter === f.value ? "default" : "outline"}
            size="sm"
            onClick={() => setRatingFilter(f.value)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : feedback.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No feedback recorded yet.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {feedback.map((f) => (
            <Card key={f.id}>
              <CardHeader className="space-y-2 py-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <RatingIcon rating={f.rating} />
                    <Badge variant="outline">{f.model}</Badge>
                  </div>
                  <CardDescription className="shrink-0">
                    {new Date(f.createdAt).toLocaleString()}
                  </CardDescription>
                </div>
                <p className="line-clamp-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Prompt:</span> {f.promptText}
                </p>
                <p className="line-clamp-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Response:</span> {f.responseText}
                </p>
                {f.comment && <p className="text-xs italic text-muted-foreground">“{f.comment}”</p>}
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
