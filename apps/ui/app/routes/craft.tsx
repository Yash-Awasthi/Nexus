// SPDX-License-Identifier: Apache-2.0
/**
 * Craft — AI-powered document generation from templates.
 *
 * Browse template gallery, fill in parameters, generate polished
 * documents (proposals, reports, emails, specs), view history,
 * and download outputs.
 *
 * API:
 *   GET  /api/craft/templates
 *   POST /api/craft/generate
 *   GET  /api/craft
 *   GET  /api/craft/:craftId
 *   GET  /api/craft/:craftId/download
 *   DELETE /api/craft/:craftId
 */
import { useState, useEffect, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import {
  PenTool,
  Loader2,
  Download,
  Trash2,
  Play,
  FileText,
  History,
  RefreshCw,
  ChevronRight,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CraftTemplate {
  id: string;
  name: string;
  description?: string;
  category?: string;
  fields?: {
    name: string;
    label: string;
    type: "text" | "textarea" | "select";
    options?: string[];
    required?: boolean;
  }[];
  exampleOutput?: string;
}

interface CraftDocument {
  id: string;
  templateId?: string;
  templateName?: string;
  title?: string;
  content?: string;
  createdAt: string;
  status: "generating" | "done" | "failed";
  wordCount?: number;
}

// ─── Generate Tab ─────────────────────────────────────────────────────────────

function GenerateTab({ templates }: { templates: CraftTemplate[] }) {
  const [selectedTemplate, setSelectedTemplate] = useState<CraftTemplate | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<CraftDocument | null>(null);
  const [err, setErr] = useState("");

  const selectTemplate = (t: CraftTemplate) => {
    setSelectedTemplate(t);
    setFields({});
    setResult(null);
  };

  const generate = useCallback(async () => {
    if (!selectedTemplate) return;
    setGenerating(true);
    setErr("");
    setResult(null);
    const r = await fetch("/api/craft/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: selectedTemplate.id, fields }),
    }).catch(() => null);
    if (r?.ok) setResult(await r.json());
    else setErr("Generation failed");
    setGenerating(false);
  }, [selectedTemplate, fields]);

  const downloadDoc = async (craftId: string) => {
    const r = await fetch(`/api/craft/${craftId}/download`).catch(() => null);
    if (!r?.ok) return;
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `craft-${craftId}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const categories = Array.from(new Set(templates.map((t) => t.category).filter(Boolean)));

  return (
    <div className="space-y-4">
      {/* Template gallery */}
      {!selectedTemplate ? (
        <div className="space-y-4">
          {categories.length > 0 ? (
            categories.map((cat) => (
              <div key={cat}>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                  {cat}
                </p>
                <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-3">
                  {templates
                    .filter((t) => t.category === cat)
                    .map((t) => (
                      <button
                        key={t.id}
                        onClick={() => selectTemplate(t)}
                        className="text-left border rounded-lg p-3 hover:border-primary/40 hover:bg-muted/30 transition-colors group"
                      >
                        <div className="flex items-start justify-between">
                          <div>
                            <p className="text-sm font-medium">{t.name}</p>
                            {t.description && (
                              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                                {t.description}
                              </p>
                            )}
                          </div>
                          <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary shrink-0 mt-0.5" />
                        </div>
                      </button>
                    ))}
                </div>
              </div>
            ))
          ) : (
            <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-3">
              {templates.map((t) => (
                <button
                  key={t.id}
                  onClick={() => selectTemplate(t)}
                  className="text-left border rounded-lg p-3 hover:border-primary/40 hover:bg-muted/30 transition-colors"
                >
                  <p className="text-sm font-medium">{t.name}</p>
                  {t.description && (
                    <p className="text-xs text-muted-foreground mt-0.5">{t.description}</p>
                  )}
                </button>
              ))}
            </div>
          )}
          {templates.length === 0 && (
            <Card>
              <CardContent className="pt-8 pb-8 text-center text-muted-foreground">
                No templates available
              </CardContent>
            </Card>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelectedTemplate(null)}>
              ← Back
            </Button>
            <h2 className="text-lg font-semibold">{selectedTemplate.name}</h2>
            {selectedTemplate.category && (
              <Badge variant="outline">{selectedTemplate.category}</Badge>
            )}
          </div>
          {selectedTemplate.description && (
            <p className="text-sm text-muted-foreground">{selectedTemplate.description}</p>
          )}

          <div className="grid md:grid-cols-2 gap-4">
            <div className="space-y-3">
              {selectedTemplate.fields && selectedTemplate.fields.length > 0 ? (
                selectedTemplate.fields.map((field) => (
                  <div key={field.name} className="space-y-1">
                    <label className="text-sm font-medium">
                      {field.label} {field.required && <span className="text-red-500">*</span>}
                    </label>
                    {field.type === "textarea" ? (
                      <Textarea
                        rows={3}
                        placeholder={`Enter ${field.label.toLowerCase()}…`}
                        value={fields[field.name] ?? ""}
                        onChange={(e) =>
                          setFields((prev) => ({ ...prev, [field.name]: e.target.value }))
                        }
                        className="resize-none"
                      />
                    ) : field.type === "select" ? (
                      <select
                        className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                        value={fields[field.name] ?? ""}
                        onChange={(e) =>
                          setFields((prev) => ({ ...prev, [field.name]: e.target.value }))
                        }
                      >
                        <option value="">Select…</option>
                        {field.options?.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Input
                        placeholder={`Enter ${field.label.toLowerCase()}…`}
                        value={fields[field.name] ?? ""}
                        onChange={(e) =>
                          setFields((prev) => ({ ...prev, [field.name]: e.target.value }))
                        }
                      />
                    )}
                  </div>
                ))
              ) : (
                <div className="space-y-1">
                  <label className="text-sm font-medium">Custom instructions</label>
                  <Textarea
                    rows={4}
                    placeholder="Describe what you want to generate…"
                    value={fields.instructions ?? ""}
                    onChange={(e) => setFields({ instructions: e.target.value })}
                    className="resize-none"
                  />
                </div>
              )}
              {err && <p className="text-red-500 text-xs">{err}</p>}
              <Button onClick={generate} disabled={generating} className="w-full">
                {generating ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    Generating…
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 mr-2" />
                    Generate
                  </>
                )}
              </Button>
            </div>

            <div className="space-y-2">
              {selectedTemplate.exampleOutput && !result && (
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                    Example output
                  </p>
                  <div className="text-xs text-muted-foreground bg-muted p-3 rounded-md max-h-48 overflow-auto whitespace-pre-wrap">
                    {selectedTemplate.exampleOutput}
                  </div>
                </div>
              )}
              {result && result.content && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">
                      Generated document
                    </p>
                    <div className="flex items-center gap-1">
                      {result.wordCount && (
                        <span className="text-xs text-muted-foreground">
                          {result.wordCount} words
                        </span>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6"
                        onClick={() => downloadDoc(result.id)}
                      >
                        <Download className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                  <div className="text-sm bg-muted p-3 rounded-md max-h-[400px] overflow-auto whitespace-pre-wrap">
                    {result.content}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── History Tab ──────────────────────────────────────────────────────────────

function HistoryTab() {
  const [docs, setDocs] = useState<CraftDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<CraftDocument | null>(null);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/craft")
      .then((r) => (r.ok ? r.json() : { documents: [] }))
      .then((d) => {
        setDocs(d.documents ?? d);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const loadDoc = async (id: string) => {
    setLoadingDoc(true);
    const r = await fetch(`/api/craft/${id}`).catch(() => null);
    if (r?.ok) setSelected(await r.json());
    setLoadingDoc(false);
  };

  const deleteDoc = async (id: string) => {
    if (!confirm("Delete this document?")) return;
    setDeleting(id);
    await fetch(`/api/craft/${id}`, { method: "DELETE" }).catch(() => {});
    setDocs((prev) => prev.filter((d) => d.id !== id));
    if (selected?.id === id) setSelected(null);
    setDeleting(null);
  };

  const downloadDoc = async (craftId: string) => {
    const r = await fetch(`/api/craft/${craftId}/download`).catch(() => null);
    if (!r?.ok) return;
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `craft-${craftId}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading)
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading…
      </div>
    );
  if (!docs.length)
    return (
      <Card>
        <CardContent className="pt-8 pb-8 text-center text-muted-foreground">
          No documents generated yet
        </CardContent>
      </Card>
    );

  return (
    <div className="grid md:grid-cols-3 gap-4">
      <div className="space-y-1.5 max-h-[500px] overflow-y-auto">
        {docs.map((doc) => (
          <div
            key={doc.id}
            className={`border rounded-lg p-3 cursor-pointer hover:bg-muted/50 transition-colors ${selected?.id === doc.id ? "bg-muted border-primary/30" : ""}`}
            onClick={() => loadDoc(doc.id)}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {doc.title ?? doc.templateName ?? "Untitled"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {new Date(doc.createdAt).toLocaleDateString()}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Badge
                  variant={
                    doc.status === "done"
                      ? "default"
                      : doc.status === "failed"
                        ? "destructive"
                        : "secondary"
                  }
                  className="text-xs"
                >
                  {doc.status}
                </Badge>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 text-red-400"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteDoc(doc.id);
                  }}
                >
                  {deleting === doc.id ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Trash2 className="w-3 h-3" />
                  )}
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="md:col-span-2">
        {loadingDoc ? (
          <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading…
          </div>
        ) : selected?.content ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">{selected.title ?? "Document"}</h3>
              <Button size="sm" variant="outline" onClick={() => downloadDoc(selected.id)}>
                <Download className="w-3 h-3 mr-1" />
                Download
              </Button>
            </div>
            <div className="text-sm bg-muted p-4 rounded-md max-h-[460px] overflow-auto whitespace-pre-wrap">
              {selected.content}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-48 text-muted-foreground border rounded-lg border-dashed">
            <div className="text-center">
              <FileText className="w-10 h-10 mx-auto mb-2 opacity-30" />
              <p className="text-sm">Select a document to view</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function Craft() {
  const [templates, setTemplates] = useState<CraftTemplate[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/craft/templates")
      .then((r) => (r.ok ? r.json() : { templates: [] }))
      .then((d) => {
        setTemplates(d.templates ?? d);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <PenTool className="w-6 h-6 text-rose-500" />
          Craft
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Generate polished documents from AI-powered templates
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading templates…
        </div>
      ) : (
        <Tabs defaultValue="generate">
          <TabsList>
            <TabsTrigger value="generate">
              <Play className="w-4 h-4 mr-1" />
              Generate
            </TabsTrigger>
            <TabsTrigger value="history">
              <History className="w-4 h-4 mr-1" />
              History
            </TabsTrigger>
          </TabsList>
          <TabsContent value="generate" className="mt-4">
            <GenerateTab templates={templates} />
          </TabsContent>
          <TabsContent value="history" className="mt-4">
            <HistoryTab />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
