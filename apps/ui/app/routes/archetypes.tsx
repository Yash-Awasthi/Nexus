import { useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { useStore } from "~/context/StoreContext";
import { Users, Plus, MoreHorizontal, Eye, Pencil, Trash2, ExternalLink } from "lucide-react";

type Archetype = {
  id: string;
  name: string;
  icon: string;
  color: string;
  thinkingStyle: string;
  description: string;
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  isCustom?: boolean;
};

const builtinArchetypes: Archetype[] = [
  {
    id: "architect",
    name: "The Architect",
    icon: "🏗️",
    color: "bg-blue-500/20 border-blue-500/30",
    thinkingStyle: "Systems Design",
    description: "Approaches problems through systems thinking, focusing on scalability, modularity, and long-term architectural decisions.",
  },
  {
    id: "pragmatist",
    name: "The Pragmatist",
    icon: "⚡",
    color: "bg-amber-500/20 border-amber-500/30",
    thinkingStyle: "Practical Solutions",
    description: "Favors battle-tested, production-ready solutions. Prioritizes shipping speed, maintainability, and developer experience.",
  },
  {
    id: "ethicist",
    name: "The Ethicist",
    icon: "⚖️",
    color: "bg-purple-500/20 border-purple-500/30",
    thinkingStyle: "Ethical Analysis",
    description: "Evaluates decisions through privacy, fairness, and societal impact lenses. Ensures compliance and responsible AI use.",
  },
  {
    id: "scientist",
    name: "The Scientist",
    icon: "🔬",
    color: "bg-green-500/20 border-green-500/30",
    thinkingStyle: "Empirical Reasoning",
    description: "Demands evidence and data. Designs experiments, questions assumptions, and follows the scientific method rigorously.",
  },
  {
    id: "creative",
    name: "The Creative",
    icon: "🎨",
    color: "bg-pink-500/20 border-pink-500/30",
    thinkingStyle: "Lateral Thinking",
    description: "Generates unconventional ideas and novel approaches. Excels at brainstorming and breaking out of established patterns.",
  },
  {
    id: "skeptic",
    name: "The Skeptic",
    icon: "🔍",
    color: "bg-red-500/20 border-red-500/30",
    thinkingStyle: "Critical Analysis",
    description: "Challenges assumptions, identifies logical fallacies, and stress-tests arguments. The devil's advocate of the council.",
  },
  {
    id: "mentor",
    name: "The Mentor",
    icon: "📚",
    color: "bg-cyan-500/20 border-cyan-500/30",
    thinkingStyle: "Educational",
    description: "Explains complex concepts clearly, provides learning paths, and adapts explanations to the audience's knowledge level.",
  },
  {
    id: "strategist",
    name: "The Strategist",
    icon: "♟️",
    color: "bg-indigo-500/20 border-indigo-500/30",
    thinkingStyle: "Strategic Planning",
    description: "Thinks in terms of long-term positioning, competitive advantage, and risk-reward trade-offs across multiple time horizons.",
  },
  {
    id: "optimizer",
    name: "The Optimizer",
    icon: "📈",
    color: "bg-emerald-500/20 border-emerald-500/30",
    thinkingStyle: "Performance Tuning",
    description: "Focuses on efficiency, performance, and resource optimization. Finds bottlenecks and eliminates waste systematically.",
  },
  {
    id: "historian",
    name: "The Historian",
    icon: "📜",
    color: "bg-orange-500/20 border-orange-500/30",
    thinkingStyle: "Historical Context",
    description: "Draws on historical precedents and patterns. Understands why past decisions were made and what can be learned from them.",
  },
  {
    id: "futurist",
    name: "The Futurist",
    icon: "🔮",
    color: "bg-violet-500/20 border-violet-500/30",
    thinkingStyle: "Forward Thinking",
    description: "Projects current trends forward, anticipates future challenges, and designs for tomorrow's requirements today.",
  },
  {
    id: "advocate",
    name: "The Advocate",
    icon: "🗣️",
    color: "bg-teal-500/20 border-teal-500/30",
    thinkingStyle: "User Empathy",
    description: "Champions the end user's perspective. Ensures solutions are accessible, intuitive, and genuinely solve user problems.",
  },
  {
    id: "guardian",
    name: "The Guardian",
    icon: "🛡️",
    color: "bg-slate-500/20 border-slate-500/30",
    thinkingStyle: "Security First",
    description: "Prioritizes security, reliability, and risk mitigation. Identifies vulnerabilities and ensures defense-in-depth.",
  },
];

const modelOptions = [
  { value: "gpt-4o", label: "GPT-4o" },
  { value: "gpt-4o-mini", label: "GPT-4o Mini" },
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { value: "claude-haiku", label: "Claude Haiku" },
  { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
];

const defaultFormState = {
  name: "",
  icon: "🤖",
  thinkingStyle: "",
  description: "",
  systemPrompt: "",
  model: "claude-sonnet-4-6",
  temperature: 0.7,
};

type FormState = typeof defaultFormState;

interface ArchetypeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (data: FormState) => void;
  initial?: FormState;
  title: string;
}

function ArchetypeDialog({ open, onOpenChange, onSave, initial, title }: ArchetypeDialogProps) {
  const [form, setForm] = useState<FormState>(initial ?? defaultFormState);
  const store = useStore();

  // Reset form when dialog opens with new data
  const handleOpenChange = (o: boolean) => {
    if (o) setForm(initial ?? defaultFormState);
    onOpenChange(o);
  };

  const handleSave = () => {
    if (!form.name.trim()) return;
    onSave(form);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-[80px_1fr] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="arch-icon" className="text-xs">Icon</Label>
              <Input
                id="arch-icon"
                value={form.icon}
                onChange={(e) => setForm((f) => ({ ...f, icon: e.target.value }))}
                className="h-9 text-xl text-center"
                maxLength={4}
                placeholder="🤖"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="arch-name" className="text-xs">Name <span className="text-destructive">*</span></Label>
              <Input
                id="arch-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. The Analyst"
                className="h-9"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="arch-thinking" className="text-xs">Thinking Style</Label>
            <Input
              id="arch-thinking"
              value={form.thinkingStyle}
              onChange={(e) => setForm((f) => ({ ...f, thinkingStyle: e.target.value }))}
              placeholder="e.g. Analytical Reasoning"
              className="h-9"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="arch-desc" className="text-xs">Description</Label>
            <Textarea
              id="arch-desc"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Describe how this archetype thinks and what it excels at..."
              rows={3}
              className="text-sm resize-none"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="arch-prompt" className="text-xs">System Prompt</Label>
            <Textarea
              id="arch-prompt"
              value={form.systemPrompt}
              onChange={(e) => setForm((f) => ({ ...f, systemPrompt: e.target.value }))}
              placeholder="You are an expert who..."
              rows={4}
              className="text-sm font-mono resize-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="arch-model" className="text-xs">Model</Label>
              <select
                id="arch-model"
                value={form.model}
                onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                className="w-full h-9 text-sm bg-background border border-border rounded-md px-3 text-foreground"
              >
                {store.allModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="arch-temp" className="text-xs">
                Temperature: <span className="font-mono text-muted-foreground">{form.temperature.toFixed(1)}</span>
              </Label>
              <input
                id="arch-temp"
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={form.temperature}
                onChange={(e) => setForm((f) => ({ ...f, temperature: parseFloat(e.target.value) }))}
                className="w-full accent-primary mt-2"
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!form.name.trim()}>
            Save Archetype
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ViewDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  archetype: Archetype | null;
}

function ViewDetailsDialog({ open, onOpenChange, archetype }: ViewDetailsDialogProps) {
  if (!archetype) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="text-2xl">{archetype.icon}</span>
            {archetype.name}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Thinking Style</p>
            <p className="text-sm">{archetype.thinkingStyle}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Description</p>
            <p className="text-sm text-muted-foreground leading-relaxed">{archetype.description}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function ArchetypesPage() {
  const store = useStore();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Archetype | null>(null);
  const [viewTarget, setViewTarget] = useState<Archetype | null>(null);

  // Merge builtins with store custom archetypes
  const customArchetypes: Archetype[] = store.customArchetypes.map((a) => ({
    id: a.id,
    name: a.name,
    icon: a.icon || "🤖",
    color: a.color || "bg-primary/20 border-primary/30",
    thinkingStyle: a.thinkingStyle,
    description: a.description,
    systemPrompt: a.systemPrompt,
    model: a.model,
    temperature: a.temperature,
    isCustom: true,
  }));

  const archetypes = [...builtinArchetypes, ...customArchetypes];

  const handleCreate = (data: FormState) => {
    store.addCustomArchetype({
      name: data.name,
      icon: data.icon || "🤖",
      color: "bg-primary/20 border-primary/30",
      thinkingStyle: data.thinkingStyle,
      description: data.description,
      systemPrompt: data.systemPrompt,
      model: data.model,
      temperature: data.temperature,
    });
  };

  const handleEdit = (data: FormState) => {
    if (!editTarget) return;
    if (editTarget.isCustom) {
      store.updateArchetype(editTarget.id, {
        name: data.name,
        icon: data.icon || editTarget.icon,
        thinkingStyle: data.thinkingStyle,
        description: data.description,
        systemPrompt: data.systemPrompt,
        model: data.model,
        temperature: data.temperature,
      });
    }
    setEditTarget(null);
  };

  const handleDelete = (id: string) => {
    store.removeArchetype(id);
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Users className="size-6 text-muted-foreground" />
            <div>
              <h1 className="text-xl font-semibold">Archetypes</h1>
              <p className="text-sm text-muted-foreground">
                AI reasoning personas that bring diverse perspectives to your council
              </p>
            </div>
          </div>
          <Button size="sm" className="gap-2" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5" />
            Create Custom
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {archetypes.map((arch) => (
            <Card
              key={arch.id}
              className={`group cursor-pointer hover:ring-2 hover:ring-primary/20 transition-all border ${arch.color}`}
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl">{arch.icon}</span>
                    <div>
                      <CardTitle className="text-sm">{arch.name}</CardTitle>
                      <span className="text-[11px] text-muted-foreground">{arch.thinkingStyle}</span>
                    </div>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 shrink-0 -mr-1 -mt-1 opacity-0 group-hover:opacity-100 hover:opacity-100 focus:opacity-100"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreHorizontal className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          setViewTarget(arch);
                        }}
                      >
                        <Eye className="size-3.5 mr-2" />
                        View Details
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditTarget(arch);
                        }}
                      >
                        <Pencil className="size-3.5 mr-2" />
                        Edit
                      </DropdownMenuItem>
                      {arch.isCustom && (
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(arch.id);
                          }}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="size-3.5 mr-2" />
                          Delete
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {arch.description}
                </p>
                {arch.isCustom && (
                  <div className="mt-2 flex items-center gap-1.5">
                    <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-medium">
                      Custom
                    </span>
                    {arch.model && (
                      <span className="text-[10px] text-muted-foreground">{arch.model}</span>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Create dialog */}
      <ArchetypeDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSave={handleCreate}
        title="Create Custom Archetype"
      />

      {/* Edit dialog */}
      <ArchetypeDialog
        open={!!editTarget}
        onOpenChange={(o) => { if (!o) setEditTarget(null); }}
        onSave={handleEdit}
        initial={
          editTarget
            ? {
                name: editTarget.name,
                icon: editTarget.icon,
                thinkingStyle: editTarget.thinkingStyle,
                description: editTarget.description,
                systemPrompt: editTarget.systemPrompt ?? "",
                model: editTarget.model ?? "claude-sonnet-4-6",
                temperature: editTarget.temperature ?? 0.7,
              }
            : undefined
        }
        title="Edit Archetype"
      />

      {/* View Details dialog */}
      <ViewDetailsDialog
        open={!!viewTarget}
        onOpenChange={(o) => { if (!o) setViewTarget(null); }}
        archetype={viewTarget}
      />
    </div>
  );
}
