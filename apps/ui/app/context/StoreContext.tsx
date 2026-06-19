// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CustomModel {
  id: string;
  label: string;
  apiUrl: string;
  apiKey?: string;
}

export interface CustomArchetype {
  id: string;
  name: string;
  icon: string;
  color: string;
  thinkingStyle: string;
  description: string;
  systemPrompt?: string;
  model?: string;
  temperature?: number;
}

// ─── Built-in models (always available) ─────────────────────────────────────

const BUILTIN_MODELS = [
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "llama-3.3-70b", label: "Llama 3.3 70B" },
];

// ─── Context ────────────────────────────────────────────────────────────────

interface StoreContextType {
  // Models
  builtinModels: typeof BUILTIN_MODELS;
  customModels: CustomModel[];
  allModels: { id: string; label: string }[];
  addCustomModel: (model: Omit<CustomModel, "id">) => string;

  // Archetypes
  customArchetypes: CustomArchetype[];
  addCustomArchetype: (arch: Omit<CustomArchetype, "id">) => void;
  updateArchetype: (id: string, data: Partial<CustomArchetype>) => void;
  removeArchetype: (id: string) => void;
}

const StoreContext = createContext<StoreContextType | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [customModels, setCustomModels] = useState<CustomModel[]>([]);
  const [customArchetypes, setCustomArchetypes] = useState<CustomArchetype[]>([]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  function lsGet<T>(key: string, fallback: T): T {
    if (typeof window === "undefined") return fallback;
    try {
      const s = localStorage.getItem(key);
      return s ? JSON.parse(s) : fallback;
    } catch {
      return fallback;
    }
  }

  function lsSet(key: string, value: unknown) {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }

  // ── Load archetypes: API first, localStorage fallback ─────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    fetch("/api/archetypes?custom=true")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        const list: CustomArchetype[] = Array.isArray(data)
          ? data
          : (data?.archetypes ?? data?.data ?? []);
        if (list.length > 0) {
          setCustomArchetypes(list);
          lsSet("Nexus_custom_archetypes", list);
        } else {
          // API returned empty — use localStorage seeds
          setCustomArchetypes(lsGet("Nexus_custom_archetypes", []));
        }
      })
      .catch(() => {
        setCustomArchetypes(lsGet("Nexus_custom_archetypes", []));
      });
  }, []);

  // ── Load custom models: localStorage only (no dedicated API) ──────────────
  useEffect(() => {
    setCustomModels(lsGet("Nexus_custom_models", []));
  }, []);

  // ── Persist custom models to localStorage ─────────────────────────────────
  useEffect(() => {
    lsSet("Nexus_custom_models", customModels);
  }, [customModels]);

  // ── Model helpers ─────────────────────────────────────────────────────────

  const addCustomModel = useCallback((model: Omit<CustomModel, "id">) => {
    const id = `custom-model-${Date.now()}`;
    setCustomModels((prev) => [...prev, { ...model, id }]);
    return id;
  }, []);

  const allModels = [...BUILTIN_MODELS, ...customModels.map((m) => ({ id: m.id, label: m.label }))];

  // ── Archetype helpers — sync to API + localStorage ────────────────────────

  const addCustomArchetype = useCallback((arch: Omit<CustomArchetype, "id">) => {
    const optimisticId = `custom-arch-${Date.now()}`;
    const newArch: CustomArchetype = { ...arch, id: optimisticId };
    setCustomArchetypes((prev) => {
      const next = [...prev, newArch];
      lsSet("Nexus_custom_archetypes", next);
      return next;
    });
    // Persist to backend
    fetch("/api/archetypes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(arch),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((created) => {
        if (created?.id && created.id !== optimisticId) {
          setCustomArchetypes((prev) => {
            const next = prev.map((a) => (a.id === optimisticId ? { ...a, id: created.id } : a));
            lsSet("Nexus_custom_archetypes", next);
            return next;
          });
        }
      })
      .catch(() => {});
  }, []);

  const updateArchetype = useCallback((id: string, data: Partial<CustomArchetype>) => {
    setCustomArchetypes((prev) => {
      const next = prev.map((a) => (a.id === id ? { ...a, ...data } : a));
      lsSet("Nexus_custom_archetypes", next);
      return next;
    });
    fetch(`/api/archetypes/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }).catch(() => {});
  }, []);

  const removeArchetype = useCallback((id: string) => {
    setCustomArchetypes((prev) => {
      const next = prev.filter((a) => a.id !== id);
      lsSet("Nexus_custom_archetypes", next);
      return next;
    });
    fetch(`/api/archetypes/${id}`, { method: "DELETE" }).catch(() => {});
  }, []);

  return (
    <StoreContext.Provider
      value={{
        builtinModels: BUILTIN_MODELS,
        customModels,
        allModels,
        addCustomModel,
        customArchetypes,
        addCustomArchetype,
        updateArchetype,
        removeArchetype,
      }}
    >
      {children}
    </StoreContext.Provider>
  );
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}
