// SPDX-License-Identifier: Apache-2.0
import {
  ArrowUp,
  Check,
  Copy,
  Download,
  EyeOff,
  Eye,
  History,
  MessageSquarePlus,
  Plus,
  Radio,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  TriangleAlert,
  Users,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";

import type { Route } from "./+types/chat";

import { ContextPicker } from "~/components/ContextPicker";
import { ContextPill, type MentionType } from "~/components/ContextPill";
import { RateAnswer } from "~/components/RateAnswer";
import { SendToCompany } from "~/components/org/SendToCompany";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "~/components/ui/sheet";
import { Switch } from "~/components/ui/switch";
import { useModelIds } from "~/hooks/use-model-ids";
import { useContextMention } from "~/hooks/useContextMention";
import {
  API_PROVIDERS,
  loadCouncilMembers,
  newMember,
  saveCouncilMembers,
  syncCouncilFromServer,
  type CouncilMember,
} from "~/lib/council";
import {
  createThread,
  deleteThread,
  deliberate,
  getMessages,
  isErrorOpinion,
  listThreads,
  onDone,
  onNotice,
  onLive,
  onOpinion,
  onVerdict,
  saveGroups,
  searchThreads,
  stopDeliberation,
  updateThreadMeta,
  type MoleculeOpinion,
} from "~/lib/deliberate";
import { hostCan, hostInvoke, hostOn } from "~/lib/host";
import { Markdown } from "~/lib/markdown";
import { opinionParts, verdictParts } from "~/lib/opinion";
import { applySTM, loadActiveSTM, saveActiveSTM, STM_MODULES, type STMModuleId } from "~/lib/stm";
import { cn } from "~/lib/utils";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Council · Nexus" }];
}

interface Mention {
  type: MentionType;
  label: string;
  value: string;
}

interface MsgGroup {
  id: string;
  round: number;
  prompt: string;
  opinions: Record<string, string>;
  archetypes?: Record<string, string>;
  verdict: string;
  error: string;
  notice?: string;
  liveUrl?: string;
  done: boolean;
}

interface Thread {
  id: string;
  title: string;
  updated_at: number;
  snippet?: string;
}

interface ArchetypeOption {
  id: string;
  name: string;
  thinkingStyle?: string;
  builtin?: boolean;
}

const MODES = [
  {
    id: "standard",
    label: "Standard",
    hint: "Members answer, then refine after reading each other",
  },
  { id: "red_blue", label: "Red vs blue", hint: "Half build the case, half attack it" },
  { id: "socratic", label: "Socratic", hint: "Question each assumption before concluding" },
  { id: "hypothesis", label: "Competing hypotheses", hint: "Weigh rival explanations on evidence" },
  { id: "confidence", label: "Confidence-scored", hint: "Every claim carries a confidence" },
] as const;

const SWATCH = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"];

function threadTitle(prompt: string) {
  return prompt.slice(0, 60).trim() + (prompt.length > 60 ? "…" : "");
}

function exportMarkdown(groups: MsgGroup[], title: string): string {
  const lines = [`# ${title}`, ""];
  for (const g of groups) {
    lines.push(`## Round ${g.round}`, "", `> ${g.prompt}`, "");
    for (const [label, text] of Object.entries(g.opinions)) {
      const persona = g.archetypes?.[label];
      lines.push(`### ${label}${persona ? ` (${persona})` : ""}`, "", text, "");
    }
    if (g.verdict) lines.push("### Synthesis", "", g.verdict, "");
    lines.push("---", "");
  }
  return lines.join("\n");
}

function download(filename: string, content: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: "text/markdown" }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function savePref(patch: Record<string, unknown>) {
  await fetch("/api/settings/preferences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }).catch(() => undefined);
}

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = useCallback((key: string, text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1600);
    });
  }, []);
  return { copied, copy };
}

