// SPDX-License-Identifier: Apache-2.0
/**
 * Structured Extraction — extract typed data from unstructured text.
 *
 * Define a JSON schema, run extraction on raw text, and get back a
 * structured object. Supports schema management, schema inference,
 * and job history.
 *
 * API:
 *   GET    /api/extraction/schemas
 *   POST   /api/extraction/schemas
 *   PUT    /api/extraction/schemas/:id
 *   DELETE /api/extraction/schemas/:id
 *   POST   /api/extraction/run
 *   GET    /api/extraction/jobs
 *   GET    /api/extraction/jobs/:id
 *   DELETE /api/extraction/jobs/:id
 *   POST   /api/extraction/preview
 *   GET    /api/extraction/templates
 *   POST   /api/extraction/infer-schema
 *   GET    /api/extraction/jobs/:id/export
 */
import { useState, useEffect, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import {
  Braces,
  Play,
  Loader2,
  RefreshCw,
  Plus,
  Trash2,
  Download,
  Wand2,
  FileJson,
  History,
  CheckCircle,
  XCircle,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExtractionSchema {
  id: string;
  name: string;
  schema: object;
  description?: string;
  createdAt: string;
}

interface ExtractionJob {
  id: string;
  schemaId?: string;
  schemaName?: string;
  status: "pending" | "running" | "done" | "failed";
  result?: object;
  error?: string;
  createdAt: string;
  durationMs?: number;
}

interface Template {
  id: string;
  name: string;
  schema: object;
  description?: string;
}

// ─── Run Tab ──────────────────────────────────────────────────────────────────

function RunTab({ schemas, templates }: { schemas: ExtractionSchema[]; templates: Template[] }) {
  const [text, setText] = useState("");
  const [schemaId, setSchemaId] = useState("");
  const [customSchema, setCustomSchema] = useState("");
  const [useCustom, setUseCustom] = useState(false);
  const [inferring, setInferring] = useState(false);
  const [running, setRunning] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [result, setResult] = useState<object | null>(null);
  const [preview, setPreview] = useState<object | null>(null);
  const [err, setErr] = useState("");

  const inferSchema = useCallback(async () => {
    if (!text.trim()) return;
    setInferring(true);
    setErr("");
    const r = await fetch("/api/extraction/infer-schema", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.trim() }),
    }).catch(() => null);
    if (r?.ok) {
      const d = await r.json();
      setCustomSchema(JSON.stringify(d.schema ?? d, null, 2));
      setUseCustom(true);
    } else setErr("Schema inference failed");
    setInferring(false);
  }, [text]);

  const runPreview = useCallback(async () => {
    if (!text.trim()) return;
    setPreviewing(true);
    setErr("");
    setPreview(null);
    const body: Record<string, unknown> = { text: text.trim() };
    if (useCustom && customSchema.trim()) {
      try {
        body.schema = JSON.parse(customSchema);
      } catch {
        setErr("Invalid JSON schema");
        setPreviewing(false);
        return;
      }
    } else if (schemaId) body.schemaId = schemaId;
    const r = await fetch("/api/extraction/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (r?.ok) setPreview(await r.json());
    else setErr("Preview failed");
    setPreviewing(false);
  }, [text, useCustom, customSchema, schemaId]);

  const run = useCallback(async () => {
    if (!text.trim()) return;
    setRunning(true);
    setErr("");
    setResult(null);
    const body: Record<string, unknown> = { text: text.trim() };
    if (useCustom && customSchema.trim()) {
      try {
        body.schema = JSON.parse(customSchema);
      } catch {
        setErr("Invalid JSON schema");
        setRunning(false);
        return;
      }
    } else if (schemaId) body.schemaId = schemaId;
    const r = await fetch("/api/extraction/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (r?.ok) setResult(await r.json());
    else setErr("Extraction failed");
    setRunning(false);
  }, [text, useCustom, customSchema, schemaId]);

  return (
    <div className="space-y-4">
      <div className="grid md:grid-cols-2 gap-4">
        {/* Input */}
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">Source Text *</label>
            <Textarea
              rows={8}
              placeholder="Paste unstructured text to extract data from…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="resize-none"
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium">Schema</label>
              <button
                className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${useCustom ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                onClick={() => setUseCustom(true)}
              >
                Custom
              </button>
              <button
                className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${!useCustom ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                onClick={() => setUseCustom(false)}
              >
                Saved
              </button>
            </div>
            {useCustom ? (
              <Textarea
                rows={6}
                placeholder={`{\n  "name": { "type": "string" },\n  "date": { "type": "string" }\n}`}
                value={customSchema}
                onChange={(e) => setCustomSchema(e.target.value)}
                className="resize-none font-mono text-xs"
              />
            ) : (
              <select
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={schemaId}
                onChange={(e) => setSchemaId(e.target.value)}
              >
                <option value="">No schema (auto-detect)</option>
                {schemas.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
                {templates.length > 0 && (
                  <optgroup label="Templates">
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            )}
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={inferSchema}
              disabled={inferring || !text.trim()}
            >
              {inferring ? (
                <Loader2 className="w-3 h-3 animate-spin mr-1" />
              ) : (
                <Wand2 className="w-3 h-3 mr-1" />
              )}
              Infer schema
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={runPreview}
              disabled={previewing || !text.trim()}
            >
              {previewing ? (
                <Loader2 className="w-3 h-3 animate-spin mr-1" />
              ) : (
                <Play className="w-3 h-3 mr-1" />
              )}
              Preview
            </Button>
            <Button size="sm" onClick={run} disabled={running || !text.trim()}>
              {running ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-1" />
                  Extracting…
                </>
              ) : (
                <>
                  <Braces className="w-4 h-4 mr-1" />
                  Extract
                </>
              )}
            </Button>
          </div>
          {err && <p className="text-red-500 text-xs">{err}</p>}
        </div>

        {/* Output */}
        <div className="space-y-3">
          {preview && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
                Preview (not saved)
              </p>
              <pre className="text-xs bg-muted p-3 rounded-md overflow-auto max-h-40">
                {JSON.stringify(preview, null, 2)}
              </pre>
            </div>
          )}
          {result && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
                Extraction Result
              </p>
              <pre className="text-xs bg-muted p-3 rounded-md overflow-auto max-h-64 whitespace-pre-wrap">
                {JSON.stringify(result, null, 2)}
              </pre>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => {
                  const blob = new Blob([JSON.stringify(result, null, 2)], {
                    type: "application/json",
                  });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "extraction.json";
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                <Download className="w-3 h-3 mr-1" />
                Download JSON
              </Button>
            </div>
          )}
          {!preview && !result && (
            <div className="border rounded-lg min-h-[200px] flex items-center justify-center bg-muted/30">
              <div className="text-center text-muted-foreground">
                <Braces className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p className="text-sm">Extracted data will appear here</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Schemas Tab ──────────────────────────────────────────────────────────────

function SchemasTab({
  schemas,
  onRefresh,
}: {
  schemas: ExtractionSchema[];
  onRefresh: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSchema, setNewSchema] = useState("{}");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const create = useCallback(async () => {
    if (!newName.trim()) {
      setErr("Name required");
      return;
    }
    let parsedSchema;
    try {
      parsedSchema = JSON.parse(newSchema);
    } catch {
      setErr("Invalid JSON");
      return;
    }
    setSaving(true);
    setErr("");
    const r = await fetch("/api/extraction/schemas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), schema: parsedSchema }),
    }).catch(() => null);
    if (r?.ok) {
      setCreating(false);
      setNewName("");
      setNewSchema("{}");
      onRefresh();
    } else setErr("Create failed");
    setSaving(false);
  }, [newName, newSchema, onRefresh]);

  const del = useCallback(
    async (id: string) => {
      if (!confirm("Delete schema?")) return;
      setDeleting(id);
      await fetch(`/api/extraction/schemas/${id}`, { method: "DELETE" }).catch(() => {});
      onRefresh();
      setDeleting(null);
    },
    [onRefresh],
  );

  return (
    <div className="space-y-3">
      {schemas.length === 0 && !creating ? (
        <Card>
          <CardContent className="pt-8 pb-8 text-center space-y-3">
            <FileJson className="w-12 h-12 mx-auto text-muted-foreground opacity-40" />
            <p className="text-muted-foreground">No schemas saved yet</p>
            <Button size="sm" onClick={() => setCreating(true)}>
              Add schema
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {schemas.map((s) => (
            <Card key={s.id}>
              <CardContent className="pt-3 pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{s.name}</p>
                    <pre className="text-xs text-muted-foreground mt-1 truncate">
                      {JSON.stringify(s.schema)}
                    </pre>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-red-400 shrink-0"
                    onClick={() => del(s.id)}
                    disabled={deleting === s.id}
                  >
                    {deleting === s.id ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Trash2 className="w-3 h-3" />
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
          <Button size="sm" variant="outline" onClick={() => setCreating(!creating)}>
            <Plus className="w-4 h-4 mr-1" />
            {creating ? "Cancel" : "New schema"}
          </Button>
        </>
      )}

      {creating && (
        <Card>
          <CardContent className="pt-4 space-y-3">
            <Input
              placeholder="Schema name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <Textarea
              rows={6}
              placeholder={
                '{\n  "company": { "type": "string" },\n  "revenue": { "type": "number" }\n}'
              }
              value={newSchema}
              onChange={(e) => setNewSchema(e.target.value)}
              className="resize-none font-mono text-xs"
            />
            {err && <p className="text-red-500 text-xs">{err}</p>}
            <div className="flex gap-2">
              <Button size="sm" onClick={create} disabled={saving}>
                {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Jobs Tab ─────────────────────────────────────────────────────────────────

function JobsTab() {
  const [jobs, setJobs] = useState<ExtractionJob[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/extraction/jobs")
      .then((r) => (r.ok ? r.json() : { jobs: [] }))
      .then((d) => {
        setJobs(d.jobs ?? d);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const exportJob = async (id: string) => {
    const r = await fetch(`/api/extraction/jobs/${id}/export`).catch(() => null);
    if (!r?.ok) return;
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `extraction-${id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const deleteJob = async (id: string) => {
    await fetch(`/api/extraction/jobs/${id}`, { method: "DELETE" }).catch(() => {});
    setJobs((prev) => prev.filter((j) => j.id !== id));
  };

  if (loading)
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading…
      </div>
    );
  if (!jobs.length)
    return (
      <Card>
        <CardContent className="pt-8 pb-8 text-center text-muted-foreground">
          No extraction jobs yet
        </CardContent>
      </Card>
    );

  return (
    <div className="space-y-2">
      {jobs.map((j) => (
        <Card key={j.id}>
          <CardContent className="pt-3 pb-3">
            <div className="flex items-center gap-3">
              {j.status === "done" ? (
                <CheckCircle className="w-4 h-4 text-green-500 shrink-0" />
              ) : j.status === "failed" ? (
                <XCircle className="w-4 h-4 text-red-500 shrink-0" />
              ) : (
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{j.schemaName ?? "Custom schema"}</span>
                  <Badge
                    variant={
                      j.status === "done"
                        ? "default"
                        : j.status === "failed"
                          ? "destructive"
                          : "secondary"
                    }
                    className="text-xs"
                  >
                    {j.status}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {new Date(j.createdAt).toLocaleString()}
                  {j.durationMs ? ` · ${j.durationMs}ms` : ""}
                </p>
              </div>
              <div className="flex gap-1 shrink-0">
                {j.status === "done" && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => exportJob(j.id)}
                  >
                    <Download className="w-3 h-3" />
                  </Button>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-red-400"
                  onClick={() => deleteJob(j.id)}
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function Extraction() {
  const [schemas, setSchemas] = useState<ExtractionSchema[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);

  const loadSchemas = useCallback(async () => {
    setLoading(true);
    const [sr, tr] = await Promise.allSettled([
      fetch("/api/extraction/schemas").then((r) => (r.ok ? r.json() : { schemas: [] })),
      fetch("/api/extraction/templates").then((r) => (r.ok ? r.json() : [])),
    ]);
    if (sr.status === "fulfilled") setSchemas(sr.value.schemas ?? sr.value);
    if (tr.status === "fulfilled") setTemplates(tr.value.templates ?? tr.value);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadSchemas();
  }, [loadSchemas]);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Braces className="w-6 h-6 text-amber-500" />
          Structured Extraction
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Extract typed, structured data from unstructured text using schemas
        </p>
      </div>

      <Tabs defaultValue="run">
        <TabsList>
          <TabsTrigger value="run">
            <Play className="w-4 h-4 mr-1" />
            Extract
          </TabsTrigger>
          <TabsTrigger value="schemas">
            <FileJson className="w-4 h-4 mr-1" />
            Schemas
          </TabsTrigger>
          <TabsTrigger value="jobs">
            <History className="w-4 h-4 mr-1" />
            Job History
          </TabsTrigger>
        </TabsList>
        <TabsContent value="run" className="mt-4">
          <RunTab schemas={schemas} templates={templates} />
        </TabsContent>
        <TabsContent value="schemas" className="mt-4">
          <SchemasTab schemas={schemas} onRefresh={loadSchemas} />
        </TabsContent>
        <TabsContent value="jobs" className="mt-4">
          <JobsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
