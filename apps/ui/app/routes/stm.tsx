// SPDX-License-Identifier: Apache-2.0
/**
 * STM — Short-Term Memory
 *
 * Full-page view for managing active STM modules and reviewing
 * session-level prompt injection history.
 *
 * /stm
 */

import { useState, useEffect } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Switch } from "~/components/ui/switch";
import { AlertTriangle, MemoryStick, Clock, Trash2, RefreshCcw, ChevronRight } from "lucide-react";
import {
  STM_MODULES,
  loadActiveSTM,
  saveActiveSTM,
  getConflicts,
  type STMModuleId,
} from "~/lib/stm";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SessionEntry {
  id: string;
  timestamp: number;
  query: string;
  modules: STMModuleId[];
  applied: string[];
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

function useSessionHistory() {
  const [history, setHistory] = useState<SessionEntry[]>([]);

  const refresh = async () => {
    try {
      const res = await fetch("/api/stm/history");
      if (res.ok) {
        const data = await res.json();
        setHistory(data.entries ?? []);
      }
    } catch {
      /* offline */
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const clear = async () => {
    try {
      await fetch("/api/stm/history", { method: "DELETE" });
      setHistory([]);
    } catch {
      /* ignore */
    }
  };

  return { history, refresh, clear };
}

// ── Main ─────────────────────────────────────────────────────────────────────

export default function STMPage() {
  const [active, setActive] = useState<STMModuleId[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { history, refresh, clear } = useSessionHistory();

  useEffect(() => {
    setActive(loadActiveSTM());
  }, []);

  const toggle = async (id: STMModuleId) => {
    const next = active.includes(id) ? active.filter((m) => m !== id) : [...active, id];

    const module = STM_MODULES.find((m) => m.id === id);
    const conflicts = module?.conflictsWith ?? [];
    const clean = next.filter((m) => !conflicts.includes(m as STMModuleId) || m === id);

    setActive(clean);
    saveActiveSTM(clean);

    fetch("/api/stm/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modules: clean }),
    }).catch(() => {});
  };

  const conflicts = getConflicts(active);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Left — module control */}
      <aside
        className="w-80 shrink-0 flex flex-col border-r border-border"
        style={{ background: "hsl(var(--card))" }}
      >
        <div className="border-b border-border px-5 py-4 flex items-center gap-2.5">
          <MemoryStick className="size-4 text-primary" />
          <div>
            <h2 className="text-sm font-semibold">STM Modules</h2>
            <p className="text-xs text-muted-foreground">Prompt modifiers per round</p>
          </div>
          {active.length > 0 && (
            <Badge variant="outline" className="ml-auto text-xs">
              {active.length} active
            </Badge>
          )}
        </div>

        <ScrollArea className="flex-1">
          <div className="p-4 space-y-2.5">
            {STM_MODULES.map((m) => {
              const isActive = active.includes(m.id);
              const hasConflict = conflicts.some((c) => c.includes(m.label));

              return (
                <div
                  key={m.id}
                  className="p-3.5 rounded-xl transition-all"
                  style={{
                    background: isActive ? "hsl(var(--primary)/0.09)" : "hsl(var(--muted)/0.35)",
                    border: `1px solid ${isActive ? "hsl(var(--primary)/0.35)" : "hsl(var(--border)/0.5)"}`,
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <span className="text-xl leading-none mt-0.5">{m.icon}</span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-semibold">{m.label}</span>
                          {hasConflict && (
                            <AlertTriangle className="size-3 text-amber-500 shrink-0" />
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                          {m.description}
                        </p>
                        {m.conflictsWith && m.conflictsWith.length > 0 && (
                          <p className="text-[10px] text-muted-foreground/50 mt-1">
                            Conflicts:{" "}
                            {m.conflictsWith
                              .map((c) => STM_MODULES.find((x) => x.id === c)?.label ?? c)
                              .join(", ")}
                          </p>
                        )}
                      </div>
                    </div>
                    <Switch
                      checked={isActive}
                      onCheckedChange={() => toggle(m.id)}
                      className="shrink-0 mt-0.5"
                    />
                  </div>

                  {/* Injection preview */}
                  {isActive && (
                    <div
                      className="mt-3 rounded-lg p-2.5 font-mono text-[10px] text-muted-foreground leading-relaxed"
                      style={{ background: "hsl(var(--muted)/0.5)" }}
                    >
                      {m.injection}
                    </div>
                  )}
                </div>
              );
            })}

            {conflicts.length > 0 && (
              <div
                className="flex items-start gap-2 p-2.5 rounded-lg text-xs mt-2"
                style={{
                  background: "hsl(38 92% 50%/0.1)",
                  border: "1px solid hsl(38 92% 50%/0.3)",
                }}
              >
                <AlertTriangle className="size-3.5 text-amber-500 shrink-0 mt-0.5" />
                <span className="text-amber-600 dark:text-amber-400">{conflicts.join("; ")}</span>
              </div>
            )}
          </div>
        </ScrollArea>
      </aside>

      {/* Right — session history */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="border-b border-border px-6 py-4 flex items-center gap-3 shrink-0">
          <Clock className="size-4 text-muted-foreground" />
          <div>
            <h1 className="text-base font-semibold">Injection History</h1>
            <p className="text-xs text-muted-foreground">STM modules applied per deliberation</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5" onClick={refresh}>
              <RefreshCcw className="size-3" /> Refresh
            </Button>
            {history.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs gap-1.5 text-destructive hover:text-destructive"
                onClick={clear}
              >
                <Trash2 className="size-3" /> Clear
              </Button>
            )}
          </div>
        </header>

        <ScrollArea className="flex-1">
          {history.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-10">
              <MemoryStick className="size-12 text-primary/20" />
              <div>
                <p className="text-sm font-medium">No injection history</p>
                <p className="text-xs text-muted-foreground mt-2 max-w-xs">
                  Enable STM modules on the left, then run a deliberation. Each round's injections
                  are logged here.
                </p>
              </div>
            </div>
          ) : (
            <div className="p-5 space-y-2">
              {history.map((entry) => {
                const isExpanded = expanded === entry.id;
                return (
                  <div
                    key={entry.id}
                    className="rounded-xl overflow-hidden"
                    style={{ border: "1px solid hsl(var(--border)/0.5)" }}
                  >
                    <button
                      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
                      onClick={() => setExpanded(isExpanded ? null : entry.id)}
                    >
                      <ChevronRight
                        className="size-3.5 text-muted-foreground transition-transform"
                        style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{entry.query}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] text-muted-foreground font-mono">
                            {new Date(entry.timestamp).toLocaleString()}
                          </span>
                          <div className="flex gap-1">
                            {entry.modules.map((id) => {
                              const mod = STM_MODULES.find((m) => m.id === id);
                              return mod ? (
                                <Badge key={id} variant="outline" className="text-[10px] h-4 px-1">
                                  {mod.icon} {mod.label}
                                </Badge>
                              ) : null;
                            })}
                          </div>
                        </div>
                      </div>
                    </button>

                    {isExpanded && (
                      <div
                        className="px-4 pb-4 space-y-2"
                        style={{ background: "hsl(var(--muted)/0.2)" }}
                      >
                        {entry.applied.map((injection, i) => (
                          <div
                            key={i}
                            className="rounded-lg p-3 font-mono text-[10px] text-muted-foreground leading-relaxed"
                            style={{
                              background: "hsl(var(--muted)/0.5)",
                              border: "1px solid hsl(var(--border)/0.4)",
                            }}
                          >
                            {injection}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}
