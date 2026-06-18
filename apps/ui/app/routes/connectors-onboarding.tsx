/**
 * Connector Onboarding — OAuth + credential-based connector setup
 *
 * Step 1: Pick connector type
 * Step 2: OAuth redirect or credential input
 * Step 3: Configure (name, sync schedule, initial sync mode)
 * Step 4: Done — navigate to sync dashboard
 */

import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Badge } from "~/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "~/components/ui/select";
import {
  ChevronLeft, ChevronRight, Plug, CheckCircle2,
  ExternalLink, Key, Globe, Loader2, ArrowRight,
} from "lucide-react";

// ── Connector catalog ─────────────────────────────────────────────────────────

interface ConnectorDef {
  id:          string;
  label:       string;
  icon:        string;
  category:    string;
  authType:    "oauth" | "api_key" | "credentials" | "url";
  oauthUrl?:   string;  // /api/auth/:provider
  fields?:     Array<{ key: string; label: string; type?: string; placeholder?: string; required?: boolean }>;
  description: string;
}

const CONNECTORS: ConnectorDef[] = [
  // ── Productivity ────────────────────────────────────────────────────────────
  { id: "google_drive",  label: "Google Drive",  icon: "🗂",  category: "Productivity", authType: "oauth",       oauthUrl: "/api/auth/google",     description: "Index files and folders from your Google Drive"    },
  { id: "notion",        label: "Notion",         icon: "📝", category: "Productivity", authType: "api_key",     fields: [{ key: "api_key", label: "Integration token", placeholder: "secret_…", required: true }], description: "Sync pages and databases from Notion"              },
  { id: "confluence",    label: "Confluence",     icon: "🌊", category: "Productivity", authType: "credentials", fields: [
    { key: "url",       label: "Confluence URL",  placeholder: "https://yoursite.atlassian.net", required: true  },
    { key: "username",  label: "Email",           placeholder: "you@example.com",               required: true  },
    { key: "api_token", label: "API Token",       type: "password",                             required: true  },
  ], description: "Sync spaces and pages from Confluence"           },
  // ── Engineering ─────────────────────────────────────────────────────────────
  { id: "github",        label: "GitHub",         icon: "🐙", category: "Engineering",  authType: "oauth",       oauthUrl: "/api/auth/github",     description: "Index repositories, issues, PRs, and wikis"        },
  { id: "gitlab",        label: "GitLab",         icon: "🦊", category: "Engineering",  authType: "api_key",     fields: [
    { key: "url",       label: "GitLab URL",  placeholder: "https://gitlab.com", required: true },
    { key: "api_token", label: "Access Token", type: "password",                 required: true },
  ], description: "Sync GitLab repos, MRs, and issues"              },
  { id: "linear",        label: "Linear",         icon: "📐", category: "Engineering",  authType: "api_key",     fields: [{ key: "api_key", label: "Linear API key", placeholder: "lin_api_…", required: true }], description: "Index Linear issues and projects"                   },
  { id: "jira",          label: "Jira",           icon: "🎯", category: "Engineering",  authType: "credentials", fields: [
    { key: "url",       label: "Jira URL",  placeholder: "https://yoursite.atlassian.net", required: true },
    { key: "username",  label: "Email",     placeholder: "you@example.com",               required: true },
    { key: "api_token", label: "API Token", type: "password",                             required: true },
  ], description: "Sync Jira tickets and project docs"               },
  // ── Messaging ───────────────────────────────────────────────────────────────
  { id: "slack",         label: "Slack",          icon: "💬", category: "Messaging",    authType: "oauth",       oauthUrl: "/api/connectors/oauth/slack",  description: "Sync Slack channels and messages"                   },
  { id: "discord",       label: "Discord",        icon: "🎮", category: "Messaging",    authType: "api_key",     fields: [{ key: "bot_token", label: "Bot Token", type: "password", required: true }], description: "Index Discord server channels"                      },
  // ── Web ─────────────────────────────────────────────────────────────────────
  { id: "web",           label: "Web crawler",    icon: "🌐", category: "Web",          authType: "url",         fields: [
    { key: "base_url",  label: "Start URL",    placeholder: "https://docs.example.com", required: true },
    { key: "depth",     label: "Crawl depth",  placeholder: "3"                                        },
  ], description: "Crawl and index any public website"               },
  { id: "zendesk",       label: "Zendesk",        icon: "🎫", category: "Support",      authType: "credentials", fields: [
    { key: "subdomain",  label: "Subdomain", placeholder: "yourco", required: true },
    { key: "email",      label: "Email",     required: true },
    { key: "api_token",  label: "API Token", type: "password", required: true },
  ], description: "Sync Zendesk tickets and help center articles"    },
];

const CATEGORIES = [...new Set(CONNECTORS.map((c) => c.category))];

// ── Steps ─────────────────────────────────────────────────────────────────────

const STEPS = ["Pick", "Auth", "Configure", "Done"] as const;

