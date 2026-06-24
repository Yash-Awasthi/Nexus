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

  // Only API-mode members can run in web context (no browser automation)
  const members = council
    .filter((m) => m.enabled && m.mode === "api" && m.provider && m.model)
    .map((m) => ({ label: m.label, provider: m.provider, model: m.model }));

  if (members.length === 0) {
    throw new Error(
      "No API-mode council members enabled. Open Settings → Council and configure at least one model.",
    );
  }

  busDispatch("deliberation:started", {});

  const res = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: args.message,
      members,
      round: args.round,
      threadId: args.threadId,
    }),
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

// ── Thread management (localStorage-backed in web mode) ───────────────────────

const THREADS_KEY = "nexus_threads";
const MSGS_PREFIX = "nexus_messages_";

interface StoredThread {
  id: string;
  title: string;
  updated_at: number;
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

export async function listThreads() {
  if (isMolecule()) return (window as any).molecule.listThreads();
  return _loadThreads();
}

export async function createThread(): Promise<string> {
  if (isMolecule()) return (window as any).molecule.createThread();
  const id = crypto.randomUUID();
  const threads = _loadThreads();
  threads.unshift({ id, title: "New deliberation", updated_at: Date.now() });
  _saveThreads(threads);
  return id;
}

export async function deleteThread(id: string) {
  if (isMolecule()) return (window as any).molecule.deleteThread(id);
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
export function saveGroups(threadId: string, groups: StoredGroup[]) {
  localStorage.setItem(MSGS_PREFIX + threadId, JSON.stringify(groups));
}

export async function getMessages(threadId: string) {
  if (isMolecule()) return (window as any).molecule.getMessages(threadId);
  // Deserialize stored groups into the flat message format hydrateThread expects
  const groups = _loadGroups(threadId);
  const msgs: Array<{
    id: string;
    role: string;
    member: string | null;
    content: string;
    round: number;
  }> = [];
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
