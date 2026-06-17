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
      message:  args.message,
      members,
      round:    args.round,
      threadId: args.threadId,
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`Chat stream failed: ${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const dec    = new TextDecoder();
  let buf      = "";

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

interface StoredThread { id: string; title: string; updated_at: number; }

function _loadThreads(): StoredThread[] {
  try {
    const raw = localStorage.getItem(THREADS_KEY);
    return raw ? (JSON.parse(raw) as StoredThread[]) : [];
  } catch { return []; }
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
}

export async function getMessages(_threadId: string) {
  if (isMolecule()) return (window as any).molecule.getMessages(_threadId);
  return []; // messages live in React state; persistence not yet implemented
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
  if (isMolecule()) return (window as any).molecule.connectProvider(provider);
  const urls: Record<string, string> = {
    chatgpt: "https://chat.openai.com",
    gemini:  "https://gemini.google.com/app",
    claude:  "https://claude.ai",
  };
  window.open(urls[provider] ?? `https://${provider}.com`, "_blank");
}

export async function isProviderConnected(provider: string): Promise<boolean> {
  if (isMolecule()) return (window as any).molecule.isProviderConnected(provider);
  return false;
}
