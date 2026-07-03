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
    defaultModel: "gpt-4o",
    defaultBaseUrl: "https://api.openai.com/v1",
    needsKey: true,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    defaultModel: "claude-3-5-sonnet-20241022",
    defaultBaseUrl: "https://api.anthropic.com",
    needsKey: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    defaultModel: "deepseek-chat",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    needsKey: true,
  },
  {
    id: "groq",
    label: "Groq",
    defaultModel: "llama-3.3-70b-versatile",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    needsKey: true,
  },
  {
    id: "gemini",
    label: "Gemini API",
    defaultModel: "gemini-2.0-flash",
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
    defaultModel: "grok-2-latest",
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
    defaultModel: "sonar",
    defaultBaseUrl: "https://api.perplexity.ai",
    needsKey: true,
  },
  {
    id: "cohere",
    label: "Cohere",
    defaultModel: "command-r-plus",
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
];

export const DEFAULT_MEMBERS: CouncilMember[] = [
  {
    id: "chatgpt",
    label: "ChatGPT",
    enabled: true,
    mode: "browser",
    provider: "openai",
    model: "gpt-4o",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    id: "gemini",
    label: "Gemini",
    enabled: true,
    mode: "browser",
    provider: "gemini",
    model: "gemini-2.0-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  {
    id: "claude",
    label: "Claude",
    enabled: true,
    mode: "browser",
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
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
