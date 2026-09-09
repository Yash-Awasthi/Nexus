// SPDX-License-Identifier: Apache-2.0
/**
 * MissionControlDashboard — mission-control inspired project grid.
 *
 * Features: project cards with status pills, shimmer animations, search,
 * density toggle, grouping, pinning. Adapted from AgentSystemLabs/mission-control.
 */
import { useState, useEffect, useMemo } from "react";
import { Search, Grid3X3, LayoutList, Plus, Settings2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ProjectCard } from "./ProjectCard";
import { CreateProjectModal } from "./CreateProjectModal";
import { GroupDialog } from "./GroupDialog";

// ── Types ──────────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  description: string;
  icon: string;
  iconColor: string;
  groupId: string | null;
  pinned: boolean;
  conversationCount: number;
  taskCounts: { running: number; needsInput: number; done: number };
  createdAt: string;
  updatedAt: string;
}

export interface Group {
  id: string;
  name: string;
  color: string;
  createdAt: string;
}

type Density = "compact" | "regular" | "spacious";

// ── Component ──────────────────────────────────────────────────────────────

export function MissionControlDashboard() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [search, setSearch] = useState("");
  const [density, setDensity] = useState<Density>("regular");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showGroupDialog, setShowGroupDialog] = useState(false);
  const [loading, setLoading] = useState(true);

  // Fetch projects and groups
  useEffect(() => {
    Promise.all([
      fetch("/api/v1/projects").then((r) => r.json()),
      fetch("/api/v1/groups").then((r) => r.json()),
    ])
      .then(([projData, grpData]) => {
        setProjects(projData.projects ?? []);
        setGroups(grpData.groups ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Filter by search
  const filtered = useMemo(() => {
    if (!search.trim()) return projects;
    const q = search.toLowerCase();
    return projects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
    );
  }, [projects, search]);

  // Partition: pinned, grouped, ungrouped
  const pinned = filtered.filter((p) => p.pinned);
  const ungrouped = filtered.filter((p) => !p.pinned && !p.groupId);
  const grouped = useMemo(() => {
    const map = new Map<string, Project[]>();
    for (const p of filtered) {
      if (p.pinned || !p.groupId) continue;
      const list = map.get(p.groupId) ?? [];
      list.push(p);
      map.set(p.groupId, list);
    }
    return map;
  }, [filtered]);

  const densityClasses: Record<Density, string> = {
    compact: "gap-3",
    regular: "gap-5",
    spacious: "gap-7",
  };

  const cardSize: Record<Density, string> = {
    compact: "min-h-[140px]",
    regular: "min-h-[180px]",
    spacious: "min-h-[220px]",
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        Loading projects…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Top Bar ────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search projects…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Density toggle */}
        <div className="flex border rounded-md">
          {(["compact", "regular", "spacious"] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDensity(d)}
              className={`px-2 py-1 text-xs ${
                density === d
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {d === "compact" ? (
                <Grid3X3 className="h-3 w-3" />
              ) : d === "regular" ? (
                <LayoutList className="h-3 w-3" />
              ) : (
                <Settings2 className="h-3 w-3" />
              )}
            </button>
          ))}
        </div>

        <Button variant="outline" size="sm" onClick={() => setShowGroupDialog(true)}>
          Groups
        </Button>
        <Button size="sm" onClick={() => setShowCreateModal(true)}>
          <Plus className="h-4 w-4 mr-1" /> New Project
        </Button>
      </div>

      {/* ── Empty State ────────────────────────────────────────────────── */}
      {projects.length === 0 && (
        <div className="text-center py-20 text-muted-foreground">
          <p className="text-lg mb-2">No projects yet</p>
          <p className="text-sm mb-4">Add a project to get started</p>
          <Button onClick={() => setShowCreateModal(true)}>
            <Plus className="h-4 w-4 mr-1" /> Add Project
          </Button>
        </div>
      )}

      {/* ── Pinned Section ─────────────────────────────────────────────── */}
      {pinned.length > 0 && (
        <section>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
            Pinned
          </h3>
          <div
            className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 ${densityClasses[density]}`}
          >
            {pinned.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                size={cardSize[density]}
                onRefresh={refreshProjects}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── Grouped Sections ───────────────────────────────────────────── */}
      {[...grouped.entries()].map(([gid, projs]) => {
        const group = groups.find((g) => g.id === gid);
        return (
          <section key={gid}>
            <h3 className="text-xs font-medium uppercase tracking-wider mb-3 flex items-center gap-2">
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ backgroundColor: group?.color ?? "#6366f1" }}
              />
              {group?.name ?? "Unknown"}
            </h3>
            <div
              className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 ${densityClasses[density]}`}
            >
              {projs.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  size={cardSize[density]}
                  onRefresh={refreshProjects}
                />
              ))}
            </div>
          </section>
        );
      })}

      {/* ── Ungrouped Section ──────────────────────────────────────────── */}
      {ungrouped.length > 0 && (
        <section>
          {grouped.size > 0 || pinned.length > 0 ? (
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
              Ungrouped
            </h3>
          ) : null}
          <div
            className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 ${densityClasses[density]}`}
          >
            {ungrouped.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                size={cardSize[density]}
                onRefresh={refreshProjects}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── Modals ─────────────────────────────────────────────────────── */}
      <CreateProjectModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={(p) => {
          setProjects((prev) => [p as Project, ...prev]);
          setShowCreateModal(false);
        }}
      />
      <GroupDialog
        isOpen={showGroupDialog}
        onClose={() => setShowGroupDialog(false)}
        groups={groups}
        onGroupsChange={setGroups}
      />
    </div>
  );

  function refreshProjects() {
    fetch("/api/v1/projects")
      .then((r) => r.json())
      .then((d) => setProjects(d.projects ?? []));
  }
}
