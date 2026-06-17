/**
 * Chat Detail — /chat/:id
 *
 * Loads a specific conversation thread by ID.
 * Messages come from GET /api/threads/:id/messages.
 * Metadata (title, mode) falls back to localStorage.
 * Supports sending follow-up messages via the deliberation SSE stream.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, Link } from "react-router";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { useAuth } from "~/context/AuthContext";
import {
  MessageSquare,
  Send,
  Plus,
  CheckCircle,
  Sparkles,
  Loader2,
  ArrowLeft,
  RefreshCw,
  ChevronRight,
} from "lucide-react";
import { deliberate, createThread, onOpinion, onVerdict, onDone } from "~/lib/deliberate";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StoredConv {
  id: string;
  title: string;
  date: string;
  mode: string;
}

interface Message {
  id: string;
  role: "user" | "archetype" | "verdict" | "system";
  name?: string;
  icon?: string;
  color?: string;
  badgeColor?: string;
  confidence?: number;
  content: string;
  createdAt?: string;
}

// ─── Archetype display config ─────────────────────────────────────────────────

const ARCHETYPE_COLORS: Array<{ color: string; badgeColor: string; icon: string }> = [
  { color: "bg-blue-500/20 text-blue-400",     badgeColor: "border-blue-500/30",   icon: "🏗️" },
  { color: "bg-amber-500/20 text-amber-400",   badgeColor: "border-amber-500/30",  icon: "⚡" },
  { color: "bg-purple-500/20 text-purple-400", badgeColor: "border-purple-500/30", icon: "⚖️" },
  { color: "bg-green-500/20 text-green-400",   badgeColor: "border-green-500/30",  icon: "🔬" },
  { color: "bg-red-500/20 text-red-400",       badgeColor: "border-red-500/30",    icon: "🎯" },
];

function colorForArchetype(name: string, index: number) {
  const i = index % ARCHETYPE_COLORS.length;
  return ARCHETYPE_COLORS[i];
}

// Map raw API message to our Message shape
function mapMessage(raw: any, index: number): Message {
  const role: Message["role"] =
    raw.role === "user" || raw.type === "user" ? "user"
    : raw.role === "verdict" || raw.type === "verdict" ? "verdict"
    : raw.role === "system" ? "system"
    : "archetype";
  const name = raw.name ?? raw.archetypeName ?? raw.author ?? undefined;
  const cfg = name ? colorForArchetype(name, index) : ARCHETYPE_COLORS[index % ARCHETYPE_COLORS.length];
  return {
    id:         String(raw.id ?? `msg-${index}`),
    role,
    name,
    icon:       raw.icon ?? (role === "archetype" ? cfg.icon : undefined),
    color:      raw.color ?? (role === "archetype" ? cfg.color : undefined),
    badgeColor: raw.badgeColor ?? (role === "archetype" ? cfg.badgeColor : undefined),
    confidence: raw.confidence ?? raw.score ?? undefined,
    content:    raw.content ?? raw.text ?? raw.body ?? "",
    createdAt:  raw.createdAt ?? raw.created_at ?? undefined,
  };
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ChatDetailPage() {
  const { id }   = useParams<{ id: string }>();
  const { user } = useAuth();

  const [conversations, setConversations] = useState<StoredConv[]>([]);
  const [messages,      setMessages]      = useState<Message[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [sending,       setSending]       = useState(false);
  const [inputValue,    setInputValue]    = useState("");
  const [threadId,      setThreadId]      = useState<string | null>(null);
  const [error,         setError]         = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const currentConv = conversations.find((c) => c.id === id);

  // ── Load sidebar conversations from localStorage ───────────────────────────
  useEffect(() => {
    if (!user?.id) return;
    try {
      const raw = localStorage.getItem(`judica-chats-${user.id}`);
      const all: StoredConv[] = raw ? JSON.parse(raw) : [];
      setConversations(all);
    } catch { setConversations([]); }
  }, [user?.id]);

  // ── Load thread messages from API ─────────────────────────────────────────
  const loadMessages = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/threads/${id}/messages`);
      if (res.ok) {
        const data = await res.json();
        const raw: any[] = Array.isArray(data) ? data : (data?.messages ?? data?.data ?? []);
        setMessages(raw.map(mapMessage));
        setThreadId(id);
      } else if (res.status === 404) {
        setMessages([]);
        setThreadId(id);
      } else {
        throw new Error(`${res.status}`);
      }
    } catch {
      setError("Could not load conversation messages.");
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { loadMessages(); }, [loadMessages]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Send follow-up message ─────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || sending) return;
    setInputValue("");
    setSending(true);

    const userMsg: Message = {
      id: "opt-" + Date.now(),
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    let opIdx = 0;
    try {
      const tid = threadId ?? await createThread();
      if (!threadId) setThreadId(tid);

      await new Promise<void>((resolve, reject) => {
        const unsubO = onOpinion((data) => {
          const msg: Message = {
            id: "opinion-" + opIdx,
            role: "archetype",
            name: data.archetype ?? data.name ?? "Archetype",
            content: data.text ?? "",
            ...colorForArchetype(data.archetype ?? "", opIdx),
            confidence: data.confidence,
          };
          opIdx++;
          setMessages((prev) => {
            const existing = prev.findIndex((m) => m.id === msg.id);
            if (existing >= 0) return prev.map((m) => m.id === msg.id ? msg : m);
            return [...prev, msg];
          });
        });

        const unsubV = onVerdict((data) => {
          const verdict: Message = {
            id: "verdict-" + Date.now(),
            role: "verdict",
            content: data.text ?? "",
          };
          setMessages((prev) => [...prev, verdict]);
        });

        const unsubD = onDone(() => {
          unsubO(); unsubV(); unsubD();
          resolve();
        });

        deliberate({ threadId: tid, message: text, round: 1 }).catch(reject);
      });
    } catch {
      setMessages((prev) => [
        ...prev,
        { id: "err-" + Date.now(), role: "system", content: "Failed to get a response. Please try again." },
      ]);
    } finally {
      setSending(false);
    }
  }, [inputValue, sending, threadId]);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Left sidebar: conversation list */}
      <div className="w-64 border-r border-border flex flex-col shrink-0 bg-card">
        <div className="p-3 border-b border-border space-y-2">
          <Link to="/chat">
            <Button variant="ghost" size="sm" className="w-full gap-2 justify-start">
              <ArrowLeft className="size-3.5" />
              All Deliberations
            </Button>
          </Link>
          <Link to="/chat">
            <Button variant="outline" size="sm" className="w-full gap-2">
              <Plus className="size-3.5" />
              New Deliberation
            </Button>
          </Link>
        </div>
        <div className="flex-1 overflow-y-auto">
          {conversations.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6 px-3">No conversations yet.</p>
          ) : (
            conversations.map((conv) => (
              <Link
                key={conv.id}
                to={`/chat/${conv.id}`}
                className={`block px-3 py-2.5 border-b border-border/50 transition-colors hover:bg-muted/50 ${conv.id === id ? "bg-muted" : ""}`}
              >
                <div className="flex items-start gap-2">
                  <MessageSquare className="size-3.5 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-medium truncate block">{conv.title}</span>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {conv.mode && (
                        <Badge variant="outline" className="text-[10px] h-3.5 px-1 py-0">{conv.mode}</Badge>
                      )}
                      <span className="text-xs text-muted-foreground">{conv.date}</span>
                    </div>
                  </div>
                  {conv.id === id && (
                    <ChevronRight className="size-3 text-primary shrink-0 mt-1" />
                  )}
                </div>
              </Link>
            ))
          )}
        </div>
      </div>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="border-b border-border px-6 py-3 flex items-center gap-3 shrink-0">
          <h2 className="text-sm font-medium flex-1 truncate">
            {currentConv?.title ?? `Conversation ${id}`}
          </h2>
          {currentConv?.mode && (
            <Badge variant="outline" className="text-[10px] shrink-0">{currentConv.mode}</Badge>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={loadMessages}
            disabled={loading}
            title="Refresh"
          >
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
              <p className="text-sm text-destructive">{error}</p>
              <Button variant="outline" size="sm" onClick={loadMessages}>Try again</Button>
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
              <MessageSquare className="size-10 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">No messages yet. Ask the council something below.</p>
            </div>
          ) : (
            messages.map((msg) => {
              if (msg.role === "user") {
                return (
                  <div key={msg.id} className="flex justify-end">
                    <div className="max-w-[70%] rounded-lg bg-primary px-4 py-2.5 text-primary-foreground text-sm">
                      {msg.content}
                    </div>
                  </div>
                );
              }

              if (msg.role === "verdict") {
                return (
                  <Card key={msg.id} className="border-primary/20 bg-primary/5">
                    <CardContent className="space-y-2 pt-4">
                      <div className="flex items-center gap-2">
                        <CheckCircle className="size-4 text-primary" />
                        <span className="text-sm font-semibold">Council Verdict</span>
                      </div>
                      <div className="text-sm whitespace-pre-line leading-relaxed">{msg.content}</div>
                    </CardContent>
                  </Card>
                );
              }

              if (msg.role === "system") {
                return (
                  <div key={msg.id} className="flex justify-center">
                    <span className="text-xs text-muted-foreground bg-muted px-3 py-1 rounded-full">{msg.content}</span>
                  </div>
                );
              }

              // Archetype message
              return (
                <div key={msg.id} className="space-y-2">
                  <div className="flex items-center gap-2">
                    {msg.icon && <span className="text-base">{msg.icon}</span>}
                    <Badge
                      className={msg.color ?? "bg-muted text-foreground"}
                      style={{ border: `1px solid` }}
                    >
                      {msg.name ?? "Archetype"}
                    </Badge>
                    {msg.confidence !== undefined && (
                      <span className="text-xs text-muted-foreground">
                        {Math.round(msg.confidence * 100)}% confidence
                      </span>
                    )}
                  </div>
                  <div className="ml-7 rounded-lg border border-border bg-card px-4 py-3 text-sm leading-relaxed">
                    {msg.content}
                  </div>
                </div>
              );
            })
          )}

          {sending && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              <span className="text-xs">Council deliberating…</span>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="border-t border-border p-4 shrink-0">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
              <Sparkles className="size-3" />
              <span>{currentConv?.mode ?? "Auto"}</span>
            </div>
            <Input
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) handleSend(); }}
              placeholder="Ask the council a follow-up…"
              className="flex-1"
              disabled={sending}
            />
            <Button size="sm" onClick={handleSend} disabled={!inputValue.trim() || sending}>
              {sending
                ? <Loader2 className="size-3.5 animate-spin" />
                : <Send className="size-3.5" />
              }
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
