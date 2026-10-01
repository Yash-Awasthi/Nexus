// SPDX-License-Identifier: Apache-2.0
/**
 * Knowledge graph — the entities and relationships Nexus has extracted, the
 * communities they cluster into, and graph search over them.
 *
 * API:
 *   GET  /api/kg/graph                 — the best-connected entities and their relationships, drawn in 3D
 *   GET  /api/kg/communities           — Leiden communities, members ranked by degree
 *   GET  /api/kg/search?q=&type=        — graph search (entities, triplets, neighbourhood, community)
 *   POST /api/kb/graph { text }         — extract entities and relationships from text
 */
import { Loader2, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { KnowledgeGraphView } from "~/components/knowledge-graph-view";
import { Page, PageHeader } from "~/components/page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { apiFetch } from "~/lib/api";

interface Entity {
  id: string;
  name: string;
  type: string;
  rank?: number;
}

interface Community {
  communityId: string;
  title: string;
  entities: Entity[];
  findings: { summary: string }[];
}

interface SearchResult {
  nodes: Entity[];
  edges: { id: string; subjectId: string; predicate: string; objectId: string }[];
  communities?: { communityId: string; title: string; summary: string }[];
}

const SEARCH_TYPES = [
  { value: "LOCAL_GRAPH", label: "Neighbourhood" },
  { value: "ENTITIES", label: "Entities" },
  { value: "TRIPLETS", label: "Relationships" },
  { value: "COMMUNITY", label: "Communities" },
];

export default function KnowledgeGraphPage() {
  const [communities, setCommunities] = useState<Community[] | null>(null);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("LOCAL_GRAPH");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    try {
      setCommunities(
        (await apiFetch<{ communities: Community[] }>("/api/kg/communities")).communities,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCommunities([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<string | undefined>) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      setNote((await fn()) ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const search = (name?: string, searchType = type) =>
    act(async () => {
      const q = encodeURIComponent((name ?? query).trim());
      setResult(await apiFetch<SearchResult>(`/api/kg/search?q=${q}&type=${searchType}`));
      return undefined;
    });

  const ingest = () =>
    act(async () => {
      const res = await apiFetch<{ nodesAdded: number; edgesAdded: number }>("/api/kb/graph", {
        method: "POST",
        json: { text: text.trim() },
      });
      setText("");
      await load();
      setReloadKey((k) => k + 1);
      return `Added ${res.nodesAdded} entities and ${res.edgesAdded} relationships.`;
    });

  const nameOf = (id: string) => result?.nodes.find((n) => n.id === id)?.name ?? id;

  return (
    <Page width="wide">
      <PageHeader
        title="Knowledge graph"
        description="Entities and relationships extracted from what you add, grouped into communities of closely linked things."
      />

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {note && <p className="text-sm text-muted-foreground">{note}</p>}

      <Card>
        <CardHeader>
          <CardTitle>Explore</CardTitle>
          <CardDescription>
            Each dot is an entity and each line a relationship. Click one to see what it links to.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <KnowledgeGraphView
            reloadKey={reloadKey}
            onSearch={(name) => {
              setQuery(name);
              setType("LOCAL_GRAPH");
              void search(name, "LOCAL_GRAPH");
            }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Search the graph</CardTitle>
          <CardDescription>Name an entity, a relationship or a topic</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Input
              aria-label="Graph search"
              placeholder="e.g. Postgres"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && query.trim() && void search()}
              className="min-w-0 flex-1 basis-40"
            />
            <Select value={type} onValueChange={setType}>
              <SelectTrigger aria-label="Search type" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEARCH_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              onClick={() => void search()}
              disabled={busy || !query.trim()}
              aria-label="Search"
            >
              <Search className="size-4" />
            </Button>
          </div>

          {result &&
            (result.nodes.length === 0 && !result.communities?.length ? (
              <p className="text-sm text-muted-foreground">Nothing in the graph matches that.</p>
            ) : (
              <div className="space-y-3 text-sm">
                {result.communities?.map((c) => (
                  <div key={c.communityId}>
                    <p className="font-medium">{c.title}</p>
                    <p className="text-xs text-muted-foreground">{c.summary}</p>
                  </div>
                ))}
                {result.nodes.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {result.nodes.map((n) => (
                      <Badge key={n.id} variant="secondary" className="font-normal">
                        {n.name} <span className="text-muted-foreground">· {n.type}</span>
                      </Badge>
                    ))}
                  </div>
                )}
                {result.edges.length > 0 && (
                  <ul className="space-y-1 text-xs">
                    {result.edges.map((e) => (
                      <li key={e.id} className="break-words">
                        {nameOf(e.subjectId)}{" "}
                        <span className="text-muted-foreground">{e.predicate}</span>{" "}
                        {nameOf(e.objectId)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Communities</CardTitle>
          <CardDescription>Most connected entities first</CardDescription>
        </CardHeader>
        <CardContent>
          {communities === null ? (
            <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
          ) : communities.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No communities yet. Add text below and linked entities will cluster here.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {communities.map((c) => (
                <div key={c.communityId} className="space-y-2 py-3">
                  <p className="text-sm font-medium break-words">{c.title}</p>
                  <div className="flex flex-wrap gap-1">
                    {c.entities.map((e) => (
                      <Badge key={e.id} variant="outline" className="font-normal">
                        {e.name}
                        <span className="text-muted-foreground" title="Links to other entities">
                          {e.rank}
                        </span>
                      </Badge>
                    ))}
                  </div>
                  <ul className="space-y-0.5 text-xs text-muted-foreground">
                    {c.findings.slice(0, 5).map((f) => (
                      <li key={f.summary} className="break-words">
                        {f.summary}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add to the graph</CardTitle>
          <CardDescription>
            Your default model reads the text and extracts entities and relationships
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            aria-label="Text to add"
            placeholder="e.g. Ada manages the payments team, which runs on Postgres."
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
          />
          <Button onClick={ingest} disabled={busy || !text.trim()}>
            Extract
          </Button>
        </CardContent>
      </Card>
    </Page>
  );
}
