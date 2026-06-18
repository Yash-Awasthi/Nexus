/**
 * STM module client library
 *
 * Mirrors the backend stmModules.ts — handles local persistence
 * and applies injections to system prompts on the frontend.
 */

export type STMModuleId = "hedge_reducer" | "direct_mode" | "curiosity_bias";

export interface STMModule {
  id:          STMModuleId;
  label:       string;
  description: string;
  icon:        string;
  injection:   string;
  conflictsWith?: STMModuleId[];
}

export const STM_MODULES: STMModule[] = [
  {
    id:          "hedge_reducer",
    label:       "Hedge Reducer",
    description: "Eliminates hedging, caveats, and wishy-washy qualifications.",
    icon:        "✂",
    conflictsWith: ["curiosity_bias"],
    injection:
      'MODIFIER — HEDGE REDUCER: Never use "it depends", "arguably", "I think", "in my opinion". ' +
      "State conclusions directly. One clear answer per question.",
  },
  {
    id:          "direct_mode",
    label:       "Direct Mode",
    description: "Forces blunt, numbered answers. No padding, no preamble.",
    icon:        "⚡",
    injection:
      "MODIFIER — DIRECT MODE: Lead with the answer immediately. " +
      "Never restate the question. No warm opener/closer. Maximum information density.",
  },
  {
    id:          "curiosity_bias",
    label:       "Curiosity Bias",
    description: "Biases toward exploratory, counter-intuitive, and unexpected angles.",
    icon:        "🔭",
    conflictsWith: ["hedge_reducer"],
    injection:
      "MODIFIER — CURIOSITY BIAS: Actively seek non-obvious angles. " +
      "Surface surprising connections. Propose at least one counter-intuitive hypothesis. " +
      "End with one open question that would change your answer if resolved.",
  },
];

const STM_KEY = "nexus_stm_active";

export function loadActiveSTM(): STMModuleId[] {
  try {
    const raw = localStorage.getItem(STM_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveActiveSTM(ids: STMModuleId[]) {
  localStorage.setItem(STM_KEY, JSON.stringify(ids));
}

export function applySTM(systemPrompt: string, activeIds: STMModuleId[]): string {
  if (!activeIds.length) return systemPrompt;
  const injections = activeIds
    .map((id) => STM_MODULES.find((m) => m.id === id)?.injection)
    .filter(Boolean)
    .join("\n\n");
  return injections ? `${systemPrompt.trim()}\n\n${injections}` : systemPrompt;
}

export function getConflicts(activeIds: STMModuleId[]): string[] {
  const errors: string[] = [];
  for (const id of activeIds) {
    const mod = STM_MODULES.find((m) => m.id === id);
    if (!mod) continue;
    for (const conflict of mod.conflictsWith ?? []) {
      if (activeIds.includes(conflict)) {
        const c = STM_MODULES.find((m) => m.id === conflict);
        errors.push(`"${mod.label}" conflicts with "${c?.label ?? conflict}"`);
      }
    }
  }
  return [...new Set(errors)];
}
