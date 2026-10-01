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
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";

import { EmptyState, Page, PageHeader, Section } from "~/components/page";
import { Button } from "~/components/ui/button";
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { authFetch } from "~/lib/api";

const PROVIDERS = [
  ["groq", "Groq", "chat"],
  ["gemini", "Google Gemini", "chat"],
  ["mistral", "Mistral", "chat"],
  ["openai", "OpenAI", "chat"],
  ["anthropic", "Anthropic", "chat"],
  ["deepseek", "DeepSeek", "chat"],
  ["openrouter", "OpenRouter", "chat"],
  ["xai", "xAI", "chat"],
  ["together", "Together AI", "chat"],
  ["perplexity", "Perplexity", "chat"],
  ["cohere", "Cohere", "chat"],
  ["bedrock", "AWS Bedrock", "chat"],
  ["vertex", "Google Vertex", "chat"],
  ["tavily", "Tavily (web search)", "tool"],
  ["exa", "Exa (web search)", "tool"],
  ["github", "GitHub (code context)", "tool"],
] as const;
const LABEL: Record<string, string> = Object.fromEntries(
  PROVIDERS.map(([id, label]) => [id, label]),
);
/** Providers with a free tier, and where to get a key. */
const FREE = [
  ["Groq", "https://console.groq.com/keys"],
  ["Google AI Studio", "https://aistudio.google.com/apikey"],
  ["Mistral", "https://console.mistral.ai/api-keys"],
] as const;
// Not a provider: any OpenAI-compatible endpoint, saved under a name the user picks.
const COMPATIBLE = "openai-compatible";
// Local model servers speak the same API and need no key; only the desktop app may reach them.
const LOCAL_SERVERS: Record<
  string,
  { label: string; name: string; baseUrl: string; model: string }
