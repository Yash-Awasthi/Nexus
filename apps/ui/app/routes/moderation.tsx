// SPDX-License-Identifier: Apache-2.0
/**
 * Moderation — content moderation check and configuration.
 *
 * Tab 1: Check — test a piece of text against moderation rules
 * Tab 2: Batch — check multiple texts at once
 * Tab 3: Config — view/adjust moderation thresholds per category
 *
 * API:
 *   POST /api/moderation/check
 *   POST /api/moderation/batch
 *   GET  /api/moderation/config
 */
import {
  ShieldAlert,
  CheckCircle,
  XCircle,
  Loader2,
  Plus,
  Trash2,
  Settings,
  AlertTriangle,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";

import { Page, PageHeader } from "~/components/page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Textarea } from "~/components/ui/textarea";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ModerationResult {
  flagged: boolean;
  categories?: Record<string, boolean>;
  scores?: Record<string, number>;
  action?: "allow" | "warn" | "block";
  reason?: string;
}

interface ModerationConfig {
  categories: {
    name: string;
    enabled: boolean;
    threshold: number;
    action: "allow" | "warn" | "block";
  }[];
}

// ─── Category badge ───────────────────────────────────────────────────────────

function CategoryScore({
  name,
  score,
  flagged,
}: {
  name: string;
  score: number;
  flagged: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      {flagged ? (
        <XCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
      ) : (
        <CheckCircle className="w-3.5 h-3.5 text-success shrink-0" />
      )}
      <span className="text-sm flex-1 capitalize">{name.replace(/_/g, " ")}</span>
      <div className="w-24 bg-muted rounded-full h-1.5 overflow-hidden">
        <div
          className={`h-1.5 rounded-full ${score > 0.7 ? "bg-destructive" : score > 0.4 ? "bg-warning" : "bg-success"}`}
          style={{ width: `${score * 100}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground w-8 text-right">
        {Math.round(score * 100)}%
      </span>
    </div>
  );
}

// ─── Single check ─────────────────────────────────────────────────────────────

function CheckTab() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ModerationResult | null>(null);
  const [err, setErr] = useState("");

  const check = useCallback(async () => {
    if (!text.trim()) return;
    setLoading(true);
    setErr("");
    setResult(null);
    try {
      const r = await fetch("/api/moderation/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim() }),
      });
      const d = (await r.json().catch(() => null)) as
        (ModerationResult & { error?: string }) | null;
      if (r.ok) setResult(d);
      else setErr(d?.error ?? "Moderation check failed");
    } catch {
      setErr("Could not reach server");
    }
    setLoading(false);
  }, [text]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4 space-y-3">
          <Textarea
            rows={5}
            placeholder="Enter text to check for policy violations…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="resize-none"
          />
          {err && <p className="text-destructive text-xs">{err}</p>}
          <Button onClick={check} disabled={loading || !text.trim()}>
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Checking…
              </>
            ) : (
              <>
                <ShieldAlert className="w-4 h-4 mr-2" />
                Check Content
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {result && (
        <Card className={result.flagged ? "border-destructive/30 " : "border-success/30 "}>
          <CardContent className="pt-4 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {result.flagged ? (
                  <XCircle className="w-5 h-5 text-destructive" />
                ) : (
                  <CheckCircle className="w-5 h-5 text-success" />
                )}
                <span
                  className={`font-semibold ${result.flagged ? "text-destructive" : "text-success "}`}
                >
                  {result.flagged ? "Content Flagged" : "Content Clear"}
                </span>
              </div>
              {result.action && (
                <Badge
                  className={
                    result.action === "block"
                      ? "bg-destructive/10 text-destructive  "
                      : result.action === "warn"
                        ? "bg-warning/10 text-warning  "
                        : "bg-success/10 text-success  "
                  }
                >
                  {result.action.toUpperCase()}
                </Badge>
              )}
            </div>
            {result.reason && <p className="text-sm text-muted-foreground">{result.reason}</p>}

            {result.scores && Object.keys(result.scores).length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Category Scores
                </p>
                {Object.entries(result.scores).map(([cat, score]) => (
                  <CategoryScore
                    key={cat}
                    name={cat}
                    score={score as number}
                    flagged={result.categories?.[cat] ?? false}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Batch check ──────────────────────────────────────────────────────────────

function BatchTab() {
  const [items, setItems] = useState([
    { id: "1", text: "" },
    { id: "2", text: "" },
  ]);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<{ id: string; result: ModerationResult }[]>([]);
  const [err, setErr] = useState("");

  const run = useCallback(async () => {
    const valid = items.filter((i) => i.text.trim());
    if (!valid.length) return;
    setLoading(true);
    setErr("");
    setResults([]);
    try {
      const r = await fetch("/api/moderation/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: valid.map((i) => ({ id: i.id, text: i.text })) }),
      });
      if (r.ok) {
        const d = (await r.json()) as { results?: { id: string; result: ModerationResult }[] };
        setResults(d.results ?? []);
      } else setErr("Batch check failed");
    } catch {
      setErr("Could not reach server");
    }
    setLoading(false);
  }, [items]);

  return (
    <div className="space-y-3">
      {items.map((item, idx) => {
        const res = results.find((r) => r.id === item.id);
        return (
          <Card key={item.id}>
            <CardContent className="pt-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">Text #{idx + 1}</span>
                <div className="flex items-center gap-2">
                  {res &&
                    (res.result.flagged ? (
                      <Badge className="bg-destructive/10 text-destructive">
                        <XCircle className="w-3 h-3 mr-1" />
                        Flagged
                      </Badge>
                    ) : (
                      <Badge className="bg-success/10 text-success">
                        <CheckCircle className="w-3 h-3 mr-1" />
                        Clear
                      </Badge>
                    ))}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 text-destructive"
                    onClick={() => setItems((prev) => prev.filter((i) => i.id !== item.id))}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              </div>
              <Textarea
                rows={2}
                placeholder="Enter text…"
                value={item.text}
                onChange={(e) =>
                  setItems((prev) =>
                    prev.map((i) => (i.id === item.id ? { ...i, text: e.target.value } : i)),
                  )
                }
                className="resize-none text-sm"
              />
            </CardContent>
          </Card>
        );
      })}
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setItems((prev) => [...prev, { id: String(Date.now()), text: "" }])}
        >
          <Plus className="w-4 h-4 mr-1" />
          Add
        </Button>
        <Button size="sm" onClick={run} disabled={loading}>
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin mr-1" />
              Checking…
            </>
          ) : (
            "Check All"
          )}
        </Button>
      </div>
      {err && <p className="text-destructive text-xs">{err}</p>}
      {results.length > 0 && (
        <div className="flex items-center gap-3 text-sm text-muted-foreground pt-1">
          <span>{results.filter((r) => r.result.flagged).length} flagged</span>
          <span>{results.filter((r) => !r.result.flagged).length} clear</span>
          <span>of {results.length} checked</span>
        </div>
      )}
    </div>
  );
}

// ─── Config Tab ───────────────────────────────────────────────────────────────

function ConfigTab() {
  const [config, setConfig] = useState<ModerationConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/moderation/config")
      .then((r) => (r.ok ? (r.json() as Promise<ModerationConfig>) : null))
      .then((d) => {
        if (d) setConfig(d);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading)
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading…
      </div>
    );
  if (!config)
    return (
      <Card>
        <CardContent className="pt-8 pb-8 text-center text-muted-foreground">
          No config available
        </CardContent>
      </Card>
    );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Settings className="w-4 h-4" />
          Moderation Categories
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {config.categories.map((cat) => (
            <div key={cat.name} className="flex items-center gap-3">
              <div
                className={`w-2 h-2 rounded-full shrink-0 ${cat.enabled ? "bg-success" : "bg-muted"}`}
              />
              <span className="text-sm w-40 capitalize">{cat.name.replace(/_/g, " ")}</span>
              <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
                <div
                  className="bg-primary h-1.5 rounded-full"
                  style={{ width: `${cat.threshold * 100}%` }}
                />
              </div>
              <span className="text-xs text-muted-foreground w-12 text-right">
                {Math.round(cat.threshold * 100)}%
              </span>
              <Badge
                variant="outline"
                className={`text-xs shrink-0 ${
                  cat.action === "block"
                    ? "border-destructive/30 text-destructive"
                    : cat.action === "warn"
                      ? "border-warning/30 text-warning"
                      : "border-success/30 text-success"
                }`}
              >
                {cat.action}
              </Badge>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function Moderation() {
  return (
    <Page width="default">
      <PageHeader
        title="Moderation"
        description="Test text against the moderation categories and tune the thresholds the explicit-content filter uses."
      />

      <Tabs defaultValue="check">
        <TabsList>
          <TabsTrigger value="check">
            <ShieldAlert className="w-4 h-4 mr-1" />
            Check
          </TabsTrigger>
          <TabsTrigger value="batch">
            <AlertTriangle className="w-4 h-4 mr-1" />
            Batch
          </TabsTrigger>
          <TabsTrigger value="config">
            <Settings className="w-4 h-4 mr-1" />
            Config
          </TabsTrigger>
        </TabsList>
        <TabsContent value="check" className="mt-4">
          <CheckTab />
        </TabsContent>
        <TabsContent value="batch" className="mt-4">
          <BatchTab />
        </TabsContent>
        <TabsContent value="config" className="mt-4">
          <ConfigTab />
        </TabsContent>
      </Tabs>
    </Page>
  );
}
