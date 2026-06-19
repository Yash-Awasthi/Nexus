// SPDX-License-Identifier: Apache-2.0
import { useState, useCallback, useEffect } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "~/components/ui/dialog";
import { deliberate, createThread, onOpinion, onDone } from "~/lib/deliberate";
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
} from "lucide-react";
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
import "@xyflow/react/dist/style.css";

type WorkflowStatus = "success" | "failed" | "pending";

type Workflow = {
  id: string;
  name: string;
  description: string;
  nodeCount: number;
  status: WorkflowStatus;
  lastRun: string;
};

const initialWorkflows: Workflow[] = [
  {
    id: "1",
    name: "Code Review Pipeline",
    description: "Automated code review with multiple archetype passes",
    nodeCount: 7,
    status: "success",
    lastRun: "2 hours ago",
  },
  {
    id: "2",
    name: "Research Synthesis",
    description: "Gather, analyze, and synthesize research from multiple sources",
    nodeCount: 12,
    status: "success",
    lastRun: "Yesterday",
  },
  {
    id: "3",
    name: "Content Generation",
    description: "Multi-stage content creation with editorial review",
    nodeCount: 5,
    status: "failed",
    lastRun: "3 hours ago",
  },
  {
    id: "4",
    name: "Data Analysis Flow",
    description: "Ingest, clean, analyze, and visualize datasets",
    nodeCount: 9,
    status: "pending",
    lastRun: "Never",
  },
  {
    id: "5",
    name: "Security Audit Chain",
    description: "Sequential security checks across codebase layers",
    nodeCount: 8,
    status: "success",
    lastRun: "1 day ago",
  },
];

const statusConfig = {
  success: { icon: CheckCircle, label: "Success", color: "text-green-400" },
  failed: { icon: XCircle, label: "Failed", color: "text-red-400" },
  pending: { icon: Clock, label: "Pending", color: "text-yellow-400" },
};

const demoNodes: Node[] = [
  {
    id: "1",
    type: "default",
    position: { x: 100, y: 100 },
    data: { label: "User Query", nodeType: "input" },
    style: {
      border: "2px solid #10b981",
      borderRadius: 8,
      background: "#0a0a0a",
      color: "#fff",
      padding: 12,
    },
  },
  {
    id: "2",
    type: "default",
    position: { x: 100, y: 250 },
    data: { label: "GPT-4o Analysis", nodeType: "llm" },
    style: {
      border: "2px solid #3b82f6",
      borderRadius: 8,
      background: "#0a0a0a",
      color: "#fff",
      padding: 12,
    },
  },
  {
    id: "3",
    type: "default",
    position: { x: 350, y: 250 },
    data: { label: "Claude Review", nodeType: "llm" },
    style: {
      border: "2px solid #3b82f6",
      borderRadius: 8,
      background: "#0a0a0a",
      color: "#fff",
      padding: 12,
    },
  },
  {
    id: "4",
    type: "default",
    position: { x: 225, y: 400 },
    data: { label: "Merge Results", nodeType: "tool" },
    style: {
      border: "2px solid #06b6d4",
      borderRadius: 8,
      background: "#0a0a0a",
      color: "#fff",
      padding: 12,
    },
  },
  {
    id: "5",
    type: "default",
    position: { x: 225, y: 550 },
    data: { label: "Final Output", nodeType: "output" },
    style: {
      border: "2px solid #f59e0b",
      borderRadius: 8,
      background: "#0a0a0a",
      color: "#fff",
      padding: 12,
    },
  },
];

const demoEdges: Edge[] = [
  { id: "e1-2", source: "1", target: "2", animated: true, style: { stroke: "#555" } },
  { id: "e1-3", source: "1", target: "3", animated: true, style: { stroke: "#555" } },
  { id: "e2-4", source: "2", target: "4", style: { stroke: "#555" } },
  { id: "e3-4", source: "3", target: "4", style: { stroke: "#555" } },
  { id: "e4-5", source: "4", target: "5", style: { stroke: "#555" } },
];

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
};