> = {
  "local-ollama": {
    label: "Ollama (on this computer)",
    name: "ollama",
    baseUrl: "http://localhost:11434/v1",
    model: "llama3.2:1b",
  },
  "local-lmstudio": {
    label: "LM Studio (on this computer)",
    name: "lmstudio",
    baseUrl: "http://localhost:1234/v1",
    model: "",
  },
};

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
  const [endpoint, setEndpoint] = useState({ name: "", baseUrl: "", model: "" });
  const [saving, setSaving] = useState(false);

  const compositeFields = COMPOSITE_FIELDS[provider];
  const compositeValid =
    !compositeFields ||
    compositeFields.every((f) => !f.required || (composite[f.name] ?? "").trim());
  const compatible = provider === COMPATIBLE;
  const endpointValid = !compatible || (endpoint.name && endpoint.baseUrl && endpoint.model);
  const keyValid = apiKey.length >= 8 || (compatible && !apiKey);
  const canSave = (compositeFields ? compositeValid : keyValid) && endpointValid;

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
        body: JSON.stringify({
          provider: compatible ? endpoint.name.trim() : provider,
          apiKey: keyBody || undefined,
          label: label || undefined,
          ...(compatible
            ? { baseUrl: endpoint.baseUrl.trim(), models: [endpoint.model.trim()] }
            : {}),
        }),
      });
      if (res.status === 503)
        throw new Error("Server encryption is not configured. Contact admin.");
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(body.message ?? body.error ?? `Failed to save key (${res.status})`);
      }
      setSuccess(`Saved ${compatible ? endpoint.name : provider} key.`);
      setDialogOpen(false);
      setApiKey("");
      setComposite({});
      setLabel("");
      setEndpoint({ name: "", baseUrl: "", model: "" });
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

  const option = (value: string, text: string) => (
    <SelectItem key={value} value={value}>
      {text}
    </SelectItem>
  );

  return (
    <Page width="narrow">
      <PageHeader
        title="Models & keys"
        description="The provider keys every council member, agent and tool runs on. Encrypted at rest and never shown again after you save them."
        actions={
          <Button onClick={() => setDialogOpen(true)}>
            <Plus /> Add key
          </Button>
        }
      />

      {error && !dialogOpen && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="flex items-start gap-2 rounded-lg border border-success/30 bg-success/10 p-3 text-sm">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
          <span>{success}</span>
        </div>
      )}

      <Section title="Your keys">
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : keys.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title="No keys yet"
            description="Add one key and the council can meet. Free tiers are enough to start."
            action={
              <Button size="sm" onClick={() => setDialogOpen(true)}>
                <Plus /> Add key
              </Button>
            }
            className="my-2 border-0 py-6"
          />
        ) : (
          <ul className="divide-y">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center gap-3 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-semibold">
                  {(LABEL[k.provider] ?? k.provider).slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {LABEL[k.provider] ?? k.provider}
                    {k.label ? <span className="text-muted-foreground"> · {k.label}</span> : null}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    <code>{k.keyPrefix ? `${k.keyPrefix}…` : "••••"}</code> · added{" "}
                    {new Date(k.createdAt).toLocaleDateString()}
                    {k.lastUsedAt
                      ? ` · last used ${new Date(k.lastUsedAt).toLocaleDateString()}`
                      : " · not used yet"}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => deleteKey(k.id)}
                  aria-label={`Delete ${k.provider} key`}
                  title="Delete"
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Free keys to start with">
        <ul className="grid gap-2 py-1 sm:grid-cols-3">
          {FREE.map(([name, url]) => (
            <li key={name}>
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm hover:bg-accent"
              >
                {name} <ExternalLink className="size-3.5 text-muted-foreground" />
              </a>
            </li>
          ))}
        </ul>
        <p className="pt-2 pb-1 text-xs text-muted-foreground">
          On the desktop app you can also add Ollama or LM Studio and run models on this computer.
        </p>
      </Section>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a key</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Provider</Label>
              <Select
                value={provider}
                onValueChange={(p) => {
                  const local = LOCAL_SERVERS[p];
                  setProvider(local ? COMPATIBLE : p);
                  if (local)
                    setEndpoint({ name: local.name, baseUrl: local.baseUrl, model: local.model });
                  setApiKey("");
                  setComposite({});
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Models</SelectLabel>
                    {PROVIDERS.filter(([, , kind]) => kind === "chat").map(([id, text]) =>
                      option(id, text),
                    )}
                    {option(COMPATIBLE, "OpenAI-compatible endpoint")}
                  </SelectGroup>
                  <SelectGroup>
                    <SelectLabel>On this computer</SelectLabel>
                    {Object.entries(LOCAL_SERVERS).map(([value, s]) => option(value, s.label))}
                  </SelectGroup>
                  <SelectGroup>
                    <SelectLabel>Tools</SelectLabel>
                    {PROVIDERS.filter(([, , kind]) => kind === "tool").map(([id, text]) =>
                      option(id, text),
                    )}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            {compatible &&
              (
                [
                  ["name", "Name (agents use name/model)", "tokenrouter"],
                  ["baseUrl", "Base URL", "https://api.example.com/v1"],
                  ["model", "Default model", "vendor/model"],
                ] as const
              ).map(([field, text, placeholder]) => (
                <div key={field} className="space-y-1.5">
                  <Label htmlFor={`endpoint-${field}`}>{text}</Label>
                  <Input
                    id={`endpoint-${field}`}
                    placeholder={placeholder}
                    value={endpoint[field]}
                    onChange={(e) => setEndpoint((c) => ({ ...c, [field]: e.target.value }))}
                    autoComplete="off"
                  />
                </div>
              ))}
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
                <Label htmlFor="apiKey">API key{compatible ? " (optional)" : ""}</Label>
                <Input
                  id="apiKey"
                  type="password"
                  placeholder="Paste the key"
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
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={addKey} disabled={saving || !canSave}>
              {saving && <Loader2 className="animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
