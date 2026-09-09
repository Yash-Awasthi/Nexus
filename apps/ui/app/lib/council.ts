// SPDX-License-Identifier: Apache-2.0
// Council member types shared between frontend and electron main

export type MemberMode = "browser" | "api";

export interface CouncilMember {
  id: string;
  label: string;
  enabled: boolean;
  mode: MemberMode;
  // API mode fields
  provider: string; // "openai" | "anthropic" | "deepseek" | "groq" | "ollama" | "openrouter" | "gemini" | "mistral" | "custom"
  model: string;
  baseUrl: string; // for ollama/custom
  // NOTE: provider API keys are NOT stored here. They live encrypted server-side
  // (see /provider-keys). The backend resolves each member's key by provider.
  // Server-computed hint about which key backs this API-mode member:
  // "user" (saved provider key) | "oauth" (linked provider account) | "env"
  // (server env key) | "local" (Ollama) | "none".
  keySource?: "user" | "oauth" | "env" | "local" | "none";
}

export const API_PROVIDERS: {
  id: string;
  label: string;
  defaultModel: string;
  defaultBaseUrl: string;
  needsKey: boolean;
}[] = [
  {
    id: "openai",
    label: "OpenAI",
    // gpt-4o was retired from the API 2026-02-16 → gpt-5.6 family GA models.
    defaultModel: "gpt-5.6-sol",
    defaultBaseUrl: "https://api.openai.com/v1",
    needsKey: true,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    // claude-3-5-sonnet-20241022 was retired by Anthropic on 2025-10-22.
    defaultModel: "claude-sonnet-4-6",
    defaultBaseUrl: "https://api.anthropic.com",
    needsKey: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    defaultModel: "deepseek-v4-flash",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    needsKey: true,
  },
  {
    id: "groq",
    label: "Groq",
    // llama-3.3-70b-versatile was decommissioned by Groq on 2026-08-16;
    // openai/gpt-oss-120b is Groq's recommended replacement.
    defaultModel: "openai/gpt-oss-120b",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    needsKey: true,
  },
  {
    id: "gemini",
    label: "Gemini API",
    // gemini-2.0-flash is decommissioned on current Gemini keys and
    // gemini-2.5-flash is legacy for new users (verified against the live
    // /chat/completions API) — gemini-3.6-flash is the current default.
    defaultModel: "gemini-3.6-flash",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    needsKey: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    defaultModel: "openai/gpt-4o",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    needsKey: true,
  },
  {
    id: "mistral",
    label: "Mistral",
    defaultModel: "mistral-large-latest",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    needsKey: true,
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    defaultModel: "grok-4.3",
    defaultBaseUrl: "https://api.x.ai/v1",
    needsKey: true,
  },
  {
    id: "together",
    label: "Together AI",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    defaultBaseUrl: "https://api.together.xyz/v1",
    needsKey: true,
  },
  {
    id: "perplexity",
    label: "Perplexity",
    // Plain "sonar" retires on 2026-09-27; sonar-pro has no announced EOL.
    defaultModel: "sonar-pro",
    defaultBaseUrl: "https://api.perplexity.ai",
    needsKey: true,
  },
  {
    id: "cohere",
    label: "Cohere",
    defaultModel: "command-a",
    defaultBaseUrl: "https://api.cohere.ai/compatibility/v1",
    needsKey: true,
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    defaultModel: "llama3.2",
    defaultBaseUrl: "http://localhost:11434/v1",
    needsKey: false,
  },
  { id: "custom", label: "Custom URL", defaultModel: "", defaultBaseUrl: "", needsKey: true },
  // OAuth-backed providers: no API key — chat streams through the account the
  // user linked under Settings → Council → Linked accounts (llm-oauth).
  {
    id: "vertex",
    label: "Google Vertex (linked account)",
    defaultModel: "gemini-3.6-flash",
    defaultBaseUrl: "",
    needsKey: false,
  },
  {
    id: "azure_openai",
    label: "Azure OpenAI (linked account)",
    defaultModel: "gpt-5.6-sol",
    defaultBaseUrl: "",
    needsKey: false,
  },
];

