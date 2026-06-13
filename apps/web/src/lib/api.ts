// SPDX-License-Identifier: Apache-2.0
const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "";
const KEY = (import.meta.env.VITE_API_KEY as string | undefined) ?? "";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (KEY) headers.Authorization = `Bearer ${KEY}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ── Gateway / Chat types ──────────────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatResponse {
  id: string;
  content: { type: "text"; text: string }[];
  model: string;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export const api = {
  get: <T>(path: string) => request<T>("GET", `/api/v1${path}`),
  post: <T>(path: string, b: unknown) => request<T>("POST", `/api/v1${path}`, b),
  patch: <T>(path: string, b: unknown) => request<T>("PATCH", `/api/v1${path}`, b),
  health: () => request<{ status: string; timestamp: string }>("GET", "/health"),

  /**
   * Send messages to the Model Gateway (Anthropic-format proxy).
   * Returns the assistant reply text.
   */
  chat: async (
    messages: ChatMessage[],
    model = "nexus/smart",
    system?: string,
  ): Promise<ChatResponse> => {
    return request<ChatResponse>("POST", "/api/v1/gateway/messages", {
      model,
      messages,
      max_tokens: 2048,
      ...(system && { system }),
    });
  },

  /** List available gateway model aliases */
  gatewayModels: () =>
    request<{ models: { id: string; provider: string; backend_model: string }[] }>(
      "GET",
      "/api/v1/gateway/models",
    ),
};
