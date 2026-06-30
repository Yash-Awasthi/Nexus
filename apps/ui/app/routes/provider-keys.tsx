// SPDX-License-Identifier: Apache-2.0
/**
 * Provider Keys — per-user BYOK LLM API key management.
 *
 * Keys are encrypted at rest by the backend and never returned after creation;
 * this page only ever shows the provider + masked prefix.
 *
 * API (all auth'd via authFetch):
 *   GET    /api/user/provider-keys      — list (no secrets)
 *   POST   /api/user/provider-keys      — store { provider, apiKey, label? }
 *   DELETE /api/user/provider-keys/:id  — remove
 */
import { Key, Plus, Trash2, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { useState, useEffect, useCallback } from "react";

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
import { authFetch } from "~/lib/api";

const PROVIDERS = [
  "openai",
  "anthropic",
  "groq",
  "gemini",
  "deepseek",
  "mistral",
  "openrouter",
  "xai",
  "together",
  "perplexity",
  "cohere",
  "bedrock",
  "vertex",
] as const;

/**
 * Providers whose credential is NOT a single key but a composite. The backend
 * stores the whole thing as one JSON blob in the same `apiKey` field and parses
 * it at driver-construction time (see apps/api/src/lib/provider-keys.ts). The UI
 * just collects the parts here and serialises them to that JSON blob on save.
 */
type CompositeField = {
  name: string;
  label: string;
  type?: "text" | "password";
  required: boolean;
  placeholder?: string;
};
const COMPOSITE_FIELDS: Record<string, CompositeField[]> = {
  bedrock: [
    { name: "accessKeyId", label: "Access Key ID", required: true },
    { name: "secretAccessKey", label: "Secret Access Key", type: "password", required: true },
    { name: "region", label: "Region", required: false, placeholder: "us-east-1" },
    { name: "sessionToken", label: "Session token (optional)", type: "password", required: false },
  ],
  vertex: [
    { name: "apiKey", label: "Access token", type: "password", required: true },
    { name: "project", label: "GCP project ID", required: true },
    { name: "region", label: "Region", required: false, placeholder: "us-central1" },
  ],
};

interface ProviderKey {
  id: string;
  provider: string;
  label?: string | null;
  keyPrefix?: string | null;
  createdAt: string;
  lastUsedAt?: string | null;
}

export default function ProviderKeysPage() {
  const [keys, setKeys] = useState<ProviderKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [dialogOpen, setDialogOpen] = useState(false);
  const [provider, setProvider] = useState<string>("groq");
  const [apiKey, setApiKey] = useState("");
  const [composite, setComposite] = useState<Record<string, string>>({});
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);

  const compositeFields = COMPOSITE_FIELDS[provider];
  const compositeValid =
    !compositeFields || compositeFields.every((f) => !f.required || (composite[f.name] ?? "").trim());
  const canSave = compositeFields ? compositeValid : apiKey.length >= 8;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await authFetch("/api/user/provider-keys");
      if (res.status === 401) throw new Error("Please sign in to manage provider keys.");
      if (!res.ok) throw new Error(`Failed to load keys (${res.status})`);
      const data = (await res.json()) as { keys: ProviderKey[] };
      setKeys(data.keys ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load keys");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const addKey = async () => {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      // Composite providers (bedrock/vertex) serialise their fields into the
      // same apiKey field as a JSON blob; the backend parses it on use.
      const keyBody = compositeFields
        ? JSON.stringify(
            Object.fromEntries(
              compositeFields
                .map((f) => [f.name, (composite[f.name] ?? "").trim()] as const)
                .filter(([, v]) => v !== ""),
            ),
          )
        : apiKey;
      const res = await authFetch("/api/user/provider-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: keyBody, label: label || undefined }),
      });
      if (res.status === 503)
        throw new Error("Server encryption is not configured. Contact admin.");
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed to save key (${res.status})`);
      }
      setSuccess(`Saved ${provider} key.`);
      setDialogOpen(false);
      setApiKey("");
      setComposite({});
      setLabel("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save key");
    } finally {
      setSaving(false);
    }
  };

  const deleteKey = async (id: string) => {
    setError("");
    try {
      const res = await authFetch(`/api/user/provider-keys/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Failed to delete key (${res.status})`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete key");
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Key className="size-5" /> Provider Keys
          </h1>
          <p className="text-sm text-muted-foreground">
            Your LLM provider API keys, encrypted at rest. Used for council and god-mode requests.
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)} className="gap-2">
          <Plus className="size-4" /> Add key
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
      ) : keys.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No provider keys yet. Add one to start running council / god-mode.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {keys.map((k) => (
            <Card key={k.id}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 py-4">
                <div className="space-y-0.5">
                  <CardTitle className="text-base capitalize">{k.provider}</CardTitle>
                  <CardDescription>
                    {k.keyPrefix ? `${k.keyPrefix}…` : "••••"}
                    {k.label ? ` · ${k.label}` : ""} · added{" "}
                    {new Date(k.createdAt).toLocaleDateString()}
                  </CardDescription>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => deleteKey(k.id)}
                  aria-label={`Delete ${k.provider} key`}
                >
                  <Trash2 className="size-4 text-destructive" />
                </Button>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add provider key</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Provider</Label>
              <Select
                value={provider}
                onValueChange={(p) => {
                  setProvider(p);
                  setApiKey("");
                  setComposite({});
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p} value={p} className="capitalize">
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {compositeFields ? (
              compositeFields.map((f) => (
                <div key={f.name} className="space-y-1.5">
                  <Label htmlFor={f.name}>{f.label}</Label>
                  <Input
                    id={f.name}
                    type={f.type ?? "text"}
                    placeholder={f.placeholder}
                    value={composite[f.name] ?? ""}
                    onChange={(e) => setComposite((c) => ({ ...c, [f.name]: e.target.value }))}
                    autoComplete="off"
                  />
                </div>
              ))
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="apiKey">API key</Label>
                <Input
                  id="apiKey"
                  type="password"
                  placeholder="sk-…"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="label">Label (optional)</Label>
              <Input
                id="label"
                placeholder="e.g. personal"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={addKey} disabled={saving || !canSave}>
              {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
