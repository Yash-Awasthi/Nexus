// SPDX-License-Identifier: Apache-2.0
import {
  FileText,
  Plus,
  Search,
  Save,
  Trash2,
  GitCommit,
  Loader2,
  History,
  Eye,
  RotateCcw,
  X,
} from "lucide-react";
import { lazy, Suspense, useState, useCallback, useEffect } from "react";

import { EmptyState, Page, PageHeader } from "~/components/page";
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
import { useTheme } from "~/context/ThemeContext";
import { useModelIds } from "~/hooks/use-model-ids";
import { apiFetch } from "~/lib/api";
import { cn } from "~/lib/utils";

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
  const { theme } = useTheme();
  const models = useModelIds();
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
  const [search, setSearch] = useState("");
  const [editedContent, setEditedContent] = useState<Record<string, string>>({});
  const [editedModel, setEditedModel] = useState<Record<string, string>>({});
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
        if (cancelled) return undefined;
        setPrompts(list);
        if (list.length > 0) setSelectedId(list[0].id);
        return undefined;
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
        return undefined;
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
    ? (editedModel[selectedId] ?? latestVersion?.model ?? models[0] ?? "")
    : "";
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
      <Page width="wide">
        <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />
      </Page>
    );
  }

  return (
    <Page width="wide">
      <PageHeader
        title="Prompts"
        description="Versioned prompts with a default model. Saving keeps every earlier version."
        actions={
          <Button size="sm" onClick={handleNewPrompt}>
            <Plus />
            New prompt
          </Button>
        }
      />

      {error && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Dismiss"
            onClick={() => setError(null)}
          >
            <X />
          </Button>
        </div>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[16rem_1fr]">
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="border-b p-3">
            <div className="relative">
              <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search prompts…"
                className="pl-8"
              />
            </div>
          </div>
          <div className="max-h-64 space-y-0.5 overflow-y-auto p-1.5 lg:max-h-[65vh]">
            {filteredPrompts.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {prompts.length ? "No prompt matches." : "No prompts yet."}
              </p>
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
                  className={cn(
                    "w-full rounded-md px-3 py-2 text-left transition-colors",
                    isSelected ? "bg-primary/10" : "hover:bg-muted",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="flex-1 truncate text-sm font-medium">{prompt.name}</span>
                    <Badge variant="outline" className="shrink-0 gap-0.5">
                      <GitCommit className="size-3" />v{vNum}
                    </Badge>
                    {isDirty && (
                      <span
                        className="size-1.5 shrink-0 rounded-full bg-warning"
                        title="Unsaved changes"
                      />
                    )}
                  </div>
                  {prompt.description && (
                    <p className="truncate text-xs text-muted-foreground">{prompt.description}</p>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border bg-card">
          {loadingDetail ? (
            <div className="flex h-64 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : selectedPrompt ? (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate text-sm font-semibold">{selectedPrompt.name}</span>
                  <Badge variant="outline" className="shrink-0 gap-0.5">
                    <GitCommit className="size-3" />v{latestVersion?.versionNum ?? 1}
                  </Badge>
                </div>
                <select
                  value={currentModel}
                  onChange={(e) => handleModelChange(e.target.value)}
                  aria-label="Model"
                  className="h-8 max-w-48 rounded-md border border-input bg-background px-2 text-xs"
                >
                  {(models.includes(currentModel) ? models : [currentModel, ...models]).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
                  <History />
                  History ({selectedPrompt.versions.length})
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={handleDelete}
                >
                  <Trash2 />
                  Delete
                </Button>
                <Button size="sm" onClick={handleSave} disabled={!hasUnsavedChanges || saving}>
                  {saving ? <Loader2 className="animate-spin" /> : <Save />}
                  Save
                </Button>
              </div>

              <div className="h-[55vh]">
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                      Loading editor…
                    </div>
                  }
                >
                  <MonacoEditor
                    height="100%"
                    language="markdown"
                    theme={theme === "dark" ? "vs-dark" : "light"}
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

              {variables.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 border-t px-4 py-2.5">
                  <span className="text-xs text-muted-foreground">Variables</span>
                  {variables.map((v) => (
                    <Badge
                      key={v}
                      variant="outline"
                      className="border-warning/30 bg-warning/10 font-mono text-warning"
                    >
                      {`{{${v}}}`}
                    </Badge>
                  ))}
                </div>
              )}
            </>
          ) : (
            <EmptyState
              icon={FileText}
              title="No prompt selected"
              description="Pick a prompt from the list, or start a new one."
              className="border-0"
            />
          )}
        </div>
      </div>

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
                    <Badge variant="outline" className="text-xs gap-0.5">
                      <GitCommit className="size-2.5" />v{v.versionNum}
                    </Badge>
                    {idx === 0 && (
                      <Badge variant="secondary" className="text-xs h-4 px-1.5">
                        latest
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground ml-auto">
                      {relativeTime(v.createdAt)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {v.model && <span className="font-mono">{v.model}</span>}
                    {v.temperature != null && <span>temp {v.temperature}</span>}
                  </div>
                  <p className="text-xs text-muted-foreground font-mono line-clamp-2 break-all">
                    {v.content.slice(0, 160)}
                    {v.content.length > 160 ? "…" : ""}
                  </p>
                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 gap-1 text-xs px-2"
                      onClick={() => setViewingVersion(v)}
                    >
                      <Eye className="size-3" />
                      View
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1 text-xs px-2"
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
    </Page>
  );
}