function NodePalette({ onAddNode }: { onAddNode: (type: string) => void }) {
  return (
    <div className="w-56 border-r border-border flex flex-col bg-background shrink-0">
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

function PropertiesPanel({
  selectedNode,
  onUpdateLabel,
}: {
  selectedNode: Node | null;
  onUpdateLabel: (id: string, label: string) => void;
}) {
  if (!selectedNode) {
    return (
      <div className="w-64 border-l border-border flex flex-col bg-background shrink-0">
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

  return (
    <div className="w-64 border-l border-border flex flex-col bg-background shrink-0">
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
            <select className="w-full h-7 text-xs bg-background border border-border rounded-md px-2 text-foreground">
              <option>gpt-4o</option>
              <option>gpt-4o-mini</option>
              <option>claude-sonnet-4-6</option>
              <option>claude-haiku</option>
              <option>gemini-2.5-pro</option>
            </select>
          </div>
        )}

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
    try {
      const raw = localStorage.getItem(`workflow-${workflow.id}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
          return { nodes: parsed.nodes as Node[], edges: parsed.edges as Edge[] };
        }
      }
    } catch {}
    return null;
  })();

  const initialNodes = savedGraph ? savedGraph.nodes : workflow.id === "1" ? demoNodes : [];
  const initialEdges = savedGraph ? savedGraph.edges : workflow.id === "1" ? demoEdges : [];

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [nodeIdCounter, setNodeIdCounter] = useState(100);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [runOutput, setRunOutput] = useState<string | null>(null);
  const [outputExpanded, setOutputExpanded] = useState(true);

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

  const handleSave = useCallback(() => {
    try {
      localStorage.setItem(`workflow-${workflow.id}`, JSON.stringify({ nodes, edges }));
      onUpdateWorkflow({ ...workflow, nodeCount: nodes.length });
      setSaveMessage("Workflow saved successfully!");
      setTimeout(() => setSaveMessage(null), 2500);
    } catch (err) {
      setSaveMessage("Failed to save workflow.");
      setTimeout(() => setSaveMessage(null), 2500);
    }
    // Persist graph to backend (fire-and-forget)
    fetch(`/api/workflows/${workflow.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodes, edges, nodeCount: nodes.length }),
    }).catch(() => {});
  }, [workflow, nodes, edges, onUpdateWorkflow]);

  const handleRun = useCallback(async () => {
    setIsRunning(true);
    setRunOutput(null);
    setOutputExpanded(true);
    try {
      const nodeLabels = nodes.map((n) => (n.data?.label as string) || "Unnamed Node");
      const prompt = `Analyze this workflow called "${workflow.name}" (${workflow.description}). Steps: ${nodeLabels.join(" -> ")}. Describe what it does, evaluate its design, and suggest improvements.`;

      const threadId = await createThread();
      let outputText = "";

      await new Promise<void>((resolve) => {
        const unsubO = onOpinion((data) => {
          outputText = data.text;
        });
        const unsubD = onDone(() => {
          unsubO();
          unsubD();
          resolve();
        });
        deliberate({ threadId, message: prompt, round: 1 }).catch(() => resolve());
      });

      setRunOutput(outputText || "Workflow analysis complete. No output returned.");

      const now = new Date();
      const timeStr = `${now.getHours()}:${now.getMinutes().toString().padStart(2, "0")}`;
      onUpdateWorkflow({
        ...workflow,
        lastRun: `Today at ${timeStr}`,
        status: "success",
        nodeCount: nodes.length,
      });
    } catch (err: any) {
      setRunOutput(`Error: ${err?.message ?? String(err)}`);
      onUpdateWorkflow({
        ...workflow,
        lastRun: "Just now",
        status: "failed",
        nodeCount: nodes.length,
      });
    } finally {
      setIsRunning(false);
    }
  }, [nodes, workflow, onUpdateWorkflow]);

  return (
    <div className="flex flex-col" style={{ height: "100vh" }}>
      {/* Toolbar */}
      <div className="h-14 border-b border-border flex items-center px-4 gap-3 bg-background shrink-0 z-10">
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
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {nodes.length} nodes · {edges.length} edges
          </span>
          {saveMessage && (
            <span className="text-xs text-green-400 animate-in fade-in">{saveMessage}</span>
          )}
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
      <div className="flex flex-1 overflow-hidden">
        <NodePalette onAddNode={handleAddNode} />

        {/* Canvas */}
        <div className="flex-1" style={{ height: "calc(100vh - 56px)" }}>
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

        <PropertiesPanel selectedNode={selectedNode} onUpdateLabel={handleUpdateLabel} />
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
  const [workflows, setWorkflows] = useState<Workflow[]>(initialWorkflows);
  const [editingWorkflow, setEditingWorkflow] = useState<Workflow | null>(null);
  const [newWorkflowOpen, setNewWorkflowOpen] = useState(false);

  // Load workflows — try API first, fall back to localStorage
  useEffect(() => {
    fetch("/api/workflows?limit=100")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        const list: Workflow[] = Array.isArray(data) ? data : (data?.workflows ?? []);
        if (list.length > 0) {
          setWorkflows(list);
          return;
        }
        throw new Error("empty");
      })
      .catch(() => {
        // Fall back to localStorage
        try {
          const raw = localStorage.getItem("workflows");
          if (raw) {
            const saved: Workflow[] = JSON.parse(raw);
            if (Array.isArray(saved)) {
              const initialIds = new Set(initialWorkflows.map((w) => w.id));
              const extras = saved.filter((w) => !initialIds.has(w.id));
              const merged = initialWorkflows.map((iw) => {
                const savedVersion = saved.find((sw) => sw.id === iw.id);
                return savedVersion ?? iw;
              });
              setWorkflows([...merged, ...extras]);
            }
          }
        } catch {}
      });
  }, []);

  // Save workflows to localStorage whenever they change
  useEffect(() => {
    try {
      localStorage.setItem("workflows", JSON.stringify(workflows));
    } catch {}
  }, [workflows]);

  const handleUpdateWorkflow = useCallback((updated: Workflow) => {
    setWorkflows((prev) => prev.map((w) => (w.id === updated.id ? updated : w)));
    setEditingWorkflow(updated);
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
    fetch("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: description || "New workflow" }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((created: Workflow) => {
        if (created?.id) {
          setWorkflows((prev) =>
            prev.map((w) => (w.id === newWorkflow.id ? { ...w, id: created.id } : w)),
          );
          setEditingWorkflow((prev) =>
            prev?.id === newWorkflow.id ? { ...prev, id: created.id } : prev,
          );
        }
      })
      .catch(() => {});
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
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <GitBranch className="size-6 text-muted-foreground" />
            <div>
              <h1 className="text-xl font-semibold">Workflows</h1>
              <p className="text-sm text-muted-foreground">
                Orchestrate multi-step AI pipelines with visual workflows
              </p>
            </div>
          </div>
          <Button
            size="sm"
            className="gap-2 relative z-10"
            onClick={() => setNewWorkflowOpen(true)}
          >
            <Plus className="size-3.5" />
            New Workflow
          </Button>
        </div>

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
                      <Button variant="ghost" size="icon" className="size-6">
                        <Play className="size-3" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      <NewWorkflowDialog
        open={newWorkflowOpen}
        onOpenChange={setNewWorkflowOpen}
        onSubmit={handleCreateWorkflow}
      />
    </div>
  );
}
