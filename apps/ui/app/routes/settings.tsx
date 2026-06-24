// SPDX-License-Identifier: Apache-2.0
import {
  Settings,
  Shield,
  MessageSquare,
  Brain,
  Gauge,
  ChevronDown,
  Filter,
  AlignLeft,
  Users,
  Plus,
  Trash2,
  Globe,
  Key,
  Loader2,
  CheckCircle2,
  Link2,
  MemoryStick,
} from "lucide-react";
import { useState, useEffect } from "react";

import { STMPanel } from "~/components/STMPanel";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import {
  type CouncilMember,
  type MemberMode,
  API_PROVIDERS,
  loadCouncilMembers,
  saveCouncilMembers,
  newMember,
} from "~/lib/council";
import { connectProvider, isProviderConnected } from "~/lib/deliberate";

// ── Connected Accounts ────────────────────────────────────────────────────────

const BROWSER_PROVIDERS = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    description: "Uses your ChatGPT Plus / Team subscription",
    logo: (
      <svg viewBox="0 0 24 24" className="size-6" fill="currentColor">
        <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.843-3.368 2.02-1.167a.076.076 0 0 1 .071 0l4.83 2.786a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.402-.678zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
      </svg>
    ),
  },
  {
    id: "gemini",
    name: "Gemini",
    description: "Uses your Google account — Gemini Advanced optional",
    logo: (
      <svg viewBox="0 0 24 24" className="size-6" fill="none">
        <path
          d="M12 24A14.304 14.304 0 0 0 0 12 14.304 14.304 0 0 0 12 0a14.304 14.304 0 0 0 12 12 14.304 14.304 0 0 0-12 12z"
          fill="url(#gemini-grad)"
        />
        <defs>
          <linearGradient
            id="gemini-grad"
            x1="0"
            y1="0"
            x2="24"
            y2="24"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#4285F4" />
            <stop offset="1" stopColor="#34A853" />
          </linearGradient>
        </defs>
      </svg>
    ),
  },
  {
    id: "claude",
    name: "Claude",
    description: "Uses your Anthropic / Claude Pro subscription",
    logo: (
      <svg viewBox="0 0 24 24" className="size-6" fill="currentColor">
        <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128-2.962-.77-.284-.283v-.351l.256-.283 4.5.064.13-.13v-.283l-4.629-1.424-.387-.516.129-.477.411-.194 5.077 1.295.098-.098-.048-.177L9.01 8.287l.098-.597.468-.258.597.194 2.109 4.242.09-.012.645-5.025.354-.384.497.065.32.384-.226 5.045.069.069 2.281-4.403.516-.258.565.258.113.636-3.242 5.433.048.177 4.952-1.296.42.194.13.413-.387.529-4.548 1.424v.283l.13.13h4.484l.256.283v.354l-.256.283-4.484.77-.098.11.098.256 4.71 2.647.097.516-.29.484-5.654-1.682-.128.064-1.069 4.823-.485.388-.515-.388-1.066-4.823-.13-.064-5.65 1.682-.293-.484.1-.516z" />
      </svg>
    ),
  },
];

