// SPDX-License-Identifier: Apache-2.0
import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/settings";

import { Page, PageHeader, Section, SettingRow } from "~/components/page";
import { Switch } from "~/components/ui/switch";
import { useTheme } from "~/context/ThemeContext";
import { cn } from "~/lib/utils";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Preferences · Nexus" }];
}

interface Prefs {
  autoCouncil: boolean;
  debateRound: boolean;
  coldValidator: boolean;
  peerRanking: boolean;
  deliberationMode: string;
  verbosityLevel: string;
  dissent: string;
  piiDetection: boolean;
  autoAnonymize: boolean;
  blockProfanity: boolean;
  blockAdultContent: boolean;
}

const DEFAULTS: Prefs = {
  autoCouncil: true,
  debateRound: true,
  coldValidator: false,
  peerRanking: false,
  deliberationMode: "standard",
  verbosityLevel: "standard",
  dissent: "off",
  piiDetection: true,
  autoAnonymize: false,
  blockProfanity: false,
  blockAdultContent: false,
};

const SELECT =
  "h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30";

export default function SettingsPage() {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void fetch("/api/settings/preferences")
      .then((r) => (r.ok ? (r.json() as Promise<Partial<Prefs>>) : {}))
      .then((p) => setPrefs({ ...DEFAULTS, ...p }))
      .catch(() => undefined);
  }, []);

  const set = <K extends keyof Prefs>(key: K, value: Prefs[K]) => {
    setPrefs((p) => ({ ...p, [key]: value }));
    void fetch("/api/settings/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    }).then((r) => {
      if (!r.ok) return;
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    });
  };

  const toggle = (key: keyof Prefs) => (
    <Switch id={key} checked={Boolean(prefs[key])} onCheckedChange={(v) => set(key, v as never)} />
  );

  return (
    <Page width="narrow">
      <PageHeader
        title="Preferences"
        description={
          <>
            How the council behaves for you. Members, models and archetypes are set from the{" "}
            <Link to="/chat" className="text-primary hover:underline">
              council
            </Link>{" "}
            itself.
          </>
        }
        actions={
          <span
            className={cn(
              "text-xs text-muted-foreground transition-opacity",
              saved ? "opacity-100" : "opacity-0",
            )}
            aria-live="polite"
          >
            Saved
          </span>
        }
      />

      <Section title="Council">
        <SettingRow
          label="Pick archetypes automatically"
          description="Members without a chosen archetype get the persona that best fits each question."
          htmlFor="autoCouncil"
        >
          {toggle("autoCouncil")}
        </SettingRow>
        <SettingRow
          label="Debate round"
          description="Members read each other's first answers and refine before the synthesis."
          htmlFor="debateRound"
        >
          {toggle("debateRound")}
        </SettingRow>
        <SettingRow
          label="Cold validator"
          description="A separate model checks the final answers for errors before you see them."
          htmlFor="coldValidator"
        >
          {toggle("coldValidator")}
        </SettingRow>
        <SettingRow
          label="Peer-ranked synthesis"
          description="Members rank each other's anonymous answers before the synthesis, and the chair leads with the top-ranked one."
          htmlFor="peerRanking"
        >
          {toggle("peerRanking")}
        </SettingRow>
        <SettingRow label="Default reasoning mode" htmlFor="deliberationMode">
          <select
            id="deliberationMode"
            className={SELECT}
            value={prefs.deliberationMode}
            onChange={(e) => set("deliberationMode", e.target.value)}
          >
            <option value="standard">Standard</option>
            <option value="red_blue">Red vs blue</option>
            <option value="socratic">Socratic</option>
            <option value="hypothesis">Competing hypotheses</option>
            <option value="confidence">Confidence-scored</option>
          </select>
        </SettingRow>
        <SettingRow label="Answer length" htmlFor="verbosityLevel">
          <select
            id="verbosityLevel"
            className={SELECT}
            value={prefs.verbosityLevel}
            onChange={(e) => set("verbosityLevel", e.target.value)}
          >
            <option value="concise">Concise</option>
            <option value="standard">Balanced</option>
            <option value="detailed">Detailed</option>
            <option value="exhaustive">Exhaustive</option>
          </select>
        </SettingRow>
      </Section>

      <Section title="Dissent" description="Stops the council from agreeing too easily.">
        <SettingRow
          label="Push back on the consensus"
          description="Every member argues the opposing case before concluding."
          htmlFor="dissent"
        >
          <select
            id="dissent"
            className={SELECT}
            value={prefs.dissent}
            onChange={(e) => set("dissent", e.target.value)}
          >
            <option value="off">Off</option>
            <option value="gentle">Gentle</option>
            <option value="moderate">Moderate</option>
            <option value="strong">Strong</option>
          </select>
        </SettingRow>
      </Section>

      <Section
        title="Privacy and safety"
        description="Checked before a message leaves for any model."
      >
        <SettingRow
          label="Warn about personal details"
          description="Flags emails, phone numbers and similar in what you send."
          htmlFor="piiDetection"
        >
          {toggle("piiDetection")}
        </SettingRow>
        <SettingRow
          label="Remove personal details"
          description="Redacts them automatically instead of only warning."
          htmlFor="autoAnonymize"
        >
          {toggle("autoAnonymize")}
        </SettingRow>
        <SettingRow label="Mask profanity" htmlFor="blockProfanity">
          {toggle("blockProfanity")}
        </SettingRow>
        <SettingRow
          label="Block explicit content"
          description="Refuses sexually explicit messages before they reach a model."
          htmlFor="blockAdultContent"
        >
          {toggle("blockAdultContent")}
        </SettingRow>
      </Section>

      <Section title="Appearance">
        <ThemePicker />
      </Section>
    </Page>
  );
}

function ThemePicker() {
  const { theme, setTheme } = useTheme();
  const options = [
    { id: "light", label: "Light", icon: Sun },
    { id: "dark", label: "Dark", icon: Moon },
    { id: "system", label: "System", icon: Monitor },
  ] as const;
  const pick = (id: (typeof options)[number]["id"]) =>
    setTheme(
      id === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : id,
    );
  return (
    <div className="grid grid-cols-3 gap-2 py-2">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => pick(o.id)}
          className={cn(
            "flex flex-col items-center gap-1.5 rounded-lg border px-3 py-3 text-sm transition-colors hover:bg-accent",
            o.id === theme && "border-primary bg-primary/5 text-primary",
          )}
        >
          <o.icon className="size-4" />
          {o.label}
        </button>
      ))}
    </div>
  );
}
