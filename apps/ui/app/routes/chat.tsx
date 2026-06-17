import { useState, useRef, useEffect, useCallback } from "react";
import { loadActiveSTM, STM_MODULES, type STMModuleId } from "~/lib/stm";
import type { Route } from "./+types/chat";
import { useContextMention } from '~/hooks/useContextMention';
import { ContextPill, type MentionType } from '~/components/ContextPill';

import {
  deliberate,
  onOpinion,
  onVerdict,
  onDone,
  listThreads,
  createThread,
  deleteThread,
  getMessages,
  toggleGlass,
  type MoleculeOpinion,
  type MoleculeVerdict,
} from "~/lib/deliberate";
import {
  loadCouncilMembers,
  saveCouncilMembers,
  newMember,
  API_PROVIDERS,
  type CouncilMember,
} from "~/lib/council";
import { Plus, Settings2, Trash2, X, ChevronDown, ChevronRight, Download, VolumeX, Volume2, Copy, Check } from "lucide-react";

interface Mention { type: MentionType; label: string; value: string }

// ─── Types ────────────────────────────────────────────────────────────────────

interface MsgGroup {
  id: string;
  round: number;
  prompt: string;
  opinions: Record<string, string>; // member label → full text
  verdict: string;
  error: string;
  done: boolean;
}

interface Thread {
  id: string;
  title: string;
  updated_at: number;
}

// ─── Meta ─────────────────────────────────────────────────────────────────────

export function meta(_: Route.MetaArgs) {
  return [{ title: "Nexus" }];
}

// ─── Palette ──────────────────────────────────────────────────────────────────

const C = {
  bg:       "#080808",
  bgAlt:    "#050505",
  bgPanel:  "#0a0a0a",
  border:   "#162a16",
  green:    "#00ff88",
  greenDim: "#4a8a4a",
  cyan:     "#00ccff",
  cyanDim:  "#a0e8ff",
  text:     "#c8ffc8",
  textDim:  "#3a5a3a",
  red:      "#ff3355",
  amber:    "#ffaa00",
} as const;

const MONO = "'JetBrains Mono','Fira Code','Cascadia Code',monospace";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isMolecule() {
  return typeof window !== "undefined" && "molecule" in window;
}

function threadTitle(prompt: string) {
  return prompt.slice(0, 60).trim() + (prompt.length > 60 ? "…" : "");
}

function exportMarkdown(groups: MsgGroup[], title: string): string {
  const lines = [`# ${title}`, ""];
  for (const g of groups) {
    lines.push(`## Round ${g.round}`, "", `> ${g.prompt}`, "");
    for (const [label, text] of Object.entries(g.opinions)) {
      lines.push(`### ${label}`, "", text, "");
    }
    if (g.verdict) lines.push(`### Synthesis`, "", g.verdict, "");
    lines.push("---", "");
  }
  return lines.join("\n");
}

