// SPDX-License-Identifier: Apache-2.0
/**
 * First run, right after sign-up: what Nexus is, how the council should argue by
 * default, and a name. Keys and council seats follow from the home checklist.
 */
import { ArrowLeft, ArrowRight, Building2, Scale, Swords, Users } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

import type { Route } from "./+types/setup";

import { NexusMark } from "~/components/brand";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { useAuth } from "~/context/AuthContext";
import { cn } from "~/lib/utils";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Welcome · Nexus" }];
}

const MODES = [
  { id: "standard", label: "Standard", hint: "Answer, read each other, refine." },
  { id: "red_blue", label: "Red vs blue", hint: "Half build the case, half attack it." },
  { id: "socratic", label: "Socratic", hint: "Question every assumption first." },
  { id: "hypothesis", label: "Competing hypotheses", hint: "Weigh rival explanations." },
  { id: "confidence", label: "Confidence-scored", hint: "Every claim carries a confidence." },
];

const WHAT = [
  {
    icon: Users,
    title: "A council, not a chatbot",
    body: "Several models answer at once, each as an archetype like the Contrarian or the Empiricist.",
  },
  {
    icon: Swords,
    title: "They argue",
    body: "Members read each other's answers and refine before anyone concludes.",
  },
  {
    icon: Scale,
    title: "A chair synthesises",
    body: "You get one recommendation, with the disagreements and who holds them.",
  },
  {
    icon: Building2,
    title: "Agents act on it",
    body: "Hand a verdict to a company of agents that plans and does the work.",
  },
];

export default function SetupPage() {
  const navigate = useNavigate();
  const { user, setUser } = useAuth();
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState("standard");
  const [debate, setDebate] = useState(true);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const finish = async () => {
    setSaving(true);
    const json = { "Content-Type": "application/json" };
    const trimmed = name.trim();
    await Promise.all([
      fetch("/api/settings/preferences", {
        method: "PUT",
        headers: json,
        body: JSON.stringify({ deliberationMode: mode, debateRound: debate }),
      }),
      trimmed &&
        fetch("/api/v1/auth/me", {
          method: "PATCH",
          headers: json,
          body: JSON.stringify({ name: trimmed }),
        }),
    ]).catch(() => undefined);
    if (trimmed && user) setUser({ ...user, username: trimmed });
    localStorage.setItem("nexus_setup_done", "1");
    navigate("/dashboard", { replace: true });
  };

  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-4">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <NexusMark className="size-7" />
            <span className="font-semibold tracking-tight">Nexus</span>
          </div>
          <div className="flex gap-1.5" aria-label={`Step ${step + 1} of 3`}>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className={cn("h-1.5 w-6 rounded-full", i <= step ? "bg-primary" : "bg-muted")}
              />
            ))}
          </div>
        </div>

        <div className="rounded-2xl border bg-card p-6 shadow-sm sm:p-8">
          {step === 0 && (
            <>
              <h1 className="text-2xl font-semibold">Welcome to Nexus</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Three quick choices, then you're in. Everything can be changed later.
              </p>
              <ul className="mt-6 space-y-4">
                {WHAT.map((w) => (
                  <li key={w.title} className="flex gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <w.icon className="size-4" />
                    </span>
                    <div>
                      <p className="text-sm font-medium">{w.title}</p>
                      <p className="text-sm text-muted-foreground">{w.body}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          {step === 1 && (
            <>
              <h1 className="text-2xl font-semibold">How should the council argue?</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                The default for new questions. You can switch per question.
              </p>
              <div className="mt-6 grid gap-2" role="radiogroup" aria-label="Reasoning mode">
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={mode === m.id}
                    onClick={() => setMode(m.id)}
                    className={cn(
                      "flex items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors hover:bg-accent",
                      mode === m.id && "border-primary bg-primary/5",
                    )}
                  >
                    <span>
                      <span className="block text-sm font-medium">{m.label}</span>
                      <span className="block text-xs text-muted-foreground">{m.hint}</span>
                    </span>
                    <span
                      className={cn(
                        "size-4 rounded-full border-2",
                        mode === m.id ? "border-primary bg-primary" : "border-muted-foreground/40",
                      )}
                    />
                  </button>
                ))}
              </div>
              <label className="mt-4 flex items-center justify-between gap-4 rounded-lg border px-4 py-3">
                <span>
                  <span className="block text-sm font-medium">Debate round</span>
                  <span className="block text-xs text-muted-foreground">
                    Members see each other's first answers and refine. Slower, better.
                  </span>
                </span>
                <Switch checked={debate} onCheckedChange={setDebate} />
              </label>
            </>
          )}

          {step === 2 && (
            <>
              <h1 className="text-2xl font-semibold">What should we call you?</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Next you'll add a provider key and seat your council.
              </p>
              <Input
                className="mt-6 h-10"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void finish()}
                placeholder="Your name (optional)"
                aria-label="Your name"
                autoFocus
              />
            </>
          )}

          <div className="mt-8 flex items-center gap-2">
            {step > 0 && (
              <Button variant="ghost" onClick={() => setStep((s) => s - 1)}>
                <ArrowLeft /> Back
              </Button>
            )}
            <Button
              className="ml-auto"
              disabled={saving}
              onClick={() => (step < 2 ? setStep((s) => s + 1) : void finish())}
            >
              {step < 2 ? "Continue" : "Enter Nexus"}
              <ArrowRight />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
