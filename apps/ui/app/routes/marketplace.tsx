// SPDX-License-Identifier: Apache-2.0
import { Store, Star, Download, Search, Plus, Loader2, FileDown, Trash2 } from "lucide-react";
import { useState, useEffect } from "react";

import { Page, PageHeader } from "~/components/page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "~/components/ui/tabs";
import { Textarea } from "~/components/ui/textarea";

type ItemType = "archetype" | "workflow" | "prompt" | "skill";

interface MarketplaceItem {
  id: string;
  name: string;
  type: ItemType;
  author: string;
  description: string;
  stars: number;
  installs: number;
  isMine?: boolean;
}

// Default seed starred/installed (shown until API loads)
const INITIAL_STARRED = new Set<string>();
const INITIAL_INSTALLED = new Set<string>();

const typeColors: Record<ItemType, string> = {
  archetype: "bg-primary/10 text-primary",
  workflow: "bg-success/10 text-success",
  prompt: "bg-primary/10 text-primary",
  skill: "bg-warning/10 text-warning",
};

interface PublishForm {
  name: string;
  description: string;
  type: ItemType | "";
  content: string;
  tags: string;
}

export default function MarketplacePage() {
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("all");
  const [items, setItems] = useState<MarketplaceItem[]>([]);
  const [starred, setStarred] = useState<Set<string>>(INITIAL_STARRED);
  const [installed, setInstalled] = useState<Set<string>>(INITIAL_INSTALLED);
  const [installing, setInstalling] = useState<Set<string>>(new Set());

  // Filter toggles
  const [filterStarred, setFilterStarred] = useState(false);
  const [filterMine, setFilterMine] = useState(false);
  const [filterInstalled, setFilterInstalled] = useState(false);

  // ── Load marketplace items from backend ─────────────────────────────────────
  useEffect(() => {
    fetch("/api/marketplace?limit=100")
      .then((r) => (r.ok ? (r.json() as Promise<{ items?: MarketplaceItem[] }>) : Promise.reject()))
      .then((data) => setItems(data.items ?? []))
      .catch(() => setActionError("Could not load the marketplace."));

    // Load user's starred and installed state
    fetch("/api/marketplace/me")
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{ starred?: string[]; installed?: string[] }>)
          : Promise.reject(),
      )
      .then((data) => {
        if (data.starred) setStarred(new Set(data.starred));
        if (data.installed) setInstalled(new Set(data.installed));
      })
      .catch(() => {});
  }, []);

  // Publish dialog
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishForm, setPublishForm] = useState<PublishForm>({
    name: "",
    description: "",
    type: "",
    content: "",
    tags: "",
  });
  const [publishLoading, setPublishLoading] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const toggleStar = (id: string) => {
    setStarred((prev) => {
      const next = new Set(prev);
      const wasStarred = next.has(id);
      if (wasStarred) {
        next.delete(id);
        setItems((items) =>
          items.map((item) =>
            item.id === id ? { ...item, stars: Math.max(0, item.stars - 1) } : item,
          ),
        );
        fetch(`/api/marketplace/${id}/star`, { method: "DELETE" }).catch(() => {});
      } else {
        next.add(id);
        setItems((items) =>
          items.map((item) => (item.id === id ? { ...item, stars: item.stars + 1 } : item)),
        );
        fetch(`/api/marketplace/${id}/star`, { method: "POST" }).catch(() => {});
      }
      return next;
    });
  };

  const handleInstall = (id: string) => {
    if (installing.has(id)) return;
    if (installed.has(id)) {
      // Uninstall — optimistic
      setInstalled((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setItems((items) =>
        items.map((item) =>
          item.id === id ? { ...item, installs: Math.max(0, item.installs - 1) } : item,
        ),
      );
      fetch(`/api/marketplace/${id}/install`, { method: "DELETE" }).catch(() => {});
      return;
    }
    // Install — optimistic with loading state
    setInstalling((prev) => new Set(prev).add(id));
    setActionError(null);
    fetch(`/api/marketplace/${id}/install`, { method: "POST" })
      .then(async (r) => {
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
          throw new Error(body.message ?? body.error ?? `Install failed (${r.status})`);
        }
        setInstalled((prev) => new Set(prev).add(id));
        setItems((items) =>
          items.map((item) => (item.id === id ? { ...item, installs: item.installs + 1 } : item)),
        );
      })
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        setInstalling((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      });
  };

  const handleDownloadJson = (item: MarketplaceItem) => {
    const exportData = {
      id: item.id,
      name: item.name,
      type: item.type,
      author: item.author,
      description: item.description,
      stars: item.stars,
      installs: item.installs,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${item.name.toLowerCase().replace(/\s+/g, "-")}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handlePublish = async () => {
    if (!publishForm.name || !publishForm.type) return;
    setPublishLoading(true);
    setPublishError(null);
    try {
      const r = await fetch("/api/marketplace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: publishForm.name,
          description: publishForm.description || publishForm.name,
          type: publishForm.type,
          content: publishForm.content,
          tags: publishForm.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        }),
      });
      const body = (await r.json().catch(() => ({}))) as {
        item?: MarketplaceItem;
        error?: string;
        message?: string;
      };
      if (!r.ok || !body.item)
        throw new Error(body.message ?? body.error ?? `Publish failed (${r.status})`);
      setItems((prev) => [body.item!, ...prev]);
      setPublishOpen(false);
      setPublishForm({ name: "", description: "", type: "", content: "", tags: "" });
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : String(err));
    } finally {
      setPublishLoading(false);
    }
  };

  const filtered = items.filter((item) => {
    const matchesSearch =
      !search ||
      item.name.toLowerCase().includes(search.toLowerCase()) ||
      item.description.toLowerCase().includes(search.toLowerCase());
    const matchesTab = tab === "all" || item.type === tab;
    const matchesFilterStarred = !filterStarred || starred.has(item.id);
    const matchesFilterMine = !filterMine || item.isMine;
    const matchesFilterInstalled = !filterInstalled || installed.has(item.id);
    return (
      matchesSearch &&
      matchesTab &&
      matchesFilterStarred &&
      matchesFilterMine &&
      matchesFilterInstalled
    );
  });

  return (
    <Page width="wide">
      <PageHeader
        title="Marketplace"
        description="Ready-made archetype line-ups, workflows, prompts and skills. Install one and it's yours to edit."
        actions={
          <Button variant="outline" onClick={() => setPublishOpen(true)}>
            <Plus /> Publish
          </Button>
        }
      />

      {/* Search */}
      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search marketplace..."
            className="pl-8"
          />
        </div>
      </div>

      {/* Tabs row with filter buttons */}
      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Left: filter toggles */}
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant={filterStarred ? "default" : "outline"}
              className="h-8 gap-1.5 text-xs"
              onClick={() => setFilterStarred((v) => !v)}
            >
              <Star className={`size-3 ${filterStarred ? "fill-current" : ""}`} />
              Starred
            </Button>
            <Button
              size="sm"
              variant={filterMine ? "default" : "outline"}
              className="h-8 text-xs"
              onClick={() => setFilterMine((v) => !v)}
            >
              My Items
            </Button>
            <Button
              size="sm"
              variant={filterInstalled ? "default" : "outline"}
              className="h-8 gap-1.5 text-xs"
              onClick={() => setFilterInstalled((v) => !v)}
            >
              <Download className="size-3" />
              Installed
            </Button>
          </div>

          {/* Divider */}
          <div className="h-6 w-px bg-border" />

          {/* Right: type tabs */}
          <TabsList className="h-8">
            <TabsTrigger value="all" className="text-xs h-full">
              All
            </TabsTrigger>
            <TabsTrigger value="archetype" className="text-xs h-full">
              Archetypes
            </TabsTrigger>
            <TabsTrigger value="workflow" className="text-xs h-full">
              Workflows
            </TabsTrigger>
            <TabsTrigger value="prompt" className="text-xs h-full">
              Prompts
            </TabsTrigger>
            <TabsTrigger value="skill" className="text-xs h-full">
              Skills
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value={tab}>
          {actionError && <p className="text-xs text-destructive mt-3">{actionError}</p>}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mt-4">
            {filtered.map((item) => {
              const isStarred = starred.has(item.id);
              const isInstalled = installed.has(item.id);
              const isInstalling = installing.has(item.id);

              return (
                <Card
                  key={item.id}
                  className="cursor-pointer hover:ring-2 hover:ring-primary/20 transition-all relative"
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-sm leading-tight">{item.name}</CardTitle>
                      <Badge className={`text-[10px] shrink-0 ${typeColors[item.type]}`}>
                        {item.type}
                      </Badge>
                    </div>
                    <CardDescription className="text-xs">{item.description}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center justify-between text-xs text-muted-foreground mb-3">
                      <span>by {item.author}</span>
                      <div className="flex items-center gap-3">
                        <span className="flex items-center gap-1">
                          <Star
                            className={`size-3 ${isStarred ? "fill-warning text-warning" : ""}`}
                          />
                          {item.stars}
                        </span>
                        <span className="flex items-center gap-1">
                          <Download className="size-3" />
                          {(item.installs ?? 0).toLocaleString()}
                        </span>
                      </div>
                    </div>

                    {/* Action buttons — always visible */}
                    <div className="flex items-center gap-2">
                      {/* Star toggle */}
                      <Button
                        size="sm"
                        variant="ghost"
                        className={`h-7 w-7 p-0 shrink-0 ${
                          isStarred ? "text-warning hover:text-warning" : "text-muted-foreground"
                        }`}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleStar(item.id);
                        }}
                        title={isStarred ? "Unstar" : "Star"}
                      >
                        <Star className={`size-3.5 ${isStarred ? "fill-current" : ""}`} />
                      </Button>

                      {/* Download JSON button */}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 shrink-0 text-muted-foreground hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDownloadJson(item);
                        }}
                        title="Download as JSON"
                      >
                        <FileDown className="size-3.5" />
                      </Button>

                      {/* Install / Uninstall button */}
                      <Button
                        size="sm"
                        variant={isInstalled ? "secondary" : "default"}
                        className="flex-1 h-7 text-xs gap-1.5"
                        disabled={isInstalling}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleInstall(item.id);
                        }}
                      >
                        {isInstalling ? (
                          <>
                            <Loader2 className="size-3 animate-spin" />
                            Installing...
                          </>
                        ) : isInstalled ? (
                          <>
                            <Trash2 className="size-3" />
                            Uninstall
                          </>
                        ) : (
                          <>
                            <Download className="size-3" />
                            Install
                          </>
                        )}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
            {filtered.length === 0 && (
              <div className="col-span-full text-center py-12 text-muted-foreground">
                No items found matching your filters.
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* Publish Dialog */}
      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Store className="size-4" />
              Publish to Marketplace
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="pub-name">Name</Label>
              <Input
                id="pub-name"
                placeholder="My Amazing Archetype"
                value={publishForm.name}
                onChange={(e) => setPublishForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pub-description">Description</Label>
              <Input
                id="pub-description"
                placeholder="What does this do?"
                value={publishForm.description}
                onChange={(e) => setPublishForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pub-type">Type</Label>
              <Select
                value={publishForm.type}
                onValueChange={(v) => setPublishForm((f) => ({ ...f, type: v as ItemType }))}
              >
                <SelectTrigger id="pub-type">
                  <SelectValue placeholder="Select a type..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="archetype">Archetype</SelectItem>
                  <SelectItem value="workflow">Workflow</SelectItem>
                  <SelectItem value="prompt">Prompt</SelectItem>
                  <SelectItem value="skill">Skill</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pub-content">Content</Label>
              <Textarea
                id="pub-content"
                placeholder="Archetype: its system prompt. Workflow: a JSON array of steps. Prompt: the template. Skill: its code."
                className="min-h-[120px] font-mono text-xs"
                value={publishForm.content}
                onChange={(e) => setPublishForm((f) => ({ ...f, content: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pub-tags">Tags</Label>
              <Input
                id="pub-tags"
                placeholder="e.g. analysis, code, automation (comma-separated)"
                value={publishForm.tags}
                onChange={(e) => setPublishForm((f) => ({ ...f, tags: e.target.value }))}
              />
            </div>
          </div>

          {publishError && <p className="text-xs text-destructive">{publishError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPublishOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handlePublish}
              disabled={!publishForm.name || !publishForm.type || publishLoading}
              className="gap-2"
            >
              {publishLoading ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Publishing...
                </>
              ) : (
                <>
                  <Plus className="size-4" />
                  Publish
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
