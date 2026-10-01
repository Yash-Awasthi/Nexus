// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { ADAPTERS, orgApi, type AdapterType, type Agent, type HeartbeatPolicy } from "~/lib/org";

interface ArchetypeOption {
  id: string;
  name: string;
  model?: string;
}

export const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Checkboxes over a list the agent can draw on; hidden when the list is empty. */
function PickList({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: { id: string; name: string }[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  if (items.length === 0) return null;
  return (
    <fieldset className="grid gap-1.5">
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      {items.map((it) => (
        <label key={it.id} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={value.includes(it.id)}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, it.id] : value.filter((x) => x !== it.id))
            }
          />
          {it.name}
        </label>
      ))}
    </fieldset>
  );
}

/** Hire a new agent, or edit an existing one when `agent` is given. */
export function AgentDialog({
  open,
  onOpenChange,
  companyId,
  agents,
  agent,
  onSaved,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  agents: Agent[];
  agent?: Agent | null;
  onSaved: (agent: Agent) => void;
  /** Extra form sections (heartbeat, adapter, budget) rendered under the basics. */
  children?: (
    draft: Record<string, unknown>,
    set: (patch: Record<string, unknown>) => void,
  ) => React.ReactNode;
}) {
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [archetypes, setArchetypes] = useState<ArchetypeOption[]>([]);
  const [secretNames, setSecretNames] = useState<string[]>([]);
  const [kbs, setKbs] = useState<{ id: string; name: string }[]>([]);
  const [skills, setSkills] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setDraft(
      agent
        ? { ...agent }
        : {
            name: "",
            role: "",
            title: "",
            reportsTo: agents.find((a) => !a.reportsTo)?.id ?? "",
            capabilities: "",
            instructions: "",
            model: "",
            archetypeId: "",
          },
    );
    fetch("/api/archetypes")
      .then((r) => (r.ok ? r.json() : { archetypes: [] }))
      .then((b: { archetypes?: ArchetypeOption[] }) => setArchetypes(b.archetypes ?? []))
      .catch(() => setArchetypes([]));
    fetch("/api/v1/secrets")
      .then((r) => (r.ok ? r.json() : { secrets: [] }))
      .then((b: { secrets?: { name: string }[] }) =>
        setSecretNames((b.secrets ?? []).map((x) => x.name)),
      )
      .catch(() => setSecretNames([]));
    fetch("/api/kb")
      .then((r) => (r.ok ? r.json() : { kbs: [] }))
      .then((b: { kbs?: { id: string; name: string }[] }) => setKbs(b.kbs ?? []))
      .catch(() => setKbs([]));
    fetch("/api/skills")
      .then((r) => (r.ok ? r.json() : { skills: [] }))
      .then((b: { skills?: { id: string; name: string; enabled?: boolean }[] }) =>
        setSkills((b.skills ?? []).filter((s) => s.enabled !== false)),
      )
      .catch(() => setSkills([]));
  }, [open, agent?.id]);

  const set = (patch: Record<string, unknown>) => setDraft((d) => ({ ...d, ...patch }));
  const text = (k: string) => String(draft[k] ?? "");

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const saved = agent
        ? await orgApi<Agent>(`/agents/${agent.id}`, { method: "PATCH", json: draft })
        : await orgApi<Agent>(`/companies/${companyId}/agents`, { method: "POST", json: draft });
      onSaved(saved);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const managers = agents.filter((a) => a.status !== "terminated" && a.id !== agent?.id);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{agent ? `Edit ${agent.name}` : "Hire an agent"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="agent-name">Name</Label>
              <Input
                id="agent-name"
                value={text("name")}
                onChange={(e) => set({ name: e.target.value })}
                placeholder="Ada"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="agent-role">Role</Label>
              <Input
                id="agent-role"
                value={text("role")}
                onChange={(e) => set({ role: e.target.value })}
                placeholder="ceo, engineer…"
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="agent-title">Title</Label>
            <Input
              id="agent-title"
              value={text("title")}
              onChange={(e) => set({ title: e.target.value })}
              placeholder="Chief Executive Officer"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="agent-reports">Reports to</Label>
              <select
                id="agent-reports"
                className={selectClass}
                value={text("reportsTo")}
                onChange={(e) => set({ reportsTo: e.target.value || null })}
              >
                <option value="">Nobody (top of the org)</option>
                {managers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} · {m.role}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="agent-archetype">Persona</Label>
              <select
                id="agent-archetype"
                className={selectClass}
                value={text("archetypeId")}
                onChange={(e) => set({ archetypeId: e.target.value || null })}
              >
                <option value="">None</option>
                {archetypes.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="agent-model">Model</Label>
            <Input
              id="agent-model"
              value={text("model")}
              onChange={(e) => set({ model: e.target.value })}
              placeholder="Leave blank for your default (e.g. groq/openai/gpt-oss-120b)"
            />
          </div>
          {(draft.adapterType ?? "nexus") === "nexus" && (
            <div className="grid gap-1.5">
              <Label htmlFor="agent-quick-model">Model for quick work</Label>
              <Input
                id="agent-quick-model"
                value={String(
                  (draft.adapterConfig as Record<string, unknown> | undefined)?.quickModel ?? "",
                )}
                onChange={(e) =>
                  set({
                    adapterConfig: {
                      ...((draft.adapterConfig as Record<string, unknown> | undefined) ?? {}),
                      quickModel: e.target.value,
                    },
                  })
                }
                placeholder="Optional cheaper model for questions and triage"
              />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="agent-capabilities">Capabilities</Label>
            <Textarea
              id="agent-capabilities"
              rows={2}
              value={text("capabilities")}
              onChange={(e) => set({ capabilities: e.target.value })}
              placeholder="What this agent is good at; peers read this when delegating."
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="agent-instructions">Instructions</Label>
            <Textarea
              id="agent-instructions"
              rows={3}
              value={text("instructions")}
              onChange={(e) => set({ instructions: e.target.value })}
              placeholder="How this agent should work on each run."
            />
          </div>
          <PickList
            label="Knowledge bases it reads"
            items={kbs}
            value={(draft.knowledgeBaseIds as string[] | undefined) ?? []}
            onChange={(knowledgeBaseIds) => set({ knowledgeBaseIds })}
          />
          <PickList
            label="Skills it runs before each turn"
            items={skills}
            value={(draft.skills as string[] | undefined) ?? []}
            onChange={(ids) => set({ skills: ids })}
          />
          <RuntimeFields
            adapterType={(draft.adapterType as AdapterType | undefined) ?? "nexus"}
            config={(draft.adapterConfig as Record<string, unknown> | undefined) ?? {}}
            onChange={(adapterType, adapterConfig) => set({ adapterType, adapterConfig })}
            agentId={agent?.id ?? null}
          />
          {(draft.adapterType ?? "nexus") !== "nexus" && (
            <div className="grid gap-1.5">
              <Label htmlFor="agent-secrets">Secrets this agent may use</Label>
              <Input
                id="agent-secrets"
                className="font-mono"
                placeholder="GITHUB_TOKEN, NPM_TOKEN"
                value={
                  Array.isArray(draft.secretNames) ? (draft.secretNames as string[]).join(", ") : ""
                }
                onChange={(e) =>
                  set({
                    secretNames: e.target.value
                      .split(",")
                      .map((x) => x.trim())
                      .filter(Boolean),
                  })
                }
              />
              <p className="text-xs text-muted-foreground">
                Passed to the process as environment variables at run time, never stored with the
                agent.
                {secretNames.length
                  ? ` Yours: ${secretNames.join(", ")}.`
                  : " Add secrets under Settings first."}
              </p>
            </div>
          )}
          <HeartbeatFields
            value={
              (draft.heartbeat as HeartbeatPolicy | undefined) ?? {
                enabled: false,
                intervalSec: 3600,
                cron: null,
                wakeOnAssign: true,
              }
            }
            onChange={(heartbeat) => set({ heartbeat })}
          />
          {children?.(draft, set)}
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || !text("name").trim()}>
            {agent ? "Save" : "Hire"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const PROCESS_TYPES: AdapterType[] = ["claude_code", "codex", "gemini", "opencode", "shell"];

/** How the agent runs: Nexus's own models, a local CLI, a command, or a webhook. */
function RuntimeFields({
  adapterType,
  config,
  onChange,
  agentId,
}: {
  adapterType: AdapterType;
  config: Record<string, unknown>;
  onChange: (t: AdapterType, c: Record<string, unknown>) => void;
  agentId: string | null;
}) {
  const [forgot, setForgot] = useState<number | null>(null);
  const cfg = (k: string) =>
    config[k] === undefined || config[k] === null ? "" : String(config[k]);
  const put = (patch: Record<string, unknown>) => onChange(adapterType, { ...config, ...patch });
  const hint = ADAPTERS.find((a) => a.id === adapterType)?.hint;
  const [headersText, setHeadersText] = useState(
    config.headers ? JSON.stringify(config.headers, null, 2) : "",
  );
  const [headersError, setHeadersError] = useState<string | null>(null);

  return (
    <fieldset className="grid gap-2 rounded-lg border p-3">
      <legend className="px-1 text-xs font-semibold uppercase text-muted-foreground">
        Runtime
      </legend>
      <select
        aria-label="Runtime"
        className={selectClass}
        value={adapterType}
        onChange={(e) => onChange(e.target.value as AdapterType, {})}
      >
        {ADAPTERS.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}

      {PROCESS_TYPES.includes(adapterType) && (
        <Input
          aria-label="Working directory"
          placeholder="Working directory (blank: the agent's own folder)"
          value={cfg("cwd")}
          onChange={(e) => put({ cwd: e.target.value || undefined })}
        />
      )}
      {adapterType === "claude_code" && (
        <div className="grid grid-cols-2 gap-2">
          <select
            aria-label="Permission mode"
            className={selectClass}
            value={cfg("permissionMode") || "default"}
            onChange={(e) => put({ permissionMode: e.target.value })}
          >
            <option value="default">Ask for tools (safe)</option>
            <option value="plan">Plan only (read-only)</option>
            <option value="acceptEdits">Accept file edits</option>
            <option value="bypassPermissions">Bypass all prompts</option>
          </select>
          <Input
            aria-label="Max turns"
            inputMode="numeric"
            placeholder="Max turns"
            value={cfg("maxTurns")}
            onChange={(e) => put({ maxTurns: Number(e.target.value) || undefined })}
          />
        </div>
      )}
      {adapterType === "codex" && (
        <select
          aria-label="Sandbox"
          className={selectClass}
          value={cfg("sandbox") || "read-only"}
          onChange={(e) => put({ sandbox: e.target.value })}
        >
          <option value="read-only">Read-only sandbox</option>
          <option value="workspace-write">Can write its workspace</option>
          <option value="danger-full-access">Full access (dangerous)</option>
        </select>
      )}
      {adapterType === "shell" && (
        <>
          <Input
            aria-label="Command"
            className="font-mono"
            placeholder="python"
            value={cfg("command")}
            onChange={(e) => put({ command: e.target.value })}
          />
          <Textarea
            aria-label="Arguments, one per line"
            className="font-mono"
            rows={2}
            placeholder={"agent.py\n--fast"}
            value={Array.isArray(config.args) ? (config.args as string[]).join("\n") : ""}
            onChange={(e) => put({ args: e.target.value.split("\n").filter((l) => l.trim()) })}
          />
        </>
      )}
      {adapterType === "http" && (
        <>
          <Input
            aria-label="Webhook URL"
            placeholder="https://agents.example.com/run"
            value={cfg("url")}
            onChange={(e) => put({ url: e.target.value })}
          />
          <Textarea
            aria-label="Headers as JSON"
            className="font-mono"
            rows={2}
            placeholder={'{"Authorization": "secret:AGENT_TOKEN"}'}
            value={headersText}
            onChange={(e) => {
              setHeadersText(e.target.value);
              if (!e.target.value.trim()) {
                setHeadersError(null);
                put({ headers: undefined });
                return;
              }
              try {
                put({ headers: JSON.parse(e.target.value) as unknown });
                setHeadersError(null);
              } catch {
                setHeadersError("Headers must be a JSON object.");
              }
            }}
          />
          {headersError && <p className="text-xs text-destructive">{headersError}</p>}
          <p className="text-xs text-muted-foreground">
            A value of <code>secret:NAME</code> is filled from your secret store at run time.
          </p>
        </>
      )}
      {adapterType !== "nexus" && (
        <Input
          aria-label="Timeout in minutes"
          inputMode="numeric"
          placeholder="Timeout minutes (default 5)"
          value={config.timeoutSec ? String(Math.round(Number(config.timeoutSec) / 60)) : ""}
          onChange={(e) => put({ timeoutSec: (Number(e.target.value) || 0) * 60 || undefined })}
        />
      )}
      {agentId && PROCESS_TYPES.includes(adapterType) && (
        <button
          type="button"
          className="justify-self-start text-xs text-muted-foreground underline"
          onClick={() =>
            void orgApi<{ forgotten: number }>(`/agents/${agentId}/forget-commands`, {
              method: "POST",
            })
              .then((r) => {
                setForgot(r.forgotten);
                return undefined;
              })
              .catch(() => undefined)
          }
        >
          {forgot === null ? "Forget allowed commands" : `Forgot ${forgot} allowed command(s)`}
        </button>
      )}
    </fieldset>
  );
}

/** When the agent wakes on its own: a timer or cron, and on new assignments. */
function HeartbeatFields({
  value,
  onChange,
}: {
  value: HeartbeatPolicy;
  onChange: (v: HeartbeatPolicy) => void;
}) {
  const mode = value.cron ? "cron" : "interval";
  return (
    <fieldset className="grid gap-2 rounded-lg border p-3">
      <legend className="px-1 text-xs font-semibold uppercase text-muted-foreground">
        Heartbeat
      </legend>
      <label className="flex items-center justify-between gap-3 text-sm">
        <span>Wake when a task is assigned or commented on</span>
        <Switch
          aria-label="Wake on assignment"
          checked={value.wakeOnAssign}
          onCheckedChange={(wakeOnAssign) => onChange({ ...value, wakeOnAssign })}
        />
      </label>
      <label className="flex items-center justify-between gap-3 text-sm">
        <span>Check in on a schedule</span>
        <Switch
          aria-label="Scheduled heartbeat"
          checked={value.enabled}
          onCheckedChange={(enabled) => onChange({ ...value, enabled })}
        />
      </label>
      {value.enabled && (
        <div className="grid grid-cols-2 gap-2">
          <select
            aria-label="Schedule kind"
            className={selectClass}
            value={mode}
            onChange={(e) =>
              onChange({ ...value, cron: e.target.value === "cron" ? "0 9 * * 1-5" : null })
            }
          >
            <option value="interval">Every N minutes</option>
            <option value="cron">Cron expression</option>
          </select>
          {mode === "interval" ? (
            <Input
              aria-label="Minutes between heartbeats"
              inputMode="numeric"
              value={String(Math.round(value.intervalSec / 60))}
              onChange={(e) =>
                onChange({ ...value, intervalSec: Math.max(1, Number(e.target.value) || 1) * 60 })
              }
            />
          ) : (
            <Input
              aria-label="Cron expression"
              className="font-mono"
              value={value.cron ?? ""}
              onChange={(e) => onChange({ ...value, cron: e.target.value })}
            />
          )}
        </div>
      )}
      {value.enabled && (
        <p className="text-xs text-muted-foreground">
          With nothing assigned, a check-in costs nothing unless its team has work waiting (a stale
          review, a blocked task, a budget near its limit); then it files itself a review task.
        </p>
      )}
    </fieldset>
  );
}
