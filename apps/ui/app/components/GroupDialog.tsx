// SPDX-License-Identifier: Apache-2.0
/**
 * GroupDialog — create, rename, delete project groups.
 * Adapted from mission-control GroupsDialog.
 */
import { useState } from "react";
import { Plus, Pencil, Trash2, X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import type { Group } from "./MissionControlDashboard";

interface GroupDialogProps {
  isOpen: boolean;
  onClose: () => void;
  groups: Group[];
  onGroupsChange: (groups: Group[]) => void;
}

const COLORS = [
  "#6366f1",
  "#ec4899",
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#ef4444",
  "#06b6d4",
];

export function GroupDialog({ isOpen, onClose, groups, onGroupsChange }: GroupDialogProps) {
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(COLORS[0]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  if (!isOpen) return null;

  async function createGroup() {
    if (!newName.trim()) return;
    const res = await fetch("/api/v1/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), color: newColor }),
    });
    if (res.ok) {
      const group = await res.json();
      onGroupsChange([...groups, group]);
      setNewName("");
    }
  }

  async function renameGroup(id: string) {
    if (!editName.trim()) return;
    await fetch(`/api/v1/groups/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: editName.trim() }),
    });
    onGroupsChange(groups.map((g) => (g.id === id ? { ...g, name: editName.trim() } : g)));
    setEditingId(null);
  }

  async function deleteGroup(id: string) {
    if (!confirm("Remove group? Projects will be ungrouped.")) return;
    await fetch(`/api/v1/groups/${id}`, { method: "DELETE" });
    onGroupsChange(groups.filter((g) => g.id !== id));
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-card border rounded-xl p-6 w-full max-w-md shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold">Manage Groups</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Create new group */}
        <div className="flex gap-2 mb-5">
          <div className="flex gap-1">
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setNewColor(c)}
                className={`w-5 h-5 rounded-full border-2 ${
                  newColor === c ? "border-white scale-110" : "border-transparent"
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
          <Input
            placeholder="Group name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createGroup()}
            className="flex-1"
          />
          <Button size="sm" onClick={createGroup} disabled={!newName.trim()}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        {/* Existing groups */}
        <div className="space-y-2">
          {groups.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">No groups yet</p>
          )}
          {groups.map((g) => (
            <div key={g.id} className="flex items-center gap-2 p-2 rounded-lg hover:bg-muted/50">
              <span
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ backgroundColor: g.color }}
              />
              {editingId === g.id ? (
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && renameGroup(g.id)}
                  className="flex-1 h-8"
                  autoFocus
                />
              ) : (
                <span className="flex-1 text-sm">{g.name}</span>
              )}
              <button
                onClick={() => {
                  setEditingId(g.id);
                  setEditName(g.name);
                }}
                className="p-1 rounded hover:bg-muted"
              >
                <Pencil className="h-3 w-3 text-muted-foreground" />
              </button>
              <button
                onClick={() => deleteGroup(g.id)}
                className="p-1 rounded hover:bg-destructive/10"
              >
                <Trash2 className="h-3 w-3 text-destructive" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
