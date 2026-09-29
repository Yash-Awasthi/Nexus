// SPDX-License-Identifier: Apache-2.0
import { ProviderIcon, ModelIcon } from "@lobehub/icons";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  useNodesState,
  useEdgesState,
  addEdge,
  type Connection,
} from "@xyflow/react";
import {
  GitBranch,
  Plus,
  CheckCircle,
  XCircle,
  Clock,
  Play,
  ChevronLeft,
  Save,
  MessageSquare,
  Brain,
  BarChart2,
  GitFork,
  Wrench,
  Code2,
  GripVertical,
  Loader2,
  ChevronDown,
  ChevronUp,
  Building2,
} from "lucide-react";
import { useState, useCallback, useEffect } from "react";

import { selectClass } from "~/components/org/AgentDialog";
import { EmptyState, Page, PageHeader } from "~/components/page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { canManage, orgApi, type Agent, type Company } from "~/lib/org";

import "@xyflow/react/dist/style.css";

type WorkflowStatus = "success" | "failed" | "pending" | "idle";

type Workflow = {
  id: string;
  name: string;
  description: string;
  nodeCount: number;
  status: WorkflowStatus;
  lastRun: string;
  steps?: StepDef[];
  graph?: { nodes: Node[]; edges: Edge[] };
  /** Five-field cron the server runs the workflow on; null when unscheduled. */
  schedule?: string | null;
  nextRunAt?: string | null;
};

// No demo/workflow seeds here: the list starts empty and renders whatever the
// API (or a saved localStorage copy) provides. Previously shipped hardcoded
// "Code Review Pipeline" etc. with fabricated run history — clicking one opened
// an empty editor and Run 404'd, because no matching record exists server-side.

const statusConfig = {
  success: { icon: CheckCircle, label: "Success", color: "text-success" },
  failed: { icon: XCircle, label: "Failed", color: "text-destructive" },
  pending: { icon: Clock, label: "Pending", color: "text-warning" },
  // Server-created workflows start as "idle" until the first run.
  idle: { icon: Clock, label: "Idle", color: "text-muted-foreground" },
};

