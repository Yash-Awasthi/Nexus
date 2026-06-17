/**
 * Honesty Tools — anti-sycophancy, confidence calibration, minority reports.
 *
 * Tab 1: Sycophancy Check — detect if an AI response is being sycophantic
 * Tab 2: Reframe — reframe a response to be more honest/direct
 * Tab 3: Confidence Calibration — assess and adjust confidence levels
 * Tab 4: Minority Report — surface contrarian or under-represented views
 *
 * API:
 *   GET  /api/honesty/modes
 *   POST /api/honesty/sycophancy-check
 *   POST /api/honesty/reframe
 *   POST /api/honesty/confidence-calibrate
 *   POST /api/honesty/score
 *   POST /api/honesty/minority-report
 */
import { useState, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Textarea } from "~/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import {
  Scale,
  Loader2,
  AlertTriangle,
  CheckCircle,
  MessageSquareDiff,
  BarChart2,
  Users,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SycophancyResult {
  sycophantic: boolean;
  score: number;
  patterns?: string[];
  explanation?: string;
}

interface ReframeResult {
  original: string;
  reframed: string;
  changes?: string[];
}

interface CalibrationResult {
  originalConfidence?: number;
  calibratedConfidence?: number;
  overconfident?: boolean;
  adjustedText?: string;
}

interface MinorityReport {
  mainView: string;
  minorityViews: { view: string; prevalence?: string; reasoning?: string }[];
  synthesis?: string;
}

// ─── Sycophancy Tab ───────────────────────────────────────────────────────────

