// SPDX-License-Identifier: Apache-2.0
/**
 * Multi-Agent World Simulation — Phase 5.3
 *
 * Build personas and environments, run multi-agent simulations,
 * watch tick-by-tick action logs, and chat with individual agents.
 *
 * Inspired by Generative Agents (Stanford), TinyTroupe (Microsoft), AI Town (a16z).
 *
 * API:
 *   POST   /api/simulate/personas           — create persona
 *   GET    /api/simulate/personas           — list
 *   POST   /api/simulate/personas/:id/chat  — chat with persona
 *   POST   /api/simulate/environments       — create environment
 *   GET    /api/simulate/environments       — list
 *   POST   /api/simulate/runs              — create simulation
 *   GET    /api/simulate/runs              — list runs
 *   POST   /api/simulate/runs/:id/tick     — advance one tick
 *   GET    /api/simulate/runs/:id/transcript — full transcript
 *   POST   /api/simulate/runs/:id/reset    — reset
 */
import { useState, useCallback, useEffect, useRef } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
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
  Users,
  Globe,
  Play,
  SkipForward,
  RotateCcw,
  Plus,
  Loader2,
  RefreshCw,
  MessageSquare,
  ChevronRight,
  Cpu,
  Zap,
  Send,
  Activity,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Persona {
  id: string;
  name: string;
  backstory: string;
  goals: string[];
  traits: string[];
  expertise: string[];
  communicationStyle: string;
  constraints: string[];
  memory: string[];
  createdAt: string;
}

interface SimEnvironment {
  id: string;
  name: string;
  description: string;
  initialState: string;
  rules: string[];
  createdAt: string;
}

interface SimAction {
  personaId: string;
  personaName: string;
  action: string;
  reasoning?: string;
}

interface SimTick {
  tick: number;
  actions: SimAction[];
  worldEvent?: string;
  timestamp: string;
}

interface Simulation {
  id: string;
  name: string;
  environmentId: string;
  personaIds: string[];
  status: "idle" | "running" | "paused" | "completed";
  currentTick: number;
  maxTicks: number;
  tickLog: SimTick[];
  createdAt: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  idle: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  running: "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300",
  paused: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300",
  completed: "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300",
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function Simulation() {
  const [tab, setTab] = useState<"personas" | "environments" | "runs">("runs");

  // Personas
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loadingPersonas, setLoadingPersonas] = useState(false);
  const [showPersonaForm, setShowPersonaForm] = useState(false);
  const [newPersona, setNewPersona] = useState({
    name: "",
    backstory: "",
    goals: "",
    traits: "",
    expertise: "",
    communicationStyle: "",
    constraints: "",
  });
  const [creatingPersona, setCreatingPersona] = useState(false);

  // Environments
  const [environments, setEnvironments] = useState<SimEnvironment[]>([]);
  const [loadingEnvs, setLoadingEnvs] = useState(false);
  const [showEnvForm, setShowEnvForm] = useState(false);
  const [newEnv, setNewEnv] = useState({
    name: "",
    description: "",
    initialState: "",
    rules: "",
  });
  const [creatingEnv, setCreatingEnv] = useState(false);

  // Runs
  const [runs, setRuns] = useState<Simulation[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [selectedRun, setSelectedRun] = useState<Simulation | null>(null);
  const [showRunForm, setShowRunForm] = useState(false);
  const [newRun, setNewRun] = useState({
    name: "",
    environmentId: "",
    personaIds: [] as string[],
    maxTicks: 10,
  });
  const [creatingRun, setCreatingRun] = useState(false);
  const [ticking, setTicking] = useState(false);
  const [autoTicking, setAutoTicking] = useState(false);
  const autoRef = useRef(false);

  // Chat with persona
  const [chatPersona, setChatPersona] = useState<Persona | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);

