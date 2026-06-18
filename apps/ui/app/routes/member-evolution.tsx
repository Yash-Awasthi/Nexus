/**
 * Member Evolution — track how council member personas adapt over time.
 *
 * Tab 1: Profile — view evolution state for a given model
 * Tab 2: Recompute — trigger a re-computation of evolution weights
 * Tab 3: Apply — apply latest evolution to active sessions
 *
 * API:
 *   GET  /api/member-evolution/:model
 *   POST /api/member-evolution/recompute
 *   POST /api/member-evolution/apply
 */
import { useState, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { TrendingUp, Loader2, RefreshCw, Play, CheckCircle } from "lucide-react";

interface EvolutionProfile {
  model: string;
  generation: number;
  traits: { name: string; value: number; delta?: number }[];
  lastUpdated?: string;
  status?: string;
}

// ─── Profile Tab ──────────────────────────────────────────────────────────────

function ProfileTab() {
  const [model, setModel] = useState("");
  const [loading, setLoading] = useState(false);
  const [profile, setProfile] = useState<EvolutionProfile | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    if (!model.trim()) return;
    setLoading(true); setErr(""); setProfile(null);
    const r = await fetch(`/api/member-evolution/${encodeURIComponent(model.trim())}`).catch(() => null);
    if (r?.ok) setProfile(await r.json());
    else setErr("Failed to load evolution profile");
    setLoading(false);
  }, [model]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4 space-y-3">
          <p className="text-sm text-muted-foreground">Enter a model identifier to view its evolution profile.</p>
          <div className="flex gap-2">
            <Input
              placeholder="e.g. gpt-4o, claude-opus-4, gemini-2.0…"
              value={model}
              onChange={e => setModel(e.target.value)}
              onKeyDown={e => e.key === "Enter" && load()}
              className="flex-1"
            />
            <Button onClick={load} disabled={loading || !model.trim()}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <TrendingUp className="w-4 h-4" />}
            </Button>
          </div>
          {err && <p className="text-red-500 text-xs">{err}</p>}
        </CardContent>
      </Card>

      {profile && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center justify-between">
              <span>{profile.model}</span>
              <div className="flex items-center gap-2">
                <Badge variant="secondary">Gen {profile.generation}</Badge>
                {profile.status && <Badge variant="outline">{profile.status}</Badge>}
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {profile.traits.map(t => (
              <div key={t.name} className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="capitalize">{t.name.replace(/_/g, " ")}</span>
                  <span className="font-mono text-xs">
                    {(t.value * 100).toFixed(1)}%
                    {t.delta !== undefined && (
                      <span className={`ml-1 text-xs ${t.delta >= 0 ? "text-green-500" : "text-red-500"}`}>
                        {t.delta >= 0 ? "+" : ""}{(t.delta * 100).toFixed(1)}
                      </span>
                    )}
                  </span>
                </div>
                <div className="w-full bg-muted rounded-full h-2">
                  <div className="bg-violet-500 h-2 rounded-full" style={{ width: `${t.value * 100}%` }} />
                </div>
              </div>
            ))}
            {profile.lastUpdated && (
              <p className="text-xs text-muted-foreground">Last updated: {new Date(profile.lastUpdated).toLocaleString()}</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Recompute Tab ────────────────────────────────────────────────────────────

function RecomputeTab() {
  const [model, setModel] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ message?: string; generation?: number } | null>(null);
  const [err, setErr] = useState("");

  const recompute = useCallback(async () => {
    setLoading(true); setErr(""); setResult(null);
    const body: Record<string, string> = {};
    if (model.trim()) body.model = model.trim();
    const r = await fetch("/api/member-evolution/recompute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (r?.ok) setResult(await r.json());
    else setErr("Recompute failed");
    setLoading(false);
  }, [model]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Trigger evolution weight recomputation. Leave model blank to recompute all.
          </p>
          <Input
            placeholder="Model (optional, blank = all)"
            value={model}
            onChange={e => setModel(e.target.value)}
          />
          {err && <p className="text-red-500 text-xs">{err}</p>}
          <Button onClick={recompute} disabled={loading}>
            {loading ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Recomputing…</> : <><RefreshCw className="w-4 h-4 mr-2" />Recompute</>}
          </Button>
        </CardContent>
      </Card>
      {result && (
        <Card className="border-green-200 dark:border-green-800">
          <CardContent className="pt-4 flex items-center gap-3">
            <CheckCircle className="w-5 h-5 text-green-500 shrink-0" />
            <div>
              <p className="text-sm font-medium">{result.message ?? "Recompute complete"}</p>
              {result.generation !== undefined && (
                <p className="text-xs text-muted-foreground">New generation: {result.generation}</p>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Apply Tab ────────────────────────────────────────────────────────────────

function ApplyTab() {
  const [sessionId, setSessionId] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ message?: string; applied?: number } | null>(null);
  const [err, setErr] = useState("");

  const apply = useCallback(async () => {
    setLoading(true); setErr(""); setResult(null);
    const body: Record<string, string> = {};
    if (sessionId.trim()) body.sessionId = sessionId.trim();
    const r = await fetch("/api/member-evolution/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (r?.ok) setResult(await r.json());
    else setErr("Apply failed");
    setLoading(false);
  }, [sessionId]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Apply the latest evolution weights to active sessions. Leave session ID blank to apply to all sessions.
          </p>
          <Input
            placeholder="Session ID (optional)"
            value={sessionId}
            onChange={e => setSessionId(e.target.value)}
          />
          {err && <p className="text-red-500 text-xs">{err}</p>}
          <Button onClick={apply} disabled={loading}>
            {loading ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Applying…</> : <><Play className="w-4 h-4 mr-2" />Apply Evolution</>}
          </Button>
        </CardContent>
      </Card>
      {result && (
        <Card className="border-green-200 dark:border-green-800">
          <CardContent className="pt-4 flex items-center gap-3">
            <CheckCircle className="w-5 h-5 text-green-500 shrink-0" />
            <div>
              <p className="text-sm font-medium">{result.message ?? "Evolution applied"}</p>
              {result.applied !== undefined && (
                <p className="text-xs text-muted-foreground">{result.applied} session(s) updated</p>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function MemberEvolution() {
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <TrendingUp className="w-6 h-6 text-violet-500" />
          Member Evolution
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Track and manage how council member personas adapt their traits over time
        </p>
      </div>
      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="recompute"><RefreshCw className="w-4 h-4 mr-1" />Recompute</TabsTrigger>
          <TabsTrigger value="apply"><Play className="w-4 h-4 mr-1" />Apply</TabsTrigger>
        </TabsList>
        <TabsContent value="profile" className="mt-4"><ProfileTab /></TabsContent>
        <TabsContent value="recompute" className="mt-4"><RecomputeTab /></TabsContent>
        <TabsContent value="apply" className="mt-4"><ApplyTab /></TabsContent>
      </Tabs>
    </div>
  );
}
