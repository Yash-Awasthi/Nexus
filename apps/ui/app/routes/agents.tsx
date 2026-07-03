// SPDX-License-Identifier: Apache-2.0
/**
 * Agents Hub — Phase 4.13 / 4.15
 *
 * Browser Agent: LLM-driven web automation (navigate, click, extract).
 * Reactive Agents: Event-driven rules that trigger agent actions on system events.
 *
 * Browser Agent API:
 *   POST /api/browser-agent/tasks                      — create task
 *   GET  /api/browser-agent/sessions                   — list sessions
 *   GET  /api/browser-agent/sessions/:id               — session detail
 *   POST /api/browser-agent/sessions/:id/action        — manual action step
 *
 * Reactive Agents API:
 *   POST /api/reactions      — create reaction rule
 *   GET  /api/reactions      — list rules
 *   PATCH /api/reactions/:id — update rule
 *   DELETE /api/reactions/:id — delete rule
 *   POST /api/reactions/emit  — emit test event
 *   GET  /api/reactions/events — recent event log
 */
import { useState, useEffect, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "~/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Globe,
  Bot,
  Zap,
  Plus,
  Loader2,
  RefreshCw,
  Play,
  CheckCircle,
  XCircle,
  Clock,
  Trash2,
  ChevronRight,
  MousePointer,
  Eye,
  Type,
  ArrowRight,
  AlertTriangle,
  Radio,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface BrowserTask {
  sessionId: string;
  task: string;
  url?: string;
  status: "pending" | "running" | "completed" | "error";
  steps: BrowserStep[];
  result?: string;
  screenshot?: string;
  error?: string;
  createdAt: string;
}

interface BrowserStep {
  action: string;
  target?: string;
  value?: string;
  description: string;
  success: boolean;
}

interface ReactionRule {
  id: string;
  eventPattern: string;
  handlerType: string;
  handlerConfig: Record<string, unknown>;
  enabled: boolean;
  lastTriggered?: string;
  triggerCount: number;
  createdAt: string;
}

interface ReactionEvent {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  matchedRules: string[];
  timestamp: string;
}

// ─── Event types ──────────────────────────────────────────────────────────────

const EVENT_TYPES = [
  "message.created",
  "task.created",
  "task.completed",
  "kb.document.added",
  "research.completed",
  "workflow.run.started",
  "workflow.run.completed",
  "user.login",
  "connector.sync.completed",
];

const HANDLER_TYPES = ["notify", "send_email", "webhook", "run_workflow", "summarize", "tag"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(d: string) {
  const diff = Date.now() - new Date(d).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

const STATUS_ICON: Record<string, React.ReactNode> = {
  pending: <Clock className="w-3 h-3 text-yellow-500" />,
  running: <Loader2 className="w-3 h-3 text-blue-500 animate-spin" />,
  completed: <CheckCircle className="w-3 h-3 text-green-500" />,
  error: <XCircle className="w-3 h-3 text-red-500" />,
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function Agents() {
  const [tab, setTab] = useState<"browser" | "reactive">("browser");

  // Browser Agent
  const [browserSessions, setBrowserSessions] = useState<BrowserTask[]>([]);
  const [selectedSession, setSelectedSession] = useState<BrowserTask | null>(null);
  const [showBrowserForm, setShowBrowserForm] = useState(false);
  const [newTask, setNewTask] = useState({ task: "", url: "" });
  const [creatingTask, setCreatingTask] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);

  // Reactive Agents
  const [reactions, setReactions] = useState<ReactionRule[]>([]);
  const [reactionEvents, setReactionEvents] = useState<ReactionEvent[]>([]);
  const [showReactionForm, setShowReactionForm] = useState(false);
  const [newReaction, setNewReaction] = useState({
    eventPattern: "message.created",
    handlerType: "notify",
    handlerConfig: "{}",
  });
  const [creatingReaction, setCreatingReaction] = useState(false);
  const [emitting, setEmitting] = useState(false);
  const [testEvent, setTestEvent] = useState("message.created");

  const [err, setErr] = useState("");

  const loadBrowserSessions = useCallback(async () => {
    setLoadingSessions(true);
    try {
      const r = await fetch("/api/browser-agent/sessions");
      if (r.ok) setBrowserSessions(await r.json());
    } catch {}
    setLoadingSessions(false);
  }, []);

  const loadReactions = useCallback(async () => {
    try {
      const r = await fetch("/api/reactions");
      if (r.ok) setReactions(await r.json());
    } catch {}
  }, []);

  const loadReactionEvents = useCallback(async () => {
    try {
      const r = await fetch("/api/reactions/events");
      if (r.ok) setReactionEvents(await r.json());
    } catch {}
  }, []);

  useEffect(() => {
    loadBrowserSessions();
    loadReactions();
    loadReactionEvents();
  }, [loadBrowserSessions, loadReactions, loadReactionEvents]);

  // ── Browser Agent ────────────────────────────────────────────────────────

  const createBrowserTask = useCallback(async () => {
    if (!newTask.task.trim()) return;
    setCreatingTask(true);
    setErr("");
    try {
      const r = await fetch("/api/browser-agent/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: newTask.task.trim(),
          startUrl: newTask.url.trim() || undefined,
        }),
      });
      if (!r.ok) {
        const d = await r.json();
        setErr(d.error ?? "Create failed");
        return;
      }
      const data = await r.json();
      const session: BrowserTask = data.session ?? data;
      setBrowserSessions((prev) => [session, ...prev]);
      setSelectedSession(session);
      setShowBrowserForm(false);
      setNewTask({ task: "", url: "" });
    } catch {
      setErr("Create failed");
    } finally {
      setCreatingTask(false);
    }
  }, [newTask]);

  const loadSession = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/browser-agent/sessions/${id}`);
      if (r.ok) {
        const data = await r.json();
        setSelectedSession(data);
        setBrowserSessions((prev) => prev.map((s) => (s.sessionId === id ? data : s)));
      }
    } catch {}
  }, []);

  // ── Reactive Agents ──────────────────────────────────────────────────────

  const createReaction = useCallback(async () => {
    setCreatingReaction(true);
    setErr("");
    try {
      let config = {};
      try {
        config = JSON.parse(newReaction.handlerConfig);
      } catch {}
      const r = await fetch("/api/reactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventPattern: newReaction.eventPattern,
          handlerType: newReaction.handlerType,
          handlerConfig: config,
        }),
      });
      if (!r.ok) {
        const d = await r.json();
        setErr(d.error ?? "Create failed");
        return;
      }
      setShowReactionForm(false);
      setNewReaction({
        eventPattern: "message.created",
        handlerType: "notify",
        handlerConfig: "{}",
      });
      loadReactions();
    } catch {
      setErr("Create failed");
    } finally {
      setCreatingReaction(false);
    }
  }, [newReaction, loadReactions]);

  const toggleReaction = useCallback(async (rule: ReactionRule) => {
    try {
      await fetch(`/api/reactions/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      setReactions((prev) =>
        prev.map((r) => (r.id === rule.id ? { ...r, enabled: !rule.enabled } : r)),
      );
    } catch {}
  }, []);

  const deleteReaction = useCallback(async (id: string) => {
    try {
      await fetch(`/api/reactions/${id}`, { method: "DELETE" });
      setReactions((prev) => prev.filter((r) => r.id !== id));
    } catch {}
  }, []);

  const emitTestEvent = useCallback(async () => {
    setEmitting(true);
    try {
      await fetch("/api/reactions/emit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventType: testEvent,
          payload: { test: true, timestamp: Date.now() },
        }),
      });
      setTimeout(() => {
        loadReactionEvents();
        loadReactions();
      }, 1000);
    } finally {
      setEmitting(false);
    }
  }, [testEvent, loadReactionEvents, loadReactions]);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Bot className="w-6 h-6 text-purple-500" />
            Agents
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Browser automation and reactive event-driven rules
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={tab === "browser" ? "default" : "outline"}
            onClick={() => setTab("browser")}
          >
            <Globe className="w-3 h-3 mr-1" />
            Browser Agent
          </Button>
          <Button
            size="sm"
            variant={tab === "reactive" ? "default" : "outline"}
            onClick={() => setTab("reactive")}
          >
            <Zap className="w-3 h-3 mr-1" />
            Reactive Rules
          </Button>
        </div>
      </div>

      {err && <p className="text-red-500 text-sm">{err}</p>}

      {/* ── Browser Agent Tab ── */}
      {tab === "browser" && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Task list */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-muted-foreground">Tasks</p>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" onClick={loadBrowserSessions}>
                  <RefreshCw className={`w-3 h-3 ${loadingSessions ? "animate-spin" : ""}`} />
                </Button>
                <Button size="sm" onClick={() => setShowBrowserForm(true)}>
                  <Plus className="w-3 h-3 mr-1" />
                  New
                </Button>
              </div>
            </div>

            {browserSessions.length === 0 ? (
              <Card>
                <CardContent className="pt-6 pb-6 text-center space-y-3">
                  <Globe className="w-10 h-10 mx-auto opacity-40 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">No tasks yet</p>
                  <Button size="sm" onClick={() => setShowBrowserForm(true)}>
                    Create task
                  </Button>
                </CardContent>
              </Card>
            ) : (
              browserSessions.map((s) => (
                <Card
                  key={s.sessionId}
                  className={`cursor-pointer hover:bg-accent/50 transition-colors ${
                    selectedSession?.sessionId === s.sessionId ? "border-primary" : ""
                  }`}
                  onClick={() => {
                    setSelectedSession(s);
                    loadSession(s.sessionId);
                  }}
                >
                  <CardContent className="pt-3 pb-3">
                    <div className="flex items-center gap-2">
                      {STATUS_ICON[s.status] ?? <Clock className="w-3 h-3" />}
                      <p className="text-xs flex-1 line-clamp-2">{s.task}</p>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {s.steps.length} steps · {timeAgo(s.createdAt)}
                    </p>
                  </CardContent>
                </Card>
              ))
            )}
          </div>

          {/* Task detail */}
          <div className="lg:col-span-2">
            {!selectedSession ? (
              <Card className="h-64 flex items-center justify-center">
                <div className="text-center text-muted-foreground">
                  <MousePointer className="w-10 h-10 mx-auto mb-2 opacity-40" />
                  <p className="text-sm">Select a task to view its steps</p>
                </div>
              </Card>
            ) : (
              <div className="space-y-3">
                <Card>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle className="text-sm">{selectedSession.task}</CardTitle>
                        {selectedSession.url && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {selectedSession.url}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge
                          className={
                            selectedSession.status === "completed"
                              ? "bg-green-100 text-green-700"
                              : selectedSession.status === "error"
                                ? "bg-red-100 text-red-700"
                                : selectedSession.status === "running"
                                  ? "bg-blue-100 text-blue-700"
                                  : "bg-slate-100 text-slate-600"
                          }
                        >
                          {selectedSession.status}
                        </Badge>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => loadSession(selectedSession.sessionId)}
                        >
                          <RefreshCw className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {selectedSession.steps.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-4">No steps yet</p>
                    ) : (
                      <div className="space-y-1 max-h-48 overflow-y-auto">
                        {selectedSession.steps.map((step, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            {step.success ? (
                              <CheckCircle className="w-3 h-3 text-green-500 shrink-0" />
                            ) : (
                              <XCircle className="w-3 h-3 text-red-500 shrink-0" />
                            )}
                            <span className="text-muted-foreground">{step.description}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {selectedSession.result && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <CheckCircle className="w-4 h-4 text-green-500" />
                        Result
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                        {selectedSession.result}
                      </p>
                    </CardContent>
                  </Card>
                )}

                {selectedSession.error && (
                  <Card className="border-red-200 bg-red-50/30">
                    <CardContent className="pt-3">
                      <p className="text-sm text-red-600">{selectedSession.error}</p>
                    </CardContent>
                  </Card>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Reactive Rules Tab ── */}
      {tab === "reactive" && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Rules */}
          <div className="lg:col-span-2 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">{reactions.length} rules</p>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={loadReactions}>
                  <RefreshCw className="w-3 h-3" />
                </Button>
                <Button size="sm" onClick={() => setShowReactionForm(true)}>
                  <Plus className="w-3 h-3 mr-1" />
                  New rule
                </Button>
              </div>
            </div>

            {reactions.length === 0 ? (
              <Card>
                <CardContent className="pt-8 pb-8 text-center space-y-3">
                  <Zap className="w-10 h-10 mx-auto opacity-40 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">No rules yet</p>
                  <p className="text-xs text-muted-foreground">
                    Reactive rules fire agent actions automatically when system events occur
                  </p>
                  <Button size="sm" onClick={() => setShowReactionForm(true)}>
                    Create first rule
                  </Button>
                </CardContent>
              </Card>
            ) : (
              reactions.map((rule) => (
                <Card key={rule.id} className={!rule.enabled ? "opacity-60" : ""}>
                  <CardContent className="pt-3 pb-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <Badge variant="outline" className="text-xs font-mono">
                            {rule.eventPattern}
                          </Badge>
                          <ArrowRight className="w-3 h-3 text-muted-foreground" />
                          <Badge className="text-xs capitalize">{rule.handlerType}</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Triggered {rule.triggerCount} time{rule.triggerCount !== 1 ? "s" : ""}
                          {rule.lastTriggered && ` · last ${timeAgo(rule.lastTriggered)}`}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          size="sm"
                          variant="ghost"
                          className={`h-7 text-xs ${rule.enabled ? "text-green-600" : "text-muted-foreground"}`}
                          onClick={() => toggleReaction(rule)}
                        >
                          {rule.enabled ? "Enabled" : "Disabled"}
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-red-500 hover:bg-red-50"
                          onClick={() => deleteReaction(rule.id)}
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>

          {/* Event log + test */}
          <div className="space-y-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Radio className="w-4 h-4" />
                  Test event
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Select value={testEvent} onValueChange={setTestEvent}>
                  <SelectTrigger className="text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EVENT_TYPES.map((e) => (
                      <SelectItem key={e} value={e} className="text-xs font-mono">
                        {e}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" className="w-full" onClick={emitTestEvent} disabled={emitting}>
                  {emitting ? (
                    <Loader2 className="w-3 h-3 animate-spin mr-1" />
                  ) : (
                    <Play className="w-3 h-3 mr-1" />
                  )}
                  Emit event
                </Button>
              </CardContent>
            </Card>

            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Event log
                </p>
                <Button variant="ghost" size="sm" className="h-6" onClick={loadReactionEvents}>
                  <RefreshCw className="w-3 h-3" />
                </Button>
              </div>
              <div className="space-y-1 max-h-60 overflow-y-auto">
                {reactionEvents.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-3">No events yet</p>
                ) : (
                  reactionEvents.slice(0, 20).map((ev) => (
                    <div key={ev.id} className="text-xs border rounded-md p-2">
                      <div className="flex items-center justify-between">
                        <span className="font-mono">{ev.eventType}</span>
                        <span className="text-muted-foreground">{timeAgo(ev.timestamp)}</span>
                      </div>
                      {ev.matchedRules.length > 0 && (
                        <p className="text-muted-foreground mt-0.5">
                          Matched {ev.matchedRules.length} rule
                          {ev.matchedRules.length > 1 ? "s" : ""}
                        </p>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create browser task dialog */}
      <Dialog open={showBrowserForm} onOpenChange={setShowBrowserForm}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Globe className="w-4 h-4" />
              New Browser Task
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Textarea
              placeholder="Describe the task, e.g. Go to news.ycombinator.com and extract the top 5 story titles"
              value={newTask.task}
              onChange={(e) => setNewTask((t) => ({ ...t, task: e.target.value }))}
              rows={3}
              className="resize-none"
            />
            <Input
              placeholder="Starting URL (optional)"
              value={newTask.url}
              onChange={(e) => setNewTask((t) => ({ ...t, url: e.target.value }))}
            />
            <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-2 text-xs text-amber-700 dark:text-amber-400 flex items-start gap-2">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
              Requires Playwright + Chromium in the runtime environment
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBrowserForm(false)}>
              Cancel
            </Button>
            <Button onClick={createBrowserTask} disabled={creatingTask || !newTask.task.trim()}>
              {creatingTask ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <Play className="w-4 h-4 mr-2" />
              )}
              Start task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create reaction rule dialog */}
      <Dialog open={showReactionForm} onOpenChange={setShowReactionForm}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Zap className="w-4 h-4" />
              New Reaction Rule
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">When this event fires…</label>
              <Select
                value={newReaction.eventPattern}
                onValueChange={(v) => setNewReaction((r) => ({ ...r, eventPattern: v }))}
              >
                <SelectTrigger className="font-mono text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EVENT_TYPES.map((e) => (
                    <SelectItem key={e} value={e} className="font-mono text-xs">
                      {e}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Run this handler…</label>
              <Select
                value={newReaction.handlerType}
                onValueChange={(v) => setNewReaction((r) => ({ ...r, handlerType: v }))}
              >
                <SelectTrigger className="capitalize">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HANDLER_TYPES.map((h) => (
                    <SelectItem key={h} value={h} className="capitalize">
                      {h}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Handler config (JSON)</label>
              <Textarea
                value={newReaction.handlerConfig}
                onChange={(e) => setNewReaction((r) => ({ ...r, handlerConfig: e.target.value }))}
                rows={3}
                className="font-mono text-xs resize-none"
                placeholder='{"message": "New event triggered!"}'
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowReactionForm(false)}>
              Cancel
            </Button>
            <Button onClick={createReaction} disabled={creatingReaction}>
              {creatingReaction ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Create rule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
