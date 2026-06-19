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
  apiKey: string;
  baseUrl: string; // for ollama/custom
}

export const API_PROVIDERS: Array<{
  id: string;
  label: string;
  defaultModel: string;
  defaultBaseUrl: string;
  needsKey: boolean;
}> = [
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
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    id: "gemini",
    label: "Gemini",
    enabled: true,
    mode: "browser",
    provider: "gemini",
    model: "gemini-2.0-flash",
    apiKey: "",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  {
    id: "claude",
    label: "Claude",
    enabled: true,
    mode: "browser",
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
    apiKey: "",
    baseUrl: "https://api.anthropic.com",
  },
];

const COUNCIL_KEY = "nexus_council";

export function loadCouncilMembers(): CouncilMember[] {
  try {
    const raw = localStorage.getItem(COUNCIL_KEY);
    if (!raw) return DEFAULT_MEMBERS;
    const parsed = JSON.parse(raw);
    // Merge to always have the 3 defaults
    return Array.isArray(parsed) ? parsed : DEFAULT_MEMBERS;
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
    apiKey: "",
    baseUrl: "https://api.deepseek.com/v1",
  };
}
