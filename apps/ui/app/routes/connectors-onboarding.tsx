// SPDX-License-Identifier: Apache-2.0
/**
 * Connector Onboarding — credential-based connector setup
 *
 * Step 1: Pick connector type
 * Step 2: credential input
 * Step 3: Configure (name, sync schedule, initial sync mode)
 * Step 4: Done — navigate to sync dashboard
 */

import { ChevronLeft, ChevronRight, Plug, CheckCircle2, Loader2, ArrowRight } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";

import { Page, PageHeader } from "~/components/page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { cn } from "~/lib/utils";

// ── Connector catalog ─────────────────────────────────────────────────────────

interface ConnectorDef {
  id: string;
  label: string;
  icon: string;
  category: string;
  authType: "api_key" | "credentials" | "url";
  fields?: {
    key: string;
    label: string;
    type?: string;
    placeholder?: string;
    required?: boolean;
  }[];
  description: string;
}

const CONNECTORS: ConnectorDef[] = [
  // ── Productivity ────────────────────────────────────────────────────────────
  {
    id: "notion",
    label: "Notion",
    icon: "📝",
    category: "Productivity",
    authType: "api_key",
    fields: [
      { key: "api_key", label: "Integration token", placeholder: "secret_…", required: true },
      { key: "database_id", label: "Database ID", placeholder: "32-character ID", required: true },
    ],
    description: "Sync pages from a Notion database",
  },
  {
    id: "confluence",
    label: "Confluence",
    icon: "🌊",
    category: "Productivity",
    authType: "credentials",
    fields: [
      {
        key: "url",
        label: "Confluence URL",
        placeholder: "https://yoursite.atlassian.net",
        required: true,
      },
      { key: "username", label: "Email", placeholder: "you@example.com", required: true },
      { key: "api_token", label: "API Token", type: "password", required: true },
      { key: "space_key", label: "Space key", placeholder: "ENG", required: true },
    ],
    description: "Sync the pages of a Confluence space",
  },
  // ── Engineering ─────────────────────────────────────────────────────────────
  {
    id: "github",
    label: "GitHub",
    icon: "🐙",
    category: "Engineering",
    authType: "api_key",
    fields: [
      { key: "token", label: "Personal access token", type: "password", required: true },
      { key: "repository", label: "Repository", placeholder: "owner/name", required: true },
    ],
    description: "Index a repository's README, issues and pull requests",
  },
  {
    id: "gitlab",
    label: "GitLab",
    icon: "🦊",
    category: "Engineering",
    authType: "api_key",
    fields: [
      { key: "url", label: "GitLab URL", placeholder: "https://gitlab.com", required: true },
      { key: "api_token", label: "Access Token", type: "password", required: true },
      {
        key: "project_id",
        label: "Project ID or path",
        placeholder: "group/project",
        required: true,
      },
    ],
    description: "Sync a GitLab project's issues and merge requests",
  },
  {
    id: "linear",
    label: "Linear",
    icon: "📐",
    category: "Engineering",
    authType: "api_key",
    fields: [
      { key: "api_key", label: "Linear API key", placeholder: "lin_api_…", required: true },
      { key: "team_id", label: "Team ID (optional)" },
    ],
    description: "Index Linear issues and projects",
  },
  {
    id: "jira",
    label: "Jira",
    icon: "🎯",
    category: "Engineering",
    authType: "credentials",
    fields: [
      {
        key: "url",
        label: "Jira URL",
        placeholder: "https://yoursite.atlassian.net",
        required: true,
      },
      { key: "username", label: "Email", placeholder: "you@example.com", required: true },
      { key: "api_token", label: "API Token", type: "password", required: true },
      { key: "jql", label: "JQL filter (optional)", placeholder: "project = ENG" },
    ],
    description: "Sync Jira tickets",
  },
  // ── Messaging ───────────────────────────────────────────────────────────────
  {
    id: "slack",
    label: "Slack",
    icon: "💬",
    category: "Messaging",
    authType: "api_key",
    fields: [
      {
        key: "bot_token",
        label: "Bot token",
        type: "password",
        placeholder: "xoxb-…",
        required: true,
      },
      { key: "channel_id", label: "Channel ID", placeholder: "C0123456789", required: true },
    ],
    description: "Sync messages from a Slack channel",
  },
  {
    id: "discord",
    label: "Discord",
    icon: "🎮",
    category: "Messaging",
    authType: "api_key",
    fields: [
      { key: "bot_token", label: "Bot Token", type: "password", required: true },
      { key: "channel_ids", label: "Channel IDs", placeholder: "comma separated", required: true },
    ],
    description: "Index messages from Discord channels",
  },
  // ── Web ─────────────────────────────────────────────────────────────────────
  {
    id: "web",
    label: "Web crawler",
    icon: "🌐",
    category: "Web",
    authType: "url",
    fields: [
      {
        key: "base_url",
        label: "Page URLs",
        placeholder: "https://docs.example.com/a, https://docs.example.com/b",
        required: true,
      },
    ],
    description: "Index a list of public web pages",
  },
  {
    id: "zendesk",
    label: "Zendesk",
    icon: "🎫",
    category: "Support",
    authType: "credentials",
    fields: [
      { key: "subdomain", label: "Subdomain", placeholder: "yourco", required: true },
      { key: "email", label: "Email", required: true },
      { key: "api_token", label: "API Token", type: "password", required: true },
    ],
    description: "Sync Zendesk tickets and help center articles",
  },
];

const CATEGORIES = [...new Set(CONNECTORS.map((c) => c.category))];

