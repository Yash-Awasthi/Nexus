// SPDX-License-Identifier: Apache-2.0
/**
 * Feature Flags — Admin management of feature flags.
 *
 * API:
 *   GET    /api/feature-flags/admin/flags          — list all flags
 *   POST   /api/feature-flags/admin/flags          — create flag
 *   PUT    /api/feature-flags/admin/flags/:id      — update flag
 *   DELETE /api/feature-flags/admin/flags/:id      — delete flag
 *   PUT    /api/feature-flags/admin/flags/:id/users/:userId — add user override
 */
import { useState, useEffect, useCallback } from "react";
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
  ToggleLeft,
  ToggleRight,
  Plus,
  Trash2,
  Loader2,
  RefreshCw,
  Flag,
  Users,
  Percent,
  CheckCircle,
  XCircle,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface FeatureFlag {
  id: string;
  key: string;
  description?: string;
  enabled: boolean;
  rolloutPercent?: number;
  userOverrides?: Record<string, boolean>;
  groupOverrides?: Record<string, boolean>;
  createdAt: string;
  updatedAt: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AdminFeatureFlags() {
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newFlag, setNewFlag] = useState({
    key: "",
    description: "",
    rolloutPercent: "100",
  });
  const [creating, setCreating] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState("");
  const [err, setErr] = useState("");

  const loadFlags = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/feature-flags/admin/flags");
      if (r.ok) {
        const d = await r.json();
        setFlags(d.flags ?? d);
      }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    loadFlags();
  }, [loadFlags]);

  const createFlag = useCallback(async () => {
    if (!newFlag.key.trim()) {
      setErr("Key is required");
      return;
    }
    setCreating(true);
    setErr("");
    try {
      const r = await fetch("/api/feature-flags/admin/flags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: newFlag.key.trim().toLowerCase().replace(/\s+/g, "_"),
          description: newFlag.description.trim(),
          rolloutPercent: parseInt(newFlag.rolloutPercent) || 100,
          enabled: false,
        }),
      });
      if (!r.ok) {
        const d = await r.json();
        setErr(d.error ?? "Create failed");
        return;
      }
      setShowCreate(false);
      setNewFlag({ key: "", description: "", rolloutPercent: "100" });
      loadFlags();
    } catch {
      setErr("Create failed");
    } finally {
      setCreating(false);
    }
  }, [newFlag, loadFlags]);

  const toggleFlag = useCallback(async (flag: FeatureFlag) => {
    setToggling(flag.id);
    try {
      await fetch(`/api/feature-flags/admin/flags/${flag.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...flag, enabled: !flag.enabled }),
      });
      setFlags((prev) => prev.map((f) => (f.id === flag.id ? { ...f, enabled: !f.enabled } : f)));
    } catch {}
    setToggling(null);
  }, []);

  const updateRollout = useCallback(async (flag: FeatureFlag, pct: number) => {
    try {
      await fetch(`/api/feature-flags/admin/flags/${flag.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...flag, rolloutPercent: pct }),
      });
      setFlags((prev) => prev.map((f) => (f.id === flag.id ? { ...f, rolloutPercent: pct } : f)));
    } catch {}
  }, []);

  const deleteFlag = useCallback(async (id: string) => {
    if (!confirm("Delete this feature flag?")) return;
    setDeleting(id);
    try {
      await fetch(`/api/feature-flags/admin/flags/${id}`, { method: "DELETE" });
      setFlags((prev) => prev.filter((f) => f.id !== id));
    } catch {}
    setDeleting(null);
  }, []);

  const filtered = flags.filter(
    (f) =>
      f.key.toLowerCase().includes(searchFilter.toLowerCase()) ||
      (f.description ?? "").toLowerCase().includes(searchFilter.toLowerCase()),
  );

  const enabledCount = flags.filter((f) => f.enabled).length;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Flag className="w-6 h-6 text-orange-500" />
            Feature Flags
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {enabledCount} of {flags.length} flags enabled
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={loadFlags}>
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="w-4 h-4 mr-1" />
            New flag
          </Button>
        </div>
      </div>

      {/* Search */}
      <Input
        placeholder="Search flags…"
        value={searchFilter}
        onChange={(e) => setSearchFilter(e.target.value)}
        className="max-w-sm"
      />

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Total</p>
            <p className="text-2xl font-bold">{flags.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Enabled</p>
            <p className="text-2xl font-bold text-green-600">{enabledCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Disabled</p>
            <p className="text-2xl font-bold text-slate-500">{flags.length - enabledCount}</p>
          </CardContent>
        </Card>
      </div>

      {/* Flag list */}
      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading flags…
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="pt-8 pb-8 text-center space-y-3">
            <Flag className="w-12 h-12 mx-auto text-muted-foreground opacity-40" />
            <p className="text-muted-foreground">
              {searchFilter ? `No flags match "${searchFilter}"` : "No flags yet"}
            </p>
            {!searchFilter && (
              <Button size="sm" onClick={() => setShowCreate(true)}>
                Create first flag
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((flag) => (
            <Card key={flag.id} className={flag.enabled ? "" : "opacity-75"}>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-start gap-4">
                  {/* Toggle */}
                  <button
                    onClick={() => toggleFlag(flag)}
                    disabled={toggling === flag.id}
                    className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {toggling === flag.id ? (
                      <Loader2 className="w-6 h-6 animate-spin" />
                    ) : flag.enabled ? (
                      <ToggleRight className="w-8 h-8 text-green-500" />
                    ) : (
                      <ToggleLeft className="w-8 h-8" />
                    )}
                  </button>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <code className="text-sm font-mono font-medium">{flag.key}</code>
                      <Badge
                        className={
                          flag.enabled
                            ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
                            : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                        }
                      >
                        {flag.enabled ? (
                          <CheckCircle className="w-2.5 h-2.5 mr-1" />
                        ) : (
                          <XCircle className="w-2.5 h-2.5 mr-1" />
                        )}
                        {flag.enabled ? "on" : "off"}
                      </Badge>
                    </div>

                    {flag.description && (
                      <p className="text-xs text-muted-foreground mt-1">{flag.description}</p>
                    )}

                    {/* Rollout */}
                    <div className="flex items-center gap-2 mt-2">
                      <Percent className="w-3 h-3 text-muted-foreground shrink-0" />
                      <div className="flex items-center gap-2 flex-1">
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={flag.rolloutPercent ?? 100}
                          onChange={(e) => updateRollout(flag, parseInt(e.target.value))}
                          className="w-32 h-1.5 accent-primary"
                        />
                        <span className="text-xs text-muted-foreground w-10">
                          {flag.rolloutPercent ?? 100}%
                        </span>
                      </div>

                      {/* User overrides count */}
                      {flag.userOverrides && Object.keys(flag.userOverrides).length > 0 && (
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Users className="w-3 h-3" />
                          {Object.keys(flag.userOverrides).length} override
                          {Object.keys(flag.userOverrides).length > 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                  </div>

                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-red-500 hover:bg-red-50 hover:text-red-600 shrink-0"
                    onClick={() => deleteFlag(flag.id)}
                    disabled={deleting === flag.id}
                  >
                    {deleting === flag.id ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Trash2 className="w-3 h-3" />
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New Feature Flag</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Key *</label>
              <Input
                placeholder="e.g. enable_new_chat_ui"
                value={newFlag.key}
                onChange={(e) => setNewFlag((f) => ({ ...f, key: e.target.value }))}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">Lowercase, underscores only</p>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Description</label>
              <Input
                placeholder="What does this flag control?"
                value={newFlag.description}
                onChange={(e) => setNewFlag((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Rollout %</label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={parseInt(newFlag.rolloutPercent) || 100}
                  onChange={(e) => setNewFlag((f) => ({ ...f, rolloutPercent: e.target.value }))}
                  className="flex-1 accent-primary"
                />
                <span className="text-sm font-medium w-10 text-right">
                  {newFlag.rolloutPercent}%
                </span>
              </div>
            </div>
            {err && <p className="text-red-500 text-xs">{err}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button onClick={createFlag} disabled={creating || !newFlag.key.trim()}>
              {creating ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Create (disabled by default)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
