/**
 * Theme management
 *
 * Themes: default-light | default-dark | matrix | glyph
 * Persisted to localStorage. Applied via data-theme attribute on <html>.
 */

export type ThemeId = "default-light" | "default-dark" | "matrix" | "glyph";

export interface Theme {
  id:          ThemeId;
  label:       string;
  description: string;
  preview:     string;  // short CSS color preview
}

export const THEMES: Theme[] = [
  {
    id:          "default-light",
    label:       "Default Light",
    description: "Warm parchment — amber gold accents",
    preview:     "#f5f0e8",
  },
  {
    id:          "default-dark",
    label:       "Default Dark",
    description: "Deep charcoal — warm gold accents",
    preview:     "#141210",
  },
  {
    id:          "matrix",
    label:       "Matrix",
    description: "Phosphor green on black. The one.",
    preview:     "#001800",
  },
  {
    id:          "glyph",
    label:       "Glyph",
    description: "Electric violet, zero radius, hacker dark",
    preview:     "#0a0814",
  },
];

const THEME_KEY = "nexus_theme";

export function getStoredTheme(): ThemeId {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw && THEMES.find((t) => t.id === raw)) return raw as ThemeId;
  } catch { /* ignore */ }
  return "default-dark";
}

export function applyTheme(id: ThemeId) {
  const root = document.documentElement;

  // Remove all theme classes / attributes
  root.classList.remove("dark");
  root.removeAttribute("data-theme");

  if (id === "default-dark") {
    root.classList.add("dark");
  } else if (id === "default-light") {
    // no class, no attribute — default :root styles
  } else {
    root.classList.add("dark");
    root.setAttribute("data-theme", id);
  }

  localStorage.setItem(THEME_KEY, id);
}

export function initTheme() {
  const stored = getStoredTheme();
  applyTheme(stored);
  return stored;
}
