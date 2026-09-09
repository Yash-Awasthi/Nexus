// SPDX-License-Identifier: Apache-2.0
/**
 * ProjectCard — mission-control style project card with status pills,
 * shimmer animation for running tasks, pin toggle.
 */
import { useState } from "react";
import { Pin, PinOff, MoreVertical, Trash2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import type { Project } from "./MissionControlDashboard";

interface ProjectCardProps {
  project: Project;
  size: string;
  onRefresh: () => void;
}

export function ProjectCard({ project, size, onRefresh }: ProjectCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { taskCounts } = project;
  const hasRunning = taskCounts.running > 0;

  async function togglePin() {
    await fetch(`/api/v1/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: !project.pinned }),
    });
    onRefresh();
  }

  async function deleteProject() {
    if (!confirm(`Remove "${project.name}"? This won't delete files.`)) return;
    await fetch(`/api/v1/projects/${project.id}`, { method: "DELETE" });
    onRefresh();
    setMenuOpen(false);
  }

  return (
    <div
      className={`group relative rounded-lg border bg-card p-4 ${size} transition-all hover:border-primary/50 hover:shadow-md cursor-pointer`}
    >
      {/* Shimmer bar for running tasks */}
      {hasRunning && (
        <div className="absolute top-0 left-0 right-0 h-0.5 rounded-t-lg overflow-hidden">
          <div className="h-full w-full animate-[shimmer_2s_infinite] bg-gradient-to-r from-transparent via-primary/60 to-transparent" />
        </div>
      )}

      {/* Header: icon + name + pin */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <div
            className="w-8 h-8 rounded-md flex items-center justify-center text-xs font-bold text-white"
            style={{ backgroundColor: project.iconColor }}
          >
            {project.icon}
          </div>
          <div>
            <h4 className="text-sm font-semibold leading-tight">{project.name}</h4>
            {project.description && (
              <p className="text-xs text-muted-foreground truncate max-w-[180px]">
                {project.description}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              togglePin();
            }}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-muted"
            title={project.pinned ? "Unpin" : "Pin"}
          >
            {project.pinned ? (
              <PinOff className="h-3 w-3 text-primary" />
            ) : (
              <Pin className="h-3 w-3 text-muted-foreground" />
            )}
          </button>

          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(!menuOpen);
              }}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-muted"
            >
              <MoreVertical className="h-3 w-3 text-muted-foreground" />
            </button>
            {menuOpen && (
              <div
                className="absolute right-0 top-full mt-1 z-50 bg-popover border rounded-md shadow-md py-1 min-w-[120px]"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted flex items-center gap-2 text-destructive"
                  onClick={deleteProject}
                >
                  <Trash2 className="h-3 w-3" /> Remove
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Status pills */}
      <div className="flex items-center gap-2 text-xs">
        {taskCounts.running > 0 && (
          <span className="inline-flex items-center gap-1 text-green-400">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            {taskCounts.running} running
          </span>
        )}
        {taskCounts.needsInput > 0 && (
          <span className="inline-flex items-center gap-1 text-amber-400">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            {taskCounts.needsInput} needs input
          </span>
        )}
        {taskCounts.done > 0 && (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50" />
            {taskCounts.done} done
          </span>
        )}
        {taskCounts.running === 0 && taskCounts.needsInput === 0 && taskCounts.done === 0 && (
          <span className="text-muted-foreground">No tasks</span>
        )}
      </div>

      {/* Click to open project detail (placeholder) */}
      {menuOpen && <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />}
    </div>
  );
}