export const DEFAULT_MEMBERS: CouncilMember[] = [
  {
    id: "chatgpt",
    label: "ChatGPT",
    enabled: true,
    mode: "browser",
    provider: "openai",
    model: "gpt-5.6-sol",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    id: "gemini",
    label: "Gemini",
    enabled: true,
    mode: "browser",
    provider: "gemini",
    model: "gemini-3.6-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  {
    id: "claude",
    label: "Claude",
    enabled: true,
    mode: "browser",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    baseUrl: "https://api.anthropic.com",
  },
];

const COUNCIL_KEY = "nexus_council";

export function loadCouncilMembers(): CouncilMember[] {
  try {
    const raw = localStorage.getItem(COUNCIL_KEY);
    if (!raw) return DEFAULT_MEMBERS;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_MEMBERS;
    // Purge any legacy plaintext `apiKey` left over from before keys moved
    // server-side; if we strip any, persist the cleaned config back to disk.
    let hadKeys = false;
    const cleaned = (parsed as (CouncilMember & { apiKey?: string })[]).map((m) => {
      if (m && typeof m === "object" && "apiKey" in m) {
        hadKeys = true;
        const { apiKey: _drop, ...rest } = m;
        void _drop;
        return rest as CouncilMember;
      }
      return m as CouncilMember;
    });
    if (hadKeys) saveCouncilMembers(cleaned);
    return cleaned;
  } catch {
    return DEFAULT_MEMBERS;
  }
}

export function saveCouncilMembers(members: CouncilMember[]) {
  localStorage.setItem(COUNCIL_KEY, JSON.stringify(members));
}

/**
 * Merge server members with local state. The server copy is the durable,
 * cross-browser source; the local copy (written by the in-chat Settings panel,
 * which only persists locally) wins per-member where it differs, and any
 * local-only members (e.g. custom URLs) are appended.
 */
export function mergeCouncilMembers(
  server: CouncilMember[],
  local: CouncilMember[],
): CouncilMember[] {
  const byId = new Map(local.map((m) => [m.id, m]));
  const merged = server.map((m) => {
    const localM = byId.get(m.id);
    if (!localM) return m;
    // keySource is server-computed metadata (which key backs this member) — a
    // stale local copy must never clobber the server's current answer.
    const { keySource: _serverAuthored, ...localRest } = localM;
    void _serverAuthored;
    return { ...m, ...localRest };
  });
  const serverIds = new Set(server.map((m) => m.id));
  for (const m of local) {
    if (!serverIds.has(m.id)) merged.push(m);
  }
  return merged;
}

/**
 * Load the server-persisted council config (per authenticated user) and merge
 * it with the local copy. Falls back to the local copy (or defaults) when the
 * server is unreachable. Returns the merged member list and persists it back
 * to localStorage so chat can read it synchronously.
 */
export async function syncCouncilFromServer(): Promise<CouncilMember[]> {
  // Only an EXPLICIT local config (the nexus_council key exists) counts as a
  // local override — the implicit defaults must never clobber the user's real
  // server config on a fresh browser.
  const hasLocal = localStorage.getItem(COUNCIL_KEY) !== null;
  const local = hasLocal ? loadCouncilMembers() : [];
  try {
    const res = await fetch("/api/settings/council", {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return loadCouncilMembers();
    const data = (await res.json()) as {
      members?: CouncilMember[];
      seeded?: boolean;
    };
    if (!Array.isArray(data.members)) return loadCouncilMembers();
    // For a fresh (seeded) user the server config is authoritative and clean —
    // don't append leftover local-only members (e.g. a previous account's
    // custom members lingering in a reused browser). Users with a real server
    // config keep local-only members so in-chat edits survive.
    const localForMerge = data.seeded
      ? local.filter((m) => data.members!.some((s) => s.id === m.id))
      : local;
    const merged = hasLocal ? mergeCouncilMembers(data.members, localForMerge) : data.members;
    saveCouncilMembers(merged);
    return merged;
  } catch {
    return loadCouncilMembers();
  }
}

export function newMember(): CouncilMember {
  return {
    id: crypto.randomUUID(),
    label: "New Member",
    enabled: true,
    mode: "api",
    provider: "deepseek",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1",
  };
}
