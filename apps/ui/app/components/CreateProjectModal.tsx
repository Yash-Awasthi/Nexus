// SPDX-License-Identifier: Apache-2.0
import React, { useState, useEffect } from "react";

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

interface CreateProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (project: Project) => void;
}

const ICON_COLORS = ["#6366f1", "#ec4899", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ef4444", "#06b6d4"];

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "hsl(var(--background))",
  border: "1px solid hsl(var(--border))",
  color: "hsl(var(--foreground))",
  borderRadius: 6,
  padding: "8px 12px",
  fontSize: 14,
  outline: "none",
  boxSizing: "border-box",
};

export function CreateProjectModal({ isOpen, onClose, onCreated }: CreateProjectModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [iconColor, setIconColor] = useState(ICON_COLORS[0]);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      fetch("/api/v1/groups")
        .then((r) => r.json())
        .then((d) => setGroups(d.groups ?? []));
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const icon = name.trim().slice(0, 2).toUpperCase() || "??";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/v1/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          icon,
          iconColor,
          groupId,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        onCreated(data);
      } else {
        onCreated({
          id: Date.now().toString(),
          name: name.trim(),
          description: description.trim(),
          icon,
          iconColor,
          groupId,
          pinned: false,
          conversationCount: 0,
          taskCounts: { running: 0, needsInput: 0, done: 0 },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    } catch {
      onCreated({
        id: Date.now().toString(),
        name: name.trim(),
        description: description.trim(),
        icon,
        iconColor,
        groupId,
        pinned: false,
        conversationCount: 0,
        taskCounts: { running: 0, needsInput: 0, done: 0 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    setLoading(false);
    setName("");
    setDescription("");
    setIconColor(ICON_COLORS[0]);
    setGroupId(null);
    onClose();
  }

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-card border rounded-xl p-6 w-[480px] max-w-[90vw] shadow-xl"
      >
        <div className="flex items-center gap-3 mb-5">
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center text-sm font-bold text-white"
            style={{ backgroundColor: iconColor }}
          >
            {icon}
          </div>
          <h2 className="text-lg font-semibold">New Project</h2>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="mb-3">
            <label className="block text-xs text-muted-foreground mb-1">Name *</label>
            <input
              style={inputStyle}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Project"
              required
              autoFocus
            />
          </div>

          <div className="mb-3">
            <label className="block text-xs text-muted-foreground mb-1">Description</label>
            <textarea
              style={{ ...inputStyle, minHeight: 60, resize: "vertical" }}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What's this project for?"
            />
          </div>

          <div className="mb-3">
            <label className="block text-xs text-muted-foreground mb-1">Color</label>
            <div className="flex gap-1.5">
              {ICON_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setIconColor(c)}
                  className={`w-6 h-6 rounded-full border-2 transition-transform ${
                    iconColor === c ? "border-white scale-110" : "border-transparent"
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>

          {groups.length > 0 && (
            <div className="mb-4">
              <label className="block text-xs text-muted-foreground mb-1">Group</label>
              <select
                style={{ ...inputStyle, cursor: "pointer" }}
                value={groupId ?? ""}
                onChange={(e) => setGroupId(e.target.value || null)}
              >
                <option value="">Ungrouped</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
          )}

          {error && <div className="text-destructive text-xs mb-3">{error}</div>}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-muted-foreground hover:bg-muted rounded-md"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !name.trim()}
              className="px-4 py-2 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "Creating…" : "Create Project"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
