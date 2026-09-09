// SPDX-License-Identifier: Apache-2.0
/**
 * Deliberation bridge — dual-mode:
 *   1. Electron desktop: delegates to window.molecule IPC (unchanged)
 *   2. Web browser:      POSTs to /api/chat/stream (SSE), fires events via EventTarget
 */

export interface MoleculeOpinion {
  provider: string;
  label: string;
  text: string;
  summary: string;
  round: number;
  /** archetype name — present in council stream responses */
  archetype?: string;
  /** display name for the council member */
  name?: string;
  /** confidence score [0-1] */
  confidence?: number;
  /** which key source backed this member's stream: user | oauth | env | local | none */
  keySource?: "user" | "oauth" | "env" | "local" | "none";
  /** 0-based debate round this chunk belongs to (round >= 1 = refinement after seeing others) */
  debateRound?: number;
  /** true when this opinion is a member failure, not model output */
  isError?: boolean;
}

/**
 * A member failure emitted as an opinion event (older servers may send the
 * bracketed "[Label error: ...]" text without isError). Opinions must render
 * as opinions; failures must render as failures — otherwise raw provider JSON
 * pollutes the transcript and reads like a member's answer.
 *
 * Round boundaries are baked into the stream text (the server announces each
 * debate round inside the member's own text), so a failure wrapper in any
 * round sits at the start of its own segment — judge the last segment.
 */
export function isErrorOpinion(opinion: Pick<MoleculeOpinion, "text" | "isError">): boolean {
  if (opinion.isError) return true;
  const text = opinion.text ?? "";
  const lastSegment =
    text.split(/――― round \d+ \(sees other members' answers\) ―――/).pop() ?? text;
  return /^\[[^\]]{1,64} error: /.test(lastSegment);
}

export interface MoleculeVerdict {
  text: string;
  summary: string;
  round: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isMolecule(): boolean {
  return typeof window !== "undefined" && "molecule" in window;
}

// Shared event bus for web path
const _bus = typeof EventTarget !== "undefined" ? new EventTarget() : null;

// In-flight stream abort handle so STOP can actually stop the stream.
let _abort: AbortController | null = null;

/** Abort the in-flight deliberation stream (web path). */
export function stopDeliberation(): void {
  _abort?.abort();
}

function busDispatch(type: string, detail: unknown) {
  _bus?.dispatchEvent(new CustomEvent(type, { detail }));
}

function busOn<T>(type: string, cb: (d: T) => void): () => void {
  if (!_bus) return () => {};
  const handler = (e: Event) => cb((e as CustomEvent<T>).detail);
  _bus.addEventListener(type, handler);
  return () => _bus.removeEventListener(type, handler);
}

// ── Core deliberation ─────────────────────────────────────────────────────────

export async function deliberate(args: {
  threadId: string;
  message: string;
  round: number;
  memberOptions?: Record<string, { deepThinking?: boolean; webSearch?: boolean }>;
}): Promise<void> {
  if (isMolecule()) {
    return (window as any).molecule.deliberate(args);
  }

  // Web path — load council config from localStorage
  const { loadCouncilMembers } = await import("~/lib/council");
  const council = loadCouncilMembers();

  // Every enabled member is sent; the server resolves each one from (in order)
  // the user's BYOK key, an OAuth-linked provider account (Sign in with Google
  // → Vertex / Entra → Azure OpenAI), or the server env key. Members with no
  // resolvable source are dropped server-side and show no opinion. `mode` is a
  // UI hint only ("browser" = consumer account / linked-account stream; "api" =
  // explicit keyed stream) — the backend never saw it, so stop client-gating.
  const members = council
    .filter((m) => m.enabled && m.provider && m.model)
    .map((m) => ({ label: m.label, provider: m.provider, model: m.model }));

  if (members.length === 0) {
    throw new Error(
      "No API-mode council members enabled. Open Settings → Council and configure at least one model.",
    );
  }

  // Honor the server-persisted "Enable Debate Round" preference (Settings →
  // Council Behaviour). Off ⇒ one-shot parallel answers; on ⇒ members see
  // each other's answers and refine.
  let rounds = 2;
  try {
    const prefs = await fetch("/api/settings/preferences", {
      signal: AbortSignal.timeout(3000),
    });
    if (prefs.ok) {
      const p = (await prefs.json()) as { debateRound?: boolean };
      if (p.debateRound === false) rounds = 1;
    }
  } catch {
    // default to debate on
  }

  busDispatch("deliberation:started", {});

  const abort = new AbortController();
  _abort = abort;
  try {
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: args.message,
        members,
        round: args.round,
        // Real debate: members answer independently (round 0), then see each
        // other's answers and refine (round 1) — unless the user disabled
        // "Enable Debate Round" in Settings.
        rounds,
        threadId: args.threadId,
      }),
      signal: abort.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`Chat stream failed: ${res.status} ${res.statusText}`);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const ev = JSON.parse(line.slice(6));
          if (ev.type === "opinion") {
            busDispatch("deliberation:opinion", ev as MoleculeOpinion);
          } else if (ev.type === "verdict") {
            busDispatch("deliberation:verdict", ev as MoleculeVerdict);
          } else if (ev.type === "done") {
            busDispatch("deliberation:done", { round: ev.round ?? args.round });
          } else if (ev.type === "error") {
            throw new Error(ev.message ?? "Stream error");
          }
        } catch {
          // skip malformed SSE lines
        }
      }
    }

    // Guarantee done fires even if backend omitted it
    busDispatch("deliberation:done", { round: args.round });
  } catch (err) {
    // User pressed STOP — not an error. No done event: the UI already
    // marked the group done and re-enabled sending.
    if (!(err instanceof DOMException && err.name === "AbortError")) throw err;
  } finally {
    if (_abort === abort) _abort = null;
  }
}

