/**
 * Internationalization (i18n) — Phase 1.27
 *
 * Lightweight i18n utilities for the Nexus frontend.
 * Inspired by i18next (MIT, i18next/i18next) and react-i18next patterns.
 *
 * Features:
 * - useTranslation() hook returning t() function
 * - Interpolation: t("hello", { name: "World" }) → "Hello, World!"
 * - Pluralization: t("item", { count: 2 }) → "2 items"
 * - Language detection from localStorage, navigator.language, fallback "en"
 * - No external dependencies — pure TypeScript/React
 *
 * Translation files live in frontend/app/lib/i18n/locales/{lang}.ts
 */

import { useState, useCallback, createContext, useContext, type ReactNode, useEffect } from "react";
import type { ComponentType } from "react";

export type TranslationKey = string;
export type TranslationValues = Record<string, string | number>;
export type Translations = Record<string, string | Record<string, string>>;

// ─── Built-in translations ───────────────────────────────────────────────────

export const en: Translations = {
  "app.name": "Nexus",
  "ask.placeholder": "Ask the council...",
  "ask.submit": "Ask",
  "ask.thinking": "The council is deliberating...",
  "sidebar.conversations": "Conversations",
  "sidebar.newChat": "New Chat",
  "sidebar.settings": "Settings",
  "sidebar.memory": "Memory",
  "sidebar.hypotheses": "Hypotheses",
  "sidebar.ideas": "Ideas",
  "nav.council": "Council",
  "nav.build": "Build",
  "nav.explore": "Explore",
  "settings.title": "Settings",
  "settings.language": "Language",
  "settings.theme": "Theme",
  "settings.verbosity": "Response Verbosity",
  "verbosity.concise": "Concise",
  "verbosity.standard": "Standard",
  "verbosity.detailed": "Detailed",
  "verbosity.exhaustive": "Exhaustive",
  "weather.sunny": "Clear Consensus",
  "weather.cloudy": "Partial Agreement",
  "weather.foggy": "Low Confidence",
  "weather.stormy": "High Disagreement",
  "error.generic": "Something went wrong. Please try again.",
  "error.rateLimit": "Too many requests. Please wait a moment.",
  "error.spendingLimit": "You've reached your spending limit for this period.",
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.delete": "Delete",
  "common.edit": "Edit",
  "common.close": "Close",
  "common.loading": "Loading...",
  "common.copy": "Copy",
  "common.copied": "Copied!",
  "item_one": "{{count}} item",
  "item_other": "{{count}} items",
};

export const es: Translations = {
  "app.name": "Nexus",
  "ask.placeholder": "Pregunta al consejo...",
  "ask.submit": "Preguntar",
  "ask.thinking": "El consejo está deliberando...",
  "sidebar.conversations": "Conversaciones",
  "sidebar.newChat": "Nueva Conversación",
  "sidebar.settings": "Configuración",
  "sidebar.memory": "Memoria",
  "settings.title": "Configuración",
  "settings.language": "Idioma",
  "settings.theme": "Tema",
  "common.save": "Guardar",
  "common.cancel": "Cancelar",
  "common.delete": "Eliminar",
  "common.edit": "Editar",
  "common.close": "Cerrar",
  "common.loading": "Cargando...",
  "common.copy": "Copiar",
  "common.copied": "¡Copiado!",
};

export const fr: Translations = {
  "app.name": "Nexus",
  "ask.placeholder": "Demandez au conseil...",
  "ask.submit": "Demander",
  "ask.thinking": "Le conseil délibère...",
  "sidebar.conversations": "Conversations",
  "sidebar.newChat": "Nouvelle conversation",
  "sidebar.settings": "Paramètres",
  "common.save": "Enregistrer",
  "common.cancel": "Annuler",
  "common.delete": "Supprimer",
  "common.edit": "Modifier",
  "common.close": "Fermer",
  "common.loading": "Chargement...",
  "common.copy": "Copier",
  "common.copied": "Copié !",
};

const LOCALES: Record<string, Translations> = { en, es, fr };
export const SUPPORTED_LANGUAGES = ["en", "es", "fr"] as const;
export type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];

// ─── Core translate function ─────────────────────────────────────────────────

export function translate(
  lang: string,
  key: string,
  values?: TranslationValues,
): string {
  const locale = LOCALES[lang] ?? LOCALES["en"];
  const fallback = LOCALES["en"];

  // Pluralization: look for key_one / key_other
  let raw: string | undefined;
  if (values?.count !== undefined) {
    const count = Number(values.count);
    const plural = count === 1 ? `${key}_one` : `${key}_other`;
    raw = (locale[plural] ?? fallback[plural]) as string | undefined;
  }
  raw = raw ?? ((locale[key] ?? fallback[key]) as string | undefined) ?? key;

  // Interpolation: replace {{var}} with values
  if (values) {
    raw = raw.replace(/\{\{(\w+)\}\}/g, (_, k) => String(values[k] ?? `{{${k}}}`));
  }

  return raw;
}

// ─── React context ───────────────────────────────────────────────────────────

interface I18nContext {
  language: string;
  setLanguage: (lang: string) => void;
  t: (key: string, values?: TranslationValues) => string;
}

import React from "react";
const I18nCtx = React.createContext<I18nContext>({
  language: "en",
  setLanguage: () => {},
  t: (key) => key,
});

function detectLanguage(): string {
  if (typeof window === "undefined") return "en";
  const stored = localStorage.getItem("Nexus_language");
  if (stored && SUPPORTED_LANGUAGES.includes(stored as SupportedLanguage)) return stored;
  const nav = navigator.language?.split("-")[0] ?? "en";
  return SUPPORTED_LANGUAGES.includes(nav as SupportedLanguage) ? nav : "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<string>("en");

  useEffect(() => {
    setLanguageState(detectLanguage());
  }, []);

  const setLanguage = useCallback((lang: string) => {
    if (SUPPORTED_LANGUAGES.includes(lang as SupportedLanguage)) {
      setLanguageState(lang);
      localStorage.setItem("Nexus_language", lang);
    }
  }, []);

  const t = useCallback(
    (key: string, values?: TranslationValues) => translate(language, key, values),
    [language],
  );

  return React.createElement(I18nCtx.Provider, { value: { language, setLanguage, t } }, children);
}

export function useTranslation() {
  return useContext(I18nCtx);
}
