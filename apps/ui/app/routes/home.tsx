// SPDX-License-Identifier: Apache-2.0
import {
  ArrowRight,
  ArrowUp,
  Building2,
  CheckCircle2,
  Circle,
  Inbox,
  KeyRound,
  MessageSquare,
  Plus,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";

import type { Route } from "./+types/home";

import { EmptyState, Page, Section } from "~/components/page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { useAuth } from "~/context/AuthContext";
import { syncCouncilFromServer, type CouncilMember } from "~/lib/council";
import { listThreads, type StoredThread } from "~/lib/deliberate";
import { orgApi } from "~/lib/org";
import { cn } from "~/lib/utils";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Home · Nexus" }];
}

interface PortfolioRow {
  id: string;
  name: string;
  status: string;
  running: number;
  agents: number;
  pendingApprovals: number;
  monthUsd: number;
}

interface InboxDigest {
  companies: {
    companyId: string;
    name: string;
    items: { kind: string; text: string; taskId?: string }[];
  }[];
  total: number;
}

interface UsagePoint {
  date: string;
  requests: number;
  tokens: number;
  costUsd: number;
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function ago(ms: number) {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export default function Home() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [question, setQuestion] = useState("");
  const [threads, setThreads] = useState<StoredThread[] | null>(null);
  const [council, setCouncil] = useState<CouncilMember[]>([]);
  const [keys, setKeys] = useState<number | null>(null);
  const [companies, setCompanies] = useState<PortfolioRow[] | null>(null);
  const [inbox, setInbox] = useState<InboxDigest | null>(null);
  const [usage, setUsage] = useState<UsagePoint[]>([]);

  useEffect(() => {
    void listThreads().then(setThreads);
    void syncCouncilFromServer().then(setCouncil);
    void fetch("/api/user/provider-keys")
      .then((r) => (r.ok ? r.json() : { keys: [] }))
      .then((d: { keys?: unknown[] } | unknown[]) =>
        setKeys(Array.isArray(d) ? d.length : (d.keys?.length ?? 0)),
      )
      .catch(() => setKeys(0));
    void orgApi<{ companies: PortfolioRow[] }>("/portfolio")
      .then((d) => setCompanies(d.companies))
      .catch(() => setCompanies([]));
    void orgApi<InboxDigest>("/inbox")
      .then(setInbox)
      .catch(() => undefined);
    void fetch("/api/dashboard?days=30")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { series?: UsagePoint[] } | null) => setUsage(d?.series ?? []))
      .catch(() => undefined);
  }, []);

  const name = user?.username ?? user?.email?.split("@")[0] ?? "";
  const ask = () => {
    const q = question.trim();
    navigate(q ? `/chat?q=${encodeURIComponent(q)}` : "/chat");
  };

  const seated = council.filter((m) => m.enabled);
  const steps = [
    {
      done: (keys ?? 0) > 0,
      title: "Add a provider key",
      body: "Groq, Gemini and Mistral all have free tiers.",
      to: "/provider-keys",
      cta: "Add key",
    },
    {
      done: seated.length >= 2 && seated.every((m) => m.keySource && m.keySource !== "none"),
      title: "Seat a council of two or more",
      body: "Every seated member needs a key behind it.",
      to: "/chat",
      cta: "Open council",
    },
    {
      done: (companies?.length ?? 0) > 0,
      title: "Create a company",
      body: "Agents that turn verdicts into finished work.",
      to: "/org",
      cta: "Create",
    },
  ];
  const loaded = keys !== null && companies !== null;
  const setupLeft = steps.filter((s) => !s.done).length;

  return (
    <Page width="wide">
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl font-semibold">
            {greeting()}
            {name ? `, ${name}` : ""}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">What should the council think about?</p>
        </div>
        <form
          className="flex max-w-3xl items-center gap-2 rounded-xl border bg-card p-1.5 pl-4 shadow-xs focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20"
          onSubmit={(e) => {
            e.preventDefault();
            ask();
          }}
        >
          <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask the council a question…"
            aria-label="Ask the council"
            className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <Button type="submit" size="icon" aria-label="Ask">
            <ArrowUp />
          </Button>
        </form>
      </div>

      {loaded && setupLeft > 0 && (
        <Section
          title="Get set up"
          description={`${steps.length - setupLeft} of ${steps.length} done`}
        >
          <ol className="grid gap-3 py-1 md:grid-cols-3">
            {steps.map((s) => (
              <li
                key={s.title}
                className={cn("flex gap-3 rounded-lg border p-3", s.done && "bg-muted/40")}
              >
                {s.done ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                ) : (
                  <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "text-sm font-medium",
                      s.done && "text-muted-foreground line-through",
                    )}
                  >
                    {s.title}
                  </p>
                  <p className="text-xs text-muted-foreground">{s.body}</p>
                  {!s.done && (
                    <Button asChild variant="link" size="sm" className="mt-1 h-auto px-0">
                      <Link to={s.to}>
                        {s.cta} <ArrowRight />
                      </Link>
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </Section>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Section
            title="Recent deliberations"
            actions={
              <Button asChild variant="ghost" size="sm">
                <Link to="/chat">
                  <Plus /> New
                </Link>
              </Button>
            }
          >
            {threads === null ? (
              <ListSkeleton />
            ) : threads.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nothing yet. Your first question will show up here.
              </p>
            ) : (
              <ul className="-mx-2">
                {threads.slice(0, 6).map((t) => (
                  <li key={t.id}>
                    <Link
                      to={`/chat/${t.id}`}
                      className="flex items-center gap-3 rounded-md px-2 py-2.5 hover:bg-accent"
                    >
                      <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {t.title || "Untitled"}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {ago(t.updated_at)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            title="Companies"
            actions={
              <Button asChild variant="ghost" size="sm">
                <Link to="/org">
                  Open <ArrowRight />
                </Link>
              </Button>
            }
          >
            {companies === null ? (
              <ListSkeleton />
            ) : companies.length === 0 ? (
              <EmptyState
                icon={Building2}
                title="No companies yet"
                description="A company is a team of agents with a mission, a budget and tasks. Send it a verdict and it gets to work."
                action={
                  <Button asChild size="sm">
                    <Link to="/org">
                      <Plus /> Create a company
                    </Link>
                  </Button>
                }
                className="my-2 border-0 py-6"
              />
            ) : (
              <ul className="-mx-2">
                {companies.map((c) => (
                  <li key={c.id}>
                    <Link
                      to={`/org?c=${c.id}${c.pendingApprovals ? "&tab=approvals" : ""}`}
                      className="flex items-center gap-3 rounded-md px-2 py-2.5 hover:bg-accent"
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-semibold">
                        {c.name.slice(0, 2).toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{c.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {c.agents} agents · {c.running} working · ${c.monthUsd.toFixed(2)} this
                          month
                        </p>
                      </div>
                      {c.pendingApprovals > 0 && (
                        <Badge variant="secondary">{c.pendingApprovals} to approve</Badge>
                      )}
                      {c.status !== "active" && <Badge variant="outline">{c.status}</Badge>}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <div className="min-w-0 space-y-6">
          <Section
            title="Needs you"
            description="Blocked tasks, reviews and approvals across your companies."
          >
            {!inbox || inbox.total === 0 ? (
              <div className="flex flex-col items-center py-6 text-center">
                <Inbox className="size-5 text-muted-foreground" />
                <p className="mt-2 text-sm text-muted-foreground">Nothing is waiting on you.</p>
              </div>
            ) : (
              <ul className="space-y-3 py-1">
                {inbox.companies
                  .filter((c) => c.items.length)
                  .map((c) => (
                    <li key={c.companyId}>
                      <Link
                        to={`/org?c=${c.companyId}&inbox=open`}
                        className="text-xs font-medium text-muted-foreground hover:text-foreground"
                      >
                        {c.name}
                      </Link>
                      <ul className="mt-1 space-y-1">
                        {c.items.slice(0, 4).map((it, i) => (
                          <li key={i} className="flex gap-2 text-sm">
                            <span
                              className={cn(
                                "mt-1.5 size-1.5 shrink-0 rounded-full",
                                it.kind === "blocked" ? "bg-destructive" : "bg-warning",
                              )}
                            />
                            <span className="line-clamp-2">{it.text}</span>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
              </ul>
            )}
          </Section>

          <UsageCard series={usage} />

          <Section title="Your council">
            {seated.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">No member is seated.</p>
            ) : (
              <ul className="space-y-2 py-1">
                {seated.map((m) => (
                  <li key={m.id} className="flex items-center gap-2 text-sm">
                    <Users className="size-3.5 text-muted-foreground" />
                    <span className="flex-1 truncate">{m.label}</span>
                    <span className="truncate text-xs text-muted-foreground">{m.model}</span>
                    {m.keySource === "none" && (
                      <Link to="/provider-keys" title="No key for this provider">
                        <KeyRound className="size-3.5 text-warning" />
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </Page>
  );
}

function UsageCard({ series }: { series: UsagePoint[] }) {
  const total = series.reduce(
    (a, p) => ({
      requests: a.requests + p.requests,
      tokens: a.tokens + p.tokens,
      cost: a.cost + p.costUsd,
    }),
    { requests: 0, tokens: 0, cost: 0 },
  );
  const peak = Math.max(1, ...series.map((p) => p.requests));
  return (
    <Section
      title="Last 30 days"
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link to="/costs">Details</Link>
        </Button>
      }
    >
      <dl className="grid grid-cols-3 gap-2 py-1">
        {[
          ["Calls", total.requests.toLocaleString()],
          ["Tokens", total.tokens >= 1000 ? `${(total.tokens / 1000).toFixed(1)}k` : total.tokens],
          ["Cost", `$${total.cost.toFixed(2)}`],
        ].map(([k, v]) => (
          <div key={k as string}>
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd className="text-lg font-semibold tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex h-12 items-end gap-0.5" aria-hidden="true">
        {series.map((p) => (
          <div
            key={p.date}
            title={`${p.date}: ${p.requests} calls`}
            className="flex-1 rounded-sm bg-primary/70"
            style={{
              height: `${Math.max(4, (p.requests / peak) * 100)}%`,
              opacity: p.requests ? 1 : 0.25,
            }}
          />
        ))}
      </div>
    </Section>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-2 py-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-8 animate-pulse rounded-md bg-muted" />
      ))}
    </div>
  );
}
