// SPDX-License-Identifier: Apache-2.0
/**
 * The company page: one screen per company with a tab per concern. The
 * selected company and tab live in the URL so a phone can bookmark a view.
 */
import { Download, Pause, Play, Plus, UserPlus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import { AgentDialog, selectClass } from "~/components/org/AgentDialog";
import { AgentSheet } from "~/components/org/AgentSheet";
import { ApprovalInbox } from "~/components/org/ApprovalInbox";
import { BudgetPanel } from "~/components/org/BudgetPanel";
import { GoalTree } from "~/components/org/GoalTree";
import { MemoryPanel } from "~/components/org/MemoryPanel";
import { OrgChart } from "~/components/org/OrgChart";
import { InboxCard, OverviewPanel, PortfolioStrip } from "~/components/org/OverviewPanel";
import { RoutineList } from "~/components/org/RoutineList";
import { RunList } from "~/components/org/RunList";
import { TaskBoard } from "~/components/org/TaskBoard";
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
import {
  StatusPill,
  orgApi,
  timeAgo,
  type Activity,
  type Agent,
  type Company,
  type OrgNode,
  useVisibleInterval,
  CompanyCan,
} from "~/lib/org";

export function meta() {
  return [{ title: "Company — Nexus" }];
}

interface Template {
  id: string;
  name: string;
  description: string;
  agents: string[];
}

function NewCompanyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (c: Company) => void;
}) {
  const [name, setName] = useState("");
  const [mission, setMission] = useState("");
  const [strict, setStrict] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [from, setFrom] = useState("blank");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    orgApi<{ templates: Template[] }>("/templates")
      .then((b) => {
        setTemplates(b.templates);
        return undefined;
      })
      .catch(() => undefined);
  }, [open]);

  const done = (c: Company) => {
    setName("");
    setMission("");
    setFrom("blank");
    onCreated(c);
    onOpenChange(false);
  };

  async function create() {
    try {
      done(
        from === "blank"
          ? await orgApi<Company>("/companies", {
              method: "POST",
              json: { name, mission, requireHireApproval: strict },
            })
          : await orgApi<Company>(`/templates/${from}`, { method: "POST", json: { name } }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function importFile(file: File) {
    try {
      const bundle = JSON.parse(await file.text()) as unknown;
      done(await orgApi<Company>("/import", { method: "POST", json: { bundle, name } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const template = templates.find((t) => t.id === from);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New company</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="company-from">Start from</Label>
            <select
              id="company-from"
              className={selectClass}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            >
              <option value="blank">A blank company</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  Template: {t.name}
                </option>
              ))}
            </select>
            {template && (
              <p className="text-xs text-muted-foreground">
                {template.description} Team: {template.agents.join(", ")}.
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="company-name">Name{template ? " (optional)" : ""}</Label>
            <Input
              id="company-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={template?.name ?? "Acme Labs"}
            />
          </div>
          {from === "blank" && (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="company-mission">Mission</Label>
                <Textarea
                  id="company-mission"
                  rows={3}
                  value={mission}
                  onChange={(e) => setMission(e.target.value)}
                  placeholder="Build the #1 note-taking app. Every task traces back to this."
                />
              </div>
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>Require approval before a new agent can run</span>
                <Switch
                  checked={strict}
                  onCheckedChange={setStrict}
                  aria-label="Require hire approval"
                />
              </label>
            </>
          )}
          <label className="text-xs text-muted-foreground">
            Or import an exported company:{" "}
            <input
              type="file"
              accept="application/json,.json"
              aria-label="Import company file"
              className="text-xs"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importFile(f);
              }}
            />
          </label>
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
          <Button onClick={create} disabled={from === "blank" && !name.trim()}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Download the company as a JSON bundle (no secrets). */
async function exportCompany(company: Company) {
  const bundle = await orgApi<unknown>(`/companies/${company.id}/export`);
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `${company.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.nexus-company.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function ActivityFeed({ companyId, refreshKey }: { companyId: string; refreshKey: number }) {
  const [rows, setRows] = useState<Activity[]>([]);
  useEffect(() => {
    orgApi<{ activity: Activity[] }>(`/companies/${companyId}/activity?limit=200`)
      .then((b) => setRows(b.activity))
      .catch(() => setRows([]));
  }, [companyId, refreshKey]);
  if (rows.length === 0)
    return <p className="text-sm text-muted-foreground">Nothing has happened yet.</p>;
  return (
    <ol className="divide-y rounded-lg border" aria-label="Activity">
      {rows.map((r) => (
        <li key={r.id} className="flex items-start justify-between gap-3 p-3 text-sm">
          <div className="min-w-0">
            <p className="font-medium">{r.action.replace(/[._]/g, " ")}</p>
            <p className="truncate text-xs text-muted-foreground">
              {r.actorType} · {r.entityType}
              {typeof r.details.name === "string" ? ` · ${r.details.name}` : ""}
              {typeof r.details.title === "string" ? ` · ${r.details.title}` : ""}
              {typeof r.details.reason === "string" ? ` · ${r.details.reason}` : ""}
            </p>
          </div>
          <time className="shrink-0 font-mono text-xs text-muted-foreground" dateTime={r.createdAt}>
            {timeAgo(r.createdAt)}
          </time>
        </li>
      ))}
    </ol>
  );
}

export interface CompanyTabProps {
  company: Company;
  agents: Agent[];
  reload: () => void;
  refreshKey: number;
}

const TABS: { id: string; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "tasks", label: "Tasks" },
  { id: "approvals", label: "Approvals" },
  { id: "org", label: "Org chart" },
  { id: "goals", label: "Goals" },
  { id: "runs", label: "Runs" },
  { id: "routines", label: "Routines" },
  { id: "memory", label: "Memory" },
  { id: "budgets", label: "Budgets" },
  { id: "activity", label: "Activity" },
];

export default function OrgPage() {
  const [params, setParams] = useSearchParams();
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [roots, setRoots] = useState<OrgNode[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [newCompany, setNewCompany] = useState(false);
  const [editing, setEditing] = useState<Agent | null | undefined>(undefined);
  const [pending, setPending] = useState(0);
  const [viewing, setViewing] = useState<string | null>(null);

  const companyId = params.get("c") ?? companies?.[0]?.id ?? null;
  const tab = params.get("tab") ?? "overview";
  const company = useMemo(
    () => companies?.find((c) => c.id === companyId) ?? null,
    [companies, companyId],
  );
  const manage = company?.can.includes("manage") ?? false;

  const select = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) next.set(k, v);
    setParams(next, { replace: true });
  };

  const loadCompanies = useCallback(() => {
    orgApi<{ companies: Company[] }>("/companies")
      .then((b) => setCompanies(b.companies))
      .catch((e: Error) => {
        setError(e.message);
        setCompanies([]);
      });
  }, []);

  const reload = useCallback(() => {
    loadCompanies();
    setRefreshKey((k) => k + 1);
  }, [loadCompanies]);

  useEffect(loadCompanies, [loadCompanies]);
  // Agents change status as runs start and finish; keep the header and chart current.
  useVisibleInterval(() => setRefreshKey((k) => k + 1), 10_000);

  useEffect(() => {
    if (!companyId) return;
    Promise.all([
      orgApi<{ agents: Agent[] }>(`/companies/${companyId}/agents`),
      orgApi<{ roots: OrgNode[] }>(`/companies/${companyId}/chart`),
      orgApi<{ approvals: unknown[] }>(`/companies/${companyId}/approvals?status=pending`),
    ])
      .then(([a, c, p]) => {
        setAgents(a.agents);
        setRoots(c.roots);
        setPending(p.approvals.length);
        return undefined;
      })
      .catch((e: Error) => setError(e.message));
  }, [companyId, refreshKey]);

  async function act(path: string) {
    setError(null);
    try {
      await orgApi(path, { method: "POST" });
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (companies === null) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Companies</h1>
        {companies.length > 0 && (
          <select
            aria-label="Select company"
            className={`${selectClass} ml-auto w-auto min-w-40`}
            value={companyId ?? ""}
            onChange={(e) => select({ c: e.target.value })}
          >
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <Button
          size="sm"
          variant={companies.length ? "outline" : "default"}
          className={companies.length ? "" : "ml-auto"}
          onClick={() => setNewCompany(true)}
        >
          <Plus className="size-4" /> New company
        </Button>
      </header>

      {error && (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      )}

      {!company ? (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <p className="font-medium">Run a company of agents</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Give it a mission, hire a CEO and a team, set budgets, and let them work through tasks
            on a schedule while you approve what matters.
          </p>
          <Button className="mt-4" onClick={() => setNewCompany(true)}>
            <Plus className="size-4" /> Create your first company
          </Button>
        </div>
      ) : (
        <CompanyCan.Provider value={company.can}>
          <PortfolioStrip
            current={company.id}
            refreshKey={refreshKey}
            onPick={(id) => select({ c: id })}
          />
          <InboxCard refreshKey={refreshKey} open={params.get("inbox") === "open"} />
          <section className="rounded-xl border bg-card p-4">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold" data-testid="company-name">
                    {company.name}
                  </h2>
                  <StatusPill status={company.status} />
                  <span className="font-mono text-xs text-muted-foreground">
                    {company.taskPrefix}
                  </span>
                  {!manage && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                      Shared with you ·{" "}
                      {company.can.length ? "comments and assignments" : "read only"}
                    </span>
                  )}
                </div>
                {company.mission && (
                  <p className="mt-1 text-sm text-muted-foreground">{company.mission}</p>
                )}
                {company.pauseReason === "budget" && (
                  <p className="mt-1 text-sm text-warning">Paused by its budget hard stop.</p>
                )}
              </div>
              {manage && (
                <Button size="sm" variant="ghost" onClick={() => void exportCompany(company)}>
                  <Download className="size-4" /> Export
                </Button>
              )}
              {!manage ? null : company.status === "active" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => act(`/companies/${company.id}/pause`)}
                >
                  <Pause className="size-4" /> Pause
                </Button>
              ) : company.status === "paused" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => act(`/companies/${company.id}/resume`)}
                >
                  <Play className="size-4" /> Resume
                </Button>
              ) : null}
            </div>
          </section>

          <nav
            className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0"
            role="tablist"
          >
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => select({ tab: t.id })}
                className={`shrink-0 rounded-full px-3 py-1.5 text-sm ${tab === t.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
              >
                {t.label}
                {t.id === "approvals" && pending > 0 && (
                  <span
                    className="ml-1.5 rounded-full bg-destructive px-1.5 text-[11px] font-semibold text-white"
                    data-testid="pending-badge"
                  >
                    {pending}
                  </span>
                )}
              </button>
            ))}
          </nav>

          {tab === "org" && (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  {agents.filter((a) => a.status !== "terminated").length} agents
                </p>
                {manage && (
                  <Button size="sm" onClick={() => setEditing(null)}>
                    <UserPlus className="size-4" /> Hire agent
                  </Button>
                )}
              </div>
              <OrgChart
                roots={roots}
                actions={{
                  readOnly: !manage,
                  onEdit: (a) => setEditing(a),
                  onOpen: (a) => setViewing(a.id),
                  onWake: (a) => void act(`/agents/${a.id}/wake`),
                  onStatus: (a, verb) => {
                    if (
                      verb === "terminate" &&
                      !window.confirm(`Terminate ${a.name}? This cannot be undone.`)
                    )
                      return;
                    void act(`/agents/${a.id}/${verb}`);
                  },
                }}
              />
            </section>
          )}

          {tab === "overview" && (
            <OverviewPanel
              companyId={company.id}
              refreshKey={refreshKey}
              goTo={(t) => select({ tab: t })}
              agents={agents}
            />
          )}

          {tab === "tasks" && (
            <TaskBoard
              companyId={company.id}
              agents={agents}
              refreshKey={refreshKey}
              onChanged={() => setRefreshKey((k) => k + 1)}
            />
          )}

          {tab === "runs" && (
            <RunList companyId={company.id} agents={agents} refreshKey={refreshKey} />
          )}

          {tab === "approvals" && (
            <ApprovalInbox
              company={company}
              agents={agents}
              refreshKey={refreshKey}
              onChanged={reload}
            />
          )}

          {tab === "memory" && <MemoryPanel companyId={company.id} refreshKey={refreshKey} />}

          {tab === "routines" && (
            <RoutineList
              companyId={company.id}
              agents={agents}
              refreshKey={refreshKey}
              onChanged={reload}
            />
          )}

          {tab === "budgets" && (
            <BudgetPanel
              companyId={company.id}
              agents={agents}
              refreshKey={refreshKey}
              onChanged={reload}
            />
          )}

          {tab === "goals" && <GoalTree companyId={company.id} refreshKey={refreshKey} />}

          {tab === "activity" && <ActivityFeed companyId={company.id} refreshKey={refreshKey} />}

          <AgentSheet
            agent={agents.find((a) => a.id === viewing) ?? null}
            agents={agents}
            companyId={company.id}
            refreshKey={refreshKey}
            onClose={() => setViewing(null)}
            onChanged={reload}
          />
          <AgentDialog
            open={editing !== undefined}
            onOpenChange={(o) => !o && setEditing(undefined)}
            companyId={company.id}
            agents={agents}
            agent={editing ?? null}
            onSaved={reload}
          />
        </CompanyCan.Provider>
      )}

      <NewCompanyDialog
        open={newCompany}
        onOpenChange={setNewCompany}
        onCreated={(c) => {
          // Reload rather than append: the list carries what the caller may do with each company.
          loadCompanies();
          select({ c: c.id, tab: "org" });
        }}
      />
    </div>
  );
}
