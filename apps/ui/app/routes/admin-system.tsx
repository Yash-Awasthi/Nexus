// SPDX-License-Identifier: Apache-2.0
import { Pencil, Check, X, Loader2 } from "lucide-react";
import { useState, useEffect } from "react";

import { Page, PageHeader } from "~/components/page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Input } from "~/components/ui/input";

interface ConfigEntry {
  key: string;
  value: string;
  type: string;
}

export default function AdminSystemPage() {
  const [configs, setConfigs] = useState<ConfigEntry[]>([]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // ── Fetch config from backend ─────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/system/config")
      .then((r) =>
        r.ok ? (r.json() as Promise<{ configs?: ConfigEntry[] }>) : Promise.reject(r.status),
      )
      .then((data) => {
        setConfigs(data.configs ?? []);
      })
      .catch((status) =>
        setError(
          status === 403 ? "Only admins can view system settings." : "Could not load settings.",
        ),
      )
      .finally(() => setLoading(false));
  }, []);

  const startEdit = (key: string, value: string) => {
    setEditingKey(key);
    setEditValue(value);
  };

  const cancelEdit = () => {
    setEditingKey(null);
    setEditValue("");
  };

  const saveEdit = async (key: string) => {
    setSaving(true);
    setError("");
    const r = await fetch(`/api/system/config/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: editValue }),
    }).catch(() => null);
    if (r?.ok) {
      setConfigs((prev) => prev.map((c) => (c.key === key ? { ...c, value: editValue } : c)));
      setEditingKey(null);
      setEditValue("");
    } else {
      setError(
        ((await r?.json().catch(() => null)) as { error?: string } | null)?.error ?? "Save failed",
      );
    }
    setSaving(false);
  };

  return (
    <Page width="default">
      <PageHeader
        title="System"
        description="The default model for built-in tools, and maintenance mode."
        actions={saving && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      >
        {error && <p className="text-sm text-destructive">{error}</p>}
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>Configuration Keys</CardTitle>
          <CardDescription>
            Edit system configuration values. Changes take effect immediately.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">
                      Key
                    </th>
                    <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">
                      Value
                    </th>
                    <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">
                      Type
                    </th>
                    <th className="text-right text-xs font-medium text-muted-foreground px-4 py-3">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {configs.map((config) => (
                    <tr key={config.key} className="border-b border-border/50 hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <code className="text-sm font-mono text-primary">{config.key}</code>
                      </td>
                      <td className="px-4 py-3">
                        {editingKey === config.key ? (
                          <Input
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            className="h-7 font-mono text-sm max-w-md"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveEdit(config.key);
                              if (e.key === "Escape") cancelEdit();
                            }}
                          />
                        ) : (
                          <code className="text-sm font-mono text-muted-foreground break-all">
                            {config.value}
                          </code>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className="text-[10px]">
                          {config.type}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {editingKey === config.key ? (
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              onClick={() => saveEdit(config.key)}
                            >
                              <Check className="size-3 text-success" />
                            </Button>
                            <Button variant="ghost" size="icon-xs" onClick={cancelEdit}>
                              <X className="size-3 text-destructive" />
                            </Button>
                          </div>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => startEdit(config.key, config.value)}
                          >
                            <Pencil className="size-3" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </Page>
  );
}