function ConnectedAccountsCard() {
  const [statuses, setStatuses] = useState<Record<string, boolean | null>>({
    chatgpt: null,
    gemini: null,
    claude: null,
  });
  const [connecting, setConnecting] = useState<string | null>(null);

  useEffect(() => {
    BROWSER_PROVIDERS.forEach(async (p) => {
      const ok = await isProviderConnected(p.id);
      setStatuses((prev) => ({ ...prev, [p.id]: ok }));
    });
  }, []);

  const handleConnect = async (id: string) => {
    setConnecting(id);
    await connectProvider(id);
    const ok = await isProviderConnected(id);
    setStatuses((prev) => ({ ...prev, [id]: ok }));
    setConnecting(null);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="size-4" />
          Connected Accounts
        </CardTitle>
        <CardDescription>
          Connect your existing subscriptions — no API key needed. Nexus opens a sign-in window and
          saves your session.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {BROWSER_PROVIDERS.map((p) => {
          const status = statuses[p.id];
          const isConnecting = connecting === p.id;
          return (
            <div key={p.id} className="flex items-center gap-4 rounded-lg border p-4">
              <div className="shrink-0 text-foreground/80">{p.logo}</div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{p.name}</p>
                <p className="text-xs text-muted-foreground">{p.description}</p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <div className="flex items-center gap-1.5 text-xs">
                  {status === null ? (
                    <Loader2 className="size-3 animate-spin text-muted-foreground" />
                  ) : status ? (
                    <>
                      <CheckCircle2 className="size-3.5 text-green-500" />
                      <span className="text-green-600 dark:text-green-400">Connected</span>
                    </>
                  ) : (
                    <>
                      <span className="size-2 rounded-full bg-amber-400 inline-block" />
                      <span className="text-muted-foreground">Not signed in</span>
                    </>
                  )}
                </div>
                <Button
                  size="sm"
                  variant={status ? "outline" : "default"}
                  className="h-8 text-xs gap-1.5"
                  onClick={() => handleConnect(p.id)}
                  disabled={isConnecting}
                >
                  {isConnecting ? (
                    <>
                      <Loader2 className="size-3 animate-spin" />
                      Opening…
                    </>
                  ) : status ? (
                    <>
                      <Globe className="size-3" />
                      Reconnect
                    </>
                  ) : (
                    <>
                      <Globe className="size-3" />
                      Sign in
                    </>
                  )}
                </Button>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-4">
      <div className="space-y-0.5">
        <Label className="text-sm font-medium">{label}</Label>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

// ── Council Member Row ────────────────────────────────────────────────────────

const BROWSER_CAPABLE = new Set(["chatgpt", "gemini", "claude"]);

function MemberRow({
  member,
  onChange,
  onRemove,
}: {
  member: CouncilMember;
  onChange: (m: CouncilMember) => void;
  onRemove?: () => void;
}) {
  const canBrowser = BROWSER_CAPABLE.has(member.id);
  const selectedProvider = API_PROVIDERS.find((p) => p.id === member.provider);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [connecting, setConnecting] = useState(false);

  // Check connection status when member is in browser mode
  useEffect(() => {
    if (!canBrowser || member.mode !== "browser") {
      setConnected(null);
      return;
    }
    isProviderConnected(member.id).then(setConnected);
  }, [member.id, member.mode, canBrowser]);

  const handleConnect = async () => {
    setConnecting(true);
    await connectProvider(member.id);
    // Re-check after window closes
    const status = await isProviderConnected(member.id);
    setConnected(status);
    setConnecting(false);
  };

  const handleModeChange = (mode: MemberMode) => {
    onChange({ ...member, mode });
  };

  const handleProviderChange = (providerId: string) => {
    const p = API_PROVIDERS.find((x) => x.id === providerId)!;
    onChange({
      ...member,
      provider: providerId,
      model: p.defaultModel,
      baseUrl: p.defaultBaseUrl,
    });
  };

  return (
    <div
      className={`rounded-lg border p-4 space-y-3 transition-opacity ${member.enabled ? "" : "opacity-50"}`}
    >
      {/* Header row */}
      <div className="flex items-center gap-3">
        <Switch
          checked={member.enabled}
          onCheckedChange={(v) => onChange({ ...member, enabled: v })}
        />
        <Input
          className="h-7 text-sm font-medium w-32 px-2"
          value={member.label}
          onChange={(e) => onChange({ ...member, label: e.target.value })}
        />

        {/* Mode toggle — browser only for chatgpt/gemini/claude */}
        <div className="flex items-center rounded-md border overflow-hidden text-xs ml-auto">
          {canBrowser && (
            <button
              className={`px-3 py-1.5 flex items-center gap-1.5 transition-colors ${
                member.mode === "browser"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => handleModeChange("browser")}
            >
              <Globe className="size-3" />
              Browser
            </button>
          )}
          <button
            className={`px-3 py-1.5 flex items-center gap-1.5 transition-colors ${
              member.mode === "api"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => handleModeChange("api")}
          >
            <Key className="size-3" />
            API
          </button>
        </div>

        {onRemove && (
          <button
            onClick={onRemove}
            className="text-muted-foreground hover:text-destructive transition-colors ml-1"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>

      {/* Browser mode — show connection status + Connect button */}
      {canBrowser && member.mode === "browser" && (
        <div className="flex items-center gap-3 pl-9">
          <div className="flex items-center gap-1.5 text-xs">
            {connected === null ? (
              <span className="size-2 rounded-full bg-muted-foreground/40 inline-block" />
            ) : connected ? (
              <CheckCircle2 className="size-3.5 text-green-500" />
            ) : (
              <span className="size-2 rounded-full bg-amber-400 inline-block" />
            )}
            <span className="text-muted-foreground">
              {connected === null ? "Checking…" : connected ? "Connected" : "Not signed in"}
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1.5"
            onClick={handleConnect}
            disabled={connecting}
          >
            {connecting ? (
              <>
                <Loader2 className="size-3 animate-spin" /> Opening…
              </>
            ) : (
              <>
                <Globe className="size-3" /> {connected ? "Re-connect" : "Connect account"}
              </>
            )}
          </Button>
          <span className="text-xs text-muted-foreground">
            Sign in with your existing {member.label} subscription
          </span>
        </div>
      )}

      {/* API config — visible when mode is api */}
      {member.mode === "api" && (
        <div className="grid grid-cols-2 gap-2 pl-9">
          {/* Provider */}
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Provider</Label>
            <Select value={member.provider} onValueChange={handleProviderChange}>
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {API_PROVIDERS.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="text-xs">
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Model */}
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Model</Label>
            <Input
              className="h-7 text-xs"
              placeholder="model name"
              value={member.model}
              onChange={(e) => onChange({ ...member, model: e.target.value })}
            />
          </div>

          {/* API keys are managed centrally and encrypted server-side — see the
              Provider Keys page (/provider-keys). Not entered per-member here. */}
          {selectedProvider?.needsKey !== false && (
            <p className="col-span-2 text-xs text-muted-foreground">
              Add this provider&apos;s key on the{" "}
              <a href="/provider-keys" className="underline">
                Provider Keys
              </a>{" "}
              page.
            </p>
          )}

          {/* Base URL — shown for ollama and custom */}
          {(member.provider === "ollama" || member.provider === "custom") && (
            <div className="space-y-1 col-span-2">
              <Label className="text-xs text-muted-foreground">Base URL</Label>
              <Input
                className="h-7 text-xs font-mono"
                placeholder="http://localhost:11434/v1"
                value={member.baseUrl}
                onChange={(e) => onChange({ ...member, baseUrl: e.target.value })}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Settings Page ────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [members, setMembers] = useState<CouncilMember[]>(loadCouncilMembers);
  const [councilSaved, setCouncilSaved] = useState(false);

  const updateMember = (id: string, updated: CouncilMember) => {
    setMembers((prev) => prev.map((m) => (m.id === id ? updated : m)));
  };

  const removeMember = (id: string) => {
    setMembers((prev) => prev.filter((m) => m.id !== id));
  };

  const addMember = () => {
    setMembers((prev) => [...prev, newMember()]);
  };

  const saveCouncil = () => {
    saveCouncilMembers(members);
    // Sync to electron main if running in desktop
    if (typeof window !== "undefined") {
      const molecule = (
        window as { molecule?: { setCouncilMembers: (m: CouncilMember[]) => void } }
      ).molecule;
      if (molecule) molecule.setCouncilMembers(members);
    }
    setCouncilSaved(true);
    setTimeout(() => setCouncilSaved(false), 2000);
    // Persist to backend (fire-and-forget)
    fetch("/api/settings/council", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ members }),
    }).catch(() => {});
  };

  const [autoCouncil, setAutoCouncil] = useState(true);
  const [debateRound, setDebateRound] = useState(true);
  const [coldValidator, setColdValidator] = useState(false);
  const [piiDetection, setPiiDetection] = useState(true);
  const [autoAnonymize, setAutoAnonymize] = useState(false);
  const [blockProfanity, setBlockProfanity] = useState(false);
  const [blockAdultContent, setBlockAdultContent] = useState(false);
  const [verbosityLevel, setVerbosityLevel] = useState("standard");
  const [deliberationMode, setDeliberationMode] = useState("standard");
  const [enableStreaming, setEnableStreaming] = useState(true);
  const [quotasOpen, setQuotasOpen] = useState(false);

  // Quotas from API
  const [quotas, setQuotas] = useState<{
    requests: number;
    requestsLimit: number;
    tokens: number;
    tokensLimit: number;
  } | null>(null);

  // ── Load preferences from backend ──────────────────────────────────────────
  useEffect(() => {
    fetch("/api/settings/preferences")
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{
              autoCouncil?: boolean;
              debateRound?: boolean;
              coldValidator?: boolean;
              piiDetection?: boolean;
              autoAnonymize?: boolean;
              blockProfanity?: boolean;
              blockAdultContent?: boolean;
              verbosityLevel?: string;
              deliberationMode?: string;
              enableStreaming?: boolean;
            }>)
          : Promise.reject(new Error("failed")),
      )
      .then((data) => {
        if (data.autoCouncil !== undefined) setAutoCouncil(data.autoCouncil);
        if (data.debateRound !== undefined) setDebateRound(data.debateRound);
        if (data.coldValidator !== undefined) setColdValidator(data.coldValidator);
        if (data.piiDetection !== undefined) setPiiDetection(data.piiDetection);
        if (data.autoAnonymize !== undefined) setAutoAnonymize(data.autoAnonymize);
        if (data.blockProfanity !== undefined) setBlockProfanity(data.blockProfanity);
        if (data.blockAdultContent !== undefined) setBlockAdultContent(data.blockAdultContent);
        if (data.verbosityLevel !== undefined) setVerbosityLevel(data.verbosityLevel);
        if (data.deliberationMode !== undefined) setDeliberationMode(data.deliberationMode);
        if (data.enableStreaming !== undefined) setEnableStreaming(data.enableStreaming);
      })
      .catch(() => {});

    // Load quotas from analytics overview
    fetch("/api/analytics/overview")
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{
              requestsToday?: number;
              conversationsToday?: number;
              requestsLimit?: number;
              totalTokensUsed?: number;
              tokensLimit?: number;
            }>)
          : Promise.reject(new Error("failed")),
      )
      .then((data) => {
        setQuotas({
          requests: data.requestsToday ?? data.conversationsToday ?? 0,
          requestsLimit: data.requestsLimit ?? 100,
          tokens: data.totalTokensUsed ?? 0,
          tokensLimit: data.tokensLimit ?? 1_000_000,
        });
      })
      .catch(() => {});
  }, []);

  // ── Save preferences when any toggle changes ───────────────────────────────
  useEffect(() => {
    const prefs = {
      autoCouncil,
      debateRound,
      coldValidator,
      piiDetection,
      autoAnonymize,
      blockProfanity,
      blockAdultContent,
      verbosityLevel,
      deliberationMode,
      enableStreaming,
    };
    fetch("/api/settings/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(prefs),
    }).catch(() => {});
  }, [
    autoCouncil,
    debateRound,
    coldValidator,
    piiDetection,
    autoAnonymize,
    blockProfanity,
    blockAdultContent,
    verbosityLevel,
    deliberationMode,
    enableStreaming,
  ]);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto p-6 space-y-6">
        <div className="flex items-center gap-3">
          <Settings className="size-6 text-muted-foreground" />
          <div>
            <h1 className="text-xl font-semibold">Settings</h1>
            <p className="text-sm text-muted-foreground">
              Configure your council members and deliberation preferences
            </p>
          </div>
        </div>

        {/* Connected Accounts */}
        <ConnectedAccountsCard />

        {/* Council Members */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="size-4" />
              Council Members
            </CardTitle>
            <CardDescription>
              Toggle members on/off. Switch between <strong>Browser</strong> (uses your existing
              subscription — no API key) or <strong>API</strong> (uses a key you provide). Mix and
              match freely.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {members.map((m) => (
              <MemberRow
                key={m.id}
                member={m}
                onChange={(updated) => updateMember(m.id, updated)}
                onRemove={BROWSER_CAPABLE.has(m.id) ? undefined : () => removeMember(m.id)}
              />
            ))}

            <button
              onClick={addMember}
              className="w-full flex items-center justify-center gap-2 rounded-lg border border-dashed py-3 text-sm text-muted-foreground hover:text-foreground hover:border-border transition-colors"
            >
              <Plus className="size-4" />
              Add member
            </button>

            <Button onClick={saveCouncil} size="sm" className="mt-1">
              {councilSaved ? "Saved ✓" : "Save Council"}
            </Button>
          </CardContent>
        </Card>

        {/* Council Behaviour */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Brain className="size-4" />
              Council Behaviour
            </CardTitle>
            <CardDescription>Control how the council deliberates</CardDescription>
          </CardHeader>
          <CardContent className="divide-y divide-border">
            <ToggleRow
              label="Auto-Council Mode"
              description="Automatically select optimal members for each query"
              checked={autoCouncil}
              onCheckedChange={setAutoCouncil}
            />
            <ToggleRow
              label="Enable Debate Round"
              description="Enable multi-round deliberation between members"
              checked={debateRound}
              onCheckedChange={setDebateRound}
            />
            <ToggleRow
              label="Cold Validator"
              description="Add a critical validator pass after consensus"
              checked={coldValidator}
              onCheckedChange={setColdValidator}
            />
          </CardContent>
        </Card>

        {/* Chat Preferences */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="size-4" />
              Chat Preferences
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-0 divide-y divide-border">
            <div className="flex items-center justify-between py-4">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium">Default Deliberation Mode</Label>
                <p className="text-sm text-muted-foreground">
                  Reasoning strategy for council sessions
                </p>
              </div>
              <Select value={deliberationMode} onValueChange={setDeliberationMode}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="standard">Standard</SelectItem>
                  <SelectItem value="socratic">Socratic</SelectItem>
                  <SelectItem value="red_blue">Red/Blue Team</SelectItem>
                  <SelectItem value="hypothesis">Hypothesis</SelectItem>
                  <SelectItem value="confidence">Confidence</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <ToggleRow
              label="Enable Streaming"
              description="Stream member responses as they are generated"
              checked={enableStreaming}
              onCheckedChange={setEnableStreaming}
            />
            <div className="flex items-center justify-between py-4">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium flex items-center gap-1.5">
                  <AlignLeft className="size-3.5" />
                  Response Verbosity
                </Label>
                <p className="text-sm text-muted-foreground">Depth and length of AI responses</p>
              </div>
              <Select value={verbosityLevel} onValueChange={setVerbosityLevel}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="concise">Concise — 2–3 sentences</SelectItem>
                  <SelectItem value="standard">Standard — balanced</SelectItem>
                  <SelectItem value="detailed">Detailed — structured</SelectItem>
                  <SelectItem value="exhaustive">Exhaustive — comprehensive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* Privacy & Safety */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="size-4" />
              Privacy &amp; Safety
            </CardTitle>
          </CardHeader>
          <CardContent className="divide-y divide-border">
            <ToggleRow
              label="PII Detection"
              description="Scan messages for personally identifiable information"
              checked={piiDetection}
              onCheckedChange={setPiiDetection}
            />
            <ToggleRow
              label="Auto-anonymize High Risk"
              description="Automatically redact detected PII before sending"
              checked={autoAnonymize}
              onCheckedChange={setAutoAnonymize}
            />
          </CardContent>
        </Card>

        {/* Content Filters */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Filter className="size-4" />
              Content Filters
            </CardTitle>
            <CardDescription>
              Both filters are <strong>off by default</strong>.
            </CardDescription>
          </CardHeader>
          <CardContent className="divide-y divide-border">
            <ToggleRow
              label="Block Profanity"
              description="Redact profanity from input and AI responses."
              checked={blockProfanity}
              onCheckedChange={setBlockProfanity}
            />
            <ToggleRow
              label="Block Adult / Explicit Content"
              description="Block adult or sexually explicit content in input and output."
              checked={blockAdultContent}
              onCheckedChange={setBlockAdultContent}
            />
          </CardContent>
        </Card>

        {/* Quotas */}
        {/* STM Modules */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MemoryStick className="size-4" />
              STM Modules
            </CardTitle>
            <CardDescription>
              Prompt modifiers applied to every council member each round. Visit{" "}
              <a href="/stm" className="text-primary hover:underline">
                STM
              </a>{" "}
              for full session history.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <STMPanel />
          </CardContent>
        </Card>

        <Collapsible open={quotasOpen} onOpenChange={setQuotasOpen}>
          <Card>
            <CollapsibleTrigger className="w-full">
              <CardHeader className="cursor-pointer">
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <Gauge className="size-4" />
                    Quotas &amp; Limits
                  </CardTitle>
                  <ChevronDown
                    className={`size-4 text-muted-foreground transition-transform ${quotasOpen ? "rotate-180" : ""}`}
                  />
                </div>
                <CardDescription>View current usage against daily limits</CardDescription>
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="space-y-5">
                {quotas === null ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" /> Loading usage…
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span>Daily Requests</span>
                        <span className="text-muted-foreground">
                          {quotas.requests.toLocaleString()} /{" "}
                          {quotas.requestsLimit.toLocaleString()}
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full bg-primary transition-all"
                          style={{
                            width: `${Math.min(100, (quotas.requests / quotas.requestsLimit) * 100).toFixed(1)}%`,
                          }}
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span>Daily Tokens</span>
                        <span className="text-muted-foreground">
                          {quotas.tokens.toLocaleString()} / {quotas.tokensLimit.toLocaleString()}
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full bg-primary transition-all"
                          style={{
                            width: `${Math.min(100, (quotas.tokens / quotas.tokensLimit) * 100).toFixed(1)}%`,
                          }}
                        />
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>
      </div>
    </div>
  );
}