// ── Event subscriptions ───────────────────────────────────────────────────────

export function onOpinion(cb: (data: MoleculeOpinion) => void): () => void {
  if (isMolecule()) return (window as any).molecule.on("deliberation:opinion", cb);
  return busOn("deliberation:opinion", cb);
}

export function onVerdict(cb: (data: MoleculeVerdict) => void): () => void {
  if (isMolecule()) return (window as any).molecule.on("deliberation:verdict", cb);
  return busOn("deliberation:verdict", cb);
}

export function onDone(cb: (data: { round: number }) => void): () => void {
  if (isMolecule()) return (window as any).molecule.on("deliberation:done", cb);
  return busOn("deliberation:done", cb);
}

// ── Thread management (API-backed in web mode; localStorage fallback) ──────────
// The API (/api/threads*) is the single source of truth for the dashboard's
// "Recent Deliberations", the chat sidebar, and message history. localStorage
// remains as an offline/dev fallback so the chat keeps working when the API
// is unreachable — API reads win whenever they succeed.

const THREADS_KEY = "nexus_threads";
const MSGS_PREFIX = "nexus_messages_";

export interface StoredThread {
  id: string;
  title: string;
  updated_at: number;
  mode?: string;
}

interface StoredGroup {
  id: string;
  round: number;
  prompt: string;
  opinions: Record<string, string>;
  verdict: string;
  error: string;
  done: boolean;
}

function _loadThreads(): StoredThread[] {
  try {
    const raw = localStorage.getItem(THREADS_KEY);
    return raw ? (JSON.parse(raw) as StoredThread[]) : [];
  } catch {
    return [];
  }
}

function _saveThreads(t: StoredThread[]) {
  localStorage.setItem(THREADS_KEY, JSON.stringify(t));
}

/** Flatten stored groups into the flat message shape hydrateThread expects. */
function flattenGroups(groups: StoredGroup[]): ThreadMessage[] {
  const msgs: ThreadMessage[] = [];
  for (const g of groups) {
    if (g.prompt)
      msgs.push({ id: g.id + "_u", role: "user", member: null, content: g.prompt, round: g.round });
    for (const [label, text] of Object.entries(g.opinions)) {
      if (text)
        msgs.push({
          id: g.id + "_" + label,
          role: "opinion",
          member: label,
          content: text,
          round: g.round,
        });
    }
    if (g.verdict)
      msgs.push({
        id: g.id + "_v",
        role: "verdict",
        member: null,
        content: g.verdict,
        round: g.round,
      });
  }
  return msgs;
}

interface ThreadMessage {
  id: string;
  role: "user" | "opinion" | "verdict" | "system";
  member: string | null;
  content: string;
  round: number;
}

export async function listThreads(): Promise<StoredThread[]> {
  if (isMolecule()) return (window as any).molecule.listThreads();
  const local = _loadThreads();
  try {
    const res = await fetch("/api/threads");
    if (res.ok) {
      // API shape: { id, title, mode?, updatedAt (ISO) } — mapped to the
      // localStorage StoredThread shape so callers see one interface.
      const data = (await res.json()) as {
        threads?: Array<{ id: string; title: string; mode?: string; updatedAt?: string }>;
      };
      const apiThreads: StoredThread[] = (data.threads ?? []).map((t) => ({
        id: t.id,
        title: t.title,
        updated_at: new Date(t.updatedAt ?? Date.now()).getTime(),
        mode: t.mode,
      }));
      // One-time migration: threads created while the API was unreachable
      // exist only in localStorage and would shadow the (empty) server list
      // forever. Push them on the first successful contact so the API stays
      // the single truth; the merged view keeps them visible this load, and a
      // failed push stays visible and retries next load. localStorage remains
      // an offline cache only.
      const known = new Set(apiThreads.map((t) => t.id));
      const missing = local.filter((t) => !known.has(t.id));
      for (const t of missing) {
        try {
          await fetch("/api/threads", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: t.id, title: t.title, mode: t.mode }),
          });
        } catch {
          /* keep below — retried on the next load */
        }
      }
      return [...apiThreads, ...missing].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    }
  } catch {
    /* fall through to localStorage */
  }
  return local;
}

