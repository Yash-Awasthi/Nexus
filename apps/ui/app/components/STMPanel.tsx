/**
 * STM Panel — STM module selector
 *
 * Shown in Settings and Chat sidebar. Toggles active STM modules
 * with conflict detection. Persists to localStorage + backend.
 */

import { useState, useEffect } from "react";
import { Badge } from "~/components/ui/badge";
import { Switch } from "~/components/ui/switch";
import { AlertTriangle } from "lucide-react";
import {
  STM_MODULES,
  loadActiveSTM,
  saveActiveSTM,
  getConflicts,
  type STMModuleId,
} from "~/lib/stm";

export function STMPanel({ compact = false }: { compact?: boolean }) {
  const [active, setActive] = useState<STMModuleId[]>([]);

  useEffect(() => {
    setActive(loadActiveSTM());
  }, []);

  const toggle = async (id: STMModuleId) => {
    const next = active.includes(id)
      ? active.filter((m) => m !== id)
      : [...active, id];

    // Conflict check — remove conflicting modules
    const module     = STM_MODULES.find((m) => m.id === id);
    const conflicts  = module?.conflictsWith ?? [];
    const deconflicted = next.filter((m) => !conflicts.includes(m as STMModuleId) || m === id);

    setActive(deconflicted);
    saveActiveSTM(deconflicted);

    // Sync to backend (best-effort)
    fetch("/api/stm/active", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ modules: deconflicted }),
    }).catch(() => {});
  };

  const conflicts = getConflicts(active);

  if (compact) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {STM_MODULES.map((m) => (
          <button
            key={m.id}
            onClick={() => toggle(m.id)}
            className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs transition-colors"
            style={{
              background: active.includes(m.id) ? "hsl(var(--primary)/0.15)" : "hsl(var(--muted)/0.4)",
              border:     `1px solid ${active.includes(m.id) ? "hsl(var(--primary)/0.4)" : "hsl(var(--border)/0.5)"}`,
              color:      active.includes(m.id) ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))",
            }}
          >
            <span>{m.icon}</span>
            <span>{m.label}</span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">STM Modules</h3>
        {active.length > 0 && (
          <Badge variant="outline" className="text-xs">{active.length} active</Badge>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Prompt modifiers applied to every council member's system prompt each round.
      </p>

      <div className="space-y-2">
        {STM_MODULES.map((m) => {
          const isActive    = active.includes(m.id);
          const hasConflict = conflicts.some((c) => c.includes(m.label));

          return (
            <div
              key={m.id}
              className="flex items-start justify-between gap-3 p-3 rounded-lg transition-colors"
              style={{
                background: isActive ? "hsl(var(--primary)/0.08)" : "hsl(var(--muted)/0.3)",
                border:     `1px solid ${isActive ? "hsl(var(--primary)/0.3)" : "hsl(var(--border)/0.4)"}`,
              }}
            >
              <div className="flex items-start gap-2.5 min-w-0">
                <span className="text-lg leading-none mt-0.5">{m.icon}</span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{m.label}</span>
                    {hasConflict && (
                      <AlertTriangle className="size-3 text-amber-500 shrink-0" />
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{m.description}</p>
                  {m.conflictsWith && m.conflictsWith.length > 0 && (
                    <p className="text-xs text-muted-foreground/60 mt-1">
                      Conflicts with: {m.conflictsWith
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
          );
        })}
      </div>

      {conflicts.length > 0 && (
        <div
          className="flex items-start gap-2 p-2.5 rounded-lg text-xs"
          style={{ background: "hsl(38 92% 50%/0.1)", border: "1px solid hsl(38 92% 50%/0.3)" }}
        >
          <AlertTriangle className="size-3.5 text-amber-500 shrink-0 mt-0.5" />
          <span className="text-amber-600 dark:text-amber-400">{conflicts.join("; ")}</span>
        </div>
      )}
    </div>
  );
}
