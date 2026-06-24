// SPDX-License-Identifier: Apache-2.0
import {
  Brain,
  Settings,
  Trash2,
  Plus,
  Eye,
  EyeOff,
  CheckCircle2,
  Loader2,
  Cpu,
  Sparkles,
  Zap,
  Globe,
  Server,
  Router,
  Wind,
  CircuitBoard,
  MessageSquare,
  Wrench,
  Check,
} from "lucide-react";
import { useState, useEffect } from "react";
// ── Provider catalogue (static config, not live data) ─────────────────────────

interface ProviderModel {
  id: string;
  name: string;
  description?: string;
}

interface Provider {
  id: string;
  name: string;
  description: string;
  icon: string;
  models: ProviderModel[];
  apiKeyPlaceholder?: string;
  supportsBaseUrl?: boolean;
}

interface ConnectedProvider {
  id: string;
  providerId: string;
  displayName: string;
  apiKey: string;
  baseUrl?: string;
  enabledModels: string[];
  isDefault: boolean;
}

const AVAILABLE_PROVIDERS: Provider[] = [
  {
    id: "openai",
    name: "OpenAI",
    description: "GPT-4o, GPT-4, and more",
    icon: "openai",
    apiKeyPlaceholder: "sk-...",
    models: [
      { id: "gpt-4o", name: "GPT-4o", description: "Most capable model" },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", description: "Fast and affordable" },
      { id: "gpt-4-turbo", name: "GPT-4 Turbo", description: "High intelligence" },
      { id: "gpt-4", name: "GPT-4", description: "Original GPT-4" },
      { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo", description: "Fast legacy model" },
      { id: "o1", name: "o1", description: "Reasoning model" },
      { id: "o1-mini", name: "o1 Mini", description: "Fast reasoning" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude 4, Claude 3.5, and more",
    icon: "anthropic",
    apiKeyPlaceholder: "sk-ant-...",
    models: [
      { id: "claude-opus-4-6", name: "Claude Opus 4.6", description: "Most capable" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", description: "Balanced performance" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", description: "Fast and efficient" },
      { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet", description: "Previous generation" },
      { id: "claude-3-opus", name: "Claude 3 Opus", description: "Previous generation" },
    ],
  },
  {
    id: "google",
    name: "Google Gemini",
    description: "Gemini Pro, Flash, and Ultra",
    icon: "google",
    apiKeyPlaceholder: "AI...",
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", description: "Most capable" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", description: "Fast and efficient" },
      { id: "gemini-2.0-pro", name: "Gemini 2.0 Pro", description: "Previous gen" },
      { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", description: "Long context" },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    description: "Ultra-fast inference engine",
    icon: "groq",
    apiKeyPlaceholder: "gsk_...",
    models: [
      { id: "llama-3.3-70b", name: "Llama 3.3 70B", description: "Fast and capable" },
      { id: "llama-3.1-8b", name: "Llama 3.1 8B", description: "Ultra-fast" },
      { id: "mixtral-8x7b", name: "Mixtral 8x7B", description: "Mixture of experts" },
      { id: "gemma2-9b", name: "Gemma 2 9B", description: "Google open model" },
    ],
  },
  {
    id: "ollama",
    name: "Ollama",
    description: "Run models locally",
    icon: "ollama",
    supportsBaseUrl: true,
    models: [
      { id: "llama3.3", name: "Llama 3.3", description: "Meta's latest" },
      { id: "mistral", name: "Mistral", description: "Mistral 7B" },
      { id: "codellama", name: "Code Llama", description: "Code generation" },
      { id: "phi3", name: "Phi-3", description: "Microsoft's small model" },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "Access multiple providers via one API",
    icon: "openrouter",
    apiKeyPlaceholder: "sk-or-...",
    models: [
      { id: "auto", name: "Auto", description: "Best model for the task" },
      { id: "openrouter/optimus", name: "Optimus", description: "OpenRouter's pick" },
    ],
  },
  {
    id: "mistral",
    name: "Mistral",
    description: "Mistral Large, Medium, and Small",
    icon: "mistral",
    apiKeyPlaceholder: "...",
    models: [
      { id: "mistral-large", name: "Mistral Large", description: "Most capable" },
      { id: "mistral-medium", name: "Mistral Medium", description: "Balanced" },
      { id: "mistral-small", name: "Mistral Small", description: "Fast" },
      { id: "codestral", name: "Codestral", description: "Code generation" },
    ],
  },
  {
    id: "cerebras",
    name: "Cerebras",
    description: "Ultra-fast wafer-scale inference",
    icon: "cerebras",
    apiKeyPlaceholder: "csk-...",
    models: [
      { id: "llama-3.3-70b-cerebras", name: "Llama 3.3 70B", description: "Fast inference" },
      { id: "llama-3.1-8b-cerebras", name: "Llama 3.1 8B", description: "Ultra-fast" },
    ],
  },
  {
    id: "cohere",
    name: "Cohere",
    description: "Command R and enterprise models",
    icon: "cohere",
    apiKeyPlaceholder: "...",
    models: [
      { id: "command-r-plus", name: "Command R+", description: "Most capable" },
      { id: "command-r", name: "Command R", description: "Fast and efficient" },
      { id: "command-light", name: "Command Light", description: "Lightweight" },
    ],
  },
  {
    id: "custom",
    name: "Custom",
    description: "Connect any OpenAI-compatible API",
    icon: "custom",
    supportsBaseUrl: true,
    models: [],
  },
];
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { Separator } from "~/components/ui/separator";
import { useStore } from "~/context/StoreContext";
import { authFetch } from "~/lib/api";
import { cn } from "~/lib/utils";

/**
 * The encrypted /provider-keys store uses canonical provider slugs. This page's
 * catalogue calls Google's provider "google"; the store/driver slug is "gemini".
 */
function toStoreProvider(id: string): string {
  return id === "google" ? "gemini" : id;
}
function fromStoreProvider(slug: string): string {
  return slug === "gemini" ? "google" : slug;
}

const PROVIDER_ICONS: Record<string, React.ReactNode> = {
  openai: <Sparkles className="size-5" />,
  anthropic: <Brain className="size-5" />,
  google: <Globe className="size-5" />,
  groq: <Zap className="size-5" />,
  ollama: <Server className="size-5" />,
  openrouter: <Router className="size-5" />,
  mistral: <Wind className="size-5" />,
  cerebras: <CircuitBoard className="size-5" />,
  cohere: <MessageSquare className="size-5" />,
  custom: <Wrench className="size-5" />,
};

function getProviderIcon(iconKey: string) {
  return PROVIDER_ICONS[iconKey] ?? <Cpu className="size-5" />;
}

export default function LanguageModelsPage() {
  const store = useStore();
  const [connectedProviders, setConnectedProviders] = useState<ConnectedProvider[]>([]);
  const [defaultModel, setDefaultModel] = useState("gpt-4o");
  const [_providersLoading, setProvidersLoading] = useState(true);

  // Load the user's encrypted provider connections (keys never returned — only a
  // masked prefix + non-secret metadata) from the BYOK store.
  useEffect(() => {
    setProvidersLoading(true);
    authFetch("/api/user/provider-keys")
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{
              keys?: {
                id: string;
                provider: string;
                label?: string | null;
                keyPrefix?: string | null;
                baseUrl?: string | null;
                models?: string[] | null;
              }[];
            }>)
          : null,
      )
      .then((data) => {
        if (!data?.keys) return;
        const mapped: ConnectedProvider[] = data.keys.map((k) => ({
          id: k.id,
          providerId: fromStoreProvider(k.provider),
          displayName: k.label ?? k.provider,
          apiKey: k.keyPrefix ? `${k.keyPrefix}••••` : "",
          baseUrl: k.baseUrl ?? "",
          enabledModels: k.models ?? [],
          isDefault: false,
        }));
        setConnectedProviders(mapped);
      })
      .catch(() => {})
      .finally(() => setProvidersLoading(false));
  }, []);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [editingConnection, setEditingConnection] = useState<ConnectedProvider | null>(null);

  // Form state
  const [formDisplayName, setFormDisplayName] = useState("");
  const [formApiKey, setFormApiKey] = useState("");
  const [formBaseUrl, setFormBaseUrl] = useState("");
  const [formEnabledModels, setFormEnabledModels] = useState<string[]>([]);
  const [showApiKey, setShowApiKey] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<"success" | "error" | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Inline API key editing state
  const [inlineKeyEditing, setInlineKeyEditing] = useState<string | null>(null);
  const [inlineKeyValue, setInlineKeyValue] = useState("");
  const [inlineKeyVisible, setInlineKeyVisible] = useState(false);

  // Custom model name input
  const [customModelName, setCustomModelName] = useState("");

  const availableToConnect = AVAILABLE_PROVIDERS.filter(
    (p) => !connectedProviders.some((cp) => cp.providerId === p.id),
  );

  function openConnectDialog(provider: Provider) {
    setEditingProvider(provider);
    setEditingConnection(null);
    setFormDisplayName(provider.name);
    setFormApiKey("");
    setFormBaseUrl(provider.id === "ollama" ? "http://localhost:11434" : "");
    setFormEnabledModels(provider.models.map((m) => m.id));
    setShowApiKey(false);
    setIsTesting(false);
    setTestResult(null);
    setDialogOpen(true);
  }

  function openEditDialog(connection: ConnectedProvider) {
    const provider = AVAILABLE_PROVIDERS.find((p) => p.id === connection.providerId);
    if (!provider) return;
    setEditingProvider(provider);
    setEditingConnection(connection);
    setFormDisplayName(connection.displayName);
    // Keys are write-only: never preload the masked stored value into the form.
    // An empty field means "keep existing key"; a new value rotates it.
    setFormApiKey("");
    setFormBaseUrl(connection.baseUrl ?? "");
    setFormEnabledModels([...connection.enabledModels]);
    setShowApiKey(false);
    setIsTesting(false);
    setTestResult(null);
    setDialogOpen(true);
  }

  function handleTestConnection() {
    setIsTesting(true);
    setTestResult(null);
    setTimeout(() => {
      setIsTesting(false);
      setTestResult("success");
    }, 1000);
  }

  async function handleSave() {
    if (!editingProvider) return;
    setIsSaving(true);
    try {
      // The store is keyed by (user, provider) and rotates on POST (soft-delete
      // old + insert), so this handles both create and edit. Keys are write-only.
      const res = await authFetch("/api/user/provider-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: toStoreProvider(editingProvider.id),
          apiKey: formApiKey || undefined,
          label: formDisplayName || editingProvider.name,
          baseUrl: formBaseUrl || undefined,
          models: formEnabledModels,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { id?: string; keyPrefix?: string | null };
        const newConn: ConnectedProvider = {
          id: data.id ?? `conn-${Date.now()}`,
          providerId: editingProvider.id,
          displayName: formDisplayName || editingProvider.name,
          apiKey: data.keyPrefix ? `${data.keyPrefix}••••` : formApiKey ? "••••" : "",
          baseUrl: formBaseUrl || undefined,
          enabledModels: formEnabledModels,
          isDefault: connectedProviders.length === 0,
        };
        // Replace any existing connection for this provider.
        setConnectedProviders((prev) => [
          ...prev.filter((cp) => cp.providerId !== editingProvider.id),
          newConn,
        ]);
      }
    } catch {
      /* ignore — optimistically updated */
    }
    setIsSaving(false);
    setDialogOpen(false);
  }

  async function handleDelete(connectionId: string) {
    try {
      await authFetch(`/api/user/provider-keys/${connectionId}`, { method: "DELETE" });
    } catch {
      /* ignore */
    }
    setConnectedProviders((prev) => prev.filter((cp) => cp.id !== connectionId));
  }

  async function handleInlineKeySave(connectionId: string) {
    const cp = connectedProviders.find((c) => c.id === connectionId);
    if (cp && inlineKeyValue) {
      try {
        // Rotate the stored key, preserving the connection's metadata.
        const res = await authFetch("/api/user/provider-keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: toStoreProvider(cp.providerId),
            apiKey: inlineKeyValue,
            label: cp.displayName,
            baseUrl: cp.baseUrl || undefined,
            models: cp.enabledModels,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { id?: string; keyPrefix?: string | null };
          setConnectedProviders((prev) =>
            prev.map((c) =>
              c.id === connectionId
                ? {
                    ...c,
                    id: data.id ?? c.id,
                    apiKey: data.keyPrefix ? `${data.keyPrefix}••••` : "••••",
                  }
                : c,
            ),
          );
        }
      } catch {
        /* ignore */
      }
    }
    setInlineKeyEditing(null);
    setInlineKeyValue("");
    setInlineKeyVisible(false);
  }

  function handleAddCustomModel() {
    if (!customModelName.trim() || !editingProvider) return;
    const modelId = customModelName.trim();
    if (!formEnabledModels.includes(modelId)) {
      setFormEnabledModels((prev) => [...prev, modelId]);
    }
    setCustomModelName("");
  }

  function toggleModel(modelId: string) {
    setFormEnabledModels((prev) =>
      prev.includes(modelId) ? prev.filter((id) => id !== modelId) : [...prev, modelId],
    );
  }

  function selectAllModels() {
    if (!editingProvider) return;
    setFormEnabledModels(editingProvider.models.map((m) => m.id));
  }

  function deselectAllModels() {
    setFormEnabledModels([]);
  }

  // Build grouped models for default model select
  const groupedModels = connectedProviders.map((cp) => {
    const provider = AVAILABLE_PROVIDERS.find((p) => p.id === cp.providerId);
    const providerModels = provider?.models.filter((m) => cp.enabledModels.includes(m.id)) ?? [];
    // Include custom models that aren't in the provider's predefined list
    const customModels = cp.enabledModels
      .filter((id) => !provider?.models.some((m) => m.id === id))
      .map((id) => ({ id, name: id, description: "Custom model" }));
    return {
      providerName: cp.displayName,
      models: [...providerModels, ...customModels],
    };
  });

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-8">
        {/* Page Header */}
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center size-10 rounded-lg bg-primary/10">
              <Cpu className="size-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Language Models</h1>
              <p className="text-sm text-muted-foreground">
                Configure AI providers and API keys for the council
              </p>
            </div>
          </div>
        </div>

        {/* Default Model */}
        <Card>
          <CardHeader>
            <CardTitle>Default Model</CardTitle>
            <CardDescription>
              Select the default language model used across the council
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Select value={defaultModel} onValueChange={setDefaultModel}>
              <SelectTrigger className="w-full max-w-sm">
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {groupedModels.map((group) => (
                  <SelectGroup key={group.providerName}>
                    <SelectLabel>{group.providerName}</SelectLabel>
                    {group.models.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        {/* Configured Providers */}
        <div className="space-y-4">
          <div>
            <h2 className="text-sm font-medium">Configured Providers</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Providers currently connected and available for use
            </p>
          </div>
          {connectedProviders.length === 0 ? (
            <Card>
              <CardContent className="py-8">
                <p className="text-center text-sm text-muted-foreground">
                  No providers configured yet. Add a provider below to get started.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-3">
              {connectedProviders.map((cp) => {
                const provider = AVAILABLE_PROVIDERS.find((p) => p.id === cp.providerId);
                return (
                  <Card key={cp.id} className="group/card">
                    <CardContent className="py-0">
                      <div className="flex items-center gap-3 py-3">
                        <div className="flex items-center justify-center size-9 rounded-lg bg-muted">
                          {provider && getProviderIcon(provider.icon)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{cp.displayName}</span>
                            {cp.isDefault && <Badge variant="secondary">Default</Badge>}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {cp.enabledModels.length} model
                            {cp.enabledModels.length !== 1 ? "s" : ""} enabled
                          </p>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button variant="ghost" size="icon-sm" onClick={() => openEditDialog(cp)}>
                            <Settings className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="opacity-0 group-hover/card:opacity-100 transition-opacity text-destructive hover:text-destructive"
                            onClick={() => handleDelete(cp.id)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                      {/* Inline API Key Input */}
                      {cp.providerId !== "ollama" && (
                        <div className="border-t border-border px-1 py-2">
                          {inlineKeyEditing === cp.id ? (
                            <div className="flex items-center gap-2">
                              <div className="relative flex-1">
                                <Input
                                  type={inlineKeyVisible ? "text" : "password"}
                                  value={inlineKeyValue}
                                  onChange={(e) => setInlineKeyValue(e.target.value)}
                                  placeholder="Enter API key..."
                                  className="h-7 text-xs pr-7"
                                  autoFocus
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") handleInlineKeySave(cp.id);
                                    if (e.key === "Escape") {
                                      setInlineKeyEditing(null);
                                      setInlineKeyVisible(false);
                                    }
                                  }}
                                />
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-xs"
                                  className="absolute right-0.5 top-1/2 -translate-y-1/2"
                                  onClick={() => setInlineKeyVisible(!inlineKeyVisible)}
                                >
                                  {inlineKeyVisible ? (
                                    <EyeOff className="size-3" />
                                  ) : (
                                    <Eye className="size-3" />
                                  )}
                                </Button>
                              </div>
                              <Button
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={() => handleInlineKeySave(cp.id)}
                              >
                                Save
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs"
                                onClick={() => {
                                  setInlineKeyEditing(null);
                                  setInlineKeyVisible(false);
                                }}
                              >
                                Cancel
                              </Button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-muted-foreground">API Key:</span>
                              <span className="text-xs font-mono text-muted-foreground truncate flex-1">
                                {cp.apiKey ? cp.apiKey.slice(0, 8) + "..." : "Not set"}
                              </span>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-[11px]"
                                onClick={() => {
                                  // Keys are write-only — never preload the masked value.
                                  setInlineKeyEditing(cp.id);
                                  setInlineKeyValue("");
                                  setInlineKeyVisible(false);
                                }}
                              >
                                Edit
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        {/* Custom Models (created from chat or other pages) */}
        {store.customModels.length > 0 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-sm font-medium">Custom Models</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Models added via the chat dialog or other pages
              </p>
            </div>
            <div className="grid gap-3">
              {store.customModels.map((m) => (
                <Card key={m.id}>
                  <CardContent className="py-0">
                    <div className="flex items-center gap-3 py-3">
                      <div className="flex items-center justify-center size-9 rounded-lg bg-muted">
                        <Wrench className="size-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{m.label}</span>
                          <Badge variant="secondary" className="text-[10px]">
                            Custom
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground truncate">{m.apiUrl}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* Add a Provider */}
        <div className="space-y-4">
          <div>
            <h2 className="text-sm font-medium">Add a Provider</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Connect a new AI provider to expand available models
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {availableToConnect.map((provider) => (
              <Card key={provider.id}>
                <CardContent className="py-0">
                  <div className="flex items-center gap-3 py-3">
                    <div className="flex items-center justify-center size-9 rounded-lg bg-muted">
                      {getProviderIcon(provider.icon)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{provider.name}</p>
                      <p className="text-xs text-muted-foreground">{provider.description}</p>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => openConnectDialog(provider)}>
                      <Plus className="size-3 mr-1" />
                      Connect
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>

        {/* Provider Configuration Dialog */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {editingProvider && getProviderIcon(editingProvider.icon)}
                {editingConnection
                  ? `Edit ${editingProvider?.name}`
                  : `Connect ${editingProvider?.name}`}
              </DialogTitle>
              <DialogDescription>
                {editingConnection
                  ? "Update your provider configuration"
                  : `Configure your ${editingProvider?.name} connection`}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              {/* Display Name */}
              <div className="space-y-1.5">
                <Label htmlFor="display-name">Display Name</Label>
                <Input
                  id="display-name"
                  value={formDisplayName}
                  onChange={(e) => setFormDisplayName(e.target.value)}
                  placeholder="Provider display name"
                />
              </div>

              {/* API Key */}
              {editingProvider?.id !== "ollama" && (
                <div className="space-y-1.5">
                  <Label htmlFor="api-key">API Key</Label>
                  <div className="relative">
                    <Input
                      id="api-key"
                      type={showApiKey ? "text" : "password"}
                      value={formApiKey}
                      onChange={(e) => setFormApiKey(e.target.value)}
                      placeholder={editingProvider?.apiKeyPlaceholder ?? "Enter your API key"}
                      className="pr-8"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="absolute right-1 top-1/2 -translate-y-1/2"
                      onClick={() => setShowApiKey(!showApiKey)}
                    >
                      {showApiKey ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                    </Button>
                  </div>
                </div>
              )}

              {/* Base URL */}
              {(editingProvider?.supportsBaseUrl ||
                editingProvider?.id === "custom" ||
                editingProvider?.id === "ollama") && (
                <div className="space-y-1.5">
                  <Label htmlFor="base-url">Base URL</Label>
                  <Input
                    id="base-url"
                    value={formBaseUrl}
                    onChange={(e) => setFormBaseUrl(e.target.value)}
                    placeholder={
                      editingProvider?.id === "ollama"
                        ? "http://localhost:11434"
                        : "https://api.example.com/v1"
                    }
                  />
                </div>
              )}

              {/* Models */}
              {editingProvider && editingProvider.models.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Models</Label>
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="xs" onClick={selectAllModels}>
                        Select All
                      </Button>
                      <Button variant="ghost" size="xs" onClick={deselectAllModels}>
                        Deselect All
                      </Button>
                    </div>
                  </div>
                  <div className="rounded-md border border-border bg-muted/30 p-2 space-y-0.5 max-h-48 overflow-y-auto">
                    {editingProvider.models.map((model) => {
                      const isEnabled = formEnabledModels.includes(model.id);
                      return (
                        <button
                          key={model.id}
                          type="button"
                          onClick={() => toggleModel(model.id)}
                          className={cn(
                            "flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted",
                            isEnabled && "bg-muted/50",
                          )}
                        >
                          <div
                            className={cn(
                              "flex items-center justify-center size-4 rounded border transition-colors",
                              isEnabled
                                ? "bg-primary border-primary text-primary-foreground"
                                : "border-muted-foreground/30",
                            )}
                          >
                            {isEnabled && <Check className="size-3" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <span className="text-xs font-medium">{model.name}</span>
                            {model.description && (
                              <span className="text-xs text-muted-foreground ml-2">
                                {model.description}
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                    {/* Show custom-added models that aren't in the provider's default list */}
                    {formEnabledModels
                      .filter((id) => !editingProvider.models.some((m) => m.id === id))
                      .map((modelId) => (
                        <button
                          key={modelId}
                          type="button"
                          onClick={() => toggleModel(modelId)}
                          className="flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted bg-muted/50"
                        >
                          <div className="flex items-center justify-center size-4 rounded border bg-primary border-primary text-primary-foreground transition-colors">
                            <Check className="size-3" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <span className="text-xs font-medium font-mono">{modelId}</span>
                            <span className="text-xs text-muted-foreground ml-2">Custom</span>
                          </div>
                        </button>
                      ))}
                  </div>
                  {/* Custom model name input */}
                  <div className="flex items-center gap-2">
                    <Input
                      value={customModelName}
                      onChange={(e) => setCustomModelName(e.target.value)}
                      placeholder="Type a custom model name..."
                      className="h-7 text-xs flex-1"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleAddCustomModel();
                        }
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs gap-1"
                      onClick={handleAddCustomModel}
                      disabled={!customModelName.trim()}
                    >
                      <Plus className="size-3" />
                      Add
                    </Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Add custom model names not listed above (e.g. fine-tuned models)
                  </p>
                </div>
              )}

              {/* Models section for providers with no predefined models (e.g. Custom) */}
              {editingProvider && editingProvider.models.length === 0 && (
                <div className="space-y-2">
                  <Label>Models</Label>
                  <div className="rounded-md border border-border bg-muted/30 p-2 space-y-0.5 max-h-48 overflow-y-auto">
                    {formEnabledModels.map((modelId) => (
                      <button
                        key={modelId}
                        type="button"
                        onClick={() => toggleModel(modelId)}
                        className="flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted bg-muted/50"
                      >
                        <div className="flex items-center justify-center size-4 rounded border bg-primary border-primary text-primary-foreground transition-colors">
                          <Check className="size-3" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-xs font-medium font-mono">{modelId}</span>
                        </div>
                      </button>
                    ))}
                    {formEnabledModels.length === 0 && (
                      <p className="text-xs text-muted-foreground text-center py-2">
                        No models added yet. Use the input below to add custom model names.
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      value={customModelName}
                      onChange={(e) => setCustomModelName(e.target.value)}
                      placeholder="Type a custom model name..."
                      className="h-7 text-xs flex-1"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleAddCustomModel();
                        }
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs gap-1"
                      onClick={handleAddCustomModel}
                      disabled={!customModelName.trim()}
                    >
                      <Plus className="size-3" />
                      Add
                    </Button>
                  </div>
                </div>
              )}

              {/* Test Connection */}
              <Separator />
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTestConnection}
                  disabled={isTesting}
                >
                  {isTesting ? (
                    <Loader2 className="size-3 mr-1 animate-spin" />
                  ) : testResult === "success" ? (
                    <CheckCircle2 className="size-3 mr-1 text-green-500" />
                  ) : null}
                  {isTesting
                    ? "Testing..."
                    : testResult === "success"
                      ? "Connected"
                      : "Test Connection"}
                </Button>
                {testResult === "success" && (
                  <span className="text-xs text-green-500">Connection successful</span>
                )}
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={isSaving}>
                {isSaving && <Loader2 className="size-3 mr-1 animate-spin" />}
                {isSaving ? "Saving..." : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