export async function createThread(title?: string, mode?: string): Promise<string> {
  if (isMolecule()) return (window as any).molecule.createThread();
  const id = crypto.randomUUID();
  try {
    const res = await fetch("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, title: title ?? "New deliberation", mode }),
    });
    if (res.ok) return id;
  } catch {
    /* fall through to localStorage */
  }
  const threads = _loadThreads();
  threads.unshift({ id, title: title ?? "New deliberation", updated_at: Date.now(), mode });
  _saveThreads(threads);
  return id;
}

/** Retitle / set mode so "Recent Deliberations" shows a real title, not "New deliberation". */
export async function updateThreadMeta(
  id: string,
  patch: { title?: string; mode?: string },
): Promise<void> {
  if (isMolecule()) return;
  try {
    await fetch(`/api/threads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  } catch {
    /* localStorage mirror below */
  }
  const threads = _loadThreads();
  const idx = threads.findIndex((t) => t.id === id);
  if (idx >= 0) {
    threads[idx] = {
      ...threads[idx],
      title: patch.title ?? threads[idx].title,
      mode: patch.mode ?? threads[idx].mode,
      updated_at: Date.now(),
    };
    _saveThreads(threads);
  }
}

export async function deleteThread(id: string) {
  if (isMolecule()) return (window as any).molecule.deleteThread(id);
  try {
    await fetch(`/api/threads/${id}`, { method: "DELETE" });
  } catch {
    /* localStorage mirror below */
  }
  _saveThreads(_loadThreads().filter((t) => t.id !== id));
  localStorage.removeItem(MSGS_PREFIX + id);
}

// ── Message persistence helpers ────────────────────────────────────────────────

function _loadGroups(threadId: string): StoredGroup[] {
  try {
    const raw = localStorage.getItem(MSGS_PREFIX + threadId);
    return raw ? (JSON.parse(raw) as StoredGroup[]) : [];
  } catch {
    return [];
  }
}

/** Persist finalized MsgGroups for a thread. Call after a round completes (done=true). */
export async function saveGroups(threadId: string, groups: StoredGroup[]) {
  // Always mirror to localStorage (offline cache + dev fallback).
  localStorage.setItem(MSGS_PREFIX + threadId, JSON.stringify(groups));
  try {
    const msgs = flattenGroups(groups);
    if (msgs.length === 0) return;
    await fetch(`/api/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: msgs }),
    });
  } catch {
    /* localStorage copy already saved */
  }
}

export async function getMessages(threadId: string) {
  if (isMolecule()) return (window as any).molecule.getMessages(threadId);
  try {
    const res = await fetch(`/api/threads/${threadId}/messages`);
    if (res.ok) {
      const data = (await res.json()) as { messages?: ThreadMessage[] };
      if (Array.isArray(data.messages) && data.messages.length > 0) return data.messages;
    }
  } catch {
    /* fall through to localStorage */
  }
  // Deserialize stored groups into the flat message format hydrateThread expects
  return flattenGroups(_loadGroups(threadId));
}

export async function getMemory(): Promise<string> {
  if (isMolecule()) return (window as any).molecule.getMemory();
  return localStorage.getItem("molecule_memory") ?? "";
}

export async function setMemory(value: string) {
  if (isMolecule()) return (window as any).molecule.setMemory(value);
  localStorage.setItem("molecule_memory", value);
}

export async function toggleGlass(on: boolean) {
  if (isMolecule()) return (window as any).molecule.toggleGlass(on);
  // no-op in web mode
}

export async function connectProvider(provider: string): Promise<void> {
  // Electron (desktop) drives a real browser via the molecule bridge.
  if (isMolecule()) return (window as any).molecule.connectProvider(provider);
  // Web cannot drive the user's logged-in browser (sandbox). Provider access on
  // web is via server-side BYOK API keys (configured in Settings → Provider Keys),
  // not by opening a tab. Surface that instead of a dead-end window.open.
  throw new Error(
    `Browser-driving "${provider}" needs the desktop app. On web, add your ${provider} API key in Settings → Provider Keys to use it via the server gateway.`,
  );
}

export async function isProviderConnected(provider: string): Promise<boolean> {
  if (isMolecule()) return (window as any).molecule.isProviderConnected(provider);
  // Web: "connected" means a server-side key exists for the provider's gateway.
  try {
    const res = await fetch("/api/user/provider-keys");
    if (!res.ok) return false;
    const data = await res.json();
    const keys: Array<{ provider?: string }> = data.keys ?? data ?? [];
    return keys.some((k) => (k.provider ?? "").toLowerCase().includes(provider.toLowerCase()));
  } catch {
    return false;
  }
}
