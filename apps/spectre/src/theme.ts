// SPDX-License-Identifier: Apache-2.0

export type ThemeId = "void" | "ember" | "neon" | "ghost";

export interface Theme {
  id: ThemeId;
  label: string;
  vars: Record<string, string>;
}

export const THEMES: Theme[] = [
  {
    id: "void",
    label: "VOID",
    vars: {
      "--bg": "#080808",
      "--bg2": "#0f0f0f",
      "--bg3": "#161616",
      "--fg": "#00ff88",
      "--fg2": "#00cc66",
      "--fg3": "#007744",
      "--accent": "#00ff88",
      "--accent2": "#00cc66",
      "--border": "#003322",
      "--danger": "#ff4444",
      "--font": '"Courier New", Courier, monospace',
    },
  },
  {
    id: "ember",
    label: "EMBER",
    vars: {
      "--bg": "#0a0605",
      "--bg2": "#120a08",
      "--bg3": "#1c100c",
      "--fg": "#ff6600",
      "--fg2": "#cc4400",
      "--fg3": "#882200",
      "--accent": "#ff5500",
      "--accent2": "#cc3300",
      "--border": "#3a1005",
      "--danger": "#ff0044",
      "--font": '"Courier New", Courier, monospace',
    },
  },
  {
    id: "neon",
    label: "NEON",
    vars: {
      "--bg": "#07000f",
      "--bg2": "#0e0019",
      "--bg3": "#160025",
      "--fg": "#bf80ff",
      "--fg2": "#9c4dff",
      "--fg3": "#6600cc",
      "--accent": "#a855f7",
      "--accent2": "#7c3aed",
      "--border": "#2e0066",
      "--danger": "#ff3366",
      "--font": '"Courier New", Courier, monospace',
    },
  },
  {
    id: "ghost",
    label: "GHOST",
    vars: {
      "--bg": "#f5f5f5",
      "--bg2": "#ffffff",
      "--bg3": "#e8e8e8",
      "--fg": "#1a1a2e",
      "--fg2": "#333355",
      "--fg3": "#666688",
      "--accent": "#6366f1",
      "--accent2": "#4f46e5",
      "--border": "#d1d5db",
      "--danger": "#ef4444",
      "--font": "system-ui, -apple-system, sans-serif",
    },
  },
];

const STORAGE_KEY = "spectre_theme";

export function getTheme(id: ThemeId): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}

export function applyTheme(id: ThemeId): void {
  const theme = getTheme(id);
  const root = document.documentElement;
  for (const [key, val] of Object.entries(theme.vars)) {
    root.style.setProperty(key, val);
  }
  localStorage.setItem(STORAGE_KEY, id);
}

export function loadSavedTheme(): ThemeId {
  const saved = localStorage.getItem(STORAGE_KEY) as ThemeId | null;
  return saved && THEMES.some((t) => t.id === saved) ? saved : "void";
}
