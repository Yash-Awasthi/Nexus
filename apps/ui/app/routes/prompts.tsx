import { lazy, Suspense, useState, useCallback, useEffect } from 'react';
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  FileText,
  Plus,
  Search,
  Save,
  Trash2,
  GitCommit,
  ChevronDown,
  Loader2,
} from "lucide-react";

const MonacoEditor = lazy(() => import('@monaco-editor/react'));

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
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { message?: string }).message ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "claude-sonnet-4-6",
  "claude-haiku",
  "gemini-2.5-pro",
];

function extractVariables(content: string): string[] {
  const matches = content.match(/\{\{([^}]+)\}\}/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.replace(/\{\{|\}\}/g, '').trim()))];
}

export default function PromptsPage() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
  const [search, setSearch] = useState('');
  const [editedContent, setEditedContent] = useState<Record<string, string>>({});
  const [editedModel, setEditedModel] = useState<Record<string, string>>({});
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Load prompt list ─────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch<{ prompts: Prompt[] }>('/api/prompts')
      .then(({ prompts: list }) => {
        if (cancelled) return;
        setPrompts(list);
        if (list.length > 0) setSelectedId(list[0].id);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
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
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => { cancelled = true; };
  }, [selectedId]);

  const latestVersion = selectedPrompt?.versions?.[0] ?? null;
  const currentContent = selectedId
    ? (editedContent[selectedId] ?? latestVersion?.content ?? '')
    : '';
  const currentModel = selectedId
    ? (editedModel[selectedId] ?? latestVersion?.model ?? 'gpt-4o')
    : 'gpt-4o';
  const variables = extractVariables(currentContent);

  const filteredPrompts = prompts.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase())
  );

  const hasUnsavedChanges = !!(selectedId && (
    (editedContent[selectedId] !== undefined && editedContent[selectedId] !== latestVersion?.content) ||
    (editedModel[selectedId] !== undefined && editedModel[selectedId] !== latestVersion?.model)
  ));

  const handleContentChange = useCallback((value: string) => {
    if (!selectedId) return;
    setEditedContent((prev) => ({ ...prev, [selectedId]: value }));
  }, [selectedId]);

  const handleModelChange = useCallback((model: string) => {
    if (!selectedId) return;
    setEditedModel((prev) => ({ ...prev, [selectedId]: model }));
    setShowModelDropdown(false);
  }, [selectedId]);

  const handleSave = useCallback(async () => {
    if (!selectedId || !selectedPrompt) return;
    const content = editedContent[selectedId] ?? latestVersion?.content;
    const model = editedModel[selectedId] ?? latestVersion?.model;
    if (!content) return;
    setSaving(true);
    try {
      const newVersion = await apiFetch<PromptVersion>(
        `/api/prompts/${selectedId}/versions`,
        {
          method: 'POST',
          body: JSON.stringify({ content, model }),
        }
      );
      // Update local state with new version
      setSelectedPrompt((prev) => prev ? { ...prev, versions: [newVersion] } : prev);
      setPrompts((prev) =>
        prev.map((p) => p.id === selectedId ? { ...p, versions: [newVersion] } : p)
      );
      setEditedContent((prev) => { const n = { ...prev }; delete n[selectedId]; return n; });
      setEditedModel((prev) => { const n = { ...prev }; delete n[selectedId]; return n; });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [selectedId, selectedPrompt, editedContent, editedModel, latestVersion]);

  const handleDelete = useCallback(async () => {
    if (!selectedId) return;
    if (!confirm('Delete this prompt? This cannot be undone.')) return;
    try {
      await apiFetch(`/api/prompts/${selectedId}`, { method: 'DELETE' });
      const remaining = prompts.filter((p) => p.id !== selectedId);
      setPrompts(remaining);
      setSelectedPrompt(null);
      setSelectedId(remaining[0]?.id ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete');
    }
  }, [selectedId, prompts]);

  const handleNewPrompt = useCallback(async () => {
    try {
      const created = await apiFetch<Prompt>('/api/prompts', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Untitled Prompt',
          content: '# New Prompt\n\nDescribe the role and instructions here.\n\n## Variables\n- Input: {{input}}',
        }),
      });
      setPrompts((prev) => [created, ...prev]);
      setSelectedId(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create prompt');
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
          <button onClick={() => setError(null)} className="font-bold">✕</button>
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
              const isDirty = editedContent[prompt.id] !== undefined || editedModel[prompt.id] !== undefined;
              const vNum = prompt.versions?.[0]?.versionNum ?? 1;
              return (
                <button
                  key={prompt.id}
                  onClick={() => setSelectedId(prompt.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-md transition-colors ${
                    isSelected
                      ? 'bg-primary/10 text-foreground'
                      : 'hover:bg-muted text-foreground'
                  }`}
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="text-xs font-medium truncate flex-1">{prompt.name}</span>
                    <Badge variant="outline" className="text-[9px] h-4 px-1 shrink-0 gap-0.5">
                      <GitCommit className="size-2" />
                      v{vNum}
                    </Badge>
                    {isDirty && (
                      <span className="size-1.5 rounded-full bg-orange-400 shrink-0" title="Unsaved changes" />
                    )}
                  </div>
                  {prompt.description && (
                    <p className="text-[10px] text-muted-foreground truncate">{prompt.description}</p>
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
                  <GitCommit className="size-2.5" />
                  v{latestVersion?.versionNum ?? 1}
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
                          m === currentModel ? 'text-primary font-medium' : ''
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
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                Save{hasUnsavedChanges ? ' *' : ''}
              </Button>
            </div>

            {/* Monaco Editor */}
            <div className="flex-1 overflow-hidden">
              <Suspense fallback={
                <div className="flex-1 flex items-center justify-center text-muted-foreground h-full">
                  Loading editor...
                </div>
              }>
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
        <div
          className="fixed inset-0 z-40"
          onClick={() => setShowModelDropdown(false)}
        />
      )}
    </div>
  );
}
