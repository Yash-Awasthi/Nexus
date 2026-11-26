// SPDX-License-Identifier: Apache-2.0
/**
 * The template gallery: built-in starting points, readable before they are created.
 *
 * The page creates nothing on load and nothing on hover — a card shows the steps or the
 * reporting tree as text, and only "Create from template" writes. That ordering is deliberate: a
 * gallery that creates four companies because you clicked twice, then asks for a name, is a mess
 * to clean up.
 *
 * Company templates are fetched from `GET /org/templates` rather than listed here, because the
 * server owns those companies. If the fetch fails the page still works for workflows and says
 * why the company half is missing, instead of pretending there are none.
 */
import { Building2, Check, GitFork, Loader2, Plus, Repeat, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Page, PageHeader } from "~/components/page";
import { CoachMark } from "~/components/coach-mark";
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
import { apiFetch } from "~/lib/api";
import {
  allTemplates,
  filterTemplates,
  templateRequest,
  WORKFLOW_TEMPLATES,
  type ServerTemplate,
  type Template,
} from "~/lib/templates";

const KIND_LABEL: Record<Template["kind"], string> = {
  workflow: "Workflow",
  company: "Company",
};

/** Normalise the array the endpoint returns, ignoring rows this page cannot present. */
export function readServerTemplates(body: unknown): ServerTemplate[] {
  const rows = (body as { templates?: unknown })?.templates;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const r = row as Partial<ServerTemplate> | null;
    if (!r || typeof r.id !== "string" || typeof r.name !== "string") return [];
    return [
      {
        id: r.id,
        name: r.name,
        description: typeof r.description === "string" ? r.description : "",
        agents: Array.isArray(r.agents) ? r.agents.filter((a): a is string => typeof a === "string") : [],
      },
    ];
  });
}

export default function TemplatesRoute() {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Template["kind"] | "all">("all");
  const [server, setServer] = useState<ServerTemplate[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [chosen, setChosen] = useState<Template | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ href: string; label: string } | null>(null);

  useEffect(() => {
    let live = true;
    apiFetch<unknown>("/api/org/templates")
      .then((body) => {
        if (live) setServer(readServerTemplates(body));
      })
      .catch((err: unknown) => {
        if (live) setServerError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const templates = useMemo(() => allTemplates(server), [server]);
  const shown = filterTemplates(templates, query, kind);

  const open = (template: Template) => {
    setChosen(template);
    setName(template.name);
    setError(null);
    setCreated(null);
  };

  const use = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const request = templateRequest(chosen, name);
      const result = await apiFetch<Record<string, unknown>>(request.url, {
        method: request.method,
        json: request.body,
      });
      const id = typeof result["id"] === "string" ? result["id"] : null;
      setCreated(
        chosen.kind === "workflow"
          ? { href: "/workflows", label: "Open workflows" }
          : { href: id ? `/org?company=${id}` : "/org", label: "Open the company" },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page width="wide">
      <PageHeader
        title="Templates"
        description="Starting points built into this server. Nothing is installed and nothing is fetched from a catalogue: read what a template contains, then create a copy you own."
      />
      <CoachMark page="/templates" />

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search templates"
          aria-label="Search templates"
          className="w-full sm:w-64"
        />
        {(["all", "workflow", "company"] as const).map((option) => (
          <Button
            key={option}
            size="sm"
            variant={kind === option ? "default" : "outline"}
            onClick={() => setKind(option)}
          >
            {option === "all" ? "Everything" : option === "workflow" ? "Workflows" : "Companies"}
          </Button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          {loading ? "loading…" : `${shown.length} of ${templates.length}`}
        </span>
      </div>

      {serverError && (
        <p role="alert" className="text-sm text-destructive">
          The server's company templates could not be read ({serverError}). Workflow templates are
          unaffected; {WORKFLOW_TEMPLATES.length} are listed below.
        </p>
      )}

      {shown.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {loading
              ? "Reading this server's templates…"
              : `Nothing matches “${query}”. Clear the search to see all ${templates.length}.`}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((template) => {
            const Icon = template.kind === "workflow" ? GitFork : Building2;
            return (
              <Card key={template.id} className="flex flex-col">
                <CardHeader className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                    <CardTitle className="text-base">{template.name}</CardTitle>
                    <Badge variant="outline" className="ml-auto font-mono text-[10px]">
                      v{template.version}
                    </Badge>
                  </div>
                  <CardDescription>{template.summary}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col gap-3">
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="secondary">{KIND_LABEL[template.kind]}</Badge>
                    {template.tags.slice(0, 3).map((tag) => (
                      <Badge key={tag} variant="outline">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {template.kind === "workflow"
                      ? `${template.steps.length} steps${template.schedule ? ` · ${template.schedule}` : " · manual"}`
                      : `${template.agents.length} agents`}
                  </p>
                  <Button className="mt-auto" variant="outline" onClick={() => open(template)}>
                    <Plus className="mr-2 size-4" aria-hidden="true" />
                    Use template
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={chosen !== null} onOpenChange={(next) => !next && setChosen(null)}>
        <DialogContent className="max-w-2xl">
          {chosen && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {chosen.name} <span className="font-mono text-xs">v{chosen.version}</span>
                </DialogTitle>
                <DialogDescription>{chosen.summary}</DialogDescription>
              </DialogHeader>

              <div className="space-y-4 text-sm">
                <div className="space-y-2">
                  <label className="text-xs font-medium" htmlFor="template-name">
                    Name for your copy
                  </label>
                  <Input
                    id="template-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>

                <div className="rounded-md border p-3">
                  <p className="mb-2 text-xs font-medium text-muted-foreground">
                    {chosen.kind === "workflow" ? "Steps, in order" : "Agents"}
                  </p>
                  <ol className="space-y-1">
                    {chosen.kind === "workflow"
                      ? chosen.steps.map((step, index) => (
                          <li key={step.id} className="flex gap-2">
                            <span className="text-muted-foreground">{index + 1}.</span>
                            <span>{step.name}</span>
                            <span className="text-xs text-muted-foreground">{step.kind}</span>
                          </li>
                        ))
                      : chosen.agents.map((agent) => (
                          <li key={agent} className="text-sm">
                            {agent}
                          </li>
                        ))}
                  </ol>
                </div>

                <div className="flex gap-2 rounded-md bg-muted p-3 text-xs">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span>{chosen.notes}</span>
                </div>

                {chosen.kind === "workflow" && chosen.schedule && (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Repeat className="size-3" aria-hidden="true" />
                    Runs on {chosen.schedule} after creation. Change the schedule on the workflow page.
                  </p>
                )}

                {error && (
                  <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                    {error}
                  </p>
                )}

                {created && (
                  <p className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
                    <Check className="size-4" aria-hidden="true" />
                    Created — <a className="underline" href={created.href}>{created.label}</a>
                  </p>
                )}
              </div>

              <DialogFooter>
                <Button variant="ghost" onClick={() => setChosen(null)}>
                  Close
                </Button>
                <Button onClick={use} disabled={busy || name.trim().length === 0}>
                  {busy && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />}
                  Create from template
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Page>
  );
}
