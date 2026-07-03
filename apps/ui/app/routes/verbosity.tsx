// SPDX-License-Identifier: Apache-2.0
/**
 * Verbosity — control and preview output verbosity levels.
 *
 * Tab 1: Levels — view available verbosity levels and their descriptions
 * Tab 2: Preview — preview how a prompt would render at a given verbosity
 *
 * API:
 *   GET  /api/verbosity/levels
 *   POST /api/verbosity/preview
 */
import { useState, useEffect, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Textarea } from "~/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Loader2, Volume2, Eye } from "lucide-react";

interface VerbosityLevel {
  id: string;
  label: string;
  description?: string;
  tokenMultiplier?: number;
}

interface PreviewResult {
  output: string;
  tokens?: number;
  level: string;
}

export default function Verbosity() {
  const [levels, setLevels] = useState<VerbosityLevel[]>([]);
  const [loadingLevels, setLoadingLevels] = useState(true);

  // Preview state
  const [prompt, setPrompt] = useState("");
  const [selectedLevel, setSelectedLevel] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/verbosity/levels")
      .then((r) => (r.ok ? r.json() : { levels: [] }))
      .then((d) => {
        const lvls = d.levels ?? d;
        setLevels(lvls);
        if (lvls.length) setSelectedLevel(lvls[0].id);
      })
      .catch(() => {})
      .finally(() => setLoadingLevels(false));
  }, []);

  const runPreview = useCallback(async () => {
    if (!prompt.trim() || !selectedLevel) return;
    setPreviewing(true);
    setErr("");
    setPreview(null);
    const r = await fetch("/api/verbosity/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt.trim(), level: selectedLevel }),
    }).catch(() => null);
    if (r?.ok) setPreview(await r.json());
    else setErr("Preview failed");
    setPreviewing(false);
  }, [prompt, selectedLevel]);

  const levelColor = (id: string) => {
    if (id === "minimal" || id === "concise")
      return "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400";
    if (id === "standard" || id === "normal")
      return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400";
    if (id === "verbose" || id === "detailed") return "bg-yellow-100 text-yellow-700";
    if (id === "exhaustive") return "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400";
    return "bg-slate-100 text-slate-600";
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Volume2 className="w-6 h-6 text-teal-500" />
          Verbosity
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Control how verbose model outputs are — from minimal to exhaustive
        </p>
      </div>

      <Tabs defaultValue="levels">
        <TabsList>
          <TabsTrigger value="levels">
            <Volume2 className="w-4 h-4 mr-1" />
            Levels
          </TabsTrigger>
          <TabsTrigger value="preview">
            <Eye className="w-4 h-4 mr-1" />
            Preview
          </TabsTrigger>
        </TabsList>

        {/* Levels */}
        <TabsContent value="levels" className="mt-4">
          {loadingLevels ? (
            <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading levels…
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 gap-3">
              {levels.map((l) => (
                <Card key={l.id}>
                  <CardContent className="pt-4 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-sm">{l.label}</span>
                      <Badge className={levelColor(l.id)}>{l.id}</Badge>
                    </div>
                    {l.description && (
                      <p className="text-xs text-muted-foreground">{l.description}</p>
                    )}
                    {l.tokenMultiplier !== undefined && (
                      <p className="text-xs text-muted-foreground">
                        Token multiplier: ×{l.tokenMultiplier}
                      </p>
                    )}
                  </CardContent>
                </Card>
              ))}
              {levels.length === 0 && (
                <Card className="col-span-2">
                  <CardContent className="pt-8 pb-8 text-center text-muted-foreground">
                    No levels configured
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </TabsContent>

        {/* Preview */}
        <TabsContent value="preview" className="mt-4 space-y-4">
          <Card>
            <CardContent className="pt-4 space-y-3">
              <Textarea
                rows={4}
                placeholder="Enter a prompt to preview at different verbosity levels…"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                className="resize-none"
              />
              {levels.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {levels.map((l) => (
                    <button
                      key={l.id}
                      onClick={() => setSelectedLevel(l.id)}
                      className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                        selectedLevel === l.id
                          ? "bg-primary text-primary-foreground border-primary"
                          : "border-border text-muted-foreground hover:border-primary/50"
                      }`}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              )}
              {err && <p className="text-red-500 text-xs">{err}</p>}
              <Button
                onClick={runPreview}
                disabled={previewing || !prompt.trim() || !selectedLevel}
              >
                {previewing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    Previewing…
                  </>
                ) : (
                  <>
                    <Eye className="w-4 h-4 mr-2" />
                    Preview
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

          {preview && (
            <Card className="border-teal-200 dark:border-teal-800">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center justify-between">
                  <span>
                    Preview — <Badge className={levelColor(preview.level)}>{preview.level}</Badge>
                  </span>
                  {preview.tokens !== undefined && (
                    <span className="text-xs text-muted-foreground font-normal">
                      {preview.tokens} tokens
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm whitespace-pre-wrap">{preview.output}</p>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
