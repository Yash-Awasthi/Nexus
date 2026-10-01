// SPDX-License-Identifier: Apache-2.0
import {
  Loader2,
  FolderOpen,
  Plus,
  MessageSquare,
  MoreVertical,
  Pencil,
  Trash2,
  ChevronLeft,
  Paperclip,
  Brain,
  BookOpen,
  Building2,
} from "lucide-react";
import { useState, useEffect } from "react";

import { ProjectFileAttachments } from "~/components/ProjectFileAttachments";
import { ProjectInstructions } from "~/components/ProjectInstructions";
import { ProjectMemoryPanel } from "~/components/ProjectMemoryPanel";
import { ProjectCompany } from "~/components/org/ProjectCompany";
import { EmptyState } from "~/components/page";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
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
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { apiFetch } from "~/lib/api";

interface Project {
  id: string;
  name: string;
  description: string;
  conversationCount: number;
  createdAt: string;
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [editProject, setEditProject] = useState<Project | null>(null);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [activeTab, setActiveTab] = useState<"memory" | "files" | "instructions" | "company">(
    "memory",
  );
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  // ── Load projects ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { projects: list } = await apiFetch<{ projects: Project[] }>("/api/v1/projects");
        if (!cancelled) setProjects(list);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openNew = () => {
    setName("");
    setDescription("");
    setNewProjectOpen(true);
  };

  const openEdit = (project: Project) => {
    setName(project.name);
    setDescription(project.description);
    setEditProject(project);
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const created = await apiFetch<Project>("/api/v1/projects", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), description: description.trim() }),
      });
      setProjects((prev) => [created, ...prev]);
      setNewProjectOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create project");
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async () => {
    if (!editProject || !name.trim()) return;
    setSaving(true);
    try {
      const updated = await apiFetch<Project>(`/api/v1/projects/${editProject.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim(), description: description.trim() }),
      });
      setProjects((prev) => prev.map((p) => (p.id === editProject.id ? updated : p)));
      setEditProject(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update project");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this project?")) return;
    try {
      await apiFetch(`/api/v1/projects/${id}`, { method: "DELETE" });
      setProjects((prev) => prev.filter((p) => p.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete project");
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // ── Project detail panel ───────────────────────────────────────────────────
  if (selectedProject) {
    const tabs: { id: typeof activeTab; icon: React.ElementType; label: string }[] = [
      { id: "memory", icon: Brain, label: "Memory" },
      { id: "files", icon: Paperclip, label: "Files" },
      { id: "instructions", icon: BookOpen, label: "Instructions" },
      { id: "company", icon: Building2, label: "Company" },
    ];
    return (
      <div className="flex-1 flex flex-col overflow-hidden h-full">
        {/* Detail header */}
        <div className="border-b border-border px-5 py-3 flex items-center gap-3 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-xs"
            onClick={() => setSelectedProject(null)}
          >
            <ChevronLeft className="size-3.5" /> All Projects
          </Button>
          <div className="h-4 w-px bg-border" />
          <FolderOpen className="size-4 text-muted-foreground" />
          <span className="font-medium text-sm">{selectedProject.name}</span>
          {selectedProject.description && (
            <span className="text-xs text-muted-foreground hidden sm:block truncate max-w-xs">
              {selectedProject.description}
            </span>
          )}
          <div className="ml-auto flex gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs h-7"
              onClick={() => openEdit(selectedProject)}
            >
              <Pencil className="size-3" /> Edit
            </Button>
          </div>
        </div>

        {/* Tabs */}
        <div className="border-b border-border px-5 flex gap-1 shrink-0">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 transition-colors ${
                activeTab === t.id
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <t.icon className="size-3.5" />
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-5">
          {activeTab === "memory" && <ProjectMemoryPanel projectId={selectedProject.id} />}
          {activeTab === "files" && <ProjectFileAttachments projectId={selectedProject.id} />}
          {activeTab === "instructions" && <ProjectInstructions projectId={selectedProject.id} />}
          {activeTab === "company" && (
            <ProjectCompany projectId={selectedProject.id} projectName={selectedProject.name} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {error && (
        <div className="fixed top-4 right-4 z-50 bg-destructive text-destructive-foreground text-xs px-3 py-2 rounded-md shadow-lg flex items-center gap-2">
          {error}
          <button onClick={() => setError(null)} className="font-bold">
            ✕
          </button>
        </div>
      )}
      <div className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h1 className="text-2xl font-semibold">Projects</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Group work around a goal: its instructions, files, notes and the company that works on
              it.
            </p>
          </div>
          <Button size="sm" className="gap-2" onClick={openNew}>
            <Plus className="size-3.5" />
            New Project
          </Button>
        </div>

        {/* Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((project) => (
            <Card
              key={project.id}
              className="cursor-pointer hover:ring-2 hover:ring-primary/20 transition-all"
              onClick={() => {
                setSelectedProject(project);
                setActiveTab("memory");
              }}
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-sm truncate">{project.name}</CardTitle>
                    <CardDescription className="text-xs mt-1">
                      {project.description}
                    </CardDescription>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreVertical className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          openEdit(project);
                        }}
                        className="gap-2 text-xs"
                      >
                        <Pencil className="size-3" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(project.id);
                        }}
                        className="gap-2 text-xs text-destructive focus:text-destructive"
                      >
                        <Trash2 className="size-3" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <MessageSquare className="size-3" />
                    {project.conversationCount} conversation
                    {project.conversationCount !== 1 ? "s" : ""}
                  </span>
                  <span>{project.createdAt}</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {projects.length === 0 && (
          <EmptyState
            icon={FolderOpen}
            title="No projects yet"
            description="A project keeps the instructions, files and notes for one goal together, and can have a company working on it."
            action={
              <Button size="sm" onClick={openNew}>
                <Plus /> New project
              </Button>
            }
          />
        )}
      </div>

      {/* New Project Dialog */}
      <Dialog open={newProjectOpen} onOpenChange={setNewProjectOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New Project</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="proj-name">Name</Label>
              <Input
                id="proj-name"
                placeholder="Project name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="proj-desc">Description</Label>
              <Textarea
                id="proj-desc"
                placeholder="What is this project about?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewProjectOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={!name.trim() || saving} className="gap-2">
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              Create Project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Project Dialog */}
      <Dialog open={!!editProject} onOpenChange={(open) => !open && setEditProject(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Project</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                placeholder="Project name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-desc">Description</Label>
              <Textarea
                id="edit-desc"
                placeholder="What is this project about?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditProject(null)}>
              Cancel
            </Button>
            <Button onClick={handleUpdate} disabled={!name.trim() || saving} className="gap-2">
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
