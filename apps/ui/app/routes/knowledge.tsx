// SPDX-License-Identifier: Apache-2.0
/**
 * Knowledge — one door for the four retrieval surfaces.
 *
 * Search, Memory, Knowledge bases and the Knowledge graph are separate stores
 * with separate APIs, but they are one workflow: you ingest into a base, it
 * becomes graph entities and memories, and you query all of it from Search.
 * This page is the tab shell only; each tab renders the existing page
 * component, so there is exactly one implementation of each surface.
 */
import { useSearchParams } from "react-router";

import KnowledgeBasesPage from "./knowledge-bases";
import KnowledgeGraphPage from "./knowledge-graph";
import MemoryPage from "./memory";
import SearchPage from "./search";

import { CoachMark } from "~/components/coach-mark";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";

const TABS = [
  { id: "search", label: "Search", Page: SearchPage },
  { id: "memory", label: "Memory", Page: MemoryPage },
  { id: "bases", label: "Knowledge bases", Page: KnowledgeBasesPage },
  { id: "graph", label: "Graph", Page: KnowledgeGraphPage },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function KnowledgePage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab") as TabId | null;
  const active = TABS.find((t) => t.id === requested) ?? TABS[0];
  const ActivePage = active.Page;

  return (
    <div className="flex flex-col gap-4">
      <CoachMark page="/knowledge" />
      <Tabs
        value={active.id}
        onValueChange={(value) => {
          const next = new URLSearchParams(params);
          next.set("tab", value);
          setParams(next, { replace: true });
        }}
      >
        <TabsList aria-label="Knowledge sections">
          {TABS.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <ActivePage />
    </div>
  );
}
