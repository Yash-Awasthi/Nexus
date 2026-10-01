// SPDX-License-Identifier: Apache-2.0
/**
 * A project handed to a company becomes one of its goals; asking for work
 * files a task under that goal for the company's top agent to run or split.
 */
import { Building2, Send } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import { selectClass } from "~/components/org/AgentDialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  StatusPill,
  canManage,
  orgApi,
  useVisibleInterval,
  type Agent,
  type Company,
} from "~/lib/org";

interface Linked {
  goal: { id: string; title: string };
  company: { id: string; name: string };
  tasks: { id: string; identifier: string; title: string; status: string }[];
}

function Ask({ link, onFiled }: { link: Linked; onFiled: () => void }) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function file() {
    setError(null);
    try {
      const { agents } = await orgApi<{ agents: Agent[] }>(`/companies/${link.company.id}/agents`);
      const lead = agents.find((a) => !a.reportsTo && a.status !== "terminated");
      await orgApi(`/companies/${link.company.id}/tasks`, {
        method: "POST",
        json: { title, goalId: link.goal.id, assigneeAgentId: lead?.id ?? null },
      });
      setTitle("");
      onFiled();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) void file();
      }}
    >
      <Input
        aria-label={`Ask ${link.company.name} for work`}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What should the company do next?"
      />
      <Button type="submit" size="sm" disabled={!title.trim()} aria-label="File task">
        <Send className="size-4" />
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}

export function ProjectCompany({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const [links, setLinks] = useState<Linked[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [pick, setPick] = useState("");

  const load = useCallback(() => {
    orgApi<{ goals: Linked[] }>(`/projects/${projectId}/goals`)
      .then((b) => setLinks(b.goals))
      .catch(() => setLinks([]));
  }, [projectId]);
  useEffect(load, [load]);
  useVisibleInterval(load, 5000);
  useEffect(() => {
    orgApi<{ companies: Company[] }>("/companies")
      .then((b) => setCompanies(b.companies.filter(canManage)))
      .catch(() => setCompanies([]));
  }, []);

  async function handOver() {
    const res = await fetch(`/api/v1/projects/${projectId}`).catch(() => null);
    const project = (res?.ok ? await res.json() : {}) as { instructions?: string };
    await orgApi(`/companies/${pick}/goals`, {
      method: "POST",
      json: { title: projectName, description: project.instructions ?? "", projectId },
    });
    setPick("");
    load();
  }

  const unlinked = companies.filter((c) => !links.some((l) => l.company.id === c.id));
  return (
    <section className="max-w-2xl space-y-4">
      <p className="text-sm text-muted-foreground">
        Hand this project to a company of agents. It becomes one of the company's goals, and the
        work you ask for here runs on its agents, budgets and approvals.
      </p>
      {links.map((l) => (
        <div key={l.goal.id} className="space-y-3 rounded-lg border p-3" data-testid="project-link">
          <div className="flex items-center gap-2">
            <Building2 className="size-4 text-primary" />
            <Link to={`/org?c=${l.company.id}&tab=tasks`} className="font-medium hover:underline">
              {l.company.name}
            </Link>
            <span className="text-xs text-muted-foreground">goal: {l.goal.title}</span>
          </div>
          <Ask link={l} onFiled={load} />
          {l.tasks.length === 0 ? (
            <p className="text-xs text-muted-foreground">No work yet.</p>
          ) : (
            <ul className="divide-y text-sm">
              {l.tasks.map((t) => (
                <li key={t.id} className="flex items-center gap-2 py-1.5">
                  <span className="font-mono text-xs text-muted-foreground">{t.identifier}</span>
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  <StatusPill status={t.status} />
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {unlinked.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Company to hand the project to"
            className={`${selectClass} w-auto min-w-40`}
            value={pick}
            onChange={(e) => setPick(e.target.value)}
          >
            <option value="">Choose a company</option>
            {unlinked.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <Button size="sm" disabled={!pick} onClick={() => void handOver()}>
            Hand over
          </Button>
        </div>
      ) : (
        companies.length === 0 && (
          <Link to="/org" className="text-sm underline">
            Create a company first
          </Link>
        )
      )}
    </section>
  );
}