function downloadText(filename: string, content: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: "text/markdown" }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Chat() {
  const [council, setCouncil]           = useState<CouncilMember[]>(() => loadCouncilMembers());
  const [threads, setThreads]           = useState<Thread[]>([]);
  const [threadId, setThreadId]         = useState<string>("");
  const [groups, setGroups]             = useState<MsgGroup[]>([]);
  const [streaming, setStreaming]       = useState(false);
  const [activeSTM, setActiveSTM]       = useState<STMModuleId[]>([]);
  const [muted, setMuted]               = useState<Set<string>>(new Set());
  const [input, setInput]               = useState("");
  const [copied, setCopied]             = useState<string | null>(null); // key of last copied item
  const [speaking, setSpeaking]         = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showThreads, setShowThreads]   = useState(false);
  const [showHelp, setShowHelp]         = useState(false);
  const [glassOn, setGlassOn]           = useState(false);
  const [mentions, setMentions]         = useState<Mention[]>([]);
  const colRefs    = useRef<Record<string, HTMLDivElement | null>>({});
  const verdictRef = useRef<HTMLDivElement | null>(null);
  const taRef      = useRef<HTMLTextAreaElement | null>(null);
  const mention                         = useContextMention(taRef);
  const councilRef = useRef(council); // stable ref for callbacks
  useEffect(() => { councilRef.current = council; }, [council]);

  // Load active STM modules from localStorage on mount
  useEffect(() => { setActiveSTM(loadActiveSTM()); }, []);

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      const raw = (await listThreads()) as Thread[];
      if (raw.length) {
        setThreads(raw);
        setThreadId(raw[0].id);
        await hydrateThread(raw[0].id);
      } else {
        const id = await createThread();
        setThreads([{ id, title: "New deliberation", updated_at: Date.now() }]);
        setThreadId(id);
      }
    })();

    // deliberation:started — electron fires this when deliberation begins
    let offStarted = () => {};
    if (isMolecule()) {
      offStarted = (window as any).molecule.on(
        "deliberation:started",
        () => setStreaming(true)
      );
    }

    const offOpinion = onOpinion((data: MoleculeOpinion) => {
      setGroups(prev => {
        if (!prev.length) return prev;
        const last = prev[prev.length - 1];
        const updated: MsgGroup = {
          ...last,
          opinions: { ...last.opinions, [data.label]: (last.opinions[data.label] ?? "") + data.text },
        };
        return [...prev.slice(0, -1), updated];
      });
      const col = colRefs.current[data.label];
      if (col) requestAnimationFrame(() => { col.scrollTop = col.scrollHeight; });
    });

    const offVerdict = onVerdict((data: MoleculeVerdict) => {
      setGroups(prev => {
        if (!prev.length) return prev;
        const last = prev[prev.length - 1];
        return [...prev.slice(0, -1), { ...last, verdict: last.verdict + data.text }];
      });
      if (verdictRef.current)
        requestAnimationFrame(() => { verdictRef.current!.scrollTop = verdictRef.current!.scrollHeight; });
    });

    const offDone = onDone((data: { round: number }) => {
      setStreaming(false);
      setGroups(prev => {
        if (!prev.length) return prev;
        const last = prev[prev.length - 1];
        const updated = { ...last, done: true };
        // auto-title the thread after round 1
        if (data.round === 1 && last.prompt) {
          setThreads(ts => ts.map(t =>
            t.id === threadId ? { ...t, title: threadTitle(last.prompt) } : t
          ));
        }
        return [...prev.slice(0, -1), updated];
      });
    });

    return () => { offStarted(); offOpinion(); offVerdict(); offDone(); };
  }, []);  // threadId captured via closure in onDone is fine since it doesn't change after mount per-session

  // ── Global keyboard shortcuts ──────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowSettings(false);
        setShowThreads(false);
        setShowHelp(false);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        taRef.current?.focus();
      }
      if (e.key === "?" && !["INPUT","TEXTAREA","SELECT"].includes((e.target as Element)?.tagName)) {
        setShowHelp(p => !p);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ── Thread hydration ───────────────────────────────────────────────────────
  // DB stores member.id (e.g. "chatgpt"); columns key by member.label (e.g. "ChatGPT").
  // We resolve via councilRef to keep the function stable.

  const hydrateThread = useCallback(async (id: string) => {
    const idToLabel = Object.fromEntries(councilRef.current.map(c => [c.id, c.label]));
    const msgs = (await getMessages(id)) as Array<{
      id: string; role: string; member: string | null; content: string; round: number;
    }>;
    const byRound: Record<number, MsgGroup> = {};
    for (const m of msgs) {
      if (!byRound[m.round])
        byRound[m.round] = { id: m.id, round: m.round, prompt: "", opinions: {}, verdict: "", error: "", done: true };
      if (m.role === "user")        byRound[m.round].prompt = m.content;
      if (m.role === "opinion" && m.member) {
        const label = idToLabel[m.member] ?? m.member;
        byRound[m.round].opinions[label] = m.content;
      }
      if (m.role === "verdict")     byRound[m.round].verdict = m.content;
    }
    setGroups(Object.values(byRound).sort((a, b) => a.round - b.round));
  }, []);

  // ── Thread actions ─────────────────────────────────────────────────────────

  const handleNewThread = async () => {
    const id = await createThread();
    setThreads(prev => [{ id, title: "New deliberation", updated_at: Date.now() }, ...prev]);
    setThreadId(id);
    setGroups([]);
    setShowThreads(false);
  };

  const handleSelectThread = async (id: string) => {
    setThreadId(id);
    setGroups([]);
    setShowThreads(false);
    await hydrateThread(id);
  };

  const handleDeleteThread = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await deleteThread(id);
    const next = threads.filter(t => t.id !== id);
    setThreads(next);
    if (threadId === id) {
      if (next.length) { setThreadId(next[0].id); await hydrateThread(next[0].id); }
      else {
        const nid = await createThread();
        setThreads([{ id: nid, title: "New deliberation", updated_at: Date.now() }]);
        setThreadId(nid);
        setGroups([]);
      }
    }
  };

  // ── Send / Stop ────────────────────────────────────────────────────────────

  const handleSend = useCallback(async () => {
    const prompt = input.trim();
    if (!prompt || streaming) return;
    setInput("");
    if (taRef.current) taRef.current.style.height = "20px";

    const group: MsgGroup = {
      id: crypto.randomUUID(),
      round: groups.length + 1,
      prompt,
      opinions: {},
      verdict: "",
      error: "",
      done: false,
    };
    setGroups(prev => [...prev, group]);
    setStreaming(true);

    // Record STM injection history (best-effort, async)
    if (activeSTM.length > 0) {
      const applied = activeSTM
        .map((id) => STM_MODULES.find((m) => m.id === id)?.injection)
        .filter(Boolean) as string[];
      fetch("/api/stm/history", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ query: prompt, modules: activeSTM, applied }),
      }).catch(() => {});
    }

    try {
      await deliberate({ threadId, message: prompt, round: group.round });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Deliberation failed.";
      setStreaming(false);
      setGroups(prev => {
        if (!prev.length) return prev;
        const last = prev[prev.length - 1];
        return [...prev.slice(0, -1), { ...last, error: msg, done: true }];
      });
    }
  }, [input, streaming, threadId, groups.length]);

  const handleStop = () => {
    setStreaming(false);
    setGroups(prev => {
      if (!prev.length) return prev;
      const last = prev[prev.length - 1];
      return [...prev.slice(0, -1), { ...last, done: true }];
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention.onKeyDown(e)) return; // picker consumed the key
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    mention.onTextareaChange(e);
    setInput(e.target.value);
    const ta = e.target;
    ta.style.height = "20px";
    ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
  };

  const handleGlass = async () => {
    const next = !glassOn;
    setGlassOn(next);
    await toggleGlass(next);
  };

  // ── Copy ───────────────────────────────────────────────────────────────────

  const handleCopy = useCallback((key: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1800);
    });
  }, []);

  // ── Export ─────────────────────────────────────────────────────────────────

  const handleExport = () => {
    const title = threads.find(t => t.id === threadId)?.title ?? "deliberation";
    const md = exportMarkdown(groups, title);
    downloadText(`${title.slice(0, 40).replace(/[^a-z0-9]/gi, "-")}.md`, md);
  };

  // ── Mute ───────────────────────────────────────────────────────────────────

  const handleMute = (label: string) => {
    setMuted(prev => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label); else next.add(label);
      return next;
    });
  };

  // TTS — read the synthesis verdict aloud via /api/tts
  const speakVerdict = useCallback(async (text: string) => {
    if (!text) return;
    // Stop any current playback
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (speaking) { setSpeaking(false); return; }
    setSpeaking(true);
    try {
      const res = await fetch("/api/tts", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ text: text.slice(0, 2000) }),
      });
      if (!res.ok) throw new Error("TTS unavailable");
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { setSpeaking(false); URL.revokeObjectURL(url); };
      audio.onerror = () => { setSpeaking(false); URL.revokeObjectURL(url); };
      audio.play().catch(() => setSpeaking(false));
    } catch {
      setSpeaking(false);
    }
  }, [speaking]);

  // ── Derived ────────────────────────────────────────────────────────────────

  const activeMembers  = council.filter(m => m.enabled);
  const currentThread  = threads.find(t => t.id === threadId);
  const totalRounds    = groups.length;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ fontFamily: MONO, background: C.bg, color: C.text, height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <style>{`
        @keyframes blink  { 50% { opacity: 0; } }
        @keyframes dots   { 0%,20% { content:'●○○' } 40%,60% { content:'●●○' } 80%,100% { content:'●●●' } }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #162a16; border-radius: 2px; }
        textarea::placeholder { color: #3a5a3a; }
        input::placeholder   { color: #3a5a3a; }
        select option        { background: #0d0d0d; }
        .col-muted           { opacity: 0.35; filter: saturate(0); }
        .copy-btn:hover      { color: #00ff88 !important; }
      `}</style>

      {/* ─── Header ─────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "7px 14px", borderBottom: `1px solid ${C.border}`, background: C.bgAlt, flexShrink: 0, position: "relative", zIndex: 30 }}>
        <span style={{ fontSize: "12px", fontWeight: 700, letterSpacing: "0.3em", color: C.green, flexShrink: 0 }}>JUDICA</span>
        <span style={{ color: C.border }}>│</span>

        {/* Thread picker */}
        <button
          onClick={() => setShowThreads(p => !p)}
          style={{ display: "flex", alignItems: "center", gap: "5px", background: "transparent", border: `1px solid ${C.border}`, borderRadius: "3px", padding: "3px 9px", fontFamily: MONO, fontSize: "10px", color: C.greenDim, cursor: "pointer", letterSpacing: "0.08em", maxWidth: "200px" }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {currentThread?.title ?? "—"}
          </span>
          <ChevronDown size={9} style={{ flexShrink: 0 }} />
        </button>

        {showThreads && (
          <div style={{ position: "absolute", top: "100%", left: "120px", background: "#0d0d0d", border: `1px solid ${C.border}`, borderRadius: "3px", minWidth: "240px", boxShadow: "0 8px 32px #000d", zIndex: 40 }}>
            <button
              onClick={handleNewThread}
              style={{ display: "flex", alignItems: "center", gap: "7px", width: "100%", padding: "8px 12px", background: "transparent", border: "none", borderBottom: `1px solid ${C.border}`, fontFamily: MONO, fontSize: "10px", color: C.green, cursor: "pointer", letterSpacing: "0.1em" }}
            >
              <Plus size={9} /> NEW THREAD
            </button>
            <div style={{ maxHeight: "260px", overflowY: "auto" }}>
              {threads.map(t => (
                <div
                  key={t.id}
                  onClick={() => handleSelectThread(t.id)}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 12px", cursor: "pointer", background: t.id === threadId ? "#162a1625" : "transparent", borderBottom: `1px solid ${C.border}18` }}
                  onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = "#162a1615"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = t.id === threadId ? "#162a1625" : "transparent"; }}
                >
                  <span style={{ fontSize: "11px", color: t.id === threadId ? C.green : C.greenDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "185px", display: "flex", alignItems: "center", gap: "4px" }}>
                    {t.id === threadId && <ChevronRight size={9} />}{t.title}
                  </span>
                  <button
                    onClick={e => handleDeleteThread(e, t.id)}
                    style={{ background: "transparent", border: "none", color: C.textDim, cursor: "pointer", padding: "2px", flexShrink: 0 }}
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Round badge */}
        {totalRounds > 0 && (
          <span style={{ fontSize: "9px", color: C.textDim, letterSpacing: "0.15em", flexShrink: 0 }}>
            {totalRounds} RND{totalRounds !== 1 ? "S" : ""}
          </span>
        )}

        {/* Right controls */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "6px" }}>
          {groups.length > 0 && (
            <button
              onClick={handleExport}
              title="Export as Markdown"
              style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: "3px", padding: "4px 8px", cursor: "pointer", color: C.greenDim, display: "flex", alignItems: "center" }}
            >
              <Download size={10} />
            </button>
          )}
          {activeSTM.length > 0 && (
            <a
              href="/stm"
              style={{ background: "transparent", border: `1px solid hsl(245 80% 65%/0.5)`, borderRadius: "3px", padding: "3px 9px", fontFamily: MONO, fontSize: "10px", color: "hsl(245 80% 70%)", letterSpacing: "0.08em", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "4px" }}
              title="STM modules active — click to manage"
            >
              ◈ STM:{activeSTM.length}
            </a>
          )}
          <button
            onClick={handleGlass}
            style={{ background: "transparent", border: `1px solid ${glassOn ? C.green : C.border}`, borderRadius: "3px", padding: "3px 9px", fontFamily: MONO, fontSize: "10px", color: glassOn ? C.green : C.greenDim, cursor: "pointer", letterSpacing: "0.08em" }}
          >
            {glassOn ? "GLASS ●" : "GLASS ○"}
          </button>
          <button
            onClick={() => setShowHelp(p => !p)}
            title="Keyboard shortcuts (?)"
            style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: "3px", padding: "3px 7px", fontFamily: MONO, fontSize: "10px", color: C.greenDim, cursor: "pointer", letterSpacing: "0.08em" }}
          >
            ?
          </button>
          <button
            onClick={() => setShowSettings(true)}
            style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: "3px", padding: "4px 8px", cursor: "pointer", color: C.greenDim, display: "flex", alignItems: "center" }}
          >
            <Settings2 size={11} />
          </button>
        </div>
      </div>

      {/* ─── Arena columns ──────────────────────────────────────────────── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden", borderBottom: `1px solid ${C.border}` }}>
        {activeMembers.length === 0 ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: C.textDim, fontSize: "11px", letterSpacing: "0.2em" }}>
            NO MEMBERS ENABLED — OPEN ⚙ SETTINGS
          </div>
        ) : (
          activeMembers.map((m, idx) => {
            const isMuted = muted.has(m.label);
            return (
              <div
                key={m.id}
                className={isMuted ? "col-muted" : ""}
                style={{ flex: 1, display: "flex", flexDirection: "column", borderRight: idx < activeMembers.length - 1 ? `1px solid ${C.border}` : "none", overflow: "hidden", minWidth: 0, transition: "opacity 0.2s" }}
              >
                {/* Column header */}
                <div style={{ padding: "5px 10px", borderBottom: `1px solid ${C.border}`, fontSize: "10px", letterSpacing: "0.14em", color: isMuted ? C.textDim : C.green, background: C.bgPanel, flexShrink: 0, display: "flex", alignItems: "center", gap: "6px" }}>
                  <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: isMuted ? C.textDim : C.green, display: "inline-block", opacity: 0.8, flexShrink: 0 }} />
                  {m.label.toUpperCase()}
                  <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "6px" }}>
                    <span style={{ fontSize: "9px", color: C.textDim }}>{m.mode === "api" ? m.model : "browser"}</span>
                    <button
                      onClick={() => handleMute(m.label)}
                      title={isMuted ? "Unmute" : "Mute"}
                      style={{ background: "transparent", border: "none", cursor: "pointer", color: isMuted ? C.amber : C.textDim, padding: "1px", display: "flex", alignItems: "center" }}
                    >
                      {isMuted ? <VolumeX size={10} /> : <Volume2 size={10} />}
                    </button>
                  </span>
                </div>

                {/* Column body */}
                <div
                  ref={el => { colRefs.current[m.label] = el; }}
                  style={{ flex: 1, overflowY: "auto", padding: "12px 14px" }}
                >
                  {groups.length === 0 && (
                    <span style={{ color: C.textDim, fontSize: "11px", letterSpacing: "0.1em" }}>awaiting prompt_</span>
                  )}
                  {groups.map((g, gi) => {
                    const text      = g.opinions[m.label] ?? "";
                    const isLast    = gi === groups.length - 1;
                    const isTicking = isLast && !g.done && streaming;
                    const copyKey   = `${g.id}:${m.label}`;
                    return (
                      <div key={g.id} style={{ marginBottom: "22px" }}>
                        {/* Round label + copy */}
                        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "5px" }}>
                          <span style={{ fontSize: "9px", color: C.textDim, letterSpacing: "0.15em" }}>RND {g.round}</span>
                          {text && (
                            <button
                              className="copy-btn"
                              onClick={() => handleCopy(copyKey, text)}
                              title="Copy"
                              style={{ background: "transparent", border: "none", cursor: "pointer", color: copied === copyKey ? C.green : C.textDim, padding: "1px", display: "flex", alignItems: "center", transition: "color 0.15s" }}
                            >
                              {copied === copyKey ? <Check size={9} /> : <Copy size={9} />}
                            </button>
                          )}
                        </div>
                        {/* Prompt echo */}
                        <div style={{ fontSize: "11px", color: C.greenDim, marginBottom: "8px", paddingLeft: "8px", borderLeft: `2px solid ${C.border}`, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                          {g.prompt}
                        </div>
                        {/* Error */}
                        {g.error && isLast && (
                          <div style={{ fontSize: "11px", color: C.red, marginBottom: "6px" }}>⚠ {g.error}</div>
                        )}
                        {/* Opinion text */}
                        <div style={{ fontSize: "12px", lineHeight: 1.78, color: C.text, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                          {text || (!isTicking && <span style={{ color: C.textDim }}>—</span>)}
                          {isTicking && (
                            <span style={{ display: "inline-block", width: "7px", height: "13px", background: C.green, animation: "blink 1s step-end infinite", verticalAlign: "text-bottom", marginLeft: text ? "2px" : 0 }} />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ─── Synthesis strip ────────────────────────────────────────────── */}
      <div style={{ borderBottom: `1px solid ${C.border}`, background: "#060c06", flexShrink: 0, maxHeight: "25vh", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "4px 12px", fontSize: "9px", letterSpacing: "0.2em", color: C.cyan, borderBottom: `1px solid #0a2533`, flexShrink: 0, display: "flex", alignItems: "center", gap: "8px" }}>
          SYNTHESIS
          {(() => {
            const last = groups[groups.length - 1];
            if (last?.verdict) {
              const key = `verdict:${last.id}`;
              return (
                <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <button
                    className="copy-btn"
                    onClick={() => handleCopy(key, last.verdict)}
                    title="Copy synthesis"
                    style={{ background: "transparent", border: "none", cursor: "pointer", color: copied === key ? C.green : C.textDim, padding: "1px", display: "flex", alignItems: "center" }}
                  >
                    {copied === key ? <Check size={9} /> : <Copy size={9} />}
                  </button>
                  <button
                    className="copy-btn"
                    onClick={() => speakVerdict(last.verdict)}
                    title={speaking ? "Stop" : "Read aloud"}
                    style={{ background: "transparent", border: "none", cursor: "pointer", color: speaking ? C.cyan : C.textDim, padding: "1px", display: "flex", alignItems: "center" }}
                  >
                    {speaking ? <VolumeX size={9} /> : <Volume2 size={9} />}
                  </button>
                </span>
              );
            }
            return null;
          })()}
        </div>
        <div
          ref={verdictRef}
          style={{ padding: "10px 14px", fontSize: "12px", lineHeight: 1.78, color: C.cyanDim, overflowY: "auto", flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
        >
          {(() => {
            const last = groups[groups.length - 1];
            if (!last) return <span style={{ color: C.textDim, fontSize: "11px", letterSpacing: "0.1em" }}>awaiting deliberation_</span>;
            if (!last.verdict && streaming)
              return <span style={{ display: "inline-block", width: "7px", height: "13px", background: C.cyan, animation: "blink 1s step-end infinite", verticalAlign: "text-bottom", opacity: 0.6 }} />;
            return last.verdict || <span style={{ color: C.textDim }}>—</span>;
          })()}
        </div>
      </div>

      {/* ─── Input row ──────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: "10px", padding: "10px 14px", background: C.bgAlt, flexShrink: 0 }}>
        <span style={{ color: C.green, fontSize: "15px", flexShrink: 0, marginBottom: "1px", opacity: 0.8 }}>›</span>
        {mentions.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "2px", alignSelf: "center" }}>
            {mentions.map((m, i) => (
              <ContextPill key={i} type={m.type} label={m.label} value={m.value}
                onRemove={() => setMentions(prev => prev.filter((_,j) => j !== i))} />
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          value={input}
          onChange={handleTextareaInput}
          onKeyDown={handleKeyDown}
          placeholder="enter prompt…"
          rows={1}
          style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: C.text, fontFamily: MONO, fontSize: "13px", resize: "none", lineHeight: 1.5, minHeight: "20px", maxHeight: "120px", overflowY: "auto" }}
        />
        {streaming ? (
          <button
            onClick={handleStop}
            style={{ background: "transparent", color: C.red, border: `1px solid ${C.red}`, borderRadius: "3px", padding: "6px 16px", fontFamily: MONO, fontSize: "11px", fontWeight: 700, letterSpacing: "0.12em", cursor: "pointer", flexShrink: 0 }}
          >
            STOP
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!input.trim()}
            style={{ background: !input.trim() ? "transparent" : C.green, color: !input.trim() ? C.greenDim : "#050505", border: `1px solid ${!input.trim() ? C.border : C.green}`, borderRadius: "3px", padding: "6px 16px", fontFamily: MONO, fontSize: "11px", fontWeight: 700, letterSpacing: "0.12em", cursor: !input.trim() ? "default" : "pointer", flexShrink: 0, transition: "all 0.15s" }}
          >
            SEND
          </button>
        )}
      </div>


      {/* ─── @context picker overlay ────────────────────────────────── */}
      {mention.isOpen && (
        <ContextPickerOverlay
          mention={mention}
          borderColor={C.border}
          greenDim={C.greenDim}
          textDim={C.textDim}
          mono={MONO}
          onSelect={(label, value) => {
            setMentions(prev => [...prev, { type: (mention.mentionType ?? 'file') as any, label, value }])
            mention.closePicker()
          }}
        />
      )}

      {/* ─── Settings panel ─────────────────────────────────────────────── */}
      {showSettings && (
        <SettingsPanel
          council={council}
          onSave={c => { setCouncil(c); saveCouncilMembers(c); setShowSettings(false); }}
          onClose={() => setShowSettings(false)}
        />
      )}

      {/* ─── Help overlay ───────────────────────────────────────────────── */}
      {showHelp && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.82)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setShowHelp(false)}
        >
          <div
            style={{ background: "#0d0d0d", border: `1px solid ${C.border}`, borderRadius: "4px", padding: "22px 28px", minWidth: "280px", fontFamily: MONO }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ fontSize: "10px", letterSpacing: "0.22em", color: C.green, marginBottom: "14px" }}>SHORTCUTS</div>
            {[
              ["Enter",      "Send prompt"],
              ["Shift+Enter","New line"],
              ["Ctrl/⌘ K",  "Focus input"],
              ["?",          "Toggle this help"],
              ["Esc",        "Close overlays"],
            ].map(([k, v]) => (
              <div key={k} style={{ display: "flex", gap: "16px", marginBottom: "8px" }}>
                <span style={{ fontSize: "10px", color: C.green, width: "90px", flexShrink: 0 }}>{k}</span>
                <span style={{ fontSize: "10px", color: C.textDim }}>{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Click-away backdrop for threads dropdown */}
      {showThreads && (
        <div style={{ position: "fixed", inset: 0, zIndex: 29 }} onClick={() => setShowThreads(false)} />
      )}
    </div>
  );
}

// ─── Settings Panel ───────────────────────────────────────────────────────────

function SettingsPanel({ council, onSave, onClose }: {
  council: CouncilMember[];
  onSave: (c: CouncilMember[]) => void;
  onClose: () => void;
}) {
  const [local, setLocal]       = useState<CouncilMember[]>(() => council.map(m => ({ ...m })));
  const [expanded, setExpanded] = useState<string | null>(null);

  const toggle = (id: string) => setLocal(prev => prev.map(m => m.id === id ? { ...m, enabled: !m.enabled } : m));
  const update = (id: string, patch: Partial<CouncilMember>) => setLocal(prev => prev.map(m => m.id === id ? { ...m, ...patch } : m));
  const remove = (id: string) => setLocal(prev => prev.filter(m => m.id !== id));
  const add    = () => setLocal(prev => [...prev, newMember()]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.87)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#0d0d0d", border: `1px solid ${C.border}`, borderRadius: "4px", width: "560px", maxHeight: "80vh", overflow: "auto", padding: "20px", fontFamily: MONO }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "18px" }}>
          <span style={{ fontSize: "11px", letterSpacing: "0.22em", color: C.green }}>COUNCIL CONFIG</span>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: C.greenDim, cursor: "pointer", padding: 0 }}>
            <X size={14} />
          </button>
        </div>

        {local.map(m => (
          <div key={m.id} style={{ marginBottom: "6px", border: `1px solid ${C.border}`, borderRadius: "3px", overflow: "hidden" }}>
            <div
              style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px 10px", background: C.bgPanel, cursor: "pointer" }}
              onClick={() => setExpanded(p => p === m.id ? null : m.id)}
            >
              <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: m.enabled ? C.green : C.textDim, flexShrink: 0 }} />
              <span style={{ flex: 1, fontSize: "11px", color: m.enabled ? C.text : C.textDim }}>{m.label}</span>
              <span style={{ fontSize: "9px", color: C.textDim }}>{m.mode === "api" ? m.model : "browser"}</span>
              <button
                onClick={e => { e.stopPropagation(); toggle(m.id); }}
                style={{ background: "transparent", border: `1px solid ${m.enabled ? C.green : C.textDim}`, borderRadius: "2px", padding: "2px 8px", fontFamily: MONO, fontSize: "9px", color: m.enabled ? C.green : C.textDim, cursor: "pointer", letterSpacing: "0.1em" }}
              >
                {m.enabled ? "ON" : "OFF"}
              </button>
              <button
                onClick={e => { e.stopPropagation(); remove(m.id); }}
                style={{ background: "transparent", border: "none", color: C.textDim, cursor: "pointer", padding: "2px" }}
              >
                <Trash2 size={11} />
              </button>
            </div>

            {expanded === m.id && (
              <div style={{ padding: "12px 10px", background: "#080808", borderTop: `1px solid ${C.border}`, display: "flex", flexDirection: "column", gap: "9px" }}>
                <SRow label="LABEL">
                  <input value={m.label} onChange={e => update(m.id, { label: e.target.value })} style={iStyle} />
                </SRow>
                <SRow label="MODE">
                  <select value={m.mode} onChange={e => update(m.id, { mode: e.target.value as "browser" | "api" })} style={iStyle}>
                    <option value="browser">browser</option>
                    <option value="api">api</option>
                  </select>
                </SRow>
                {m.mode === "api" && (
                  <>
                    <SRow label="PROVIDER">
                      <select
                        value={m.provider}
                        onChange={e => {
                          const p = API_PROVIDERS.find(x => x.id === e.target.value);
                          update(m.id, { provider: e.target.value, model: p?.defaultModel ?? m.model, baseUrl: p?.defaultBaseUrl ?? m.baseUrl });
                        }}
                        style={iStyle}
                      >
                        {API_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                      </select>
                    </SRow>
                    <SRow label="MODEL">
                      <input value={m.model} onChange={e => update(m.id, { model: e.target.value })} style={iStyle} />
                    </SRow>
                    <SRow label="API KEY">
                      <input type="password" value={m.apiKey} onChange={e => update(m.id, { apiKey: e.target.value })} style={iStyle} placeholder="sk-…" />
                    </SRow>
                    {(m.provider === "ollama" || m.provider === "custom") && (
                      <SRow label="BASE URL">
                        <input value={m.baseUrl} onChange={e => update(m.id, { baseUrl: e.target.value })} style={iStyle} />
                      </SRow>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        ))}

        <div style={{ display: "flex", gap: "8px", marginTop: "14px" }}>
          <button onClick={add}                  style={{ ...bStyle, flex: 1 }}>+ ADD MEMBER</button>
          <button onClick={() => onSave(local)}  style={{ ...bStyle, background: C.green, color: "#050505", border: `1px solid ${C.green}` }}>SAVE</button>
        </div>
      </div>
    </div>
  );
}

function SRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
      <span style={{ fontSize: "9px", letterSpacing: "0.15em", color: C.textDim, width: "72px", flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

const iStyle: React.CSSProperties = {
  width: "100%", background: "#0a0a0a", border: `1px solid ${C.border}`,
  borderRadius: "2px", padding: "4px 8px", fontFamily: MONO,
  fontSize: "11px", color: C.text, outline: "none", boxSizing: "border-box",
};

const bStyle: React.CSSProperties = {
  background: "transparent", border: `1px solid ${C.border}`, borderRadius: "3px",
  padding: "8px 14px", fontFamily: MONO, fontSize: "10px", color: C.greenDim,
  cursor: "pointer", letterSpacing: "0.1em",
};

// ── Context picker overlay with live API results ───────────────────────────────

interface PickerResult { label: string; value: string; meta?: string }

function ContextPickerOverlay({
  mention, borderColor, greenDim, textDim, mono, onSelect,
}: {
  mention: ReturnType<typeof import("~/hooks/useContextMention").useContextMention>
  borderColor: string; greenDim: string; textDim: string; mono: string
  onSelect: (label: string, value: string) => void
}) {
  const [results, setResults] = useState<PickerResult[]>([])
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!mention.isOpen || !mention.mentionType) { setResults([]); return }

    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const q = encodeURIComponent(mention.query ?? '')
        let url = ''
        if (mention.mentionType === 'file')   url = `/api/context/files?q=${q}`
        if (mention.mentionType === 'symbol') url = `/api/context/symbols?q=${q}`
        if (mention.mentionType === 'web')    url = `/api/context/web?q=${q}`
        if (!url) { setResults([]); setLoading(false); return }

        const res = await fetch(url)
        if (!res.ok) throw new Error()
        const data = await res.json()
        // normalize: files → {path,name}, symbols → {name,kind,file}, web → {title,url}
        const items: PickerResult[] = (data.results ?? data ?? []).slice(0, 8).map((r: any) => ({
          label: r.name ?? r.title ?? r.path ?? String(r),
          value: r.path ?? r.url ?? r.name ?? String(r),
          meta:  r.kind ?? r.file ?? r.domain ?? undefined,
        }))
        setResults(items)
      } catch {
        setResults([])
      }
      setLoading(false)
    }, 150)

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [mention.isOpen, mention.mentionType, mention.query])

  const typeLabel = mention.mentionType ? mention.mentionType.toUpperCase() : 'CONTEXT'

  return (
    <div style={{
      position: "fixed", top: mention.anchorPos.top, left: mention.anchorPos.left,
      zIndex: 9000, background: "#0d0d0d", border: `1px solid ${borderColor}`,
      borderRadius: 8, width: 300, maxHeight: 280, overflow: "hidden",
      display: "flex", flexDirection: "column", boxShadow: "0 8px 32px #000c",
      fontFamily: mono,
    }}>
      {/* Header */}
      <div style={{ padding: "5px 10px", borderBottom: `1px solid #1a1a1a`, fontSize: 10, color: greenDim, letterSpacing: "0.1em", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>{typeLabel} {mention.query ? `· "${mention.query}"` : ''}</span>
        {loading && <span style={{ color: textDim, fontSize: 9 }}>…</span>}
      </div>

      {/* Results */}
      <div style={{ overflowY: "auto", flex: 1 }}>
        {!mention.mentionType ? (
          <div style={{ padding: "10px 12px" }}>
            {[['@file:', 'search project files'], ['@symbol:', 'search exports/functions'], ['@web:', 'search the web']].map(([cmd, hint]) => (
              <div key={cmd} style={{ display: "flex", gap: 8, marginBottom: 7, fontSize: 11 }}>
                <span style={{ color: greenDim, width: 72, flexShrink: 0 }}>{cmd}</span>
                <span style={{ color: textDim }}>{hint}</span>
              </div>
            ))}
          </div>
        ) : results.length === 0 && !loading ? (
          <div style={{ padding: "10px 12px", fontSize: 11, color: textDim }}>
            {mention.query ? 'No results' : `Type to search ${typeLabel.toLowerCase()}s…`}
          </div>
        ) : (
          results.map((r, i) => (
            <div
              key={i}
              onClick={() => onSelect(r.label, r.value)}
              style={{
                padding: "7px 12px", cursor: "pointer", borderBottom: `1px solid #111`,
                display: "flex", flexDirection: "column", gap: 2,
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = "#1a2a1a" }}
              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = "transparent" }}
            >
              <span style={{ fontSize: 12, color: "#c8ffc8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</span>
              {r.meta && <span style={{ fontSize: 10, color: textDim }}>{r.meta}</span>}
            </div>
          ))
        )}
      </div>
      <div style={{ padding: "4px 10px", borderTop: `1px solid #111`, fontSize: 9, color: textDim }}>
        ↑↓ navigate · Enter select · Esc close
      </div>
    </div>
  )
}
