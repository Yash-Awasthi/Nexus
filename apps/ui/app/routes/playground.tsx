// SPDX-License-Identifier: Apache-2.0
/**
 * Playground — Multi-window LLM prompt testing and comparison.
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
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Textarea } from "~/components/ui/textarea";

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

const MODELS = [
  "openai/gpt-oss-120b",
  "gpt-4o-mini",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "deepseek-chat",
];

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
  onRun: (id: string) => void;
  canRemove: boolean;
  isExecutingAll: boolean;
}

function PlaygroundWindowComponent({
  window: w,
  onUpdate,
  onRemove,
  onRun,
  canRemove,
  isExecutingAll,
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
    <div className="flex flex-col border border-border rounded-lg bg-background overflow-hidden">
      {/* Window header */}
      <div className="h-10 border-b border-border flex items-center px-3 gap-2 bg-muted/30 shrink-0">
        <span className="text-xs font-medium text-muted-foreground truncate flex-1">
          Window
        </span>
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
            onClick={() => onUpdate(w.id, { result: null, error: null, tokenUsage: null, timing: null })}
            title="Clear result"
          >
            <RotateCcw className="size-3.5" />
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
      <div className="h-9 border-b border-border flex items-center px-3 gap-2 bg-background shrink-0">
        <select
          value={w.model}
          onChange={(e) => onUpdate(w.id, { model: e.target.value })}
          className="text-[11px] font-mono bg-background border border-border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary"
        >
          {MODELS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Settings2 className="size-3" />
          <span>temp</span>
          <input
            type="number"
            value={w.temperature}
            onChange={(e) =>
              onUpdate(w.id, { temperature: parseFloat(e.target.value) || 0 })
            }
            min={0}
            max={2}
            step={0.1}
            className="w-12 text-[10px] font-mono bg-background border border-border rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <span className="ml-1">max</span>
          <input
            type="number"
            value={w.maxTokens}
            onChange={(e) =>
              onUpdate(w.id, { maxTokens: parseInt(e.target.value) || 256 })
            }
            min={64}
            max={128000}
            step={256}
            className="w-16 text-[10px] font-mono bg-background border border-border rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-primary"
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
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">
              Variables
            </span>
            {variables.map((v) => (
              <Badge
                key={v}
                variant="outline"
                className="text-[9px] h-4 font-mono border-orange-500/40 text-orange-400 bg-orange-500/5"
              >
                {`{{${v}}}`}
              </Badge>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {variables.map((v) => (
              <div key={v} className="flex items-center gap-1">
                <span className="text-[10px] font-mono text-muted-foreground">{v}:</span>
                <Input
                  value={w.variables[v] ?? ""}
                  onChange={(e) =>
                    onUpdate(w.id, {
                      variables: { ...w.variables, [v]: e.target.value },
                    })
                  }
                  placeholder={v}
                  className="h-6 text-[10px] font-mono w-32"
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
            <span className="text-[10px] font-medium text-muted-foreground">Result</span>
            <div className="flex items-center gap-2 ml-auto">
              {w.timing && (
                <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
                  <Clock className="size-2.5" />
                  {formatDuration(w.timing.endTime - w.timing.startTime)}
                </span>
              )}
              {w.tokenUsage && (
                <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
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

export default function PlaygroundPage() {
  const [state, setState] = useState<PlaygroundState>(() => loadState());
  const [isExecutingAll, setIsExecutingAll] = useState(false);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

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
        // Call the gateway API for LLM inference
        const response = await fetch("/api/deliberate", {
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
          const body = await response.json().catch(() => ({}));
          throw new Error(
            (body as { message?: string }).message ?? `Request failed: ${response.status}`
          );
        }

        const data = await response.json() as {
          content?: string;
          usage?: { input_tokens: number; output_tokens: number };
        };

        updateWindow(id, {
          isRunning: false,
          result: data.content ?? "No response",
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
    [state.windows, updateWindow]
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
    [state.windows]
  );

  const hasAnyRunning = state.windows.some((w) => w.isRunning);
  const windowCount = state.windows.length;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Page header */}
      <div className="h-12 border-b border-border flex items-center px-4 gap-3 bg-background shrink-0">
        <span className="text-sm font-semibold">Playground</span>
        <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
          {windowCount} window{windowCount !== 1 ? "s" : ""}
        </Badge>
        {hasAnyRunning && (
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Running...
          </div>
        )}
        <div className="flex items-center gap-2 ml-auto">
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={addWindow}
          >
            <Plus className="size-3.5" />
            Add Window
          </Button>
          {hasAnyRunning ? (
            <Button
              variant="destructive"
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={stopAll}
            >
              Stop All
            </Button>
          ) : (
            <Button
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={runAllWindows}
              disabled={!state.windows.some((w) => w.prompt.trim())}
            >
              <Play className="size-3.5" />
              Run All
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={resetPlayground}
            title="Reset playground"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Windows grid */}
      <div className="flex-1 overflow-auto p-4">
        {windowCount === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-3">
              <div className="text-4xl">🧪</div>
              <p className="text-sm text-muted-foreground">
                Add a window to start testing prompts
              </p>
              <Button size="sm" onClick={addWindow} className="gap-1.5">
                <Plus className="size-3.5" />
                Add Window
              </Button>
            </div>
          </div>
        ) : (
          <div
            className="grid gap-4"
            style={{
              gridTemplateColumns: `repeat(${Math.min(windowCount, 3)}, 1fr)`,
            }}
          >
            {state.windows.map((w) => (
              <PlaygroundWindowComponent
                key={w.id}
                window={w}
                onUpdate={updateWindow}
                onRemove={removeWindow}
                onRun={runWindow}
                canRemove={windowCount > 1}
                isExecutingAll={isExecutingAll}
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer info */}
      <div className="h-8 border-t border-border flex items-center px-4 text-[10px] text-muted-foreground bg-muted/20 shrink-0 gap-4">
        <span>
          Tip: Use {"{{variable}}"} syntax in prompts for dynamic values
        </span>
        <span>•</span>
        <span>Results are not persisted — use prompts page for versioning</span>
      </div>
    </div>
  );
}