  const loadPersonas = useCallback(async () => {
    setLoadingPersonas(true);
    try {
      const r = await fetch("/api/simulate/personas");
      if (r.ok) {
        const data = await r.json();
        setPersonas(Array.isArray(data) ? data : (data?.personas ?? data?.items ?? []));
      }
    } catch {}
    setLoadingPersonas(false);
  }, []);

  const loadEnvironments = useCallback(async () => {
    setLoadingEnvs(true);
    try {
      const r = await fetch("/api/simulate/environments");
      if (r.ok) {
        const data = await r.json();
        setEnvironments(Array.isArray(data) ? data : (data?.environments ?? data?.items ?? []));
      }
    } catch {}
    setLoadingEnvs(false);
  }, []);

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    try {
      const r = await fetch("/api/simulate/runs");
      if (r.ok) {
        const data = await r.json();
        setRuns(Array.isArray(data) ? data : (data?.runs ?? data?.items ?? []));
      }
    } catch {}
    setLoadingRuns(false);
  }, []);

  useEffect(() => {
    loadPersonas();
    loadEnvironments();
    loadRuns();
  }, [loadPersonas, loadEnvironments, loadRuns]);

  // Auto-scroll chat
  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [chatMessages]);

  // ── Persona CRUD ──────────────────────────────────────────────────────────

  const createPersona = useCallback(async () => {
    if (!newPersona.name.trim() || !newPersona.backstory.trim()) return;
    setCreatingPersona(true);
    try {
      const r = await fetch("/api/simulate/personas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newPersona.name.trim(),
          backstory: newPersona.backstory.trim(),
          goals: newPersona.goals
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          traits: newPersona.traits
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          expertise: newPersona.expertise
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          communicationStyle: newPersona.communicationStyle.trim() || "neutral",
          constraints: newPersona.constraints
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      });
      if (r.ok) {
        setShowPersonaForm(false);
        setNewPersona({
          name: "",
          backstory: "",
          goals: "",
          traits: "",
          expertise: "",
          communicationStyle: "",
          constraints: "",
        });
        loadPersonas();
      }
    } finally {
      setCreatingPersona(false);
    }
  }, [newPersona, loadPersonas]);

  // ── Environment CRUD ──────────────────────────────────────────────────────

  const createEnvironment = useCallback(async () => {
    if (!newEnv.name.trim()) return;
    setCreatingEnv(true);
    try {
      const r = await fetch("/api/simulate/environments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newEnv.name.trim(),
          description: newEnv.description.trim(),
          initialState: newEnv.initialState.trim(),
          rules: newEnv.rules
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      });
      if (r.ok) {
        setShowEnvForm(false);
        setNewEnv({ name: "", description: "", initialState: "", rules: "" });
        loadEnvironments();
      }
    } finally {
      setCreatingEnv(false);
    }
  }, [newEnv, loadEnvironments]);

  // ── Run CRUD ──────────────────────────────────────────────────────────────

  const createRun = useCallback(async () => {
    if (!newRun.name.trim() || !newRun.environmentId || newRun.personaIds.length === 0) return;
    setCreatingRun(true);
    try {
      const r = await fetch("/api/simulate/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newRun),
      });
      if (r.ok) {
        const data = await r.json();
        setShowRunForm(false);
        setNewRun({ name: "", environmentId: "", personaIds: [], maxTicks: 10 });
        loadRuns();
        setSelectedRun(data.simulation ?? data);
        setTab("runs");
      }
    } finally {
      setCreatingRun(false);
    }
  }, [newRun, loadRuns]);

  const tickSimulation = useCallback(async (sim: Simulation) => {
    if (sim.currentTick >= sim.maxTicks) return;
    setTicking(true);
    try {
      const r = await fetch(`/api/simulate/runs/${sim.id}/tick`, { method: "POST" });
      if (r.ok) {
        const data = await r.json();
        const updated = data.simulation ?? data;
        setSelectedRun(updated);
        setRuns((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      }
    } finally {
      setTicking(false);
    }
  }, []);

  const startAutoTick = useCallback(async (sim: Simulation) => {
    autoRef.current = true;
    setAutoTicking(true);
    let current = sim;
    while (
      autoRef.current &&
      current.currentTick < current.maxTicks &&
      current.status !== "completed"
    ) {
      await new Promise((r) => setTimeout(r, 800));
      if (!autoRef.current) break;
      try {
        const r2 = await fetch(`/api/simulate/runs/${current.id}/tick`, { method: "POST" });
        if (!r2.ok) break;
        const data = await r2.json();
        current = data.simulation ?? data;
        setSelectedRun({ ...current });
        setRuns((prev) => prev.map((s) => (s.id === current.id ? current : s)));
      } catch {
        break;
      }
    }
    autoRef.current = false;
    setAutoTicking(false);
  }, []);

  const resetSimulation = useCallback(async (sim: Simulation) => {
    try {
      const r = await fetch(`/api/simulate/runs/${sim.id}/reset`, { method: "POST" });
      if (r.ok) {
        const data = await r.json();
        const updated = data.simulation ?? data;
        setSelectedRun(updated);
        setRuns((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      }
    } catch {}
  }, []);

  // ── Chat with persona ─────────────────────────────────────────────────────

  const openChat = useCallback((persona: Persona) => {
    setChatPersona(persona);
    setChatMessages([]);
    setChatInput("");
  }, []);

  const sendChat = useCallback(async () => {
    if (!chatPersona || !chatInput.trim()) return;
    const msg = chatInput.trim();
    setChatInput("");
    setChatMessages((prev) => [...prev, { role: "user", content: msg }]);
    setChatSending(true);
    try {
      const r = await fetch(`/api/simulate/personas/${chatPersona.id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...chatMessages, { role: "user", content: msg }],
          simulationId: selectedRun?.id,
        }),
      });
      if (r.ok) {
        const data = await r.json();
        setChatMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.response ?? data.message ?? "" },
        ]);
      }
    } finally {
      setChatSending(false);
    }
  }, [chatPersona, chatInput, chatMessages, selectedRun]);

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Activity className="w-6 h-6 text-emerald-500" />
            Multi-Agent Simulation
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {personas.length} personas · {environments.length} environments · {runs.length} runs
          </p>
        </div>
        <div className="flex gap-2">
          {(["runs", "personas", "environments"] as const).map((t) => (
            <Button
              key={t}
              size="sm"
              variant={tab === t ? "default" : "outline"}
              onClick={() => setTab(t)}
              className="capitalize"
            >
              {t}
            </Button>
          ))}
        </div>
      </div>

      {/* ── Runs Tab ── */}
      {tab === "runs" && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Left: run list */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-muted-foreground">Simulations</p>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" onClick={loadRuns}>
                  <RefreshCw className={`w-3 h-3 ${loadingRuns ? "animate-spin" : ""}`} />
                </Button>
                <Button size="sm" onClick={() => setShowRunForm(true)}>
                  <Plus className="w-3 h-3 mr-1" />
                  New
                </Button>
              </div>
            </div>

            {runs.length === 0 && !loadingRuns && (
              <Card>
                <CardContent className="pt-6 pb-6 text-center space-y-3">
                  <Cpu className="w-10 h-10 mx-auto opacity-40 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">No simulations yet</p>
                  <Button size="sm" onClick={() => setShowRunForm(true)}>
                    Create first run
                  </Button>
                </CardContent>
              </Card>
            )}

            {runs.map((run) => (
              <Card
                key={run.id}
                className={`cursor-pointer hover:bg-accent/50 transition-colors border-2 ${
                  selectedRun?.id === run.id ? "border-primary" : "border-border"
                }`}
                onClick={() => setSelectedRun(run)}
              >
                <CardContent className="pt-3 pb-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium truncate">{run.name}</span>
                    <Badge className={`text-xs ${STATUS_COLOR[run.status]}`}>{run.status}</Badge>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>{run.personaIds.length} agents</span>
                    <span>
                      tick {run.currentTick}/{run.maxTicks}
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Right: run detail */}
          <div className="lg:col-span-2">
            {!selectedRun ? (
              <Card className="h-64 flex items-center justify-center">
                <p className="text-muted-foreground text-sm">Select a simulation to view</p>
              </Card>
            ) : (
              <div className="space-y-4">
                {/* Control bar */}
                <Card>
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="flex-1">
                        <p className="text-base font-semibold">{selectedRun.name}</p>
                        <p className="text-xs text-muted-foreground">
                          Tick {selectedRun.currentTick} / {selectedRun.maxTicks} ·{" "}
                          {selectedRun.personaIds.length} agents
                        </p>
                      </div>
                      <Badge className={`text-xs ${STATUS_COLOR[selectedRun.status]}`}>
                        {selectedRun.status}
                      </Badge>

                      {!autoTicking ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => tickSimulation(selectedRun)}
                            disabled={ticking || selectedRun.currentTick >= selectedRun.maxTicks}
                          >
                            {ticking ? (
                              <Loader2 className="w-3 h-3 animate-spin mr-1" />
                            ) : (
                              <SkipForward className="w-3 h-3 mr-1" />
                            )}
                            Next tick
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => startAutoTick(selectedRun)}
                            disabled={selectedRun.currentTick >= selectedRun.maxTicks}
                          >
                            <Play className="w-3 h-3 mr-1" />
                            Run all
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => {
                            autoRef.current = false;
                          }}
                        >
                          <Loader2 className="w-3 h-3 animate-spin mr-1" />
                          Stop
                        </Button>
                      )}

                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => resetSimulation(selectedRun)}
                        disabled={ticking || autoTicking}
                      >
                        <RotateCcw className="w-3 h-3" />
                      </Button>
                    </div>

                    {/* Progress bar */}
                    <div className="mt-3">
                      <div className="w-full bg-muted rounded-full h-2">
                        <div
                          className="bg-emerald-500 h-2 rounded-full transition-all"
                          style={{
                            width: `${Math.round((selectedRun.currentTick / selectedRun.maxTicks) * 100)}%`,
                          }}
                        />
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Tick log */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Tick Log</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {(selectedRun.tickLog ?? []).length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-4">
                        No ticks yet — press "Next tick" or "Run all" to start
                      </p>
                    ) : (
                      <div className="space-y-3 max-h-96 overflow-y-auto">
                        {[...(selectedRun.tickLog ?? [])].reverse().map((tick) => (
                          <div key={tick.tick} className="border-l-2 border-emerald-400 pl-3">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-xs font-bold text-emerald-600 dark:text-emerald-400">
                                Tick {tick.tick}
                              </span>
                              {tick.worldEvent && (
                                <Badge variant="outline" className="text-xs">
                                  🌍 {tick.worldEvent}
                                </Badge>
                              )}
                            </div>
                            <div className="space-y-1">
                              {tick.actions.map((action, i) => (
                                <div key={i} className="text-xs space-y-0.5">
                                  <span className="font-medium text-foreground">
                                    {action.personaName}:
                                  </span>{" "}
                                  <span className="text-muted-foreground">{action.action}</span>
                                  {action.reasoning && (
                                    <p className="text-xs text-muted-foreground/60 italic pl-2">
                                      ({action.reasoning})
                                    </p>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Personas Tab ── */}
      {tab === "personas" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">{personas.length} personas</p>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={loadPersonas}>
                <RefreshCw className={`w-3 h-3 ${loadingPersonas ? "animate-spin" : ""}`} />
              </Button>
              <Button size="sm" onClick={() => setShowPersonaForm(true)}>
                <Plus className="w-3 h-3 mr-1" />
                New persona
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {personas.map((p) => (
              <Card key={p.id} className="hover:shadow-md transition-shadow">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm">{p.name}</CardTitle>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => openChat(p)}
                    >
                      <MessageSquare className="w-3 h-3 mr-1" />
                      Chat
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="text-xs text-muted-foreground line-clamp-2">{p.backstory}</p>
                  {p.traits.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {p.traits.slice(0, 4).map((t) => (
                        <Badge key={t} variant="secondary" className="text-xs font-normal">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {p.goals.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">Goals:</span>{" "}
                      {p.goals.slice(0, 2).join(", ")}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>

          {personas.length === 0 && !loadingPersonas && (
            <Card>
              <CardContent className="pt-8 pb-8 text-center space-y-3">
                <Users className="w-12 h-12 mx-auto opacity-40 text-muted-foreground" />
                <p className="text-muted-foreground">No personas yet</p>
                <Button size="sm" onClick={() => setShowPersonaForm(true)}>
                  Create first persona
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ── Environments Tab ── */}
      {tab === "environments" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">{environments.length} environments</p>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={loadEnvironments}>
                <RefreshCw className={`w-3 h-3 ${loadingEnvs ? "animate-spin" : ""}`} />
              </Button>
              <Button size="sm" onClick={() => setShowEnvForm(true)}>
                <Plus className="w-3 h-3 mr-1" />
                New environment
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {environments.map((e) => (
              <Card key={e.id}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Globe className="w-4 h-4 text-blue-500" />
                    {e.name}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="text-xs text-muted-foreground">{e.description}</p>
                  {e.initialState && (
                    <p className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">Initial state:</span>{" "}
                      {e.initialState}
                    </p>
                  )}
                  {e.rules.length > 0 && (
                    <div>
                      <p className="text-xs font-medium">Rules:</p>
                      <ul className="list-disc list-inside space-y-0.5">
                        {e.rules.slice(0, 3).map((r, i) => (
                          <li key={i} className="text-xs text-muted-foreground">
                            {r}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>

          {environments.length === 0 && !loadingEnvs && (
            <Card>
              <CardContent className="pt-8 pb-8 text-center space-y-3">
                <Globe className="w-12 h-12 mx-auto opacity-40 text-muted-foreground" />
                <p className="text-muted-foreground">No environments yet</p>
                <Button size="sm" onClick={() => setShowEnvForm(true)}>
                  Create first environment
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ── Dialogs ── */}

      {/* Create Persona */}
      <Dialog open={showPersonaForm} onOpenChange={setShowPersonaForm}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New Persona</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="Name *"
              value={newPersona.name}
              onChange={(e) => setNewPersona((p) => ({ ...p, name: e.target.value }))}
            />
            <Textarea
              placeholder="Backstory *"
              rows={3}
              value={newPersona.backstory}
              onChange={(e) => setNewPersona((p) => ({ ...p, backstory: e.target.value }))}
              className="resize-none"
            />
            <Input
              placeholder="Goals (comma-separated)"
              value={newPersona.goals}
              onChange={(e) => setNewPersona((p) => ({ ...p, goals: e.target.value }))}
            />
            <Input
              placeholder="Traits (comma-separated)"
              value={newPersona.traits}
              onChange={(e) => setNewPersona((p) => ({ ...p, traits: e.target.value }))}
            />
            <Input
              placeholder="Expertise (comma-separated)"
              value={newPersona.expertise}
              onChange={(e) => setNewPersona((p) => ({ ...p, expertise: e.target.value }))}
            />
            <Input
              placeholder="Communication style"
              value={newPersona.communicationStyle}
              onChange={(e) => setNewPersona((p) => ({ ...p, communicationStyle: e.target.value }))}
            />
            <Input
              placeholder="Constraints (comma-separated)"
              value={newPersona.constraints}
              onChange={(e) => setNewPersona((p) => ({ ...p, constraints: e.target.value }))}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPersonaForm(false)}>
              Cancel
            </Button>
            <Button
              onClick={createPersona}
              disabled={creatingPersona || !newPersona.name || !newPersona.backstory}
            >
              {creatingPersona ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Environment */}
      <Dialog open={showEnvForm} onOpenChange={setShowEnvForm}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New Environment</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="Name *"
              value={newEnv.name}
              onChange={(e) => setNewEnv((v) => ({ ...v, name: e.target.value }))}
            />
            <Textarea
              placeholder="Description"
              rows={2}
              value={newEnv.description}
              onChange={(e) => setNewEnv((v) => ({ ...v, description: e.target.value }))}
              className="resize-none"
            />
            <Textarea
              placeholder="Initial world state (paragraph)"
              rows={2}
              value={newEnv.initialState}
              onChange={(e) => setNewEnv((v) => ({ ...v, initialState: e.target.value }))}
              className="resize-none"
            />
            <Textarea
              placeholder="Rules (one per line)"
              rows={3}
              value={newEnv.rules}
              onChange={(e) => setNewEnv((v) => ({ ...v, rules: e.target.value }))}
              className="resize-none font-mono text-sm"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEnvForm(false)}>
              Cancel
            </Button>
            <Button onClick={createEnvironment} disabled={creatingEnv || !newEnv.name}>
              {creatingEnv ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Run */}
      <Dialog open={showRunForm} onOpenChange={setShowRunForm}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New Simulation Run</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="Run name *"
              value={newRun.name}
              onChange={(e) => setNewRun((r) => ({ ...r, name: e.target.value }))}
            />
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Environment *</label>
              <select
                className="w-full border rounded-md p-2 text-sm bg-background"
                value={newRun.environmentId}
                onChange={(e) => setNewRun((r) => ({ ...r, environmentId: e.target.value }))}
              >
                <option value="">Select environment…</option>
                {environments.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Personas * (select multiple)</label>
              <div className="border rounded-md p-2 max-h-36 overflow-y-auto space-y-1">
                {personas.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newRun.personaIds.includes(p.id)}
                      onChange={(e) => {
                        setNewRun((r) => ({
                          ...r,
                          personaIds: e.target.checked
                            ? [...r.personaIds, p.id]
                            : r.personaIds.filter((id) => id !== p.id),
                        }));
                      }}
                    />
                    <span className="text-sm">{p.name}</span>
                  </label>
                ))}
                {personas.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No personas yet — create some first
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <label className="text-sm shrink-0">Max ticks:</label>
              <input
                type="number"
                className="border rounded-md p-1.5 text-sm w-20 bg-background"
                min={1}
                max={50}
                value={newRun.maxTicks}
                onChange={(e) =>
                  setNewRun((r) => ({ ...r, maxTicks: parseInt(e.target.value) || 10 }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRunForm(false)}>
              Cancel
            </Button>
            <Button
              onClick={createRun}
              disabled={
                creatingRun ||
                !newRun.name ||
                !newRun.environmentId ||
                newRun.personaIds.length === 0
              }
            >
              {creatingRun ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Create simulation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Chat with persona */}
      <Dialog
        open={!!chatPersona}
        onOpenChange={(open) => {
          if (!open) setChatPersona(null);
        }}
      >
        <DialogContent className="max-w-lg h-[550px] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4" />
              Chat with {chatPersona?.name}
            </DialogTitle>
          </DialogHeader>
          <div ref={chatRef} className="flex-1 overflow-y-auto space-y-3 py-2 px-1">
            {chatMessages.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-4">
                Start chatting — {chatPersona?.name} will stay in character
              </p>
            )}
            {chatMessages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[80%] rounded-lg p-2.5 text-sm ${
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-foreground"
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}
            {chatSending && (
              <div className="flex justify-start">
                <div className="bg-muted rounded-lg p-2.5 text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {chatPersona?.name} is thinking…
                </div>
              </div>
            )}
          </div>
          <div className="flex gap-2 pt-2 border-t">
            <Input
              placeholder={`Message ${chatPersona?.name}…`}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendChat();
                }
              }}
              disabled={chatSending}
            />
            <Button size="icon" onClick={sendChat} disabled={chatSending || !chatInput.trim()}>
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
