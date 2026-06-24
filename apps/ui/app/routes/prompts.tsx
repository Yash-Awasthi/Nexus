// SPDX-License-Identifier: Apache-2.0
import {
  FileText,
  Plus,
  Search,
  Save,
  Trash2,
  GitCommit,
  ChevronDown,
  Loader2,
  History,
  Eye,
  RotateCcw,
} from "lucide-react";
import { lazy, Suspense, useState, useCallback, useEffect } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "~/components/ui/sheet";

const MonacoEditor = lazy(() => import("@monaco-editor/react"));

// ── Types ──────────────────────────────────────────────────────────────────
interface PromptVersion {
  id: string;
  versionNum: number;
  content: string;
  model: string | null;
  temperature: number | null;
  createdAt: string;
}

interface Prompt {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  versions: PromptVersion[];
}

// ── API helpers ────────────────────────────────────────────────────────────
async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers as Record<string, string>) },
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    throw new Error((body as { message?: string }).message ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const MODELS = ["gpt-4o", "gpt-4o-mini", "claude-sonnet-4-6", "claude-haiku", "gemini-2.5-pro"];

function extractVariables(content: string): string[] {
  const matches = content.match(/\{\{([^}]+)\}\}/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.replace(/\{\{|\}\}/g, "").trim()))];
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function PromptsPage() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
  const [search, setSearch] = useState("");
  const [editedContent, setEditedContent] = useState<Record<string, string>>({});
  const [editedModel, setEditedModel] = useState<Record<string, string>>({});
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [viewingVersion, setViewingVersion] = useState<PromptVersion | null>(null);
  const [restoringNum, setRestoringNum] = useState<number | null>(null);

  // ── Load prompt list ─────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch<{ prompts: Prompt[] }>("/api/prompts")
      .then(({ prompts: list }) => {
        if (cancelled) return;
        setPrompts(list);
        if (list.length > 0) setSelectedId(list[0].id);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Load detail when selection changes ──────────────────────────────────
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setLoadingDetail(true);
    apiFetch<Prompt>(`/api/prompts/${selectedId}`)
      .then((detail) => {
        if (!cancelled) setSelectedPrompt(detail);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const latestVersion = selectedPrompt?.versions?.[0] ?? null;
  const currentContent = selectedId
    ? (editedContent[selectedId] ?? latestVersion?.content ?? "")
    : "";
  const currentModel = selectedId
    ? (editedModel[selectedId] ?? latestVersion?.model ?? "gpt-4o")
    : "gpt-4o";
  const variables = extractVariables(currentContent);

  const filteredPrompts = prompts.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase()),
  );

  const hasUnsavedChanges = !!(
    selectedId &&
    ((editedContent[selectedId] !== undefined &&
      editedContent[selectedId] !== latestVersion?.content) ||
      (editedModel[selectedId] !== undefined && editedModel[selectedId] !== latestVersion?.model))
  );

  const handleContentChange = useCallback(
    (value: string) => {
      if (!selectedId) return;
      setEditedContent((prev) => ({ ...prev, [selectedId]: value }));
    },
    [selectedId],
  );

  const handleModelChange = useCallback(
    (model: string) => {
      if (!selectedId) return;
      setEditedModel((prev) => ({ ...prev, [selectedId]: model }));
      setShowModelDropdown(false);
    },
    [selectedId],
  );

  const handleSave = useCallback(async () => {
    if (!selectedId || !selectedPrompt) return;
    const content = editedContent[selectedId] ?? latestVersion?.content;
    const model = editedModel[selectedId] ?? latestVersion?.model;
    if (!content) return;
    setSaving(true);
    try {
      const newVersion = await apiFetch<PromptVersion>(`/api/prompts/${selectedId}/versions`, {
        method: "POST",
        body: JSON.stringify({ content, model }),
      });
      // Prepend the new version so the full history stays available to the drawer.
      setSelectedPrompt((prev) =>
        prev ? { ...prev, versions: [newVersion, ...prev.versions] } : prev,
      );
      setPrompts((prev) =>
        prev.map((p) =>
          p.id === selectedId ? { ...p, versions: [newVersion, ...p.versions] } : p,
        ),
      );
      setEditedContent((prev) => {
        const n = { ...prev };
        delete n[selectedId];
        return n;
      });
      setEditedModel((prev) => {
        const n = { ...prev };
        delete n[selectedId];
        return n;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [selectedId, selectedPrompt, editedContent, editedModel, latestVersion]);

  // Restore is non-destructive: it creates a NEW version from an old one's content
  // (matching the "save = new version" semantics), it never rewrites history.
  const handleRestore = useCallback(
    async (version: PromptVersion) => {
      if (!selectedId) return;
      setRestoringNum(version.versionNum);
      try {
        const newVersion = await apiFetch<PromptVersion>(`/api/prompts/${selectedId}/versions`, {
          method: "POST",
          body: JSON.stringify({
            content: version.content,
            model: version.model,
            temperature: version.temperature,
          }),
        });
        setSelectedPrompt((prev) =>
          prev ? { ...prev, versions: [newVersion, ...prev.versions] } : prev,
        );
        setPrompts((prev) =>
          prev.map((p) =>
            p.id === selectedId ? { ...p, versions: [newVersion, ...p.versions] } : p,
          ),
        );
        // Drop any unsaved edits so the editor reflects the restored content.
        setEditedContent((prev) => {
          const n = { ...prev };
          delete n[selectedId];
          return n;
        });
        setEditedModel((prev) => {
          const n = { ...prev };
          delete n[selectedId];
          return n;
        });
        setViewingVersion(null);
        setHistoryOpen(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to restore version");
      } finally {
        setRestoringNum(null);
      }
    },
    [selectedId],
  );

  const handleDelete = useCallback(async () => {
    if (!selectedId) return;
    if (!confirm("Delete this prompt? This cannot be undone.")) return;
    try {
      await apiFetch(`/api/prompts/${selectedId}`, { method: "DELETE" });
      const remaining = prompts.filter((p) => p.id !== selectedId);
      setPrompts(remaining);
      setSelectedPrompt(null);
      setSelectedId(remaining[0]?.id ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    }
  }, [selectedId, prompts]);

  const handleNewPrompt = useCallback(async () => {
    try {
      const created = await apiFetch<Prompt>("/api/prompts", {
        method: "POST",
        body: JSON.stringify({
          name: "Untitled Prompt",
          content:
            "# New Prompt\n\nDescribe the role and instructions here.\n\n## Variables\n- Input: {{input}}",
        }),
      });
      setPrompts((prev) => [created, ...prev]);
      setSelectedId(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create prompt");
    }
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex-1 flex overflow-hidden">
      {error && (
        <div className="fixed top-4 right-4 z-50 bg-destructive text-destructive-foreground text-xs px-3 py-2 rounded-md shadow-lg flex items-center gap-2">
          {error}
          <button onClick={() => setError(null)} className="font-bold">
            ✕
          </button>
        </div>
      )}

      {/* Left sidebar */}
      <div className="w-64 border-r border-border flex flex-col bg-background shrink-0">
        <div className="p-3 border-b border-border space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText className="size-4 text-muted-foreground" />
              <span className="text-sm font-semibold">Prompts</span>
              <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
                {prompts.length}
              </Badge>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={handleNewPrompt}
              title="New prompt"
            >
              <Plus className="size-3.5" />
            </Button>
          </div>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search prompts..."
              className="h-7 pl-6 text-xs"
            />
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-1.5 space-y-0.5">
            {filteredPrompts.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-6">No prompts found</p>
            )}
            {filteredPrompts.map((prompt) => {
              const isSelected = prompt.id === selectedId;
              const isDirty =
                editedContent[prompt.id] !== undefined || editedModel[prompt.id] !== undefined;
              const vNum = prompt.versions?.[0]?.versionNum ?? 1;
              return (
                <button
                  key={prompt.id}
                  onClick={() => setSelectedId(prompt.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-md transition-colors ${
                    isSelected ? "bg-primary/10 text-foreground" : "hover:bg-muted text-foreground"
                  }`}
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="text-xs font-medium truncate flex-1">{prompt.name}</span>
                    <Badge variant="outline" className="text-[9px] h-4 px-1 shrink-0 gap-0.5">
                      <GitCommit className="size-2" />v{vNum}
                    </Badge>
                    {isDirty && (
                      <span
                        className="size-1.5 rounded-full bg-orange-400 shrink-0"
                        title="Unsaved changes"
                      />
                    )}
                  </div>
                  {prompt.description && (
                    <p className="text-[10px] text-muted-foreground truncate">
                      {prompt.description}
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </div>

      {/* Main editor area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {loadingDetail ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : selectedPrompt ? (
          <>
            {/* Top bar */}
            <div className="h-12 border-b border-border flex items-center px-4 gap-3 bg-background shrink-0">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <FileText className="size-4 text-muted-foreground shrink-0" />
                <span className="text-sm font-medium truncate">{selectedPrompt.name}</span>
                <Badge variant="outline" className="text-[10px] shrink-0 gap-0.5">
                  <GitCommit className="size-2.5" />v{latestVersion?.versionNum ?? 1}
                </Badge>
              </div>

              {/* Model selector */}
              <div className="relative">
                <button
                  onClick={() => setShowModelDropdown((v) => !v)}
                  className="flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border text-xs hover:bg-muted transition-colors"
                >
                  <span className="text-muted-foreground">Model:</span>
                  <span className="font-medium">{currentModel}</span>
                  <ChevronDown className="size-3 text-muted-foreground" />
                </button>
                {showModelDropdown && (
                  <div className="absolute right-0 top-full mt-1 bg-popover border border-border rounded-md shadow-lg z-50 min-w-40 py-1">
                    {MODELS.map((m) => (
                      <button
                        key={m}
                        onClick={() => handleModelChange(m)}
                        className={`w-full text-left px-3 py-1.5 text-xs hover:bg-muted transition-colors ${
                          m === currentModel ? "text-primary font-medium" : ""
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => setHistoryOpen(true)}
                title="Version history"
              >
                <History className="size-3.5" />
                History
                <Badge variant="secondary" className="text-[9px] h-4 px-1">
                  {selectedPrompt.versions.length}
                </Badge>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive"
                onClick={handleDelete}
              >
                <Trash2 className="size-3.5" />
                Delete
              </Button>
              <Button
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={handleSave}
                disabled={!hasUnsavedChanges || saving}
              >
                {saving ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Save className="size-3.5" />
                )}
                Save{hasUnsavedChanges ? " *" : ""}
              </Button>
            </div>

            {/* Monaco Editor */}
            <div className="flex-1 overflow-hidden">
              <Suspense
                fallback={
                  <div className="flex-1 flex items-center justify-center text-muted-foreground h-full">
                    Loading editor...
                  </div>
                }
              >
                <MonacoEditor
                  height="100%"
                  language="markdown"
                  theme="vs-dark"
                  value={currentContent}
                  onChange={(value) => handleContentChange(value || "")}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 14,
                    wordWrap: "on",
                    lineNumbers: "on",
                    scrollBeyondLastLine: false,
                    padding: { top: 16 },
                  }}
                />
              </Suspense>
            </div>

            {/* Variable bar */}
            {variables.length > 0 && (
              <div className="h-10 border-t border-border flex items-center px-4 gap-2 bg-muted/30 shrink-0">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold shrink-0">
                  Variables
                </span>
                <div className="flex items-center gap-1.5 overflow-x-auto">
                  {variables.map((v) => (
                    <Badge
                      key={v}
                      variant="outline"
                      className="text-[10px] h-5 shrink-0 font-mono border-orange-500/40 text-orange-400 bg-orange-500/5"
                    >
                      {`{{${v}}}`}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center space-y-2">
              <FileText className="size-10 text-muted-foreground mx-auto" />
              <p className="text-sm text-muted-foreground">Select a prompt to edit</p>
              <Button size="sm" onClick={handleNewPrompt} className="gap-1.5">
                <Plus className="size-3.5" />
                New Prompt
              </Button>
            </div>
          </div>
        )}
      </div>

      {showModelDropdown && (
        <div className="fixed inset-0 z-40" onClick={() => setShowModelDropdown(false)} />
      )}

      {/* Version history drawer */}
      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent className="w-full sm:max-w-md flex flex-col gap-0 p-0">
          <SheetHeader className="p-4 border-b border-border">
            <SheetTitle className="flex items-center gap-2 text-sm">
              <History className="size-4" />
              Version History
            </SheetTitle>
            <SheetDescription className="text-xs">
              {selectedPrompt?.name ?? "Prompt"} — {selectedPrompt?.versions.length ?? 0} version
              {(selectedPrompt?.versions.length ?? 0) === 1 ? "" : "s"}. Restoring creates a new
              version; older versions are never overwritten.
            </SheetDescription>
          </SheetHeader>
          <ScrollArea className="flex-1">
            <div className="p-3 space-y-2">
              {(selectedPrompt?.versions ?? []).map((v, idx) => (
                <div
                  key={v.id}
                  className="rounded-md border border-border p-3 space-y-2 bg-background"
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px] gap-0.5">
                      <GitCommit className="size-2.5" />v{v.versionNum}
                    </Badge>
                    {idx === 0 && (
                      <Badge variant="secondary" className="text-[9px] h-4 px-1.5">
                        latest
                      </Badge>
                    )}
                    <span className="text-[10px] text-muted-foreground ml-auto">
                      {relativeTime(v.createdAt)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    {v.model && <span className="font-mono">{v.model}</span>}
                    {v.temperature != null && <span>temp {v.temperature}</span>}
                  </div>
                  <p className="text-[11px] text-muted-foreground font-mono line-clamp-2 break-all">
                    {v.content.slice(0, 160)}
                    {v.content.length > 160 ? "…" : ""}
                  </p>
                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 gap-1 text-[10px] px-2"
                      onClick={() => setViewingVersion(v)}
                    >
                      <Eye className="size-3" />
                      View
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1 text-[10px] px-2"
                      onClick={() => handleRestore(v)}
                      disabled={restoringNum != null || idx === 0}
                      title={idx === 0 ? "Already the latest version" : "Restore as a new version"}
                    >
                      {restoringNum === v.versionNum ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <RotateCcw className="size-3" />
                      )}
                      Restore
                    </Button>
                  </div>
                </div>
              ))}
              {(selectedPrompt?.versions.length ?? 0) === 0 && (
                <p className="text-xs text-muted-foreground text-center py-6">No versions yet</p>
              )}
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>

      {/* Read-only version preview */}
      <Dialog open={viewingVersion != null} onOpenChange={(o) => !o && setViewingVersion(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <GitCommit className="size-4" />
              Version {viewingVersion?.versionNum}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {viewingVersion?.model && <span className="font-mono">{viewingVersion.model}</span>}
              {viewingVersion?.temperature != null && (
                <span className="ml-2">temp {viewingVersion.temperature}</span>
              )}
              {viewingVersion && (
                <span className="ml-2">{relativeTime(viewingVersion.createdAt)}</span>
              )}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[55vh] rounded-md border border-border bg-muted/30">
            <pre className="text-xs font-mono p-3 whitespace-pre-wrap break-words">
              {viewingVersion?.content}
            </pre>
          </ScrollArea>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => viewingVersion && handleRestore(viewingVersion)}
              disabled={
                restoringNum != null || viewingVersion?.versionNum === latestVersion?.versionNum
              }
            >
              <RotateCcw className="size-3.5" />
              Restore this version
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