// ── Main component ────────────────────────────────────────────────────────────

export default function ConnectorsOnboardingPage() {
  const navigate = useNavigate();

  const [step, setStep]               = useState(0);
  const [selected, setSelected]       = useState<ConnectorDef | null>(null);
  const [filterCategory, setFilter]   = useState<string>("all");
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [config, setConfig]           = useState({ name: "", syncMode: "load", schedule: "daily" });
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [createdId, setCreatedId]     = useState<string | null>(null);

  const setField = (key: string, val: string) =>
    setCredentials((p) => ({ ...p, [key]: val }));

  const canAdvanceAuth = () => {
    if (!selected) return false;
    if (selected.authType === "oauth") return true; // OAuth redirects then comes back
    const fields = selected.fields ?? [];
    return fields.filter((f) => f.required).every((f) => credentials[f.key]?.trim());
  };

  const handleOAuth = () => {
    if (!selected?.oauthUrl) return;
    // Store state for post-OAuth redirect
    sessionStorage.setItem("nexus_connector_pending", JSON.stringify({ connectorId: selected.id, step: 2 }));
    window.location.href = selected.oauthUrl + `?redirect_to=/connectors/new&source=${selected.id}`;
  };

  // Check if returning from OAuth
  useEffect(() => {
    const pending = sessionStorage.getItem("nexus_connector_pending");
    if (pending) {
      try {
        const { connectorId } = JSON.parse(pending);
        const def = CONNECTORS.find((c) => c.id === connectorId);
        if (def) { setSelected(def); setStep(2); }
      } catch { /* ignore */ }
      sessionStorage.removeItem("nexus_connector_pending");
    }
  }, []);

  const handleCreate = async () => {
    if (!selected) return;
    setLoading(true);
    setError(null);
    try {
      const body = {
        name:           config.name || selected.label,
        source:         selected.id,
        inputType:      "connector",
        credentials,
        syncConfig: {
          mode:     config.syncMode,
          schedule: config.schedule !== "manual" ? config.schedule : undefined,
        },
      };

      const res = await fetch("/api/connectors", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).message ?? `Failed (${res.status})`);
      }

      const data = await res.json();
      setCreatedId(data.id ?? data.connector?.id);
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Creation failed");
    }
    setLoading(false);
  };

  const filteredConnectors = filterCategory === "all"
    ? CONNECTORS
    : CONNECTORS.filter((c) => c.category === filterCategory);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-2xl space-y-5">

        {/* Progress */}
        <div className="flex items-center gap-1 justify-center">
          {STEPS.map((s, i) => (
            <div key={s} className="flex items-center gap-1">
              <div
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs"
                style={{
                  background: i === step ? "hsl(var(--primary)/0.15)" : i < step ? "hsl(var(--muted)/0.3)" : "transparent",
                  color:      i === step ? "hsl(var(--primary))" : i < step ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground))",
                  border:     `1px solid ${i === step ? "hsl(var(--primary)/0.3)" : "transparent"}`,
                }}
              >
                {i < step ? <CheckCircle2 className="size-3" /> : <Plug className="size-3" />}
                {s}
              </div>
              {i < STEPS.length - 1 && (
                <div className="w-4 h-px" style={{ background: i < step ? "hsl(var(--primary)/0.4)" : "hsl(var(--border))" }} />
              )}
            </div>
          ))}
        </div>

        {/* Card */}
        <div
          className="rounded-xl p-6"
          style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
        >

          {/* Step 0 — Pick connector */}
          {step === 0 && (
            <div className="space-y-4">
              <div>
                <h2 className="font-semibold text-base">Add a connector</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Connect a data source to ingest documents into your knowledge base.
                </p>
              </div>

              {/* Category filter */}
              <div className="flex flex-wrap gap-1.5">
                {["all", ...CATEGORIES].map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setFilter(cat)}
                    className="px-2.5 py-1 rounded-full text-xs transition-colors capitalize"
                    style={{
                      background: filterCategory === cat ? "hsl(var(--primary)/0.15)" : "hsl(var(--muted)/0.4)",
                      color:      filterCategory === cat ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))",
                      border:     `1px solid ${filterCategory === cat ? "hsl(var(--primary)/0.3)" : "hsl(var(--border)/0.5)"}`,
                    }}
                  >
                    {cat}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {filteredConnectors.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => { setSelected(c); setCredentials({}); }}
                    className="flex items-start gap-2.5 p-3 rounded-lg text-left transition-colors"
                    style={{
                      background: selected?.id === c.id ? "hsl(var(--primary)/0.1)" : "hsl(var(--muted)/0.3)",
                      border:     `1px solid ${selected?.id === c.id ? "hsl(var(--primary)/0.4)" : "hsl(var(--border)/0.5)"}`,
                    }}
                  >
                    <span className="text-xl">{c.icon}</span>
                    <div className="min-w-0">
                      <p className="text-xs font-medium">{c.label}</p>
                      <Badge variant="outline" className="text-[10px] mt-0.5 h-3.5 px-1">
                        {c.authType}
                      </Badge>
                    </div>
                  </button>
                ))}
              </div>

              {selected && (
                <p className="text-xs text-muted-foreground border-t border-border pt-3">
                  <span className="text-foreground font-medium">{selected.label}:</span> {selected.description}
                </p>
              )}
            </div>
          )}

          {/* Step 1 — Auth */}
          {step === 1 && selected && (
            <div className="space-y-5">
              <div className="flex items-center gap-2">
                <span className="text-2xl">{selected.icon}</span>
                <div>
                  <h2 className="font-semibold text-base">{selected.label}</h2>
                  <p className="text-xs text-muted-foreground">{selected.description}</p>
                </div>
              </div>

              {selected.authType === "oauth" ? (
                <div className="space-y-4">
                  <p className="text-sm">
                    Click below to authorize Nexus to access your {selected.label} account.
                    You'll be redirected back after granting access.
                  </p>
                  <Button onClick={handleOAuth} className="gap-2 w-full">
                    <ExternalLink className="size-4" />
                    Connect {selected.label} via OAuth
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {(selected.fields ?? []).map((field) => (
                    <div key={field.key} className="space-y-1.5">
                      <Label className="text-xs">
                        {field.label}
                        {field.required && <span className="text-destructive ml-1">*</span>}
                      </Label>
                      <Input
                        type={field.type ?? "text"}
                        placeholder={field.placeholder}
                        value={credentials[field.key] ?? ""}
                        onChange={(e) => setField(field.key, e.target.value)}
                        className="text-xs font-mono h-8"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Step 2 — Configure */}
          {step === 2 && selected && (
            <div className="space-y-4">
              <h2 className="font-semibold text-base">Configure sync</h2>

              <div className="space-y-1.5">
                <Label className="text-xs">Connector name</Label>
                <Input
                  value={config.name}
                  onChange={(e) => setConfig((c) => ({ ...c, name: e.target.value }))}
                  placeholder={selected.label}
                  className="text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Initial sync mode</Label>
                <Select value={config.syncMode} onValueChange={(v) => setConfig((c) => ({ ...c, syncMode: v }))}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="load" className="text-xs">Load — full initial sync</SelectItem>
                    <SelectItem value="poll" className="text-xs">Poll — incremental updates only</SelectItem>
                    <SelectItem value="slim" className="text-xs">Slim — metadata only (fast)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Sync schedule</Label>
                <Select value={config.schedule} onValueChange={(v) => setConfig((c) => ({ ...c, schedule: v }))}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual"  className="text-xs">Manual only</SelectItem>
                    <SelectItem value="hourly"  className="text-xs">Every hour</SelectItem>
                    <SelectItem value="daily"   className="text-xs">Daily</SelectItem>
                    <SelectItem value="weekly"  className="text-xs">Weekly</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {error && (
                <p className="text-xs text-destructive">{error}</p>
              )}
            </div>
          )}

          {/* Step 3 — Done */}
          {step === 3 && (
            <div className="text-center space-y-4 py-4">
              <div className="text-5xl">🎉</div>
              <div>
                <h2 className="font-semibold text-lg">Connector created!</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  {selected?.label} is connected. The first sync will start shortly.
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <Button
                  onClick={() => navigate(createdId ? `/connectors/sync?id=${createdId}` : "/connectors/sync")}
                  className="gap-2"
                >
                  View sync status <ArrowRight className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  onClick={() => { setStep(0); setSelected(null); setCredentials({}); setCreatedId(null); }}
                >
                  Add another connector
                </Button>
              </div>
            </div>
          )}

          {/* Navigation */}
          {step < 3 && (
            <div className="flex gap-2 mt-6 pt-4 border-t border-border">
              {step > 0 && (
                <Button variant="outline" className="gap-1.5 text-sm" onClick={() => setStep((s) => s - 1)}>
                  <ChevronLeft className="size-3.5" /> Back
                </Button>
              )}
              {step === 0 && (
                <Button
                  className="flex-1 gap-1.5 text-sm"
                  disabled={!selected}
                  onClick={() => setStep(1)}
                >
                  Continue <ChevronRight className="size-3.5" />
                </Button>
              )}
              {step === 1 && selected?.authType !== "oauth" && (
                <Button
                  className="flex-1 gap-1.5 text-sm"
                  disabled={!canAdvanceAuth()}
                  onClick={() => setStep(2)}
                >
                  Continue <ChevronRight className="size-3.5" />
                </Button>
              )}
              {step === 2 && (
                <Button
                  className="flex-1 gap-1.5 text-sm"
                  disabled={loading}
                  onClick={handleCreate}
                >
                  {loading
                    ? <><Loader2 className="size-3.5 animate-spin" /> Creating…</>
                    : <>Create connector <CheckCircle2 className="size-3.5" /></>
                  }
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