function SycophancyTab() {
  const [prompt, setPrompt] = useState("");
  const [response, setResponse] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SycophancyResult | null>(null);
  const [err, setErr] = useState("");

  const check = useCallback(async () => {
    if (!response.trim()) return;
    setLoading(true); setErr(""); setResult(null);
    const r = await fetch("/api/honesty/sycophancy-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt.trim() || undefined, response: response.trim() }),
    }).catch(() => null);
    if (r?.ok) setResult(await r.json());
    else setErr("Check failed");
    setLoading(false);
  }, [prompt, response]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4 space-y-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">Original Prompt <span className="text-muted-foreground font-normal">(optional)</span></label>
            <Textarea rows={2} placeholder="What prompt produced this response?" value={prompt} onChange={e => setPrompt(e.target.value)} className="resize-none text-sm" />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">AI Response *</label>
            <Textarea rows={5} placeholder="Paste the AI response to check for sycophancy…" value={response} onChange={e => setResponse(e.target.value)} className="resize-none" />
          </div>
          {err && <p className="text-red-500 text-xs">{err}</p>}
          <Button onClick={check} disabled={loading || !response.trim()}>
            {loading ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Checking…</> : <><Scale className="w-4 h-4 mr-2" />Check Sycophancy</>}
          </Button>
        </CardContent>
      </Card>

      {result && (
        <Card className={result.sycophantic ? "border-orange-200 dark:border-orange-800" : "border-green-200 dark:border-green-800"}>
          <CardContent className="pt-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {result.sycophantic
                  ? <AlertTriangle className="w-5 h-5 text-orange-500" />
                  : <CheckCircle className="w-5 h-5 text-green-500" />}
                <span className={`font-semibold ${result.sycophantic ? "text-orange-600" : "text-green-600 dark:text-green-400"}`}>
                  {result.sycophantic ? "Sycophantic Response" : "Response Appears Honest"}
                </span>
              </div>
              <Badge className={result.score > 0.6 ? "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400" : "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"}>
                {Math.round(result.score * 100)}% sycophancy score
              </Badge>
            </div>
            {result.explanation && <p className="text-sm text-muted-foreground">{result.explanation}</p>}
            {result.patterns && result.patterns.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Detected patterns</p>
                {result.patterns.map((p, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <AlertTriangle className="w-3 h-3 text-orange-400 shrink-0" />
                    <span>{p}</span>
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

// ─── Reframe Tab ──────────────────────────────────────────────────────────────

function ReframeTab() {
  const [response, setResponse] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ReframeResult | null>(null);
  const [err, setErr] = useState("");

  const reframe = useCallback(async () => {
    if (!response.trim()) return;
    setLoading(true); setErr(""); setResult(null);
    const r = await fetch("/api/honesty/reframe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response: response.trim() }),
    }).catch(() => null);
    if (r?.ok) setResult(await r.json());
    else setErr("Reframe failed");
    setLoading(false);
  }, [response]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4 space-y-3">
          <label className="text-sm font-medium">Response to Reframe</label>
          <Textarea rows={5} placeholder="Paste a sycophantic or vague AI response to reframe as more direct…" value={response} onChange={e => setResponse(e.target.value)} className="resize-none" />
          {err && <p className="text-red-500 text-xs">{err}</p>}
          <Button onClick={reframe} disabled={loading || !response.trim()}>
            {loading ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Reframing…</> : <><MessageSquareDiff className="w-4 h-4 mr-2" />Reframe</>}
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
            <CardHeader className="pb-2"><CardTitle className="text-sm">Reframed (Honest)</CardTitle></CardHeader>
            <CardContent>
              <p className="text-sm">{result.reframed}</p>
              {result.changes && result.changes.length > 0 && (
                <div className="mt-3 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Changes made</p>
                  {result.changes.map((c, i) => <p key={i} className="text-xs text-muted-foreground">• {c}</p>)}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

// ─── Confidence Tab ───────────────────────────────────────────────────────────

function ConfidenceTab() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CalibrationResult | null>(null);
  const [err, setErr] = useState("");

  const calibrate = useCallback(async () => {
    if (!text.trim()) return;
    setLoading(true); setErr(""); setResult(null);
    const r = await fetch("/api/honesty/confidence-calibrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.trim() }),
    }).catch(() => null);
    if (r?.ok) setResult(await r.json());
    else setErr("Calibration failed");
    setLoading(false);
  }, [text]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4 space-y-3">
          <label className="text-sm font-medium">Text to Calibrate</label>
          <Textarea rows={5} placeholder="Paste a text with confidence claims to calibrate…" value={text} onChange={e => setText(e.target.value)} className="resize-none" />
          {err && <p className="text-red-500 text-xs">{err}</p>}
          <Button onClick={calibrate} disabled={loading || !text.trim()}>
            {loading ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Calibrating…</> : <><BarChart2 className="w-4 h-4 mr-2" />Calibrate Confidence</>}
          </Button>
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardContent className="pt-4 space-y-3">
            {result.originalConfidence !== undefined && result.calibratedConfidence !== undefined && (
              <div className="flex items-center gap-4 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Original</p>
                  <p className="text-xl font-bold">{Math.round(result.originalConfidence * 100)}%</p>
                </div>
                <span className="text-muted-foreground">→</span>
                <div>
                  <p className="text-xs text-muted-foreground">Calibrated</p>
                  <p className="text-xl font-bold text-primary">{Math.round(result.calibratedConfidence * 100)}%</p>
                </div>
                {result.overconfident && (
                  <Badge className="bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400 ml-auto">Overconfident</Badge>
                )}
              </div>
            )}
            {result.adjustedText && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Adjusted Text</p>
                <p className="text-sm whitespace-pre-wrap bg-muted/30 p-3 rounded-md">{result.adjustedText}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Minority Report Tab ──────────────────────────────────────────────────────

function MinorityTab() {
  const [topic, setTopic] = useState("");
  const [mainView, setMainView] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<MinorityReport | null>(null);
  const [err, setErr] = useState("");

  const generate = useCallback(async () => {
    if (!topic.trim()) return;
    setLoading(true); setErr(""); setResult(null);
    const r = await fetch("/api/honesty/minority-report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: topic.trim(), mainView: mainView.trim() || undefined }),
    }).catch(() => null);
    if (r?.ok) setResult(await r.json());
    else setErr("Failed to generate minority report");
    setLoading(false);
  }, [topic, mainView]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4 space-y-3">
          <p className="text-sm text-muted-foreground">Surface contrarian, minority, or under-represented viewpoints on any topic.</p>
          <div className="space-y-1">
            <label className="text-sm font-medium">Topic *</label>
            <Textarea rows={2} placeholder="e.g. remote work is always better than in-office…" value={topic} onChange={e => setTopic(e.target.value)} className="resize-none text-sm" />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Dominant View <span className="text-muted-foreground font-normal">(optional)</span></label>
            <Textarea rows={2} placeholder="Describe the mainstream position to challenge…" value={mainView} onChange={e => setMainView(e.target.value)} className="resize-none text-sm" />
          </div>
          {err && <p className="text-red-500 text-xs">{err}</p>}
          <Button onClick={generate} disabled={loading || !topic.trim()}>
            {loading ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Generating…</> : <><Users className="w-4 h-4 mr-2" />Generate Minority Report</>}
          </Button>
        </CardContent>
      </Card>

      {result && (
        <div className="space-y-3">
          {result.mainView && (
            <Card className="opacity-70">
              <CardContent className="pt-3 pb-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Dominant view</p>
                <p className="text-sm">{result.mainView}</p>
              </CardContent>
            </Card>
          )}
          {result.minorityViews.map((mv, i) => (
            <Card key={i} className="border-violet-200 dark:border-violet-800">
              <CardContent className="pt-3 pb-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm flex-1">{mv.view}</p>
                  {mv.prevalence && <Badge variant="outline" className="text-xs shrink-0">{mv.prevalence}</Badge>}
                </div>
                {mv.reasoning && <p className="text-xs text-muted-foreground mt-1">{mv.reasoning}</p>}
              </CardContent>
            </Card>
          ))}
          {result.synthesis && (
            <Card>
              <CardContent className="pt-3 pb-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Synthesis</p>
                <p className="text-sm">{result.synthesis}</p>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function Honesty() {
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Scale className="w-6 h-6 text-emerald-600" />
          Honesty Tools
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Detect sycophancy, reframe to be more direct, calibrate confidence, surface minority views
        </p>
      </div>

      <Tabs defaultValue="sycophancy">
        <TabsList>
          <TabsTrigger value="sycophancy"><Scale className="w-4 h-4 mr-1" />Sycophancy</TabsTrigger>
          <TabsTrigger value="reframe"><MessageSquareDiff className="w-4 h-4 mr-1" />Reframe</TabsTrigger>
          <TabsTrigger value="confidence"><BarChart2 className="w-4 h-4 mr-1" />Confidence</TabsTrigger>
          <TabsTrigger value="minority"><Users className="w-4 h-4 mr-1" />Minority Report</TabsTrigger>
        </TabsList>
        <TabsContent value="sycophancy" className="mt-4"><SycophancyTab /></TabsContent>
        <TabsContent value="reframe" className="mt-4"><ReframeTab /></TabsContent>
        <TabsContent value="confidence" className="mt-4"><ConfidenceTab /></TabsContent>
        <TabsContent value="minority" className="mt-4"><MinorityTab /></TabsContent>
      </Tabs>
    </div>
  );
}
