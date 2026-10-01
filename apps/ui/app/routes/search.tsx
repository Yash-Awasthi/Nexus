// SPDX-License-Identifier: Apache-2.0
/**
 * Search — one question across your knowledge bases, your knowledge graph and the web, with
 * numbered sources and, if you want it, an answer that cites them.
 *
 * API:
 *   GET  /api/kb            — the bases to search
 *   POST /api/search        — { query, kbs?, web?, graph?, answer? }
 */
import { BookOpen, Globe, Loader2, Network, Search as SearchIcon } from "lucide-react";
import { Fragment, useEffect, useState } from "react";

import { Page, PageHeader } from "~/components/page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { apiFetch } from "~/lib/api";
import { cn } from "~/lib/utils";

interface Kb {
  id: string;
  name: string;
}

interface Hit {
  n?: number;
  title: string;
  url?: string;
  source: "knowledge_base" | "knowledge_graph" | "web";
  kbName?: string;
  text: string;
  score: number;
}

interface Found {
  query: string;
  results: Hit[];
  sources: { n: number; title: string; url?: string }[];
  answer?: string;
  cited?: number[];
  answerError?: string;
  notes: string[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const STOP = new Set(
  "the and who what when where how why for are was were with that this from into have has not you your our their".split(
    " ",
  ),
);

/** The text, cut to a window around the first word of the query it holds, with those words marked. */
function Marked({ text, query }: { text: string; query: string }) {
  const words = query
    .split(/\W+/)
    .filter((w) => w.length >= 3 && !STOP.has(w.toLowerCase()))
    .map(escape);
  if (!words.length) return <>{text.slice(0, 320)}</>;
  const re = new RegExp(`(${words.join("|")})`, "gi");
  let from = 0;
  let to = text.length;
  if (text.length > 320) {
    const at = text.search(re);
    from = Math.max(0, (at < 0 ? 0 : at) - 100);
    to = Math.min(text.length, from + 320);
  }
  const parts = text.slice(from, to).split(re);
  return (
    <>
      {from > 0 && "… "}
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded bg-primary/20 px-0.5 text-foreground">
            {p}
          </mark>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
      {to < text.length && " …"}
    </>
  );
}

/** An answer with each [n] turned into a badge that jumps to that source. */
function Answer({ text }: { text: string }) {
  return (
    <p className="text-sm leading-relaxed whitespace-pre-wrap">
      {text.split(/(\[\d{1,3}\])/g).map((part, i) => {
        const m = /^\[(\d{1,3})\]$/.exec(part);
        return m ? (
          <a
            key={i}
            href={`#source-${m[1]}`}
            className="mx-0.5 rounded bg-primary/15 px-1 text-xs font-medium text-primary no-underline"
          >
            {m[1]}
          </a>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        );
      })}
    </p>
  );
}

const SOURCE_LABEL = { knowledge_base: "Knowledge base", knowledge_graph: "Graph", web: "Web" };

export default function SearchPage() {
  const [kbs, setKbs] = useState<Kb[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [web, setWeb] = useState(false);
  const [graph, setGraph] = useState(true);
  const [answer, setAnswer] = useState(true);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await apiFetch<{ kbs: Kb[] }>("/api/kb?limit=100");
        if (live) setKbs(res.kbs ?? []);
      } catch {
        /* no bases listed: the web and the graph can still be searched */
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const run = async () => {
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setError("");
    try {
      setFound(
        await apiFetch<Found>("/api/search", {
          method: "POST",
          json: { query: q, kbs: picked, web, graph, answer },
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleKb = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <Page>
      <PageHeader
        title="Search"
        description="Ask once across your knowledge bases, your graph and the web. Every result keeps its source, and an answer cites the ones it used."
      />

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <div className="flex gap-2">
          <Input
            aria-label="Search"
            placeholder="e.g. When do backups run?"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={500}
            className="min-w-0 flex-1"
          />
          <Button type="submit" disabled={busy || !query.trim()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <SearchIcon className="size-4" />}
            Search
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-xs text-muted-foreground">Search in</span>
          {kbs.length === 0 ? (
            <span className="text-xs text-muted-foreground">no knowledge bases yet</span>
          ) : (
            kbs.map((kb) => (
              <button
                key={kb.id}
                type="button"
                aria-pressed={picked.includes(kb.id)}
                onClick={() => toggleKb(kb.id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                  picked.includes(kb.id)
                    ? "border-primary/50 bg-primary/10"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <BookOpen className="size-3" /> {kb.name}
              </button>
            ))
          )}
          {picked.length === 0 && kbs.length > 1 && (
            <span className="text-xs text-muted-foreground">(all of them)</span>
          )}
          <button
            type="button"
            aria-pressed={graph}
            onClick={() => setGraph((v) => !v)}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
              graph ? "border-primary/50 bg-primary/10" : "text-muted-foreground",
            )}
          >
            <Network className="size-3" /> Graph
          </button>
          <button
            type="button"
            aria-pressed={web}
            onClick={() => setWeb((v) => !v)}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
              web ? "border-primary/50 bg-primary/10" : "text-muted-foreground",
            )}
          >
            <Globe className="size-3" /> Web
          </button>
          <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={answer} onCheckedChange={setAnswer} aria-label="Write an answer" />
            Write an answer
          </label>
        </div>
      </form>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {found && (
        <div className="space-y-4">
          {found.notes.map((n) => (
            <p key={n} className="text-sm text-muted-foreground">
              {n}
            </p>
          ))}

          {found.answer && (
            <Card className="border-primary/30 bg-primary/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Answer</CardTitle>
              </CardHeader>
              <CardContent>
                <Answer text={found.answer} />
              </CardContent>
            </Card>
          )}
          {found.answerError && (
            <p className="text-sm text-destructive">
              Could not write an answer: {found.answerError}
            </p>
          )}

          {found.results.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing matched that.</p>
          ) : (
            <ul className="space-y-3">
              {found.results.map((r, i) => (
                <li
                  key={`${r.title}-${i}`}
                  id={
                    r.n && found.results.findIndex((x) => x.n === r.n) === i
                      ? `source-${r.n}`
                      : undefined
                  }
                  className="scroll-mt-20 rounded-lg border bg-card p-4"
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {r.n && (
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 font-medium",
                          found.cited?.includes(r.n)
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {r.n}
                      </span>
                    )}
                    <span className="font-medium break-words">{r.title}</span>
                    <Badge variant="outline" className="font-normal">
                      {r.source === "knowledge_base" && r.kbName
                        ? r.kbName
                        : SOURCE_LABEL[r.source]}
                    </Badge>
                    {r.url && (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="truncate text-muted-foreground underline-offset-2 hover:underline"
                      >
                        {r.url}
                      </a>
                    )}
                  </div>
                  <p className="mt-2 text-sm break-words text-muted-foreground">
                    <Marked text={r.text} query={found.query} />
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Page>
  );
}