export default function Chat() {
  const { id: routeId } = useParams();
  const navigate = useNavigate();
  const [search] = useSearchParams();

  const [council, setCouncil] = useState<CouncilMember[]>(() => loadCouncilMembers());
  const [archetypes, setArchetypes] = useState<ArchetypeOption[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState(routeId ?? "");
  const [groups, setGroups] = useState<MsgGroup[]>([]);
  const [streaming, setStreaming] = useState(false);
  const streamingRef = useRef(false);
  // Home's ask box hands its question over as ?q=.
  const [input, setInput] = useState(() => search.get("q") ?? "");
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [activeSTM, setActiveSTM] = useState<STMModuleId[]>([]);
  const [mode, setMode] = useState("standard");
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);
  const [templateId, setTemplateId] = useState("");
  useEffect(() => {
    fetch("/api/v1/council/templates")
      .then((r) => (r.ok ? r.json() : { templates: [] }))
      .then((d: { templates?: { id: string; name: string }[] }) => setTemplates(d.templates ?? []))
      .catch(() => setTemplates([]));
  }, []);
  const [debate, setDebate] = useState(true);
  const [blind, setBlind] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [showCouncil, setShowCouncil] = useState(false);
  const [showThreads, setShowThreads] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const mention = useContextMention();
  const { copied, copy } = useCopy();

  const councilRef = useRef(council);
  councilRef.current = council;
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  // ── Load council, archetypes, preferences, threads ──────────────────────────
  useEffect(() => {
    void syncCouncilFromServer().then(setCouncil);
    void fetch("/api/archetypes")
      .then((r) => (r.ok ? r.json() : { archetypes: [] }))
      .then((d: { archetypes?: ArchetypeOption[] }) => setArchetypes(d.archetypes ?? []))
      .catch(() => undefined);
    void fetch("/api/settings/preferences")
      .then((r) => (r.ok ? r.json() : {}))
      .then((p: { deliberationMode?: string; debateRound?: boolean }) => {
        if (p.deliberationMode) setMode(p.deliberationMode);
        if (typeof p.debateRound === "boolean") setDebate(p.debateRound);
      })
      .catch(() => undefined);
    void listThreads().then((t) => setThreads(t as Thread[]));
    setActiveSTM(loadActiveSTM());
    try {
      setBlind(localStorage.getItem("nexus_blind_review") === "1");
    } catch {
      /* per-viewer convenience only */
    }
  }, []);

  const hydrateThread = useCallback(async (id: string) => {
    const idToLabel = Object.fromEntries(councilRef.current.map((c) => [c.id, c.label]));
    const msgs = (await getMessages(id)) as {
      id: string;
      role: string;
      member: string | null;
      archetype?: string | null;
      content: string;
      round: number;
    }[];
    const byRound: Record<number, MsgGroup> = {};
    for (const m of msgs) {
      byRound[m.round] ??= {
        id: m.id,
        round: m.round,
        prompt: "",
        opinions: {},
        verdict: "",
        error: "",
        done: true,
      };
      if (m.role === "user") byRound[m.round].prompt = m.content;
      if (m.role === "opinion" && m.member) {
        const label = idToLabel[m.member] ?? m.member;
        byRound[m.round].opinions[label] = m.content;
        if (m.archetype)
          byRound[m.round].archetypes = { ...byRound[m.round].archetypes, [label]: m.archetype };
      }
      if (m.role === "verdict") byRound[m.round].verdict = m.content;
    }
    if (threadIdRef.current === id)
      setGroups(Object.values(byRound).sort((a, b) => a.round - b.round));
  }, []);

  // The URL names the thread; a send on a blank page creates one and moves here.
  useEffect(() => {
    if (!routeId) {
      if (!streamingRef.current) {
        setThreadId("");
        setGroups([]);
      }
      return;
    }
    if (routeId === threadIdRef.current && groups.length) return;
    setThreadId(routeId);
    threadIdRef.current = routeId;
    setGroups([]);
    void hydrateThread(routeId);
  }, [routeId, hydrateThread]);

  // ── Stream events ────────────────────────────────────────────────────────────
  useEffect(() => {
    const offStarted = hostCan("deliberate")
      ? hostOn("deliberation:started", () => {
          streamingRef.current = true;
          setStreaming(true);
        })
      : () => {};
    const patchLast = (fn: (g: MsgGroup) => MsgGroup) =>
      setGroups((prev) => (prev.length ? [...prev.slice(0, -1), fn(prev[prev.length - 1])] : prev));

    const offOpinion = onOpinion((d: MoleculeOpinion) =>
      patchLast((g) => ({
        ...g,
        opinions: { ...g.opinions, [d.label]: (g.opinions[d.label] ?? "") + d.text },
        archetypes: d.archetype ? { ...g.archetypes, [d.label]: d.archetype } : g.archetypes,
      })),
    );
    const offVerdict = onVerdict((d) => patchLast((g) => ({ ...g, verdict: g.verdict + d.text })));
    const offNotice = onNotice(({ message }) => patchLast((g) => ({ ...g, notice: message })));
    const offLive = onLive(({ url }) => patchLast((g) => ({ ...g, liveUrl: url })));
    const offDone = onDone((d) => {
      streamingRef.current = false;
      setStreaming(false);
      setGroups((prev) => {
        if (!prev.length) return prev;
        const last = { ...prev[prev.length - 1], done: true };
        const next = [...prev.slice(0, -1), last];
        if (!hostCan("threads")) void saveGroups(threadIdRef.current, next);
        if (d.round === 1 && last.prompt) {
          const title = threadTitle(last.prompt);
          setThreads((ts) => ts.map((t) => (t.id === threadIdRef.current ? { ...t, title } : t)));
          void updateThreadMeta(threadIdRef.current, { title });
        }
        return next;
      });
    });
    return () => {
      offStarted();
      offOpinion();
      offVerdict();
      offNotice();
      offLive();
      offDone();
    };
  }, []);

  // Keep a reload mid-stream from losing the exchange.
  useEffect(() => {
    if (hostCan("threads") || !groups.length || !threadIdRef.current) return;
    const t = setTimeout(() => void saveGroups(threadIdRef.current, groups), 600);
    return () => clearTimeout(t);
  }, [groups]);

  useEffect(() => {
    if (streaming) endRef.current?.scrollIntoView({ block: "end" });
  }, [groups, streaming]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        taRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ── Actions ──────────────────────────────────────────────────────────────────
  const send = useCallback(async () => {
    const prompt = input.trim();
    if (!prompt || streamingRef.current) return;
    streamingRef.current = true;
    setStreaming(true);
    setInput("");
    const sentMentions = mentions.map(({ type, value }) => ({ type, value }));
    setMentions([]);

    let id = threadIdRef.current;
    if (!id) {
      const title = threadTitle(prompt);
      id = await createThread(title);
      threadIdRef.current = id;
      setThreadId(id);
      setThreads((prev) => [{ id, title, updated_at: Date.now() }, ...prev]);
      navigate(`/chat/${id}`, { replace: true });
    }

    const round = groups.length + 1;
    setGroups((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        round,
        prompt,
        opinions: {},
        verdict: "",
        error: "",
        done: false,
      },
    ]);
    try {
      await deliberate({
        threadId: id,
        message: prompt,
        round,
        preamble: applySTM("", activeSTM),
        mentions: sentMentions,
        ...(templateId ? { templateId } : {}),
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : "The deliberation failed.";
      const msg = /\b40[13]\b/.test(raw)
        ? "Your session expired. Sign in again, then resend."
        : raw;
      streamingRef.current = false;
      setStreaming(false);
      setGroups((prev) =>
        prev.length
          ? [...prev.slice(0, -1), { ...prev[prev.length - 1], error: msg, done: true }]
          : prev,
      );
    }
  }, [input, mentions, groups.length, activeSTM, templateId, navigate]);

  const stop = () => {
    streamingRef.current = false;
    setStreaming(false);
    stopDeliberation();
    setGroups((prev) => {
      if (!prev.length) return prev;
      const next = [...prev.slice(0, -1), { ...prev[prev.length - 1], done: true }];
      if (!hostCan("threads")) void saveGroups(threadIdRef.current, next);
      return next;
    });
  };

  const removeThread = async (id: string) => {
    await deleteThread(id);
    setThreads((prev) => prev.filter((t) => t.id !== id));
    if (id === threadIdRef.current) navigate("/chat");
  };

  const speak = async (text: string) => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (speaking) {
      window.speechSynthesis?.cancel();
      setSpeaking(false);
      return;
    }
    setSpeaking(true);
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.slice(0, 2000) }),
      });
      const data = res.ok ? ((await res.json()) as { audio?: string | null }) : {};
      if (!data.audio) {
        const u = new SpeechSynthesisUtterance(text.slice(0, 2000));
        u.onend = u.onerror = () => setSpeaking(false);
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
        return;
      }
      const audio = new Audio(data.audio);
      audioRef.current = audio;
      audio.onended = audio.onerror = () => setSpeaking(false);
      await audio.play();
    } catch {
      setSpeaking(false);
    }
  };

  const toggleSTM = (id: STMModuleId) => {
    setActiveSTM((prev) => {
      const conflicts = STM_MODULES.find((m) => m.id === id)?.conflictsWith ?? [];
      const next = prev.includes(id)
        ? prev.filter((x) => x !== id)
        : [...prev.filter((x) => !conflicts.includes(x)), id];
      saveActiveSTM(next);
      return next;
    });
  };

  const toggleBlind = (on: boolean) => {
    setBlind(on);
    setRevealed(new Set());
    try {
      localStorage.setItem("nexus_blind_review", on ? "1" : "0");
    } catch {
      /* per-viewer convenience only */
    }
  };

  const onInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    mention.onTextareaChange(e);
    setInput(e.target.value);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  };

  const pickMention = useCallback(
    (label: string, value: string) => {
      setMentions((prev) => [
        ...prev,
        { type: (mention.mentionType ?? "file") as MentionType, label, value },
      ]);
      setInput((prev) => prev.replace(/@[^@\s]*$/, ""));
      mention.closePicker();
      taRef.current?.focus();
    },
    [mention],
  );

  const active = council.filter((m) => m.enabled);
  const archetypeName = useMemo(() => new Map(archetypes.map((a) => [a.id, a.name])), [archetypes]);
  const current = threads.find((t) => t.id === threadId);
  const modeLabel = MODES.find((m) => m.id === mode)?.label ?? "Standard";

  const threadList = (
    <ThreadList
      threads={threads}
      activeId={threadId}
      onPick={(id) => {
        setShowThreads(false);
        navigate(`/chat/${id}`);
      }}
      onNew={() => {
        setShowThreads(false);
        navigate("/chat");
      }}
      onDelete={removeThread}
    />
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 flex-col border-r bg-sidebar/40 xl:flex">
        {threadList}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 sm:px-4">
          <Button
            variant="ghost"
            size="icon-sm"
            className="xl:hidden"
            onClick={() => setShowThreads(true)}
            aria-label="Past deliberations"
          >
            <History />
          </Button>
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
            {current?.title ?? "New deliberation"}
          </h1>
          {threadId && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowOptions(true)}
              aria-label="Thread options"
            >
              <SlidersHorizontal /> <span className="hidden sm:inline">Thread</span>
            </Button>
          )}
          {groups.length > 0 && (
            <Button
              variant="ghost"
              size="icon-sm"
              title="Export as Markdown"
              aria-label="Export as Markdown"
              onClick={() =>
                download(
                  `${(current?.title ?? "deliberation").slice(0, 40).replace(/[^a-z0-9]+/gi, "-")}.md`,
                  exportMarkdown(groups, current?.title ?? "Deliberation"),
                )
              }
            >
              <Download />
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => navigate("/chat")}>
            <MessageSquarePlus /> <span className="hidden sm:inline">New</span>
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-5xl px-3 py-6 sm:px-6">
            {groups.length === 0 ? (
              <EmptyState
                members={active}
                archetypeName={archetypeName}
                onEditCouncil={() => setShowCouncil(true)}
                onPick={(q) => {
                  setInput(q);
                  taRef.current?.focus();
                }}
              />
            ) : (
              <div className="space-y-10">
                {groups.map((g, gi) => (
                  <Round
                    key={g.id}
                    group={g}
                    members={active}
                    archetypeName={archetypeName}
                    live={gi === groups.length - 1 && !g.done && streaming}
                    blind={blind && !revealed.has(g.id)}
                    onReveal={() => setRevealed((s) => new Set(s).add(g.id))}
                    threadId={threadId}
                    copied={copied}
                    onCopy={copy}
                    speaking={speaking}
                    onSpeak={speak}
                  />
                ))}
                <div ref={endRef} />
              </div>
            )}
          </div>
        </div>

        {/* Composer */}
        <div className="shrink-0 border-t bg-background/80 px-3 py-3 backdrop-blur sm:px-6">
          <div className="relative mx-auto max-w-3xl">
            {mention.isOpen && <ContextPicker mention={mention} onSelect={pickMention} />}
            <div className="rounded-xl border bg-card shadow-xs transition-shadow focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
              {mentions.length > 0 && (
                <div className="flex flex-wrap gap-1 px-3 pt-2.5">
                  {mentions.map((m, i) => (
                    <ContextPill
                      key={`${m.value}-${i}`}
                      type={m.type}
                      label={m.label}
                      value={m.value}
                      onRemove={() => setMentions((prev) => prev.filter((_, j) => j !== i))}
                    />
                  ))}
                </div>
              )}
              <textarea
                ref={taRef}
                value={input}
                onChange={onInput}
                onKeyDown={(e) => {
                  if (mention.onKeyDown(e)) return;
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={1}
                aria-label="Message the council"
                placeholder="Ask the council anything. Type @ to add files, the web or a knowledge base."
                className="block max-h-[200px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm outline-none placeholder:text-muted-foreground"
              />
              <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowCouncil(true)}
                  aria-label="Edit council"
                >
                  <MemberStack members={active} />
                  <span>
                    {active.length} {active.length === 1 ? "member" : "members"}
                  </span>
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" aria-label="Deliberation settings">
                      <Settings2 /> {templates.find((t) => t.id === templateId)?.name ?? modeLabel}
                      {debate ? " · debate" : ""}
                      {activeSTM.length ? ` · ${activeSTM.length} style` : ""}
                      {blind ? " · blind" : ""}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" side="top" className="w-72">
                    <DropdownMenuLabel>How the council reasons</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={mode}
                      onValueChange={(v) => {
                        setMode(v);
                        void savePref({ deliberationMode: v });
                      }}
                    >
                      {MODES.map((m) => (
                        <DropdownMenuRadioItem key={m.id} value={m.id} className="items-start">
                          <div className="grid">
                            <span>{m.label}</span>
                            <span className="text-xs text-muted-foreground">{m.hint}</span>
                          </div>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                    {templates.length > 0 && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>Council template</DropdownMenuLabel>
                        <DropdownMenuRadioGroup value={templateId} onValueChange={setTemplateId}>
                          <DropdownMenuRadioItem value="">None</DropdownMenuRadioItem>
                          {templates.map((t) => (
                            <DropdownMenuRadioItem key={t.id} value={t.id}>
                              {t.name}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuCheckboxItem
                      checked={debate}
                      onCheckedChange={(v) => {
                        setDebate(v);
                        void savePref({ debateRound: v });
                      }}
                    >
                      Debate round — members read each other and refine
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem checked={blind} onCheckedChange={toggleBlind}>
                      Blind review — hide who said what until you reveal
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Answer style</DropdownMenuLabel>
                    {STM_MODULES.map((m) => (
                      <DropdownMenuCheckboxItem
                        key={m.id}
                        checked={activeSTM.includes(m.id)}
                        onCheckedChange={() => toggleSTM(m.id)}
                        className="items-start"
                      >
                        <div className="grid">
                          <span>{m.label}</span>
                          <span className="text-xs text-muted-foreground">{m.description}</span>
                        </div>
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <div className="ml-auto flex items-center gap-2">
                  <span className="hidden text-xs text-muted-foreground sm:inline">
                    Enter to send · Shift+Enter new line
                  </span>
                  {streaming ? (
                    <Button size="icon" variant="secondary" onClick={stop} aria-label="Stop">
                      <Square className="fill-current" />
                    </Button>
                  ) : (
                    <Button
                      size="icon"
                      onClick={() => void send()}
                      disabled={!input.trim() || active.length === 0}
                      aria-label="Send"
                    >
                      <ArrowUp />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <Sheet open={showThreads} onOpenChange={setShowThreads}>
        <SheetContent side="left" className="w-72 p-0" showCloseButton={false}>
          <SheetHeader className="sr-only">
            <SheetTitle>Past deliberations</SheetTitle>
          </SheetHeader>
          {threadList}
        </SheetContent>
      </Sheet>

      {threadId && (
        <ThreadOptions threadId={threadId} open={showOptions} onOpenChange={setShowOptions} />
      )}

      <CouncilDialog
        open={showCouncil}
        onOpenChange={setShowCouncil}
        council={council}
        archetypes={archetypes}
        onSave={async (c) => {
          setCouncil(c);
          saveCouncilMembers(c);
          if (hostCan("councilSync")) void hostInvoke("councilSync", "setCouncilMembers", c);
          const d = (await fetch("/api/settings/council", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ members: c }),
          })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)) as {
            keySources?: { index: number; source?: string }[];
            validations?: MemberCheck[];
          } | null;
          if (d?.keySources) {
            const withKeys = c.map((m, i) => ({
              ...m,
              keySource: d.keySources?.[i]?.source as CouncilMember["keySource"],
            }));
            setCouncil(withKeys);
            saveCouncilMembers(withKeys);
          }
          const found: Record<string, string> = {};
          for (const v of d?.validations ?? []) {
            const text = checkMessage(v);
            const id = c[v.index]?.id;
            if (text && id) found[id] = text;
          }
          return found;
        }}
      />
    </div>
  );
}

// ── Threads ──────────────────────────────────────────────────────────────────

function ThreadList({
  threads,
  activeId,
  onPick,
  onNew,
  onDelete,
}: {
  threads: Thread[];
  activeId: string;
  onPick: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Thread[] | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    const timer = setTimeout(() => {
      void searchThreads(q)
        .then((found) => setHits(found as Thread[]))
        .catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  const shown = hits ?? threads;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-3">
        <span className="text-sm font-medium">Deliberations</span>
        <Button variant="ghost" size="icon-sm" onClick={onNew} aria-label="New deliberation">
          <Plus />
        </Button>
      </div>
      <div className="shrink-0 border-b p-2">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search deliberations"
          aria-label="Search deliberations"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {shown.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            {query.trim() ? "No deliberation matches." : "Your deliberations will appear here."}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {shown.map((t) => (
              <li key={t.id} className="group relative">
                <button
                  type="button"
                  onClick={() => onPick(t.id)}
                  className={cn(
                    "w-full truncate rounded-md px-2.5 py-2 pr-8 text-left text-sm hover:bg-accent",
                    t.id === activeId && "bg-accent font-medium",
                  )}
                >
                  {t.title || "Untitled"}
                  {t.snippet && (
                    <span className="block truncate text-xs font-normal text-muted-foreground">
                      {t.snippet}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(t.id)}
                  aria-label={`Delete ${t.title}`}
                  className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────────

const STARTERS = [
  "Should we rewrite our monolith as services this year?",
  "What are the strongest arguments against a four-day work week?",
  "Review this pricing idea: $0 base plan, pay per seat above five.",
  "Which evidence would change your mind about remote work productivity?",
];

function EmptyState({
  members,
  archetypeName,
  onEditCouncil,
  onPick,
}: {
  members: CouncilMember[];
  archetypeName: Map<string, string>;
  onEditCouncil: () => void;
  onPick: (q: string) => void;
}) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center pt-6 text-center sm:pt-14">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <Users className="size-6" />
      </div>
      <h2 className="mt-4 text-2xl font-semibold">Put a question to your council</h2>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        Each member answers from its own perspective, reads the others, then the council writes one
        synthesis — with the disagreements left in.
      </p>

      <div className="mt-8 w-full rounded-xl border bg-card p-4 text-left">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium">Seated today</span>
          <Button variant="ghost" size="sm" onClick={onEditCouncil}>
            Edit council
          </Button>
        </div>
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No member is switched on. Open the council to add one.
          </p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {members.map((m, i) => (
              <li key={m.id} className="flex items-center gap-2.5 rounded-lg border px-3 py-2">
                <span className={cn("size-2 shrink-0 rounded-full", SWATCH[i % SWATCH.length])} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{m.label}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {(m.archetypeId && archetypeName.get(m.archetypeId)) ??
                      "Archetype picked per question"}
                    {" · "}
                    {m.model}
                  </p>
                </div>
                {m.keySource === "none" && (
                  <Link
                    to="/provider-keys"
                    className="ml-auto shrink-0"
                    title={`No ${m.provider} key saved`}
                  >
                    <TriangleAlert className="size-4 text-warning" />
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-6 grid w-full gap-2 sm:grid-cols-2">
        {STARTERS.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => onPick(q)}
            className="rounded-lg border px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── A round ──────────────────────────────────────────────────────────────────

function Round({
  group,
  members,
  archetypeName,
  live,
  blind,
  onReveal,
  threadId,
  copied,
  onCopy,
  speaking,
  onSpeak,
}: {
  group: MsgGroup;
  members: CouncilMember[];
  archetypeName: Map<string, string>;
  live: boolean;
  blind: boolean;
  onReveal: () => void;
  threadId: string;
  copied: string | null;
  onCopy: (key: string, text: string) => void;
  speaking: boolean;
  onSpeak: (text: string) => void;
}) {
  const labels = [
    ...new Set([...(live ? members.map((m) => m.label) : []), ...Object.keys(group.opinions)]),
  ];
  const byLabel = new Map(members.map((m, i) => [m.label, { m, i }]));

  return (
    <section className="space-y-4">
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm whitespace-pre-wrap text-primary-foreground">
          {group.prompt}
        </div>
      </div>

      {group.notice && (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
          {group.notice}
        </p>
      )}
      {group.error && (
        <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {group.error}
        </p>
      )}

      {labels.length > 0 && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Round {group.round} · {labels.length} perspectives
            </span>
            {group.liveUrl && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void navigator.clipboard?.writeText(location.origin + group.liveUrl)}
                title="Anyone with this link can watch this answer for the next hour"
              >
                <Radio /> Copy watch link
              </Button>
            )}
            {blind && (
              <Button variant="ghost" size="sm" onClick={onReveal}>
                <Eye /> Reveal members
              </Button>
            )}
          </div>
          <div
            className={cn(
              "grid gap-3",
              labels.length > 1 && "md:grid-cols-2",
              labels.length > 2 && "xl:grid-cols-3",
            )}
          >
            {labels.map((label, i) => {
              const entry = byLabel.get(label);
              const text = group.opinions[label] ?? "";
              const persona =
                group.archetypes?.[label] ??
                (entry?.m.archetypeId ? archetypeName.get(entry.m.archetypeId) : undefined);
              return (
                <MemberCard
                  key={label}
                  label={blind ? `Member ${String.fromCharCode(65 + i)}` : label}
                  persona={blind ? undefined : persona}
                  model={blind ? undefined : entry?.m.model}
                  swatch={SWATCH[(entry?.i ?? i) % SWATCH.length]}
                  text={text}
                  live={live}
                  copyKey={`${group.id}:${label}`}
                  copied={copied}
                  onCopy={onCopy}
                />
              );
            })}
          </div>
        </>
      )}

      {(group.verdict || live) && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 sm:p-5">
          <div className="mb-2 flex flex-wrap items-center gap-1">
            <Sparkles className="size-4 text-primary" />
            <span className="mr-auto text-sm font-semibold">Synthesis</span>
            {group.verdict && (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Copy synthesis"
                  title="Copy"
                  onClick={() => onCopy(`v:${group.id}`, group.verdict)}
                >
                  {copied === `v:${group.id}` ? <Check /> : <Copy />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={speaking ? "Stop reading" : "Read aloud"}
                  title={speaking ? "Stop reading" : "Read aloud"}
                  onClick={() => onSpeak(group.verdict)}
                >
                  {speaking ? <VolumeX /> : <Volume2 />}
                </Button>
              </>
            )}
            {group.done && group.verdict && (
              <>
                <RateAnswer
                  sessionId={threadId || group.id}
                  messageId={group.id}
                  prompt={group.prompt}
                  answer={group.verdict}
                  model="council"
                />
                <SendToCompany question={group.prompt} verdict={group.verdict} />
              </>
            )}
          </div>
          {group.verdict ? (
            <VerdictBody text={group.verdict} live={live} />
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="size-1.5 animate-pulse rounded-full bg-primary" />
              Waiting for the members to finish…
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function VerdictBody({ text, live }: { text: string; live: boolean }) {
  const { status, body } = verdictParts(text);
  return (
    <div className="space-y-3">
      {status && (
        <Badge variant="outline" className="h-auto py-1 whitespace-normal">
          {status}
        </Badge>
      )}
      {body ? (
        <div className="text-sm leading-relaxed">
          <Markdown text={body} />
        </div>
      ) : (
        live && <p className="text-sm text-muted-foreground">The chair is writing the synthesis…</p>
      )}
    </div>
  );
}

function MemberCard({
  label,
  persona,
  model,
  swatch,
  text,
  live,
  copyKey,
  copied,
  onCopy,
}: {
  label: string;
  persona?: string;
  model?: string;
  swatch: string;
  text: string;
  live: boolean;
  copyKey: string;
  copied: string | null;
  onCopy: (key: string, text: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const failed = isErrorOpinion({ text });
  const long = text.length > 900;

  return (
    <article className="flex min-w-0 flex-col rounded-xl border bg-card">
      <header className="flex items-start gap-2 border-b px-3.5 py-2.5">
        <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", swatch)} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{label}</p>
          {(persona || model) && (
            <p className="truncate text-xs text-muted-foreground">
              {persona}
              {persona && model ? " · " : ""}
              {model}
            </p>
          )}
        </div>
        {text && !failed && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Copy ${label}`}
            onClick={() => onCopy(copyKey, text)}
          >
            {copied === copyKey ? <Check /> : <Copy />}
          </Button>
        )}
      </header>
      <div className="px-3.5 py-3 text-sm leading-relaxed">
        {failed ? (
          <p className="flex items-start gap-2 text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            {text.replace(/^\[[^\]]{1,64} error: /, "").replace(/\]$/, "")}
          </p>
        ) : text ? (
          <div className={cn("space-y-3", long && !expanded && "line-clamp-[14]")}>
            {opinionParts(text).map((part, i) => (
              <div key={i} className="space-y-2">
                {i > 0 && (
                  <p className="flex items-center gap-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    <span className="h-px flex-1 bg-border" /> After reading the others
                    <span className="h-px flex-1 bg-border" />
                  </p>
                )}
                {part.body && <Markdown text={part.body} />}
                {part.final && (
                  <div className="rounded-lg border-l-2 border-primary bg-primary/5 px-3 py-2">
                    <p className="text-[11px] font-medium tracking-wide text-primary uppercase">
                      Final position
                    </p>
                    <Markdown text={part.final} />
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : live ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-primary" /> Thinking…
          </p>
        ) : (
          <p className="text-muted-foreground">No answer.</p>
        )}
        {long && !failed && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-2 text-xs font-medium text-primary hover:underline"
          >
            {expanded ? "Show less" : "Show all"}
          </button>
        )}
      </div>
    </article>
  );
}

function MemberStack({ members }: { members: CouncilMember[] }) {
  return (
    <span className="flex -space-x-1">
      {members.slice(0, 4).map((m, i) => (
        <span
          key={m.id}
          className={cn(
            "flex size-5 items-center justify-center rounded-full text-[10px] font-semibold text-white ring-2 ring-card",
            SWATCH[i % SWATCH.length],
          )}
        >
          {m.label.slice(0, 1).toUpperCase()}
        </span>
      ))}
    </span>
  );
}

// ── Council editor ───────────────────────────────────────────────────────────

interface LinkedAccount {
  providerId: string;
  displayName: string;
  driverProvider: string | null;
}
interface LinkableProvider {
  id: string;
  displayName: string;
  supported: boolean;
}

interface MemberCheck {
  index: number;
  provider: string;
  model: string;
  status: string;
  availableModels?: string[];
}

function checkMessage(v: MemberCheck): string | null {
  if (v.status === "no_key") return `No key for ${v.provider}. Add one under Models & keys.`;
  if (v.status === "missing_model") return "Choose a model.";
  if (v.status === "unreachable") return `Could not reach ${v.provider} to check the model.`;
  if (v.status !== "missing") return null;
  const hint = v.availableModels?.slice(0, 3).join(", ");
  return `${v.model} is not available on this key.${hint ? ` Try ${hint}.` : ""}`;
}

function CouncilDialog({
  open,
  onOpenChange,
  council,
  archetypes,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  council: CouncilMember[];
  archetypes: ArchetypeOption[];
  /** Saves, then resolves to a warning per member id that will not run as configured. */
  onSave: (c: CouncilMember[]) => Promise<Record<string, string>>;
}) {
  const [draft, setDraft] = useState<CouncilMember[]>(council);
  const [linked, setLinked] = useState<LinkedAccount[]>([]);
  const [linkable, setLinkable] = useState<LinkableProvider[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const modelIds = useModelIds();

  useEffect(() => {
    if (open) setChecks({});
  }, [open]);

  const save = async () => {
    setSaving(true);
    const found = await onSave(draft).finally(() => setSaving(false));
    setChecks(found);
    if (Object.keys(found).length === 0) onOpenChange(false);
  };

  useEffect(() => {
    if (!open) return;
    setDraft(council.map((m) => ({ ...m })));
    void Promise.all([
      fetch("/api/v1/llm-oauth/status").then((r) => (r.ok ? r.json() : {})),
      fetch("/api/v1/llm-oauth/providers").then((r) => (r.ok ? r.json() : {})),
    ])
      .then(([s, c]: [{ linked?: LinkedAccount[] }, { providers?: LinkableProvider[] }]) => {
        setLinked(s.linked ?? []);
        setLinkable((c.providers ?? []).filter((p) => p.supported));
      })
      .catch(() => undefined);
  }, [open, council]);

  const update = (id: string, patch: Partial<CouncilMember>) => {
    setDraft((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
    setChecks(({ [id]: _, ...rest }) => rest);
  };

  const link = async (id: string) => {
    setBusy(id);
    try {
      if (hostCan("providerSignIn")) {
        await hostInvoke("providerSignIn", "connectProvider", id);
        const s = (await fetch("/api/v1/llm-oauth/status").then((r) => r.json())) as {
          linked?: LinkedAccount[];
        };
        setLinked(s.linked ?? []);
      } else {
        const res = await fetch(`/api/v1/llm-oauth/${id}/start`, { method: "POST" });
        const body = (await res.json()) as { authUrl?: string };
        if (body.authUrl) window.location.assign(body.authUrl);
      }
    } finally {
      setBusy(null);
    }
  };

  const unlink = async (id: string) => {
    setBusy(id);
    await fetch(`/api/v1/llm-oauth/${id}/revoke`, { method: "POST" }).catch(() => undefined);
    setLinked((prev) => prev.filter((a) => a.providerId !== id));
    setBusy(null);
  };

  const linkedIds = new Set(linked.map((a) => a.providerId));
  const accounts = [
    ...linked.map((a) => ({ id: a.providerId, name: a.displayName, linked: true })),
    ...linkable
      .filter((p) => !linkedIds.has(p.id))
      .map((p) => ({ id: p.id, name: p.displayName, linked: false })),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Council</DialogTitle>
          <DialogDescription>
            Who sits on the council, which model each one runs and which archetype it speaks as.
            Keys live under{" "}
            <Link to="/provider-keys" className="text-primary hover:underline">
              Models &amp; keys
            </Link>
            .
          </DialogDescription>
        </DialogHeader>

        <datalist id="council-models">
          {modelIds.map((id) => (
            <option key={id} value={id.includes("/") ? id.slice(id.indexOf("/") + 1) : id} />
          ))}
        </datalist>

        <ul className="space-y-3">
          {draft.map((m, i) => (
            <li
              key={m.id}
              className={cn("rounded-lg border p-3", !m.enabled && "bg-muted/40 opacity-70")}
            >
              <div className="flex items-center gap-2">
                <span className={cn("size-2.5 shrink-0 rounded-full", SWATCH[i % SWATCH.length])} />
                <Input
                  value={m.label}
                  onChange={(e) => update(m.id, { label: e.target.value })}
                  aria-label="Member name"
                  className="h-8 max-w-48 font-medium"
                />
                {m.keySource === "none" && (
                  <Badge variant="outline" className="border-warning/50 text-warning">
                    No key
                  </Badge>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <Switch
                    checked={m.enabled}
                    onCheckedChange={(v) => update(m.id, { enabled: v })}
                    aria-label={`${m.label} seated`}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${m.label}`}
                    onClick={() => setDraft((prev) => prev.filter((x) => x.id !== m.id))}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <Field label="Archetype">
                  <select
                    value={m.archetypeId ?? ""}
                    onChange={(e) => update(m.id, { archetypeId: e.target.value || undefined })}
                    className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                  >
                    <option value="">Auto — fits the question</option>
                    {archetypes.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                        {a.builtin === false ? " (yours)" : ""}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Provider">
                  <select
                    value={m.provider}
                    onChange={(e) => {
                      const p = API_PROVIDERS.find((x) => x.id === e.target.value);
                      update(m.id, {
                        provider: e.target.value,
                        model: p?.defaultModel ?? m.model,
                        baseUrl: p?.defaultBaseUrl ?? m.baseUrl,
                        keySource: undefined,
                      });
                    }}
                    className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                  >
                    {!API_PROVIDERS.some((p) => p.id === m.provider) && (
                      <option value={m.provider}>{m.provider}</option>
                    )}
                    {API_PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Model">
                  <Input
                    value={m.model}
                    list="council-models"
                    onChange={(e) => update(m.id, { model: e.target.value })}
                  />
                </Field>
                {(m.provider === "ollama" || m.provider === "custom") && (
                  <Field label="Base URL" className="sm:col-span-3">
                    <Input
                      value={m.baseUrl}
                      onChange={(e) => update(m.id, { baseUrl: e.target.value })}
                    />
                  </Field>
                )}
              </div>
              {checks[m.id] && (
                <p className="mt-2 text-xs text-warning" role="alert">
                  {checks[m.id]}
                </p>
              )}
            </li>
          ))}
        </ul>

        <Button
          variant="outline"
          className="w-full border-dashed"
          onClick={() => setDraft((prev) => [...prev, newMember()])}
        >
          <Plus /> Add member
        </Button>

        {accounts.length > 0 && (
          <div className="space-y-2 border-t pt-4">
            <p className="text-sm font-medium">Linked accounts</p>
            <p className="text-xs text-muted-foreground">
              Stream through a cloud account instead of an API key.
            </p>
            {accounts.map((a) => (
              <div key={a.id} className="flex items-center gap-2 rounded-lg border px-3 py-2">
                <span className="text-sm">{a.name}</span>
                {a.linked && <Badge variant="secondary">Linked</Badge>}
                <Button
                  variant={a.linked ? "ghost" : "outline"}
                  size="sm"
                  className="ml-auto"
                  disabled={busy === a.id}
                  onClick={() => void (a.linked ? unlink(a.id) : link(a.id))}
                >
                  {a.linked ? "Unlink" : "Link"}
                </Button>
              </div>
            ))}
          </div>
        )}

        {Object.keys(checks).length > 0 && (
          <p className="text-sm text-muted-foreground" role="status">
            Saved. The flagged members will fail until you fix them.
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {Object.keys(checks).length > 0 ? "Close" : "Cancel"}
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            Save council
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("grid gap-1", className)}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

// ── Per-thread steering ──────────────────────────────────────────────────────

interface Rule {
  id: string;
  pattern: string;
}
interface Domain {
  id: string;
  name: string;
  description: string;
}

function ThreadOptions({
  threadId,
  open,
  onOpenChange,
}: {
  threadId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [draft, setDraft] = useState("");
  const [domains, setDomains] = useState<Domain[]>([]);
  const [domain, setDomain] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    void fetch(`/api/negation/${threadId}`)
      .then((r) => (r.ok ? r.json() : { rules: [] }))
      .then((d: { rules?: Rule[] }) => setRules(d.rules ?? []));
    void fetch("/api/specialisation/domains")
      .then((r) => (r.ok ? r.json() : { domains: [] }))
      .then((d: { domains?: Domain[] }) => setDomains(d.domains ?? []));
    void fetch(`/api/specialisation/thread/${threadId}`)
      .then((r) => (r.ok ? r.json() : { domain: null }))
      .then((d: { domain?: string | null }) => setDomain(d.domain ?? null));
  }, [open, threadId]);

  const addRule = async () => {
    const pattern = draft.trim();
    if (!pattern) return;
    const res = await fetch("/api/negation/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ convId: threadId, patterns: [{ pattern }] }),
    });
    if (res.ok) {
      setRules(((await res.json()) as { rules: Rule[] }).rules);
      setDraft("");
    }
  };

  const removeRule = async (id: string) => {
    await fetch(`/api/negation/${threadId}/${id}`, { method: "DELETE" });
    setRules((prev) => prev.filter((r) => r.id !== id));
  };

  const chooseDomain = async (id: string) => {
    setError(null);
    if (!id) {
      await fetch(`/api/specialisation/thread/${threadId}`, { method: "DELETE" });
      setDomain(null);
      return;
    }
    const res = await fetch("/api/specialisation/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: id, sessionId: threadId }),
    });
    if (res.ok) setDomain(id);
    else
      setError(((await res.json()) as { error?: string }).error ?? "Could not apply the domain.");
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Steer this deliberation</SheetTitle>
        </SheetHeader>
        <div className="space-y-8 px-4 pb-6">
          <section className="space-y-2">
            <h3 className="text-sm font-medium">Domain focus</h3>
            <p className="text-xs text-muted-foreground">
              Every member answers through this lens for the rest of the thread.
            </p>
            <select
              value={domain ?? ""}
              onChange={(e) => void chooseDomain(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="">None</option>
              {domains.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} — {d.description}
                </option>
              ))}
            </select>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-medium">Ruled out</h3>
            <p className="text-xs text-muted-foreground">
              Things the council must not suggest in this thread, like “no paid tools” or “don’t
              change the database”.
            </p>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void addRule();
              }}
            >
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Don’t recommend…"
                aria-label="New rule"
              />
              <Button type="submit" variant="secondary" disabled={!draft.trim()}>
                Add
              </Button>
            </form>
            {rules.length === 0 ? (
              <p className="py-2 text-xs text-muted-foreground">No rules yet.</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {rules.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <EyeOff className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="flex-1">{r.pattern}</span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove ${r.pattern}`}
                      onClick={() => void removeRule(r.id)}
                    >
                      <Trash2 />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