/** The workflow list, whether the server sent a bare array or `{ workflows }`. */
function workflowList(data: unknown): Record<string, unknown>[] {
  const list: unknown = Array.isArray(data) ? data : (data as { workflows?: unknown })?.workflows;
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

/** Normalize server records (id/name/steps/status/createdAt) to the UI shape. */
function normalizeWorkflow(w: Record<string, unknown>): Workflow {
  const steps = Array.isArray(w.steps) ? w.steps : [];
  // Server statuses are idle|running|completed|error; the UI renders
  // success|failed|pending|idle — map them so a post-run list refresh
  // doesn't crash on an unknown status key.
  const serverStatus = String(w.status ?? "idle");
  const status: WorkflowStatus =
    serverStatus === "completed"
      ? "success"
      : serverStatus === "error"
        ? "failed"
        : serverStatus === "running"
          ? "pending"
          : "idle";
  const lastRun =
    typeof w.lastRunAt === "string"
      ? w.lastRunAt
      : typeof w.lastRun === "string"
        ? w.lastRun
        : "Never";
  return {
    id: String(w.id ?? ""),
    name: String(w.name ?? "Untitled workflow"),
    description: typeof w.description === "string" ? w.description : "",
    nodeCount: typeof w.nodeCount === "number" ? w.nodeCount : steps.length,
    status,
    lastRun,
    steps: steps.map((s) => s as StepDef),
    ...(w.graph ? { graph: w.graph as { nodes: Node[]; edges: Edge[] } } : {}),
    schedule: typeof w.schedule === "string" ? w.schedule : null,
    nextRunAt: typeof w.nextRunAt === "string" ? w.nextRunAt : null,
  };
}

const nodeTypeStyles: Record<
  string,
  { border: string; label: string; icon: React.ElementType; description: string }
> = {
  input: {
    border: "#10b981",
    label: "Query Input",
    icon: MessageSquare,
    description: "Entry point for user input",
  },
  llm: {
    border: "#3b82f6",
    label: "LLM Node",
    icon: Brain,
    description: "AI model processing step",
  },
  output: {
    border: "#f59e0b",
    label: "Result Output",
    icon: BarChart2,
    description: "Final output collector",
  },
  branch: {
    border: "#a855f7",
    label: "Branch/Condition",
    icon: GitFork,
    description: "Conditional routing logic",
  },
  tool: {
    border: "#06b6d4",
    label: "Tool Call",
    icon: Wrench,
    description: "External tool integration",
  },
  code: {
    border: "#64748b",
    label: "Code Block",
    icon: Code2,
    description: "Custom code execution",
  },
  org: {
    border: "#ef4444",
    label: "Company Task",
    icon: Building2,
    description: "Hand the data to a company agent",
  },
};

function NodePalette({ onAddNode }: { onAddNode: (type: string) => void }) {
  return (
    <div className="w-full md:w-56 max-h-56 md:max-h-none overflow-y-auto border-b md:border-b-0 md:border-r border-border flex flex-col bg-background shrink-0">
      <div className="p-3 border-b border-border">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Node Palette
        </p>
        <p className="text-[10px] text-muted-foreground mt-0.5">Drag or click to add</p>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {Object.entries(nodeTypeStyles).map(([type, cfg]) => {
          const Icon = cfg.icon;
          return (
            <button
              key={type}
              onClick={() => onAddNode(type)}
              className="w-full text-left flex items-center gap-2.5 px-3 py-2.5 rounded-lg hover:bg-muted transition-colors group border border-transparent hover:border-border"
            >
              <div
                className="size-7 rounded-md flex items-center justify-center shrink-0"
                style={{ background: `${cfg.border}20`, border: `1px solid ${cfg.border}` }}
              >
                <Icon className="size-3.5" style={{ color: cfg.border }} />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium leading-none">{cfg.label}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">
                  {cfg.description}
                </p>
              </div>
              <GripVertical className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 ml-auto shrink-0" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A model row from GET /api/v1/gateway/models (registry seeded from models.dev). */
interface GatewayModel {
  id: string;
  provider: string;
  backend_model?: string;
  available?: boolean;
}

/** A serializable step definition understood by POST /api/workflows/:id/run. */
type StepDef = Record<string, unknown>;

/**
 * Compile the ReactFlow graph into the server's step-definition shape.
 *
 * Ordering follows the edges (Kahn's algorithm); disconnected or cyclic
 * graphs fall back to insertion order. LLM nodes become agent steps that the
 * backend executes through the gateway fallback chain; branch nodes become
 * pass-through conditions; everything else is an explicit pass-through fn
 * step so the trace shows every node.
 */
function compileSteps(nodes: Node[], edges: Edge[], models: GatewayModel[]): StepDef[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    adj.get(e.source)!.push(e.target);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }
  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const ordered: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    ordered.push(id);
    for (const t of adj.get(id) ?? []) {
      const d = (indeg.get(t) ?? 1) - 1;
      indeg.set(t, d);
      if (d === 0) queue.push(t);
    }
  }
  if (ordered.length !== nodes.length) {
    ordered.splice(0, ordered.length, ...nodes.map((n) => n.id));
  }

  const steps: StepDef[] = [];
  for (const id of ordered) {
    const n = byId.get(id)!;
    const type = (n.data?.nodeType as string) ?? "input";
    const label = (n.data?.label as string) || type;
    if (type === "llm") {
      // Empty model (user never touched the select) = the first registry
      // model, which is exactly what the properties panel displays.
      const modelId = (n.data?.model as string) || models[0]?.id || "";
      const row = models.find((m) => m.id === modelId);
      steps.push({
        kind: "agent",
        id,
        name: label,
        provider: row?.provider,
        model: row?.backend_model ?? modelId,
        task: `Perform this step ("${label}") on the current workflow data. Answer concisely and usefully.`,
      });
    } else if (type === "org") {
      steps.push({
        kind: "org_task",
        id,
        name: label,
        title: label,
        companyId: n.data?.companyId,
        agentId: n.data?.agentId || null,
        wait: n.data?.wait === true,
      });
    } else if (type === "branch") {
      steps.push({ kind: "condition", id, name: label, conditionResult: true });
    } else {
      steps.push({ kind: "fn", id, name: label, transform: "data" });
    }
  }
  return steps;
}

// Shown before /gateway/models responds (or if the call fails / is unauthorized).
const FALLBACK_MODELS: GatewayModel[] = [
  { id: "openai/gpt-oss-120b", provider: "groq" },
  { id: "gpt-4o-mini", provider: "openai" },
  { id: "claude-sonnet-4-6", provider: "anthropic" },
  { id: "claude-haiku-4-5", provider: "anthropic" },
  { id: "gemini-3.6-flash", provider: "google" },
];

/** Which company and agent a Company Task node hands its data to. */
function OrgTaskFields({
  node,
  onUpdateData,
}: {
  node: Node;
  onUpdateData: (id: string, patch: Record<string, unknown>) => void;
}) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const companyId = (node.data?.companyId as string) || "";
  useEffect(() => {
    orgApi<{ companies: Company[] }>("/companies")
      .then((b) => setCompanies(b.companies.filter(canManage)))
      .catch(() => setCompanies([]));
  }, []);
  useEffect(() => {
    if (!companyId) return setAgents([]);
    orgApi<{ agents: Agent[] }>(`/companies/${companyId}/agents`)
      .then((b) => setAgents(b.agents.filter((a) => a.status !== "terminated")))
      .catch(() => setAgents([]));
  }, [companyId]);
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor="wf-org-company" className="text-xs font-medium text-muted-foreground">
          Company
        </label>
        <select
          id="wf-org-company"
          className={selectClass}
          value={companyId}
          onChange={(e) => onUpdateData(node.id, { companyId: e.target.value, agentId: "" })}
        >
          <option value="">Choose a company</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="wf-org-agent" className="text-xs font-medium text-muted-foreground">
          Agent
        </label>
        <select
          id="wf-org-agent"
          className={selectClass}
          value={(node.data?.agentId as string) || ""}
          onChange={(e) => onUpdateData(node.id, { agentId: e.target.value })}
        >
          <option value="">Unassigned (the CEO triages)</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={node.data?.wait === true}
          onChange={(e) => onUpdateData(node.id, { wait: e.target.checked })}
        />
        Wait for the result and pass it on
      </label>
    </div>
  );
}

function PropertiesPanel({
  selectedNode,
  onUpdateLabel,
  onUpdateModel,
  onUpdateData,
  models,
}: {
  selectedNode: Node | null;
  onUpdateLabel: (id: string, label: string) => void;
  onUpdateModel: (id: string, model: string) => void;
  onUpdateData: (id: string, patch: Record<string, unknown>) => void;
  models: GatewayModel[];
}) {
  if (!selectedNode) {
    return (
      <div className="w-full md:w-64 border-t md:border-t-0 md:border-l border-border flex flex-col bg-background shrink-0">
        <div className="p-3 border-b border-border">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Properties
          </p>
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-xs text-muted-foreground text-center">
            Select a node to view its properties
          </p>
        </div>
      </div>
    );
  }

  const nodeType = (selectedNode.data?.nodeType as string) || "input";
  const cfg = nodeTypeStyles[nodeType] || nodeTypeStyles.input;
  const Icon = cfg.icon;
  const label = (selectedNode.data?.label as string) || "";
  const selectedModel =
    (selectedNode.data?.model as string) || models[0]?.id || FALLBACK_MODELS[0]!.id;

  // Persist the default model into the node: the panel *shows* the first
  // registry model, but the node only learns about it once the user touches
  // the select — otherwise saves carry an empty model.
  useEffect(() => {
    if (nodeType === "llm" && !selectedNode.data?.model) {
      onUpdateModel(selectedNode.id, models[0]?.id ?? FALLBACK_MODELS[0]!.id);
    }
  }, [nodeType, selectedNode, onUpdateModel, models]);

  return (
    <div className="w-full md:w-64 border-t md:border-t-0 md:border-l border-border flex flex-col bg-background shrink-0">
      <div className="p-3 border-b border-border">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Properties
        </p>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        <div className="flex items-center gap-2.5">
          <div
            className="size-8 rounded-md flex items-center justify-center shrink-0"
            style={{ background: `${cfg.border}20`, border: `1px solid ${cfg.border}` }}
          >
            <Icon className="size-4" style={{ color: cfg.border }} />
          </div>
          <div>
            <p className="text-xs font-medium">{cfg.label}</p>
            <p className="text-[10px] text-muted-foreground">Node ID: {selectedNode.id}</p>
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Label</label>
          <Input
            value={label}
            onChange={(e) => onUpdateLabel(selectedNode.id, e.target.value)}
            className="h-7 text-xs"
            placeholder="Node label..."
          />
        </div>

        {nodeType === "llm" && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Model</label>
            <Select value={selectedModel} onValueChange={(m) => onUpdateModel(selectedNode.id, m)}>
              <SelectTrigger className="h-7 text-xs">
                <div className="flex items-center gap-1.5 truncate">
                  <ModelIcon model={selectedModel} size={14} />
                  <SelectValue placeholder="Select model" />
                </div>
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id} className="text-xs">
                    <span className="flex items-center gap-2">
                      <ProviderIcon provider={m.provider} size={14} type="mono" />
                      <span className="truncate">{m.id}</span>
                      {m.available === false && (
                        <span className="text-[10px] text-muted-foreground">(no key)</span>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {nodeType === "org" && <OrgTaskFields node={selectedNode} onUpdateData={onUpdateData} />}

        {nodeType === "branch" && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Condition</label>
            <Input className="h-7 text-xs font-mono" placeholder="e.g. score > 0.8" />
          </div>
        )}

        {nodeType === "code" && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Language</label>
            <select className="w-full h-7 text-xs bg-background border border-border rounded-md px-2 text-foreground">
              <option>python</option>
              <option>javascript</option>
              <option>typescript</option>
            </select>
          </div>
        )}

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Node Type</label>
          <Badge
            variant="outline"
            className="text-[10px]"
            style={{ borderColor: cfg.border, color: cfg.border }}
          >
            {cfg.label}
          </Badge>
        </div>
      </div>
    </div>
  );
}

function WorkflowEditor({
  workflow,
  onBack,
  onUpdateWorkflow,
}: {
  workflow: Workflow;
  onBack: () => void;
  onUpdateWorkflow: (updated: Workflow) => void;
}) {
  const savedGraph = (() => {
    if (workflow.graph) return workflow.graph;
    // Canvases saved before the server kept them live in this browser only.
    try {
      const raw = localStorage.getItem(`workflow-${workflow.id}`);
      if (raw) {
        const parsed = JSON.parse(raw) as { nodes?: unknown; edges?: unknown };
        if (Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
          return { nodes: parsed.nodes as Node[], edges: parsed.edges as Edge[] };
        }
      }
    } catch {
      // A corrupt saved graph falls back to the default below.
    }
    return null;
  })();

  const initialNodes = savedGraph?.nodes ?? [];
  const initialEdges = savedGraph?.edges ?? [];

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [nodeIdCounter, setNodeIdCounter] = useState(100);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [runOutput, setRunOutput] = useState<string | null>(null);
  const [outputExpanded, setOutputExpanded] = useState(true);
  const [models, setModels] = useState<GatewayModel[]>(FALLBACK_MODELS);
  const [schedule, setSchedule] = useState(workflow.schedule ?? "");

  // Feed the model picker from the registry (seeded from models.dev, §1.5).
  // Falls back to the static list on any error / unauthorized.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/v1/gateway/models");
        if (!res.ok) return;
        const data = (await res.json()) as { models?: GatewayModel[] };
        if (!cancelled && Array.isArray(data.models) && data.models.length > 0) {
          setModels(data.models);
        }
      } catch {
        /* keep FALLBACK_MODELS */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onConnect = useCallback(
    (connection: Connection) =>
      setEdges((eds) => addEdge({ ...connection, style: { stroke: "#555" } }, eds)),
    [setEdges],
  );

  const handleAddNode = useCallback(
    (type: string) => {
      const cfg = nodeTypeStyles[type] || nodeTypeStyles.input;
      const newId = `node-${nodeIdCounter}`;
      setNodeIdCounter((c) => c + 1);
      const newNode: Node = {
        id: newId,
        type: "default",
        position: { x: 200 + Math.random() * 200, y: 200 + Math.random() * 200 },
        data: { label: cfg.label, nodeType: type },
        style: {
          border: `2px solid ${cfg.border}`,
          borderRadius: 8,
          background: "#0a0a0a",
          color: "#fff",
          padding: 12,
        },
      };
      setNodes((nds) => [...nds, newNode]);
      setSelectedNode(newNode);
    },
    [nodeIdCounter, setNodes],
  );

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNode(node);
  }, []);

  const handlePaneClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  const handleUpdateLabel = useCallback(
    (id: string, label: string) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== id) return n;
          return { ...n, data: { ...n.data, label } };
        }),
      );
      setSelectedNode((prev) =>
        prev && prev.id === id ? { ...prev, data: { ...prev.data, label } } : prev,
      );
    },
    [setNodes],
  );

  const handleUpdateData = useCallback(
    (id: string, patch: Record<string, unknown>) => {
      setNodes((nds) =>
        nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)),
      );
      setSelectedNode((prev) =>
        prev && prev.id === id ? { ...prev, data: { ...prev.data, ...patch } } : prev,
      );
    },
    [setNodes],
  );
  const handleUpdateModel = useCallback(
    (id: string, model: string) => handleUpdateData(id, { model }),
    [handleUpdateData],
  );

  const handleSave = useCallback(async () => {
    const steps = compileSteps(nodes, edges, models);
    try {
      const res = await fetch(`/api/workflows/${workflow.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ steps, graph: { nodes, edges }, schedule: schedule.trim() || null }),
      });
      const saved = (await res.json().catch(() => ({}))) as {
        error?: string;
        nextRunAt?: string | null;
      };
      if (!res.ok) throw new Error(saved.error ?? `server responded ${res.status}`);
      // Carry the compiled steps back into the list object so the card's
      // Play button knows the workflow is runnable without a refetch.
      onUpdateWorkflow({
        ...workflow,
        nodeCount: nodes.length,
        steps,
        graph: { nodes, edges },
        schedule: schedule.trim() || null,
        nextRunAt: saved.nextRunAt ?? null,
      });
      setSaveMessage(
        saved.nextRunAt
          ? `Saved. Next run ${new Date(saved.nextRunAt).toLocaleString()}.`
          : "Workflow saved successfully!",
      );
    } catch (err) {
      const reason = err instanceof Error ? ` (${err.message})` : "";
      setSaveMessage(`Failed to save to server${reason}.`);
    }
    setTimeout(() => setSaveMessage(null), 2500);
  }, [workflow, nodes, edges, models, schedule, onUpdateWorkflow]);

  const handleRun = useCallback(async () => {
    const steps = compileSteps(nodes, edges, models);
    if (steps.length === 0) {
      setRunOutput(
        "Nothing to run — add at least one node to the canvas (e.g. an LLM Node) first, then Run again.",
      );
      setOutputExpanded(true);
      return;
    }
    setIsRunning(true);
    setRunOutput(null);
    setOutputExpanded(true);
    try {
      // Send the compiled steps with the run so a run right after (or while)
      // saving always executes the graph as it appears on the canvas.
      const res = await fetch(`/api/workflows/${workflow.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: {
            query: workflow.name,
            description: workflow.description,
          },
          steps,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        status?: string;
        result?: unknown;
        error?: string;
        message?: string;
        events?: {
          type: string;
          stepId?: string;
          timestamp: string;
        }[];
      };
      if (!res.ok || data.status === "error") {
        throw new Error(data.message ?? data.error ?? `server responded ${res.status}`);
      }

      const stepNames = new Map(steps.map((s) => [String(s.id), String(s.name ?? s.id)]));
      const trace = (data.events ?? [])
        .filter((e) => e.type.startsWith("step:"))
        .map((e) => {
          const name = e.stepId ? (stepNames.get(e.stepId) ?? e.stepId) : "";
          return `[${e.type.replace("step:", "")}] ${name}`.trim();
        })
        .join("\n");
      const finalResult =
        typeof data.result === "string" ? data.result : JSON.stringify(data.result, null, 2);
      setRunOutput(
        `Workflow completed successfully.\n\nFinal result:\n${finalResult}\n\nStep trace:\n${trace || "(no steps executed)"}`,
      );

      const now = new Date();
      const timeStr = `${now.getHours()}:${now.getMinutes().toString().padStart(2, "0")}`;
      onUpdateWorkflow({
        ...workflow,
        lastRun: `Today at ${timeStr}`,
        status: "success",
        nodeCount: nodes.length,
        steps,
      });
    } catch (err) {
      setRunOutput(`Workflow failed: ${err instanceof Error ? err.message : String(err)}`);
      onUpdateWorkflow({
        ...workflow,
        lastRun: "Just now",
        status: "failed",
        nodeCount: nodes.length,
        steps,
      });
    } finally {
      setIsRunning(false);
    }
  }, [nodes, edges, models, workflow, onUpdateWorkflow]);

  return (
    <div className="flex flex-col" style={{ height: "100%" }}>
      {/* Toolbar */}
      <div className="min-h-14 py-2 border-b border-border flex flex-wrap items-center px-4 gap-3 bg-background shrink-0 z-10">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
          <ChevronLeft className="size-4" />
          Back
        </Button>
        <div className="w-px h-5 bg-border" />
        <GitBranch className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">{workflow.name}</span>
        <Badge
          variant="outline"
          className={`text-[10px] ml-1 ${statusConfig[workflow.status].color}`}
        >
          {statusConfig[workflow.status].label}
        </Badge>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {nodes.length} nodes · {edges.length} edges
          </span>
          {saveMessage && (
            <span className="text-xs text-success animate-in fade-in">{saveMessage}</span>
          )}
          <Input
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
            placeholder="cron, e.g. 0 9 * * 1-5"
            aria-label="Schedule (cron)"
            title="Run on this five-field cron (server time); leave empty to run only by hand"
            className="h-7 w-28 sm:w-40 text-xs font-mono"
          />
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 h-7 text-xs"
            onClick={handleRun}
            disabled={isRunning}
          >
            {isRunning ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
            {isRunning ? "Running..." : "Run"}
          </Button>
          <Button size="sm" className="gap-1.5 h-7 text-xs" onClick={handleSave}>
            <Save className="size-3" />
            Save
          </Button>
        </div>
      </div>

      {/* Editor layout */}
      <div className="flex flex-1 flex-col md:flex-row overflow-y-auto md:overflow-hidden">
        <NodePalette onAddNode={handleAddNode} />

        {/* Canvas */}
        <div className="flex-1 min-h-[60vh] md:min-h-0 md:h-[calc(100%-56px)]">
          <div style={{ width: "100%", height: "100%" }}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={handleNodeClick}
              onPaneClick={handlePaneClick}
              fitView
              style={{ background: "#0a0a0a" }}
            >
              <Background color="#333" gap={20} />
              <Controls />
              <MiniMap style={{ background: "#1a1a1a" }} nodeColor="#666" />
            </ReactFlow>
          </div>
        </div>

        <PropertiesPanel
          selectedNode={selectedNode}
          onUpdateLabel={handleUpdateLabel}
          onUpdateModel={handleUpdateModel}
          onUpdateData={handleUpdateData}
          models={models}
        />
      </div>

      {/* AI Run Output Panel */}
      {runOutput && (
        <div className="border-t border-border bg-background shrink-0">
          <button
            onClick={() => setOutputExpanded((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-muted transition-colors"
          >
            <span>AI Run Output</span>
            {outputExpanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronUp className="size-3.5" />
            )}
          </button>
          {outputExpanded && (
            <div className="px-4 pb-3 max-h-48 overflow-y-auto">
              <div className="text-xs text-foreground whitespace-pre-wrap leading-relaxed bg-muted/50 rounded-md p-3 border border-border">
                {runOutput}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface NewWorkflowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string, description: string) => void;
}

function NewWorkflowDialog({ open, onOpenChange, onSubmit }: NewWorkflowDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const handleOpenChange = (o: boolean) => {
    onOpenChange(o);
  };

  // Reset fields whenever dialog opens
  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
    }
  }, [open]);

  const handleSubmit = () => {
    if (!name.trim()) return;
    onSubmit(name.trim(), description.trim());
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Workflow</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="wf-name" className="text-xs">
              Workflow Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="wf-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Customer Onboarding Flow"
              className="h-9"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmit();
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wf-desc" className="text-xs">
              Description
            </Label>
            <Textarea
              id="wf-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what this workflow does..."
              rows={3}
              className="text-sm resize-none"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!name.trim()}>
            Create Workflow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [editingWorkflow, setEditingWorkflow] = useState<Workflow | null>(null);
  const [newWorkflowOpen, setNewWorkflowOpen] = useState(false);

  // Load workflows — API first. An empty server list is authoritative
  // (server-created workflows only; demo data was removed); localStorage is a
  // fallback for when the API is unreachable, not a source of stale demos.
  useEffect(() => {
    fetch("/api/workflows?limit=100")
      .then((r) => (r.ok ? (r.json() as Promise<unknown>) : Promise.reject(new Error())))
      .then((data) => setWorkflows(workflowList(data).map(normalizeWorkflow)))
      .catch(() => {
        // Network/server error only — fall back to locally-saved workflows.
        try {
          const raw = localStorage.getItem("workflows");
          if (raw) {
            const saved = JSON.parse(raw) as unknown;
            if (Array.isArray(saved) && saved.length > 0) setWorkflows(saved as Workflow[]);
          }
        } catch {
          // Nothing usable saved locally either.
        }
      });
  }, []);

  // Save workflows to localStorage whenever they change
  useEffect(() => {
    try {
      localStorage.setItem("workflows", JSON.stringify(workflows));
    } catch {
      // Storage full or blocked; the server copy is the source of truth.
    }
  }, [workflows]);

  const handleUpdateWorkflow = useCallback((updated: Workflow) => {
    setWorkflows((prev) => prev.map((w) => (w.id === updated.id ? updated : w)));
    setEditingWorkflow(updated);
  }, []);

  // Run a workflow straight from the list card. Refetches the list afterwards
  // so the server-side status/lastRunAt updates become visible.
  const runWorkflowFromList = useCallback(async (wf: Workflow) => {
    if (!wf.steps || wf.steps.length === 0) return;
    try {
      const res = await fetch(`/api/workflows/${wf.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: { query: wf.name } }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        status?: string;
        error?: string;
        message?: string;
      };
      if (!res.ok || data.status === "error") {
        throw new Error(data.message ?? data.error ?? `server responded ${res.status}`);
      }
      const fresh = (await (await fetch("/api/workflows?limit=100")).json()) as unknown;
      setWorkflows(workflowList(fresh).map(normalizeWorkflow));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      setWorkflows((prev) => prev.map((w) => (w.id === wf.id ? { ...w, status: "failed" } : w)));
      console.error(`workflow run failed: ${reason}`);
    }
  }, []);

  const handleCreateWorkflow = (name: string, description: string) => {
    const newWorkflow: Workflow = {
      id: `custom-${Date.now()}`,
      name,
      description: description || "New workflow",
      nodeCount: 0,
      status: "pending",
      lastRun: "Never",
    };
    setWorkflows((prev) => [...prev, newWorkflow]);
    setEditingWorkflow(newWorkflow);

    // Persist to backend, swap optimistic id if server returns one
    void (async () => {
      const r = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description: description || "New workflow" }),
      }).catch(() => null);
      // Offline or refused: the workflow stays local under its optimistic id.
      const created = r?.ok ? ((await r.json().catch(() => null)) as Workflow | null) : null;
      if (!created?.id) return;
      setWorkflows((prev) =>
        prev.map((w) => (w.id === newWorkflow.id ? { ...w, id: created.id } : w)),
      );
      setEditingWorkflow((prev) =>
        prev?.id === newWorkflow.id ? { ...prev, id: created.id } : prev,
      );
    })();
  };

  if (editingWorkflow) {
    return (
      <WorkflowEditor
        workflow={editingWorkflow}
        onBack={() => setEditingWorkflow(null)}
        onUpdateWorkflow={handleUpdateWorkflow}
      />
    );
  }

  return (
    <Page width="wide">
      <PageHeader
        title="Workflows"
        description="Chain model calls, tools and conditions into a pipeline, then run it with one click or from the API."
        actions={
          <Button className="relative z-10" onClick={() => setNewWorkflowOpen(true)}>
            <Plus /> New workflow
          </Button>
        }
      />

      {workflows.length === 0 && (
        <EmptyState
          icon={GitFork}
          title="No workflows yet"
          description="A workflow runs the same steps every time: fetch, ask a model, branch, act."
          action={
            <Button size="sm" onClick={() => setNewWorkflowOpen(true)}>
              <Plus /> New workflow
            </Button>
          }
        />
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {workflows.map((wf) => {
          const st = statusConfig[wf.status];
          const StatusIcon = st.icon;
          return (
            <Card key={wf.id} className="hover:ring-2 hover:ring-primary/20 transition-all">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">{wf.name}</CardTitle>
                  <StatusIcon className={`size-4 ${st.color}`} />
                </div>
                <CardDescription>{wf.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{wf.nodeCount} nodes</span>
                  <span>Last run: {wf.lastRun}</span>
                </div>
                <div className="flex items-center gap-2 mt-3">
                  <Badge variant="outline" className={`text-[10px] ${st.color}`}>
                    {st.label}
                  </Badge>
                  <div className="ml-auto flex items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-2.5 text-[11px] gap-1"
                      onClick={() => setEditingWorkflow(wf)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      onClick={() => runWorkflowFromList(wf)}
                      title={
                        wf.steps?.length
                          ? "Run workflow"
                          : "No steps saved yet — open Edit to add nodes"
                      }
                    >
                      <Play className="size-3" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <NewWorkflowDialog
        open={newWorkflowOpen}
        onOpenChange={setNewWorkflowOpen}
        onSubmit={handleCreateWorkflow}
      />
    </Page>
  );
}