// ── Steps ─────────────────────────────────────────────────────────────────────

const STEPS = ["Pick", "Auth", "Configure", "Done"] as const;

// ── Main component ────────────────────────────────────────────────────────────

export default function ConnectorsOnboardingPage() {
  const navigate = useNavigate();

  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState<ConnectorDef | null>(null);
  const [filterCategory, setFilter] = useState<string>("all");
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [config, setConfig] = useState({ name: "", syncMode: "load", schedule: "daily" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const setField = (key: string, val: string) => setCredentials((p) => ({ ...p, [key]: val }));

  const canAdvanceAuth = () => {
    if (!selected) return false;
    const fields = selected.fields ?? [];
    return fields.filter((f) => f.required).every((f) => credentials[f.key]?.trim());
  };

  const handleCreate = async () => {
    if (!selected) return;
    setLoading(true);
    setError(null);
    try {
      const body = {
        name: config.name || selected.label,
        source: selected.id,
        inputType: "connector",
        credentials,
        syncConfig: {
          mode: config.syncMode,
          schedule: config.schedule !== "manual" ? config.schedule : undefined,
        },
      };

      const res = await fetch("/api/connectors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(err.message ?? `Failed (${res.status})`);
      }

      const data = (await res.json()) as { id?: string; connector?: { id?: string } };
      setCreatedId(data.id ?? data.connector?.id ?? null);
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Creation failed");
    }
    setLoading(false);
  };

  const filteredConnectors =
    filterCategory === "all" ? CONNECTORS : CONNECTORS.filter((c) => c.category === filterCategory);

  return (
    <Page width="narrow">
      <PageHeader
        title="Add a connector"
        description="Connect a source whose documents sync into your knowledge bases."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link to="/connectors/sync">Back to connectors</Link>
          </Button>
        }
      />
      <div className="space-y-5">
        {/* Progress */}
        <div className="flex flex-wrap items-center justify-center gap-1">
          {STEPS.map((s, i) => (
            <div key={s} className="flex items-center gap-1">
              <div
                className={cn(
                  "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs",
                  i === step
                    ? "border-primary/30 bg-primary/15 text-primary"
                    : i < step
                      ? "border-transparent bg-muted/50 text-foreground"
                      : "border-transparent text-muted-foreground",
                )}
              >
                {i < step ? <CheckCircle2 className="size-3" /> : <Plug className="size-3" />}
                {s}
              </div>
              {i < STEPS.length - 1 && (
                <div className={cn("h-px w-4", i < step ? "bg-primary/40" : "bg-border")} />
              )}
            </div>
          ))}
        </div>

        {/* Card */}
        <div className="rounded-xl border bg-card p-4 sm:p-6">
          {/* Step 0 — Pick connector */}
          {step === 0 && (
            <div className="space-y-4">
              {/* Category filter */}
              <div className="flex flex-wrap gap-1.5">
                {["all", ...CATEGORIES].map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setFilter(cat)}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs capitalize transition-colors",
                      filterCategory === cat
                        ? "border-primary/30 bg-primary/15 text-primary"
                        : "border-border/50 bg-muted/40 text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {cat}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {filteredConnectors.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      setSelected(c);
                      setCredentials({});
                    }}
                    className={cn(
                      "flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors",
                      selected?.id === c.id
                        ? "border-primary/40 bg-primary/10"
                        : "border-border/50 bg-muted/30 hover:bg-muted/60",
                    )}
                  >
                    <span className="text-xl">{c.icon}</span>
                    <div className="min-w-0">
                      <p className="text-xs font-medium">{c.label}</p>
                      <Badge variant="outline" className="text-xs mt-0.5 h-3.5 px-1">
                        {c.authType}
                      </Badge>
                    </div>
                  </button>
                ))}
              </div>

              {selected && (
                <p className="text-xs text-muted-foreground border-t border-border pt-3">
                  <span className="text-foreground font-medium">{selected.label}:</span>{" "}
                  {selected.description}
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
                <Select
                  value={config.syncMode}
                  onValueChange={(v) => setConfig((c) => ({ ...c, syncMode: v }))}
                >
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="load" className="text-xs">
                      Load — full initial sync
                    </SelectItem>
                    <SelectItem value="poll" className="text-xs">
                      Poll — only items changed since the last sync
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Sync schedule</Label>
                <Select
                  value={config.schedule}
                  onValueChange={(v) => setConfig((c) => ({ ...c, schedule: v }))}
                >
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual" className="text-xs">
                      Manual only
                    </SelectItem>
                    <SelectItem value="hourly" className="text-xs">
                      Every hour
                    </SelectItem>
                    <SelectItem value="daily" className="text-xs">
                      Daily
                    </SelectItem>
                    <SelectItem value="weekly" className="text-xs">
                      Weekly
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {error && <p className="text-xs text-destructive">{error}</p>}
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
                  onClick={() =>
                    navigate(createdId ? `/connectors/sync?id=${createdId}` : "/connectors/sync")
                  }
                  className="gap-2"
                >
                  View sync status <ArrowRight className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setStep(0);
                    setSelected(null);
                    setCredentials({});
                    setCreatedId(null);
                  }}
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
                <Button
                  variant="outline"
                  className="gap-1.5 text-sm"
                  onClick={() => setStep((s) => s - 1)}
                >
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
              {step === 1 && (
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
                  {loading ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" /> Creating…
                    </>
                  ) : (
                    <>
                      Create connector <CheckCircle2 className="size-3.5" />
                    </>
                  )}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </Page>
  );
}
