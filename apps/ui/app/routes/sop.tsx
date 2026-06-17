/**
 * SOPs — Standard Operating Procedures for AI workflows.
 *
 * Browse and run pre-defined SOPs (procedures with structured steps
 * that guide the AI through complex multi-step tasks).
 *
 * API:
 *   GET  /api/sop/templates
 *   POST /api/sop/run
 */
import { useState, useEffect, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
  ClipboardList,
  Loader2,
  Play,
  ChevronRight,
  CheckCircle,
  Loader,
  XCircle,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SOPTemplate {
  id: string;
  name: string;
  description?: string;
  category?: string;
  steps?: string[];
  inputs?: { name: string; label: string; required?: boolean }[];
  estimatedMinutes?: number;
}

interface SOPResult {
  sopId?: string;
  stepResults: {
    stepNumber: number;
    stepName?: string;
    output: string;
    status: "done" | "failed" | "skipped";
  }[];
  finalOutput?: string;
  success: boolean;
  durationMs?: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function SOP() {
  const [templates, setTemplates] = useState<SOPTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<SOPTemplate | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SOPResult | null>(null);
  const [filter, setFilter] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/sop/templates")
      .then(r => r.ok ? r.json() : { templates: [] })
      .then(d => setTemplates(d.templates ?? d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const selectTemplate = (t: SOPTemplate) => {
    setSelected(t);
    setInputs({});
    setResult(null);
    setErr("");
  };

  const run = useCallback(async () => {
    if (!selected) return;
    setRunning(true); setErr(""); setResult(null);
    const r = await fetch("/api/sop/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sopId: selected.id, inputs }),
    }).catch(() => null);
    if (r?.ok) setResult(await r.json());
    else setErr("SOP run failed");
    setRunning(false);
  }, [selected, inputs]);

  const categories = Array.from(new Set(templates.map(t => t.category).filter(Boolean)));
  const filtered = templates.filter(t =>
    t.name.toLowerCase().includes(filter.toLowerCase()) ||
    (t.description ?? "").toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ClipboardList className="w-6 h-6 text-indigo-500" />
          Standard Operating Procedures
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Run pre-defined multi-step AI procedures for complex structured tasks
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
          <Loader2 className="w-5 h-5 animate-spin" />Loading SOPs…
        </div>
      ) : (
        <div className="grid md:grid-cols-3 gap-6">
          {/* Template browser */}
          <div className="space-y-3">
            <Input
              placeholder="Search SOPs…"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              className="h-8 text-sm"
            />
            {filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground">No SOPs found</p>
            ) : (
              filtered.map(t => (
                <button
                  key={t.id}
                  onClick={() => selectTemplate(t)}
                  className={`w-full text-left border rounded-lg p-3 hover:bg-muted/40 transition-colors group ${selected?.id === t.id ? "bg-muted border-primary/30" : ""}`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{t.name}</p>
                      {t.description && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{t.description}</p>}
                      <div className="flex items-center gap-2 mt-1.5">
                        {t.category && <Badge variant="secondary" className="text-xs">{t.category}</Badge>}
                        {t.steps && <span className="text-xs text-muted-foreground">{t.steps.length} steps</span>}
                        {t.estimatedMinutes && <span className="text-xs text-muted-foreground">~{t.estimatedMinutes}min</span>}
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 group-hover:text-primary mt-0.5" />
                  </div>
                </button>
              ))
            )}
          </div>

          {/* Run panel */}
          <div className="md:col-span-2 space-y-4">
            {!selected ? (
              <div className="flex items-center justify-center h-48 text-muted-foreground border rounded-lg border-dashed">
                <div className="text-center">
                  <ClipboardList className="w-10 h-10 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">Select an SOP to run</p>
                </div>
              </div>
            ) : (
              <>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center justify-between">
                      <span>{selected.name}</span>
                      {selected.estimatedMinutes && (
                        <Badge variant="outline">~{selected.estimatedMinutes} min</Badge>
                      )}
                    </CardTitle>
                    {selected.description && (
                      <p className="text-sm text-muted-foreground">{selected.description}</p>
                    )}
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {/* Step preview */}
                    {selected.steps && selected.steps.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Steps</p>
                        {selected.steps.map((step, i) => (
                          <div key={i} className="flex items-center gap-2 text-sm text-muted-foreground">
                            <span className="w-5 h-5 rounded-full bg-muted text-xs flex items-center justify-center shrink-0">{i + 1}</span>
                            {step}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Inputs */}
                    {selected.inputs && selected.inputs.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Inputs</p>
                        {selected.inputs.map(inp => (
                          <div key={inp.name} className="space-y-1">
                            <label className="text-sm font-medium">
                              {inp.label} {inp.required && <span className="text-red-500">*</span>}
                            </label>
                            <Input
                              placeholder={`Enter ${inp.label.toLowerCase()}…`}
                              value={inputs[inp.name] ?? ""}
                              onChange={e => setInputs(prev => ({ ...prev, [inp.name]: e.target.value }))}
                            />
                          </div>
                        ))}
                      </div>
                    )}

                    {err && <p className="text-red-500 text-xs">{err}</p>}

                    <Button onClick={run} disabled={running} className="w-full">
                      {running ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Running SOP…</> : <><Play className="w-4 h-4 mr-2" />Run SOP</>}
                    </Button>
                  </CardContent>
                </Card>

                {/* Results */}
                {result && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      {result.success
                        ? <CheckCircle className="w-5 h-5 text-green-500" />
                        : <XCircle className="w-5 h-5 text-red-500" />}
                      <span className="font-medium">{result.success ? "SOP Completed Successfully" : "SOP Failed"}</span>
                      {result.durationMs && <Badge variant="outline">{(result.durationMs / 1000).toFixed(1)}s</Badge>}
                    </div>

                    {/* Step results */}
                    <div className="space-y-2">
                      {result.stepResults.map(step => (
                        <Card key={step.stepNumber} className={step.status === "failed" ? "border-red-200 dark:border-red-800" : step.status === "skipped" ? "opacity-50" : ""}>
                          <CardContent className="pt-3 pb-3">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="w-5 h-5 rounded-full bg-muted text-xs flex items-center justify-center shrink-0">{step.stepNumber}</span>
                              <span className="text-sm font-medium">{step.stepName ?? `Step ${step.stepNumber}`}</span>
                              <Badge variant={step.status === "done" ? "default" : step.status === "failed" ? "destructive" : "secondary"} className="text-xs ml-auto">
                                {step.status}
                              </Badge>
                            </div>
                            <p className="text-sm text-muted-foreground line-clamp-3">{step.output}</p>
                          </CardContent>
                        </Card>
                      ))}
                    </div>

                    {result.finalOutput && (
                      <Card className="border-primary/20">
                        <CardHeader className="pb-2"><CardTitle className="text-sm">Final Output</CardTitle></CardHeader>
                        <CardContent>
                          <p className="text-sm whitespace-pre-wrap">{result.finalOutput}</p>
                        </CardContent>
                      </Card>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
