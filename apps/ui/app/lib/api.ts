// SPDX-License-Identifier: Apache-2.0
/**
 * Authenticated fetch helper.
 *
 * Attaches the logged-in user's JWT (captured by AuthContext.login and stored
 * under `nexus_token`) as an `Authorization: Bearer` header. Use this for any
 * call to an auth-gated endpoint (e.g. /api/user/provider-keys, /api/godmode/*,
 * /api/v1/council/*).
 */
const TOKEN_KEY = "nexus_token";

/** The stored access token, or null when logged out. */
export function getAuthToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** fetch() with the bearer token attached when present. */
export async function authFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const token = getAuthToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

/** A single council member's settled vote (mirrors @nexus/contracts ModelVote). */
export interface CouncilVote {
  model: string;
  provider: string;
  vote: "yes" | "no" | "abstain";
  reasoning: string;
  confidence: number;
  latencyMs: number;
}

/** Callbacks for {@link streamCouncilDeliberation}. */
export interface CouncilStreamHandlers {
  /** Fired once per model as its vote lands (before the final verdict). */
  onVote?: (vote: CouncilVote) => void;
  /** Fired once with the full deliberation response when voting completes. */
  onDone?: (response: unknown) => void;
  /** Fired on a server-side deliberation error. */
  onError?: (message: string) => void;
}

/**
 * Consume POST /api/v1/council/deliberate/stream — an SSE stream that emits each
 * model's vote as it arrives, then a final `done` event. Resolves when the
 * stream closes. Pass an AbortSignal to cancel in flight.
 */
export async function streamCouncilDeliberation(
  body: {
    proposal: { title: string; description?: string };
    budgetUsd?: number;
    timeoutMs?: number;
  },
  handlers: CouncilStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await authFetch("/api/v1/council/deliberate/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    handlers.onError?.(`Council stream failed (${res.status})`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  // Parse `event: <name>\ndata: <json>\n\n` SSE frames.
  const dispatch = (frame: string): void => {
    const evMatch = /^event: (.+)$/m.exec(frame);
    const dataMatch = /^data: (.+)$/m.exec(frame);
    if (!evMatch || !dataMatch) return;
    let payload: unknown;
    try {
      payload = JSON.parse(dataMatch[1]);
    } catch {
      return;
    }
    if (evMatch[1] === "vote") handlers.onVote?.(payload as CouncilVote);
    else if (evMatch[1] === "done") handlers.onDone?.(payload);
    else if (evMatch[1] === "error")
      handlers.onError?.((payload as { error?: string }).error ?? "Deliberation failed");
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const f of frames) if (f.trim()) dispatch(f);
  }
  if (buf.trim()) dispatch(buf);
}
