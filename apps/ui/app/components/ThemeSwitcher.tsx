/**
 * ThemeSwitcher — compact theme picker
 * Used in Settings and the header menu.
 */

import { useState, useEffect } from "react";
import { THEMES, getStoredTheme, applyTheme, type ThemeId } from "~/lib/theme";
import { Palette } from "lucide-react";

export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const [current, setCurrent] = useState<ThemeId>("default-dark");

  useEffect(() => {
    setCurrent(getStoredTheme());
  }, []);

  const handleChange = (id: ThemeId) => {
    setCurrent(id);
    applyTheme(id);
  };

  if (compact) {
    return (
      <div className="flex items-center gap-1.5" title="Theme">
        <Palette className="size-3.5 text-muted-foreground" />
        <div className="flex gap-1">
          {THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => handleChange(t.id)}
              title={t.label}
              className="size-4 rounded-full border-2 transition-transform hover:scale-110"
              style={{
                background:   t.preview,
                borderColor:  current === t.id ? "hsl(var(--primary))" : "hsl(var(--border))",
                transform:    current === t.id ? "scale(1.2)" : undefined,
              }}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Palette className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Theme</h3>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {THEMES.map((t) => (
          <button
            key={t.id}
            onClick={() => handleChange(t.id)}
            className="flex items-start gap-3 p-3 rounded-lg text-left transition-all"
            style={{
              background: current === t.id ? "hsl(var(--primary)/0.1)" : "hsl(var(--muted)/0.3)",
              border:     `1px solid ${current === t.id ? "hsl(var(--primary)/0.4)" : "hsl(var(--border)/0.5)"}`,
            }}
          >
            <div
              className="size-8 rounded-md shrink-0 mt-0.5"
              style={{ background: t.preview, border: "1px solid hsl(var(--border)/0.6)" }}
            />
            <div className="min-w-0">
              <p className="text-xs font-medium truncate">{t.label}</p>
              <p className="text-xs text-muted-foreground truncate">{t.description}</p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
