// SPDX-License-Identifier: Apache-2.0
/**
 * Playground → Compare — Multi-window LLM prompt testing and comparison.
 *
 * Lives at /playground/compare. /playground is the experiments index.
 *
 * Inspired by langfuse/langfuse web/src/features/playground/
 * Features:
 *   • Multi-window side-by-side prompt comparison
 *   • Run All / Stop All global controls
 *   • Persistent window state across refreshes
 *   • Model selection per window
 *   • Variable injection for prompt templates
 *   • Response timing and token usage display
 */

import {
  Play,
  Plus,
  X,
  Loader2,
  Copy,
  Trash2,
  RotateCcw,
  Settings2,
  Clock,
  Coins,
} from "lucide-react";
import { useState, useCallback, useEffect, useRef } from "react";

import { AnswerDrift } from "~/components/answer-drift";
import { LearnedRouting } from "~/components/learned-routing";
import { EmptyState, Page, PageHeader } from "~/components/page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { useModelIds } from "~/hooks/use-model-ids";
import { authFetch } from "~/lib/api";

// ── Types ──────────────────────────────────────────────────────────────────

interface PlaygroundWindow {
  id: string;
  prompt: string;
  model: string;
  temperature: number;
  maxTokens: number;
  variables: Record<string, string>;
  result: string | null;
  error: string | null;
  isRunning: boolean;
  timing: { startTime: number; endTime: number } | null;
  tokenUsage: { input: number; output: number } | null;
}

interface PlaygroundState {
  windows: PlaygroundWindow[];
}

// ── Constants ──────────────────────────────────────────────────────────────

const STORAGE_KEY = "nexus-playground-state";

// ── Helpers ────────────────────────────────────────────────────────────────

