// SPDX-License-Identifier: Apache-2.0
/**
 * MCP Servers — per-user Model Context Protocol server registry.
 *
 * The server's API key is encrypted at rest by the backend and never returned
 * after creation; this page only shows the masked prefix. "Test connection"
 * makes a live outbound call server-side (SSRF-guarded, socket-pinned) and
 * persists the resulting health + tool list.
 *
 * API (all auth'd via authFetch):
 *   GET    /api/v1/mcp/servers          — list (no secrets)
 *   POST   /api/v1/mcp/servers          — create { name, endpoint, transportType, apiKey?, description? }
 *   PUT    /api/v1/mcp/servers/:id       — update (empty apiKey keeps the stored one)
 *   DELETE /api/v1/mcp/servers/:id       — soft-delete
 *   POST   /api/v1/mcp/servers/:id/test  — live connection test (http transport only)
 */
import {
  Server,
  Plus,
  Trash2,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Pencil,
  Plug,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";

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
import { authFetch } from "~/lib/api";

const TRANSPORTS = ["http", "stdio", "websocket"] as const;
type Transport = (typeof TRANSPORTS)[number];

interface McpServer {
  id: string;
  name: string;
  description?: string | null;
  transportType: Transport;
  endpoint: string;
  keyPrefix?: string | null;
  tools?: string[] | null;
  status?: string | null;
  enabled?: boolean;
  createdAt: string;
  lastHealthCheckAt?: string | null;
}

interface TestResult {
  ok: boolean;
  tools?: string[];
  message?: string;
}

const statusColor = (s?: string | null): string => {
  switch (s) {
    case "active":
      return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
    case "error":
      return "bg-destructive/15 text-destructive";
    default:
      return "bg-muted text-muted-foreground";
  }
};

export default function McpServersPage() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [transportType, setTransportType] = useState<Transport>("http");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  // Per-server test state.
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});

  const canSave = name.trim().length > 0 && endpoint.trim().length > 0;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await authFetch("/api/v1/mcp/servers");
      if (res.status === 401) throw new Error("Please sign in to manage MCP servers.");
      if (!res.ok) throw new Error(`Failed to load servers (${res.status})`);
      const data = (await res.json()) as { servers: McpServer[] };
      setServers(data.servers ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load servers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditingId(null);
    setName("");
    setDescription("");
    setTransportType("http");
    setEndpoint("");
    setApiKey("");
    setDialogOpen(true);
  };

  const openEdit = (s: McpServer) => {
    setEditingId(s.id);
    setName(s.name);
    setDescription(s.description ?? "");
    setTransportType(s.transportType);
    setEndpoint(s.endpoint);
    setApiKey("");
    setDialogOpen(true);
  };

  const save = async () => {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || undefined,
        transportType,
        endpoint: endpoint.trim(),
        // Empty key on edit keeps the stored one; on create it stays unset.
        apiKey: apiKey.trim() || undefined,
      };
      const res = editingId
        ? await authFetch(`/api/v1/mcp/servers/${editingId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        : await authFetch("/api/v1/mcp/servers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
      if (res.status === 503)
        throw new Error("Server encryption is not configured. Contact admin.");
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? `Failed to save server (${res.status})`);
      }
      setSuccess(editingId ? `Updated ${name.trim()}.` : `Added ${name.trim()}.`);
      setDialogOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save server");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setError("");
    try {
      const res = await authFetch(`/api/v1/mcp/servers/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Failed to delete server (${res.status})`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete server");
    }
  };

  const test = async (id: string) => {
    setTesting((t) => ({ ...t, [id]: true }));
    setTestResults((r) => {
      const next = { ...r };
      delete next[id];
      return next;
    });
    try {
      const res = await authFetch(`/api/v1/mcp/servers/${id}/test`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        tools?: string[];
        message?: string;
        error?: string;
      };
      setTestResults((r) => ({
        ...r,
        [id]: {
          ok: res.ok && body.ok !== false,
          tools: body.tools,
          message: body.message ?? body.error,
        },
      }));
      // Refresh so the persisted status badge reflects the test outcome.
      await load();
    } catch (err) {
      setTestResults((r) => ({
        ...r,
        [id]: { ok: false, message: err instanceof Error ? err.message : "Test failed" },
      }));
    } finally {
      setTesting((t) => ({ ...t, [id]: false }));
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Server className="size-5" /> MCP Servers
          </h1>
          <p className="text-sm text-muted-foreground">
            Model Context Protocol servers available to your agents. Keys are encrypted at rest.
          </p>
        </div>
        <Button onClick={openCreate} className="gap-2">
          <Plus className="size-4" /> Add server
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="flex items-start gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          <span>{success}</span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : servers.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No MCP servers yet. Add one to expose its tools to your agents.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {servers.map((s) => {
            const result = testResults[s.id];
            return (
              <Card key={s.id}>
                <CardHeader className="flex flex-row items-start justify-between space-y-0 py-4">
                  <div className="min-w-0 space-y-0.5">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <span className="truncate">{s.name}</span>
                      <Badge variant="outline" className="shrink-0 uppercase">
                        {s.transportType}
                      </Badge>
                      {s.status && (
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${statusColor(s.status)}`}
                        >
                          {s.status}
                        </span>
                      )}
                    </CardTitle>
                    <CardDescription className="truncate">
                      {s.endpoint}
                      {s.keyPrefix ? ` · ${s.keyPrefix}…` : ""}
                      {s.tools && s.tools.length > 0 ? ` · ${s.tools.length} tools` : ""}
                    </CardDescription>
                    {s.description && (
                      <p className="text-xs text-muted-foreground">{s.description}</p>
                    )}
                    {result && (
                      <p
                        className={`text-xs ${result.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}
                      >
                        {result.ok
                          ? `Connected · ${result.tools?.length ?? 0} tools${
                              result.tools && result.tools.length > 0
                                ? ` (${result.tools.slice(0, 5).join(", ")}${result.tools.length > 5 ? "…" : ""})`
                                : ""
                            }`
                          : `Failed: ${result.message ?? "connection error"}`}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => test(s.id)}
                      disabled={testing[s.id]}
                      aria-label={`Test ${s.name}`}
                      title={s.transportType === "http" ? "Test connection" : "Only http is testable"}
                    >
                      {testing[s.id] ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Plug className="size-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openEdit(s)}
                      aria-label={`Edit ${s.name}`}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => remove(s.id)}
                      aria-label={`Delete ${s.name}`}
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  </div>
                </CardHeader>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit MCP server" : "Add MCP server"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="mcp-name">Name</Label>
              <Input
                id="mcp-name"
                placeholder="e.g. github-tools"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Transport</Label>
              <Select value={transportType} onValueChange={(t) => setTransportType(t as Transport)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRANSPORTS.map((t) => (
                    <SelectItem key={t} value={t} className="uppercase">
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mcp-endpoint">Endpoint</Label>
              <Input
                id="mcp-endpoint"
                placeholder="https://mcp.example.com/sse"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mcp-key">
                API key {editingId ? "(leave blank to keep current)" : "(optional)"}
              </Label>
              <Input
                id="mcp-key"
                type="password"
                placeholder="••••••••"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mcp-desc">Description (optional)</Label>
              <Textarea
                id="mcp-desc"
                placeholder="What this server provides…"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving || !canSave}>
              {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              {editingId ? "Save changes" : "Add server"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
