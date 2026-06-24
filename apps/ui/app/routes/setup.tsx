// SPDX-License-Identifier: Apache-2.0
/**
 * First-run onboarding wizard — 4 steps
 *
 * Step 1: Welcome + platform overview
 * Step 2: Council configuration (providers + keys)
 * Step 3: Deliberation preferences
 * Step 4: Identity + launch
 */

import {
  Zap,
  Users,
  Brain,
  Settings2,
  ChevronRight,
  ChevronLeft,
  CheckCircle2,
  Key,
  Globe,
  Cpu,
  Sparkles,
  ArrowRight,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

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
import { Switch } from "~/components/ui/switch";
import { useAuth } from "~/context/AuthContext";
import {
  type CouncilMember,
  API_PROVIDERS,
  DEFAULT_MEMBERS,
  saveCouncilMembers,
} from "~/lib/council";

// ─── Constants ────────────────────────────────────────────────────────────────

const STEPS = [
  { id: 1, label: "Welcome", icon: Sparkles },
  { id: 2, label: "Council", icon: Users },
  { id: 3, label: "Prefs", icon: Settings2 },
  { id: 4, label: "Launch", icon: Zap },
] as const;

const SYNTHESIS_MODELS = [
  { id: "rotate", label: "Rotate (default)", detail: "Each round a different member synthesizes" },
  {
    id: "fastest",
    label: "Fastest responder",
    detail: "Whoever finishes first writes the verdict",
  },
  { id: "openai", label: "Always OpenAI", detail: "" },
  { id: "anthropic", label: "Always Anthropic", detail: "" },
  { id: "gemini", label: "Always Gemini", detail: "" },
];

const DELIBERATION_MODES = [
  { id: "consensus", label: "Consensus", desc: "Find common ground across all members" },
  { id: "debate", label: "Debate", desc: "Argue opposing positions before verdict" },
  { id: "expert", label: "Expert Panel", desc: "Each member uses a specialist persona" },
  { id: "blind", label: "Blind Council", desc: "Members cannot see each other's answers" },
];

const BROWSER_ACCOUNTS = [
  { id: "chatgpt", name: "ChatGPT", hint: "Uses your ChatGPT Plus / Team account" },
  { id: "gemini", name: "Gemini", hint: "Uses your Google account (Gemini Advanced opt.)" },
  { id: "claude", name: "Claude", hint: "Uses your Anthropic / Claude Pro subscription" },
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface WizardPrefs {
  synthesisModel: string;
  deliberationMode: string;
  roundsBeforeCompact: number;
  browserAccounts: Record<string, boolean>;
  apiMembers: CouncilMember[];
  username: string;
}

// ─── Step 1: Welcome ─────────────────────────────────────────────────────────

function StepWelcome() {
  return (
    <div className="space-y-7">
      <div className="text-center space-y-3">
        <div className="flex justify-center">
          <div className="relative">
            <div
              className="size-20 rounded-2xl flex items-center justify-center text-4xl"
              style={{
                background:
                  "linear-gradient(135deg, hsl(var(--primary)/0.12), hsl(var(--primary)/0.04))",
                border: "1px solid hsl(var(--primary)/0.3)",
              }}
            >
              ⚖
            </div>
            <div
              className="absolute -inset-1 rounded-2xl blur-md opacity-20 pointer-events-none"
              style={{ background: "hsl(var(--primary))" }}
            />
          </div>
        </div>
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Welcome to Nexus</h2>
          <p className="text-muted-foreground mt-1 text-sm">Multi-model AI deliberation platform</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2.5">
        {[
          {
            icon: Users,
            title: "Council",
            desc: "3–51 AI models deliberate simultaneously on your question",
          },
          {
            icon: Brain,
            title: "Synthesis",
            desc: "A rotating synthesizer distills a single verdict from all opinions",
          },
          {
            icon: Cpu,
            title: "RAG + Memory",
            desc: "Your docs, connectors, and conversation history inform every answer",
          },
          {
            icon: Zap,
            title: "Agentic tools",
            desc: "Code execution, web search, and 50+ connectors available to the council",
          },
        ].map(({ icon: Icon, title, desc }) => (
          <div
            key={title}
            className="flex items-start gap-3 p-3 rounded-lg"
            style={{
              background: "hsl(var(--muted)/0.4)",
              border: "1px solid hsl(var(--border)/0.5)",
            }}
          >
            <Icon className="size-4 text-primary mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium">{title}</p>
              <p className="text-xs text-muted-foreground">{desc}</p>
            </div>
          </div>
        ))}
      </div>

      <p className="text-xs text-center text-muted-foreground">
        This wizard takes ~2 minutes. Everything can be changed in Settings later.
      </p>
    </div>
  );
}

// ─── Step 2: Council ─────────────────────────────────────────────────────────

function StepCouncil({
  prefs,
  setPrefs,
}: {
  prefs: WizardPrefs;
  setPrefs: React.Dispatch<React.SetStateAction<WizardPrefs>>;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [newProvider, setNewProvider] = useState("openai");
  const [newModel, setNewModel] = useState("");

  const toggleBrowser = (id: string) =>
    setPrefs((p) => ({
      ...p,
      browserAccounts: { ...p.browserAccounts, [id]: !p.browserAccounts[id] },
    }));

  const addApi = () => {
    const prov = API_PROVIDERS.find((p) => p.id === newProvider)!;
    const model = newModel.trim() || prov.defaultModel;
    const member: CouncilMember = {
      id: `api_${Date.now()}`,
      label: `${prov.label} — ${model}`,
      enabled: true,
      mode: "api",
      provider: prov.id,
      model,
      baseUrl: prov.defaultBaseUrl,
    };
    setPrefs((p) => ({ ...p, apiMembers: [...p.apiMembers, member] }));
    setShowAdd(false);
    setNewModel("");
    setNewProvider("openai");
  };

  const removeApi = (id: string) =>
    setPrefs((p) => ({ ...p, apiMembers: p.apiMembers.filter((m) => m.id !== id) }));

  const enabledCount = Object.values(prefs.browserAccounts).filter(Boolean).length;
  const total = enabledCount + prefs.apiMembers.length;

  return (
    <div className="space-y-5">
      {/* Browser accounts */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <h3 className="font-semibold text-sm">Browser accounts</h3>
          <Badge variant="outline" className="text-xs h-4">
            {enabledCount}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Use your existing subscriptions — no API key needed.
        </p>
        <div className="space-y-2">
          {BROWSER_ACCOUNTS.map(({ id, name, hint }) => (
            <div
              key={id}
              className="flex items-center justify-between p-3 rounded-lg"
              style={{
                background: "hsl(var(--muted)/0.4)",
                border: "1px solid hsl(var(--border)/0.5)",
              }}
            >
              <div>
                <p className="text-sm font-medium">{name}</p>
                <p className="text-xs text-muted-foreground">{hint}</p>
              </div>
              <Switch
                checked={prefs.browserAccounts[id] ?? false}
                onCheckedChange={() => toggleBrowser(id)}
              />
            </div>
          ))}
        </div>
      </div>

      {/* API members */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Key className="size-3.5 text-muted-foreground" />
          <h3 className="font-semibold text-sm">API members</h3>
          <Badge variant="outline" className="text-xs h-4">
            {prefs.apiMembers.length}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Add models via API key — OpenAI, Groq, OpenRouter, Ollama, and more.
        </p>

        {prefs.apiMembers.length > 0 && (
          <div className="space-y-1.5 mb-3">
            {prefs.apiMembers.map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between p-2.5 rounded-md text-xs"
                style={{
                  background: "hsl(var(--muted)/0.3)",
                  border: "1px solid hsl(var(--border)/0.4)",
                }}
              >
                <span className="font-medium font-mono">{m.label}</span>
                <button
                  onClick={() => removeApi(m.id)}
                  className="text-muted-foreground hover:text-destructive ml-2"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {showAdd ? (
          <div
            className="p-3 rounded-lg space-y-3"
            style={{
              background: "hsl(var(--muted)/0.4)",
              border: "1px solid hsl(var(--border)/0.5)",
            }}
          >
            <div className="space-y-1.5">
              <Label className="text-xs">Provider</Label>
              <Select value={newProvider} onValueChange={setNewProvider}>
                <SelectTrigger className="h-8 text-xs">
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
            <div className="space-y-1.5">
              <Label className="text-xs">
                Model{" "}
                <span className="text-muted-foreground">
                  (blank = {API_PROVIDERS.find((p) => p.id === newProvider)?.defaultModel})
                </span>
              </Label>
              <Input
                className="h-8 text-xs font-mono"
                value={newModel}
                onChange={(e) => setNewModel(e.target.value)}
              />
            </div>
            {API_PROVIDERS.find((p) => p.id === newProvider)?.needsKey && (
              <p className="text-xs text-muted-foreground">
                Add this provider&apos;s key (encrypted server-side) on the Provider Keys page after
                setup.
              </p>
            )}
            <div className="flex gap-2">
              <Button size="sm" className="h-7 text-xs flex-1" onClick={addApi}>
                Add member
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => setShowAdd(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="w-full h-8 text-xs gap-2 border-dashed"
            onClick={() => setShowAdd(true)}
          >
            <Globe className="size-3.5" /> Add API model
          </Button>
        )}
      </div>

      {total === 0 && (
        <p className="text-xs text-center text-amber-500">
          Enable at least one browser account or add an API member to continue.
        </p>
      )}
      {total > 0 && (
        <p className="text-xs text-center text-muted-foreground">
          Council: <span className="text-foreground font-semibold">{total}</span> member
          {total !== 1 ? "s" : ""}
        </p>
      )}
    </div>
  );
}

// ─── Step 3: Prefs ────────────────────────────────────────────────────────────

function StepPrefs({
  prefs,
  setPrefs,
}: {
  prefs: WizardPrefs;
  setPrefs: React.Dispatch<React.SetStateAction<WizardPrefs>>;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-semibold text-sm mb-1">Deliberation mode</h3>
        <p className="text-xs text-muted-foreground mb-3">
          How should council members approach each question?
        </p>
        <div className="space-y-2">
          {DELIBERATION_MODES.map(({ id, label, desc }) => (
            <button
              key={id}
              onClick={() => setPrefs((p) => ({ ...p, deliberationMode: id }))}
              className="w-full flex items-start gap-3 p-3 rounded-lg text-left transition-colors"
              style={{
                background:
                  prefs.deliberationMode === id
                    ? "hsl(var(--primary)/0.1)"
                    : "hsl(var(--muted)/0.4)",
                border: `1px solid ${prefs.deliberationMode === id ? "hsl(var(--primary)/0.4)" : "hsl(var(--border)/0.5)"}`,
              }}
            >
              {prefs.deliberationMode === id ? (
                <CheckCircle2 className="size-4 text-primary mt-0.5 shrink-0" />
              ) : (
                <div
                  className="size-4 rounded-full mt-0.5 shrink-0"
                  style={{ border: "1px solid hsl(var(--border))" }}
                />
              )}
              <div>
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">{desc}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div>
        <h3 className="font-semibold text-sm mb-1">Synthesis model</h3>
        <p className="text-xs text-muted-foreground mb-2">
          Who writes the final verdict each round?
        </p>
        <Select
          value={prefs.synthesisModel}
          onValueChange={(v) => setPrefs((p) => ({ ...p, synthesisModel: v }))}
        >
          <SelectTrigger className="text-xs h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SYNTHESIS_MODELS.map(({ id, label, detail }) => (
              <SelectItem key={id} value={id} className="text-xs">
                {label}
                {detail && <span className="text-muted-foreground"> — {detail}</span>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <h3 className="font-semibold text-sm mb-1">Compaction threshold</h3>
        <p className="text-xs text-muted-foreground mb-2">
          Compress old rounds into a summary after this many rounds.
        </p>
        <div className="flex items-center gap-2">
          {[3, 5, 8, 12].map((n) => (
            <button
              key={n}
              onClick={() => setPrefs((p) => ({ ...p, roundsBeforeCompact: n }))}
              className="flex-1 py-1.5 rounded-md text-xs font-medium transition-colors"
              style={{
                background:
                  prefs.roundsBeforeCompact === n ? "hsl(var(--primary))" : "hsl(var(--muted)/0.5)",
                color:
                  prefs.roundsBeforeCompact === n
                    ? "hsl(var(--primary-foreground))"
                    : "hsl(var(--muted-foreground))",
                border: "1px solid hsl(var(--border)/0.5)",
              }}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Step 4: Launch ───────────────────────────────────────────────────────────

function StepLaunch({
  prefs,
  setPrefs,
}: {
  prefs: WizardPrefs;
  setPrefs: React.Dispatch<React.SetStateAction<WizardPrefs>>;
}) {
  const enabledBrowser = Object.entries(prefs.browserAccounts)
    .filter(([, v]) => v)
    .map(([k]) => BROWSER_ACCOUNTS.find((b) => b.id === k)?.name ?? k);

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <div className="text-4xl">🚀</div>
        <h3 className="font-semibold text-base">One last thing</h3>
        <p className="text-xs text-muted-foreground">Pick a display name — you're done.</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="wizard-name">Your name</Label>
        <Input
          id="wizard-name"
          placeholder="e.g. Alex"
          value={prefs.username}
          onChange={(e) => setPrefs((p) => ({ ...p, username: e.target.value }))}
          autoFocus
          className="text-sm"
        />
        <p className="text-xs text-muted-foreground">Stored locally — never sent anywhere.</p>
      </div>

      {/* Summary */}
      <div
        className="rounded-lg p-3 space-y-2 text-xs"
        style={{ background: "hsl(var(--muted)/0.4)", border: "1px solid hsl(var(--border)/0.5)" }}
      >
        <p className="font-semibold text-foreground mb-1">Your setup</p>
        {[
          ["Browser accounts", enabledBrowser.length > 0 ? enabledBrowser.join(", ") : "None"],
          ["API members", String(prefs.apiMembers.length)],
          ["Mode", prefs.deliberationMode],
          ["Synthesis", SYNTHESIS_MODELS.find((m) => m.id === prefs.synthesisModel)?.label ?? ""],
          ["Compact after", `${prefs.roundsBeforeCompact} rounds`],
        ].map(([key, val]) => (
          <div key={key} className="flex justify-between">
            <span className="text-muted-foreground">{key}</span>
            <span className="text-foreground capitalize">{val}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main wizard ─────────────────────────────────────────────────────────────

export default function SetupPage() {
  const navigate = useNavigate();
  const { setUser } = useAuth();

  const [step, setStep] = useState(1);
  const [prefs, setPrefs] = useState<WizardPrefs>({
    synthesisModel: "rotate",
    deliberationMode: "consensus",
    roundsBeforeCompact: 5,
    browserAccounts: { chatgpt: true, gemini: true, claude: true },
    apiMembers: [],
    username: "",
  });

  const totalMembers =
    Object.values(prefs.browserAccounts).filter(Boolean).length + prefs.apiMembers.length;

  const canAdvance = () => {
    if (step === 2) return totalMembers > 0;
    if (step === 4) return prefs.username.trim().length > 0;
    return true;
  };

  const advance = () => {
    if (step < 4) {
      setStep((s) => s + 1);
      return;
    }
    finish();
  };

  const finish = () => {
    // Build council member list from wizard selections
    const members: CouncilMember[] = [
      ...BROWSER_ACCOUNTS.filter((b) => prefs.browserAccounts[b.id]).map((b) => ({
        ...(DEFAULT_MEMBERS.find((m) => m.id === b.id) ?? DEFAULT_MEMBERS[0]),
        enabled: true,
      })),
      ...prefs.apiMembers,
    ];
    saveCouncilMembers(members);

    // Persist deliberation prefs
    localStorage.setItem(
      "nexus_prefs",
      JSON.stringify({
        synthesisModel: prefs.synthesisModel,
        deliberationMode: prefs.deliberationMode,
        roundsBeforeCompact: prefs.roundsBeforeCompact,
      }),
    );

    // Mark first-run complete
    localStorage.setItem("nexus_setup_done", "1");

    // Sign in as local user
    const username = prefs.username.trim() || "Commander";
    setUser({ id: `user_${Date.now()}`, username });
    navigate("/chat", { replace: true });
  };

  const currentStep = STEPS.find((s) => s.id === step)!;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-5">
        {/* Progress bar */}
        <div className="flex items-center justify-center gap-1">
          {STEPS.map((s, i) => (
            <div key={s.id} className="flex items-center gap-1">
              <button
                onClick={() => s.id < step && setStep(s.id)}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors"
                style={{
                  background:
                    s.id === step
                      ? "hsl(var(--primary)/0.15)"
                      : s.id < step
                        ? "hsl(var(--muted)/0.3)"
                        : "transparent",
                  color:
                    s.id === step
                      ? "hsl(var(--primary))"
                      : s.id < step
                        ? "hsl(var(--foreground))"
                        : "hsl(var(--muted-foreground))",
                  border: `1px solid ${s.id === step ? "hsl(var(--primary)/0.3)" : "transparent"}`,
                  cursor: s.id < step ? "pointer" : "default",
                }}
              >
                {s.id < step ? <CheckCircle2 className="size-3" /> : <s.icon className="size-3" />}
                <span className="hidden sm:inline">{s.label}</span>
              </button>
              {i < STEPS.length - 1 && (
                <div
                  className="w-4 h-px"
                  style={{
                    background: s.id < step ? "hsl(var(--primary)/0.4)" : "hsl(var(--border))",
                  }}
                />
              )}
            </div>
          ))}
        </div>

        {/* Card */}
        <div
          className="rounded-xl p-6"
          style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
        >
          <div className="mb-5">
            <div className="flex items-center gap-2 mb-1">
              <currentStep.icon className="size-4 text-primary" />
              <h2 className="font-semibold text-base">{currentStep.label}</h2>
              <span className="ml-auto text-xs text-muted-foreground">
                {step} / {STEPS.length}
              </span>
            </div>
            <div className="h-px w-full" style={{ background: "hsl(var(--border)/0.6)" }} />
          </div>

          {step === 1 && <StepWelcome />}
          {step === 2 && <StepCouncil prefs={prefs} setPrefs={setPrefs} />}
          {step === 3 && <StepPrefs prefs={prefs} setPrefs={setPrefs} />}
          {step === 4 && <StepLaunch prefs={prefs} setPrefs={setPrefs} />}

          {/* Navigation */}
          <div className="flex gap-2 mt-6">
            {step > 1 && (
              <Button
                variant="outline"
                className="gap-1.5 text-sm"
                onClick={() => setStep((s) => s - 1)}
              >
                <ChevronLeft className="size-3.5" /> Back
              </Button>
            )}
            <Button className="flex-1 gap-1.5 text-sm" onClick={advance} disabled={!canAdvance()}>
              {step === 4 ? (
                <>
                  <ArrowRight className="size-3.5" /> Enter Nexus
                </>
              ) : (
                <>
                  Continue <ChevronRight className="size-3.5" />
                </>
              )}
            </Button>
          </div>
        </div>

        <p className="text-center text-xs text-muted-foreground">
          All configuration is stored locally — nothing leaves your machine.
        </p>
      </div>
    </div>
  );
}
