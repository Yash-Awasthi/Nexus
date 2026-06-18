/**
 * Echo Chamber Detector — detect and break sycophantic AI agreement loops.
 *
 * Tab 1: Detect — analyze a conversation thread for echo chamber patterns
 * Tab 2: Inject Dissent — inject a contrarian perspective into a conversation
 * Tab 3: Config — configure echo chamber detection settings
 *
 * API:
 *   POST  /api/echo-chamber/detect
 *   POST  /api/echo-chamber/inject-dissent
 *   GET   /api/echo-chamber/config
 *   PATCH /api/echo-chamber/config
 */
import { useState, useEffect, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Textarea } from "~/components/ui/textarea";
import { Input } from "~/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import {
  Waves,
  AlertTriangle,
  MessageSquarePlus,
  Settings,
  Loader2,
  CheckCircle,
  XCircle,
  ThumbsDown,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface EchoChamberResult {
  detected: boolean;
  score: number;
  patterns?: { type: string; description: string; severity: "low" | "medium" | "high" }[];
  explanation?: string;
  recommendation?: string;
}

interface DissentResult {
  dissent: string;
  tone?: string;
  perspective?: string;
}

interface EchoConfig {
  enabled: boolean;
  threshold: number;
  autoInjectDissent: boolean;
  aggressiveness?: "gentle" | "moderate" | "strong";
}

// ─── Detect Tab ───────────────────────────────────────────────────────────────