function generateId(): string {
  return `pw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function extractVariables(text: string): string[] {
  const matches = text.match(/\{\{([^}]+)\}\}/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.replace(/\{\{|\}\}/g, "").trim()))];
}

function loadState(): PlaygroundState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as PlaygroundState;
      if (parsed.windows && Array.isArray(parsed.windows) && parsed.windows.length > 0) {
        // Reset running states on load
        return {
          windows: parsed.windows.map((w) => ({
            ...w,
            isRunning: false,
            error: null,
          })),
        };
      }
    }
  } catch {
    // ignore
  }
  return { windows: [createDefaultWindow()] };
}

function saveState(state: PlaygroundState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

function createDefaultWindow(): PlaygroundWindow {
  return {
    id: generateId(),
    prompt: "",
    model: "gpt-4o",
    temperature: 0.7,
    maxTokens: 1024,
    variables: {},
    result: null,
    error: null,
    isRunning: false,
    timing: null,
    tokenUsage: null,
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// ── Window Component ───────────────────────────────────────────────────────

interface WindowProps {
  window: PlaygroundWindow;
  onUpdate: (id: string, updates: Partial<PlaygroundWindow>) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
  onRun: (id: string) => void;
  canRemove: boolean;
  isExecutingAll: boolean;
  models: string[];
}

function PlaygroundWindowComponent({
  window: w,
  onUpdate,
  onRemove,
  onDuplicate,
  onRun,
  canRemove,
  isExecutingAll,
  models,
}: WindowProps) {
  const variables = extractVariables(w.prompt);

  const handleRun = useCallback(() => {
    onRun(w.id);
  }, [w.id, onRun]);

  const handleCopyResult = useCallback(() => {
    if (w.result) {
      navigator.clipboard.writeText(w.result);
    }
  }, [w.result]);

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border bg-card">
      {/* Window header */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <span className="flex-1 truncate font-mono text-xs text-muted-foreground">{w.model}</span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => onRun(w.id)}
            disabled={w.isRunning || isExecutingAll}
            title="Run"
          >
            {w.isRunning ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() =>
              onUpdate(w.id, { result: null, error: null, tokenUsage: null, timing: null })
            }
            title="Clear result"
          >
            <RotateCcw className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => onDuplicate(w.id)}
            title="Duplicate window"
            aria-label="Duplicate window"
          >
            <Copy className="size-3.5" />
          </Button>
          {canRemove && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-destructive hover:text-destructive"
              onClick={() => onRemove(w.id)}
              title="Remove window"
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Model & settings bar */}
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <select
          value={w.model}
          onChange={(e) => onUpdate(w.id, { model: e.target.value })}
          aria-label="Model"
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-xs"
        >
          {(models.includes(w.model) ? models : [w.model, ...models]).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Settings2 className="size-3.5" />
          <span>temp</span>
          <input
            type="number"
            value={w.temperature}
            onChange={(e) => onUpdate(w.id, { temperature: parseFloat(e.target.value) || 0 })}
            min={0}
            max={2}
            step={0.1}
            aria-label="Temperature"
            className="h-8 w-14 rounded-md border border-input bg-background px-1.5 font-mono text-xs"
          />
          <span className="ml-1">max</span>
          <input
            type="number"
            value={w.maxTokens}
            onChange={(e) => onUpdate(w.id, { maxTokens: parseInt(e.target.value) || 256 })}
            min={64}
            max={128000}
            step={256}
            aria-label="Max tokens"
            className="h-8 w-20 rounded-md border border-input bg-background px-1.5 font-mono text-xs"
          />
        </div>
      </div>

      {/* Prompt input */}
      <div className="flex-1 min-h-[120px] max-h-[300px] overflow-auto">
        <Textarea
          value={w.prompt}
          onChange={(e) => onUpdate(w.id, { prompt: e.target.value })}
          placeholder="Enter your prompt here... Use {{variable}} for variables"
          className="h-full min-h-[120px] resize-none border-0 rounded-none focus-visible:ring-0 text-sm font-mono"
        />
      </div>

      {/* Variables bar */}
      {variables.length > 0 && (
        <div className="border-t border-border px-3 py-2 bg-muted/20 space-y-1.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
              Variables
            </span>
            {variables.map((v) => (
              <Badge
                key={v}
                variant="outline"
                className="text-xs h-4 font-mono border-warning/30 text-warning bg-warning/10"
              >
                {`{{${v}}}`}
              </Badge>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {variables.map((v) => (
              <div key={v} className="flex items-center gap-1">
                <span className="text-xs font-mono text-muted-foreground">{v}:</span>
                <Input
                  value={w.variables[v] ?? ""}
                  onChange={(e) =>
                    onUpdate(w.id, {
                      variables: { ...w.variables, [v]: e.target.value },
                    })
                  }
                  placeholder={v}
                  className="h-6 text-xs font-mono w-32"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Run button (when no result) */}
      {!w.result && !w.error && (
        <div className="border-t border-border p-3 flex justify-center">
          <Button
            size="sm"
            onClick={handleRun}
            disabled={w.isRunning || isExecutingAll || !w.prompt.trim()}
            className="gap-1.5"
          >
            {w.isRunning ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" />
            )}
            Run
          </Button>
        </div>
      )}

      {/* Result */}
      {(w.result || w.error) && (
        <div className="border-t border-border">
          {/* Result header */}
          <div className="h-8 flex items-center px-3 gap-2 bg-muted/30">
            <span className="text-xs font-medium text-muted-foreground">Result</span>
            <div className="flex items-center gap-2 ml-auto">
              {w.timing && (
                <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
                  <Clock className="size-2.5" />
                  {formatDuration(w.timing.endTime - w.timing.startTime)}
                </span>
              )}
              {w.tokenUsage && (
                <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
                  <Coins className="size-2.5" />
                  {w.tokenUsage.input + w.tokenUsage.output} tokens
                </span>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="size-5"
                onClick={handleCopyResult}
                title="Copy result"
              >
                <Copy className="size-3" />
              </Button>
            </div>
          </div>

          {/* Result content */}
          <div className="max-h-[250px] overflow-auto">
            {w.error ? (
              <div className="p-3 text-xs text-destructive font-mono whitespace-pre-wrap">
                {w.error}
              </div>
            ) : (
              <div className="p-3 text-sm font-mono whitespace-pre-wrap break-words">
                {w.result}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function PlaygroundComparePage() {
  const [state, setState] = useState<PlaygroundState>(() => loadState());
  const [isExecutingAll, setIsExecutingAll] = useState(false);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const models = useModelIds();

  // A window left on a model the caller cannot reach moves to one they can.
  useEffect(() => {
    if (!models.length) return;
    setState((prev) =>
      prev.windows.every((w) => models.includes(w.model))
        ? prev
        : {
            ...prev,
            windows: prev.windows.map((w) =>
              models.includes(w.model) ? w : { ...w, model: models[0]! },
            ),
          },
    );
  }, [models, state.windows.length]);

  // Persist state
  useEffect(() => {
    saveState(state);
  }, [state]);

  const addWindow = useCallback(() => {
    setState((prev) => ({
      ...prev,
      windows: [...prev.windows, createDefaultWindow()],
    }));
  }, []);

  const removeWindow = useCallback((id: string) => {
    setState((prev) => ({
      ...prev,
      windows: prev.windows.filter((w) => w.id !== id),
    }));
    // Abort any running request
    const controller = abortControllersRef.current.get(id);
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(id);
    }
  }, []);

  const updateWindow = useCallback((id: string, updates: Partial<PlaygroundWindow>) => {
    setState((prev) => ({
      ...prev,
      windows: prev.windows.map((w) => (w.id === id ? { ...w, ...updates } : w)),
    }));
  }, []);

  const runWindow = useCallback(
    async (id: string) => {
      const win = state.windows.find((w) => w.id === id);
      if (!win || !win.prompt.trim() || win.isRunning) return;

      // Replace variables in prompt
      let filledPrompt = win.prompt;
      for (const [key, value] of Object.entries(win.variables)) {
        filledPrompt = filledPrompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
      }

      // Set running state
      updateWindow(id, {
        isRunning: true,
        result: null,
        error: null,
        timing: null,
        tokenUsage: null,
      });

      const controller = new AbortController();
      abortControllersRef.current.set(id, controller);
      const startTime = Date.now();

      try {
        // /api/v1/gateway/messages is the durable Anthropic-shaped inference
        // endpoint. This page used to post to /api/deliberate, which is
        // registered nowhere, so every run here returned 404.
        const response = await authFetch("/api/v1/gateway/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{ role: "user", content: filledPrompt }],
            model: win.model,
            temperature: win.temperature,
            max_tokens: win.maxTokens,
          }),
          signal: controller.signal,
        });

        const endTime = Date.now();

        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { message?: string };
          throw new Error(body.message ?? `Request failed: ${response.status}`);
        }

        const data = (await response.json()) as {
          content?: { type: string; text?: string }[];
          usage?: { input_tokens: number; output_tokens: number };
        };
        const text = (data.content ?? [])
          .map((block) => block.text ?? "")
          .join("")
          .trim();

        updateWindow(id, {
          isRunning: false,
          result: text || "No response",
          timing: { startTime, endTime },
          tokenUsage: data.usage
            ? { input: data.usage.input_tokens, output: data.usage.output_tokens }
            : null,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          updateWindow(id, { isRunning: false });
        } else {
          const endTime = Date.now();
          updateWindow(id, {
            isRunning: false,
            error: err instanceof Error ? err.message : String(err),
            timing: { startTime, endTime },
          });
        }
      } finally {
        abortControllersRef.current.delete(id);
      }
    },
    [state.windows, updateWindow],
  );

  const runAllWindows = useCallback(async () => {
    setIsExecutingAll(true);
    const runPromises = state.windows
      .filter((w) => w.prompt.trim() && !w.isRunning)
      .map((w) => runWindow(w.id));
    await Promise.allSettled(runPromises);
    setIsExecutingAll(false);
  }, [state.windows, runWindow]);

  const stopAll = useCallback(() => {
    for (const [id, controller] of abortControllersRef.current) {
      controller.abort();
      updateWindow(id, { isRunning: false });
    }
    abortControllersRef.current.clear();
    setIsExecutingAll(false);
  }, [updateWindow]);

  const resetPlayground = useCallback(() => {
    // Stop all running requests
    for (const controller of abortControllersRef.current.values()) {
      controller.abort();
    }
    abortControllersRef.current.clear();
    setState({ windows: [createDefaultWindow()] });
    setIsExecutingAll(false);
  }, []);

  const duplicateWindow = useCallback(
    (id: string) => {
      const win = state.windows.find((w) => w.id === id);
      if (!win) return;
      const newWindow: PlaygroundWindow = {
        ...createDefaultWindow(),
        prompt: win.prompt,
        model: win.model,
        temperature: win.temperature,
        maxTokens: win.maxTokens,
        variables: { ...win.variables },
      };
      setState((prev) => ({
        ...prev,
        windows: [...prev.windows, newWindow],
      }));
    },
    [state.windows],
  );

  const hasAnyRunning = state.windows.some((w) => w.isRunning);
  const windowCount = state.windows.length;

  return (
    <Page width="full">
      <PageHeader
        title="Compare models"
        description="Run one prompt on several models side by side. Use {{variable}} for values you want to swap; results are not saved."
        actions={
          <>
            {hasAnyRunning && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Running
              </span>
            )}
            <Button variant="outline" size="sm" onClick={addWindow}>
              <Plus />
              Add window
            </Button>
            {hasAnyRunning ? (
              <Button variant="destructive" size="sm" onClick={stopAll}>
                Stop all
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => void runAllWindows()}
                disabled={!state.windows.some((w) => w.prompt.trim())}
              >
                <Play />
                Run all
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={resetPlayground}
              aria-label="Reset"
              title="Reset"
            >
              <Trash2 />
            </Button>
          </>
        }
      />

      {windowCount === 0 ? (
        <EmptyState
          title="No windows"
          description="Add a window to start comparing models."
          action={
            <Button size="sm" onClick={addWindow}>
              <Plus />
              Add window
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))]">
          {state.windows.map((w) => (
            <PlaygroundWindowComponent
              key={w.id}
              window={w}
              onUpdate={updateWindow}
              onRemove={removeWindow}
              onDuplicate={duplicateWindow}
              onRun={runWindow}
              canRemove={windowCount > 1}
              isExecutingAll={isExecutingAll}
              models={models}
            />
          ))}
        </div>
      )}
      <LearnedRouting />
      <AnswerDrift />
    </Page>
  );
}
