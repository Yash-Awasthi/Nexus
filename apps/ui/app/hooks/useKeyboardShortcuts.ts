/**
 * Keyboard Shortcut System — Phase 1.25
 *
 * A lightweight, composable keyboard shortcut hook for the Nexus UI.
 *
 * Inspired by:
 * - tinykeys (MIT, jamiebuilds/tinykeys) — tiny key binding library
 * - Mousetrap (Apache 2.0, ccampbell/mousetrap) — keyboard shortcut library
 * - Linear's keyboard shortcut system — chord sequences (g→c for go to conversations)
 *
 * Features:
 * - Single key bindings: "mod+k", "mod+enter", "escape"
 * - Chord sequences: "g c" (press g, then c within 1.5s)
 * - Modifier normalization: "mod" = Ctrl on Windows/Linux, Cmd on Mac
 * - Suppressed in inputs/textareas (unless marked data-capture-shortcuts)
 *
 * Usage:
 *   useKeyboardShortcuts([
 *     { keys: "mod+k", action: openSearch, description: "Open search" },
 *     { keys: "g c", action: goToConversations, description: "Go to conversations" },
 *   ])
 */

import { useEffect, useCallback, useRef } from "react";

export interface KeyboardShortcut {
  keys: string;
  action: () => void;
  description: string;
  /** If true, fires even when focus is in an input/textarea */
  global?: boolean;
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPod|iPad/i.test(navigator.platform);

/** Normalize "mod" to the platform-specific meta key */
function normalizeKey(key: string): string {
  return key.replace(/\bmod\b/gi, IS_MAC ? "Meta" : "Control");
}

/** Check if a KeyboardEvent matches a key combo string (e.g., "mod+k", "escape") */
function matchesCombo(event: KeyboardEvent, combo: string): boolean {
  const normalized = normalizeKey(combo);
  const parts = normalized.split("+").map(p => p.trim().toLowerCase());

  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);

  const pressedKey = event.key.toLowerCase();
  if (pressedKey !== key) return false;

  for (const mod of modifiers) {
    if (mod === "ctrl" && !event.ctrlKey) return false;
    if (mod === "control" && !event.ctrlKey) return false;
    if (mod === "shift" && !event.shiftKey) return false;
    if (mod === "alt" && !event.altKey) return false;
    if (mod === "meta" && !event.metaKey) return false;
  }
  // No extra modifier pressed
  if (!modifiers.includes("ctrl") && !modifiers.includes("control") && event.ctrlKey) return false;
  if (!modifiers.includes("shift") && event.shiftKey) return false;
  if (!modifiers.includes("alt") && event.altKey) return false;
  if (!modifiers.includes("meta") && event.metaKey && !IS_MAC) return false;

  return true;
}

/** Returns true if focus is in a text input (shortcuts should be suppressed) */
function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || (el as HTMLElement).isContentEditable) {
    // Allow if element explicitly opts-in
    return !(el as HTMLElement).dataset.captureShortcuts;
  }
  return false;
}

/**
 * Register keyboard shortcuts.
 * Supports single combos ("mod+k") and chord sequences ("g c").
 */
export function useKeyboardShortcuts(shortcuts: KeyboardShortcut[]) {
  const pendingChordRef = useRef<string | null>(null);
  const chordTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    for (const shortcut of shortcuts) {
      const isChord = shortcut.keys.includes(" ");

      if (isChord) {
        const [first, second] = shortcut.keys.split(" ");

        if (pendingChordRef.current === normalizeKey(first)) {
          if (matchesCombo(event, second)) {
            if (!shortcut.global && isInputFocused()) continue;
            event.preventDefault();
            if (chordTimeoutRef.current) clearTimeout(chordTimeoutRef.current);
            pendingChordRef.current = null;
            shortcut.action();
            return;
          }
        }

        if (matchesCombo(event, first)) {
          if (!shortcut.global && isInputFocused()) continue;
          if (chordTimeoutRef.current) clearTimeout(chordTimeoutRef.current);
          pendingChordRef.current = normalizeKey(first);
          chordTimeoutRef.current = setTimeout(() => {
            pendingChordRef.current = null;
          }, 1500);
          return;
        }
      } else {
        if (matchesCombo(event, shortcut.keys)) {
          if (!shortcut.global && isInputFocused()) continue;
          event.preventDefault();
          shortcut.action();
          return;
        }
      }
    }
  }, [shortcuts]);

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (chordTimeoutRef.current) clearTimeout(chordTimeoutRef.current);
    };
  }, [handleKeyDown]);
}

/** Display a human-readable shortcut label */
export function formatShortcut(keys: string): string {
  const mac = IS_MAC;
  return keys
    .replace(/\bmod\b/gi, mac ? "⌘" : "Ctrl")
    .replace(/\bshift\b/gi, mac ? "⇧" : "Shift")
    .replace(/\balt\b/gi, mac ? "⌥" : "Alt")
    .replace(/\bescape\b/gi, "Esc")
    .replace(/\benter\b/gi, "↵")
    .replace(/\+/g, mac ? "" : "+")
    .replace(/ /g, " › ");
}

/** Convenience: app-wide default shortcuts reference */
export const APP_SHORTCUTS = {
  FOCUS_INPUT:     "mod+k",
  SUBMIT:          "mod+enter",
  NEW_CHAT:        "mod+n",
  TOGGLE_SIDEBAR:  "mod+b",
  GO_SETTINGS:     "g s",
  GO_CONVERSATIONS:"g c",
  GO_MEMORY:       "g m",
  CLOSE_MODAL:     "escape",
} as const;