function DetectTab() {
  const [conversation, setConversation] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<EchoChamberResult | null>(null);
  const [err, setErr] = useState("");

  const detect = useCallback(async () => {
    if (!conversation.trim()) return;
    setLoading(true); setErr(""); setResult(null);
    const r = await fetch("/api/echo-chamber/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation: conversation.trim() }),
    }).catch(() => null);
    if (r?.ok) setResult(await r.json());
    else setErr("Detection failed");
    setLoading(false);
  }, [conversation]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Paste a conversation to analyze for echo chamber patterns — excessive agreement, sycophancy, groupthink, or lack of critical pushback.
          </p>
          <Textarea
            rows={8}
            placeholder={"User: I think X is the best approach.\nAI: Absolutely, X is a great choice!\nUser: Yeah, I thought so. X is clearly superior.\nAI: You're right, X is definitely the best option…"}
            value={conversation}
            onChange={e => setConversation(e.target.value)}
            className="resize-none font-mono text-xs"
          />
          {err && <p className="text-red-500 text-xs">{err}</p>}
          <Button onClick={detect} disabled={loading || !conversation.trim()}>
            {loading ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Analyzing…</> : <><Waves className="w-4 h-4 mr-2" />Detect Echo Chamber</>}
          </Button>
        </CardContent>
      </Card>

      {result && (
        <Card className={result.detected ? "border-orange-200 dark:border-orange-800" : "border-green-200 dark:border-green-800"}>
          <CardContent className="pt-4 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {result.detected
                  ? <AlertTriangle className="w-5 h-5 text-orange-500" />
                  : <CheckCircle className="w-5 h-5 text-green-500" />}
                <span className={`font-semibold ${result.detected ? "text-orange-600" : "text-green-600 dark:text-green-400"}`}>
                  {result.detected ? "Echo Chamber Detected" : "No Echo Chamber Detected"}
                </span>
              </div>
              <Badge className={
                result.score > 0.7 ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
                : result.score > 0.4 ? "bg-orange-100 text-orange-700"
                : "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
              }>
                Score: {Math.round(result.score * 100)}%
              </Badge>
            </div>
            {result.explanation && <p className="text-sm text-muted-foreground">{result.explanation}</p>}
            {result.patterns && result.patterns.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Patterns found</p>
                {result.patterns.map((p, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm">
                    <Badge className={
                      p.severity === "high" ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400 shrink-0"
                      : p.severity === "medium" ? "bg-orange-100 text-orange-700 shrink-0"
                      : "bg-yellow-100 text-yellow-700 shrink-0"
                    }>
                      {p.severity}
                    </Badge>
                    <div>
                      <span className="font-medium capitalize">{p.type.replace(/_/g, " ")}</span>
                      <p className="text-muted-foreground text-xs">{p.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {result.recommendation && (
              <div className="bg-muted/50 rounded-lg p-3 text-sm">
                <p className="font-medium mb-1">Recommendation</p>
                <p className="text-muted-foreground">{result.recommendation}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Dissent Tab ──────────────────────────────────────────────────────────────

function DissentTab() {
  const [conversation, setConversation] = useState("");
  const [topic, setTopic] = useState("");
  const [tone, setTone] = useState("balanced");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DissentResult | null>(null);
  const [err, setErr] = useState("");

  const inject = useCallback(async () => {
    if (!conversation.trim()) return;
    setLoading(true); setErr(""); setResult(null);
    const r = await fetch("/api/echo-chamber/inject-dissent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation: conversation.trim(), topic: topic.trim() || undefined, tone }),
    }).catch(() => null);
    if (r?.ok) setResult(await r.json());
    else setErr("Dissent injection failed");
    setLoading(false);
  }, [conversation, topic, tone]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Generate a contrarian perspective to inject into an echo chamber conversation.
          </p>
          <Textarea
            rows={6}
            placeholder="Paste the conversation to inject dissent into…"
            value={conversation}
            onChange={e => setConversation(e.target.value)}
            className="resize-none text-sm"
          />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Topic focus <span className="text-muted-foreground font-normal">(optional)</span></label>
              <Input placeholder="e.g. technical feasibility" value={topic} onChange={e => setTopic(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Tone</label>
              <select
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={tone}
                onChange={e => setTone(e.target.value)}
              >
                {["socratic", "devil's advocate", "balanced", "direct", "firm"].map(t => (
                  <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                ))}
              </select>
            </div>
          </div>
          {err && <p className="text-red-500 text-xs">{err}</p>}
          <Button onClick={inject} disabled={loading || !conversation.trim()}>
            {loading ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Generating…</> : <><MessageSquarePlus className="w-4 h-4 mr-2" />Inject Dissent</>}
          </Button>
        </CardContent>
      </Card>

      {result && (
        <Card className="border-violet-200 dark:border-violet-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <ThumbsDown className="w-4 h-4 text-violet-500" />
              Generated Dissent
              {result.tone && <Badge variant="outline">{result.tone}</Badge>}
              {result.perspective && <Badge variant="outline">{result.perspective}</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap">{result.dissent}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Config Tab ───────────────────────────────────────────────────────────────

function ConfigTab() {
  const [config, setConfig] = useState<EchoConfig | null>(null);
  const [edit, setEdit] = useState<Partial<EchoConfig>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    fetch("/api/echo-chamber/config").then(r => r.ok ? r.json() : null).then(d => {
      if (d) { setConfig(d); setEdit(d); }
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const save = useCallback(async () => {
    setSaving(true); setMsg("");
    const r = await fetch("/api/echo-chamber/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(edit),
    }).catch(() => null);
    if (r?.ok) { const d = await r.json(); setConfig(d); setEdit(d); setMsg("Saved"); }
    setSaving(false);
  }, [edit]);

  if (loading) return <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center"><Loader2 className="w-4 h-4 animate-spin" />Loading…</div>;
  if (!config) return <Card><CardContent className="pt-8 pb-8 text-center text-muted-foreground">Config unavailable</CardContent></Card>;

  return (
    <Card>
      <CardContent className="pt-4 space-y-4">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium">Echo Chamber Detection Enabled</label>
          <button
            onClick={() => setEdit(prev => ({ ...prev, enabled: !prev.enabled }))}
            className={`w-12 h-6 rounded-full transition-colors relative ${edit.enabled ? "bg-primary" : "bg-slate-300 dark:bg-slate-600"}`}
          >
            <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${edit.enabled ? "translate-x-6" : "translate-x-0.5"}`} />
          </button>
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium flex justify-between">
            Detection Threshold <span className="font-normal text-muted-foreground">{Math.round((edit.threshold ?? 0.6) * 100)}%</span>
          </label>
          <input
            type="range" min={0.1} max={1.0} step={0.05}
            value={edit.threshold ?? 0.6}
            onChange={e => setEdit(prev => ({ ...prev, threshold: parseFloat(e.target.value) }))}
            className="w-full accent-primary"
          />
          <div className="flex justify-between text-xs text-muted-foreground"><span>More sensitive</span><span>Less sensitive</span></div>
        </div>
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium">Auto-inject dissent</label>
          <button
            onClick={() => setEdit(prev => ({ ...prev, autoInjectDissent: !prev.autoInjectDissent }))}
            className={`w-12 h-6 rounded-full transition-colors relative ${edit.autoInjectDissent ? "bg-primary" : "bg-slate-300 dark:bg-slate-600"}`}
          >
            <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${edit.autoInjectDissent ? "translate-x-6" : "translate-x-0.5"}`} />
          </button>
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">Aggressiveness</label>
          <select
            className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={edit.aggressiveness ?? "moderate"}
            onChange={e => setEdit(prev => ({ ...prev, aggressiveness: e.target.value as EchoConfig["aggressiveness"] }))}
          >
            {["gentle", "moderate", "strong"].map(a => <option key={a} value={a}>{a.charAt(0).toUpperCase() + a.slice(1)}</option>)}
          </select>
        </div>
        {msg && <p className="text-green-600 dark:text-green-400 text-xs">{msg}</p>}
        <Button onClick={save} disabled={saving}>
          {saving ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Saving…</> : "Save Config"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function EchoChamber() {
  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Waves className="w-6 h-6 text-violet-500" />
          Echo Chamber Detector
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Detect sycophantic agreement loops and inject critical perspectives
        </p>
      </div>

      <Tabs defaultValue="detect">
        <TabsList>
          <TabsTrigger value="detect"><Waves className="w-4 h-4 mr-1" />Detect</TabsTrigger>
          <TabsTrigger value="dissent"><MessageSquarePlus className="w-4 h-4 mr-1" />Inject Dissent</TabsTrigger>
          <TabsTrigger value="config"><Settings className="w-4 h-4 mr-1" />Config</TabsTrigger>
        </TabsList>
        <TabsContent value="detect" className="mt-4"><DetectTab /></TabsContent>
        <TabsContent value="dissent" className="mt-4"><DissentTab /></TabsContent>
        <TabsContent value="config" className="mt-4"><ConfigTab /></TabsContent>
      </Tabs>
    </div>
  );
}
