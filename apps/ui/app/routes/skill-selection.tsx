/**
 * Skill Selection — select and preview the best skills for a given task.
 *
 * Tab 1: Select — run skill selection for a task prompt
 * Tab 2: Preview — preview how selected skills would handle a prompt
 *
 * API:
 *   POST /api/skill-selection/select
 *   POST /api/skill-selection/preview
 */
import { useState, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Textarea } from "~/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Loader2, Wrench, Eye, Star } from "lucide-react";

interface SkillMatch {
  skillId: string;
  name: string;
  score: number;
  reason?: string;
}

interface SelectResult {
  skills: SkillMatch[];
  primary?: string;
  reasoning?: string;
}

interface PreviewResult {
  output: string;
  skillsUsed: string[];
  tokens?: number;
}

// ─── Select Tab ───────────────────────────────────────────────────────────────

function SelectTab() {
  const [prompt, setPrompt] = useState("");
  const [topK, setTopK] = useState(3);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SelectResult | null>(null);
  const [err, setErr] = useState("");

  const select = useCallback(async () => {
    if (!prompt.trim()) return;
    setLoading(true); setErr(""); setResult(null);
    const r = await fetch("/api/skill-selection/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt.trim(), topK }),
    }).catch(() => null);
    if (r?.ok) setResult(await r.json());
    else setErr("Skill selection failed");
    setLoading(false);
  }, [prompt, topK]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4 space-y-3">
          <Textarea
            rows={4}
            placeholder="Describe the task to find the best skills for…"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            className="resize-none"
          />
          <div className="flex items-center gap-3">
            <label className="text-sm text-muted-foreground shrink-0">Top K:</label>
            <input
              type="range" min={1} max={10} step={1}
              value={topK}
              onChange={e => setTopK(parseInt(e.target.value))}
              className="flex-1 accent-primary"
            />
            <span className="text-sm font-mono w-4">{topK}</span>
          </div>
          {err && <p className="text-red-500 text-xs">{err}</p>}
          <Button onClick={select} disabled={loading || !prompt.trim()}>
            {loading ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Selecting…</> : <><Wrench className="w-4 h-4 mr-2" />Select Skills</>}
          </Button>
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Star className="w-4 h-4 text-amber-500" />
              {result.skills.length} skill(s) matched
              {result.primary && <Badge className="bg-amber-100 text-amber-700">{result.primary}</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {result.reasoning && <p className="text-xs text-muted-foreground">{result.reasoning}</p>}
            {result.skills.map((s, i) => (
              <div key={s.skillId} className="flex items-start gap-3">
                <span className="text-xs text-muted-foreground w-4 mt-1">{i + 1}</span>
                <div className="flex-1 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{s.name}</span>
                    <span className="text-xs text-muted-foreground">{Math.round(s.score * 100)}%</span>
                  </div>
                  <div className="w-full bg-muted rounded-full h-1.5">
                    <div className="bg-amber-500 h-1.5 rounded-full" style={{ width: `${s.score * 100}%` }} />
                  </div>
                  {s.reason && <p className="text-xs text-muted-foreground">{s.reason}</p>}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Preview Tab ──────────────────────────────────────────────────────────────

function PreviewTab() {
  const [prompt, setPrompt] = useState("");
  const [skillIds, setSkillIds] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [err, setErr] = useState("");

  const preview = useCallback(async () => {
    if (!prompt.trim()) return;
    setLoading(true); setErr(""); setResult(null);
    const body: Record<string, unknown> = { prompt: prompt.trim() };
    if (skillIds.trim()) body.skillIds = skillIds.split(",").map(s => s.trim()).filter(Boolean);
    const r = await fetch("/api/skill-selection/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (r?.ok) setResult(await r.json());
    else setErr("Preview failed");
    setLoading(false);
  }, [prompt, skillIds]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4 space-y-3">
          <Textarea
            rows={4}
            placeholder="Enter a prompt to preview with skill augmentation…"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            className="resize-none"
          />
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Skill IDs to apply (comma-separated, optional)</label>
            <input
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="skill-a, skill-b…"
              value={skillIds}
              onChange={e => setSkillIds(e.target.value)}
            />
          </div>
          {err && <p className="text-red-500 text-xs">{err}</p>}
          <Button onClick={preview} disabled={loading || !prompt.trim()}>
            {loading ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Previewing…</> : <><Eye className="w-4 h-4 mr-2" />Preview</>}
          </Button>
        </CardContent>
      </Card>

      {result && (
        <Card className="border-amber-200 dark:border-amber-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center justify-between">
              <div className="flex flex-wrap gap-1">
                {result.skillsUsed.map(s => (
                  <Badge key={s} variant="secondary" className="text-xs">{s}</Badge>
                ))}
              </div>
              {result.tokens !== undefined && (
                <span className="text-xs text-muted-foreground font-normal shrink-0">{result.tokens} tokens</span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap">{result.output}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function SkillSelection() {
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Wrench className="w-6 h-6 text-amber-500" />
          Skill Selection
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Automatically select and apply the best skill set for any task
        </p>
      </div>
      <Tabs defaultValue="select">
        <TabsList>
          <TabsTrigger value="select"><Wrench className="w-4 h-4 mr-1" />Select</TabsTrigger>
          <TabsTrigger value="preview"><Eye className="w-4 h-4 mr-1" />Preview</TabsTrigger>
        </TabsList>
        <TabsContent value="select" className="mt-4"><SelectTab /></TabsContent>
        <TabsContent value="preview" className="mt-4"><PreviewTab /></TabsContent>
      </Tabs>
    </div>
  );
}
