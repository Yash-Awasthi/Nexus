// SPDX-License-Identifier: Apache-2.0
import { useState, useEffect } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "~/components/ui/tabs";
import { Textarea } from "~/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "~/components/ui/dialog";
import {
  Store,
  Star,
  Download,
  Search,
  Plus,
  Check,
  Loader2,
  FileDown,
  Trash2,
} from "lucide-react";

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

const CURRENT_USER = "myuser";

const initialItems: MarketplaceItem[] = [
  {
    id: "1",
    name: "The Architect",
    type: "archetype",
    author: "Nexus",
    description: "Systems-level design thinking and architectural analysis",
    stars: 234,
    installs: 1847,
  },
  {
    id: "2",
    name: "Code Review Pipeline",
    type: "workflow",
    author: "devtools-co",
    description: "Automated multi-pass code review with severity scoring",
    stars: 189,
    installs: 923,
  },
  {
    id: "3",
    name: "Research Synthesizer",
    type: "prompt",
    author: "ml-research",
    description: "Structured research gathering and synthesis prompt chain",
    stars: 156,
    installs: 672,
  },
  {
    id: "4",
    name: "The Ethicist",
    type: "archetype",
    author: "Nexus",
    description: "Ethical analysis, bias detection, and fairness evaluation",
    stars: 201,
    installs: 1523,
  },
  {
    id: "5",
    name: "Data Pipeline Builder",
    type: "workflow",
    author: "dataeng-team",
    description: "Visual data pipeline construction with validation steps",
    stars: 98,
    installs: 412,
  },
  {
    id: "6",
    name: "API Generator",
    type: "skill",
    author: "apicraft",
    description: "Generate REST/GraphQL APIs from natural language specifications",
    stars: 312,
    installs: 2341,
  },
  {
    id: "7",
    name: "Debate Moderator",
    type: "prompt",
    author: "council-labs",
    description: "Controls multi-archetype debate flow and consensus building",
    stars: 87,
    installs: 345,
  },
  {
    id: "8",
    name: "Security Scanner",
    type: "skill",
    author: "secteam",
    description: "Automated security vulnerability scanning and reporting",
    stars: 267,
    installs: 1892,
  },
  {
    id: "9",
    name: "My Custom Workflow",
    type: "workflow",
    author: CURRENT_USER,
    description: "A personal workflow for automating report generation",
    stars: 12,
    installs: 47,
    isMine: true,
  },
  {
    id: "10",
    name: "My Prompt Template",
    type: "prompt",
    author: CURRENT_USER,
    description: "Structured prompt for technical documentation writing",
    stars: 8,
    installs: 23,
    isMine: true,
  },
];

// Default seed starred/installed (shown until API loads)
const INITIAL_STARRED = new Set<string>();
const INITIAL_INSTALLED = new Set<string>();

const typeColors: Record<ItemType, string> = {
  archetype: "bg-blue-500/20 text-blue-400",
  workflow: "bg-green-500/20 text-green-400",
  prompt: "bg-purple-500/20 text-purple-400",
  skill: "bg-amber-500/20 text-amber-400",
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
  const [items, setItems] = useState<MarketplaceItem[]>(initialItems);
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
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        const list: MarketplaceItem[] = Array.isArray(data)
          ? data
          : (data?.items ?? data?.data ?? []);
        if (list.length > 0) setItems(list);
      })
      .catch(() => {
        /* keep initialItems as fallback */
      });

    // Load user's starred and installed state
    fetch("/api/marketplace/me")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        if (data?.starred) setStarred(new Set<string>(data.starred));
        if (data?.installed) setInstalled(new Set<string>(data.installed));
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
    fetch(`/api/marketplace/${id}/install`, { method: "POST" })
      .catch(() => {})
      .finally(() => {
        setInstalling((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        setInstalled((prev) => new Set(prev).add(id));
        setItems((items) =>
          items.map((item) => (item.id === id ? { ...item, installs: item.installs + 1 } : item)),
        );
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
    const optimisticId = `pub_${Date.now()}`;
    const optimistic: MarketplaceItem = {
      id: optimisticId,
      name: publishForm.name,
      type: publishForm.type as ItemType,
      author: CURRENT_USER,
      description: publishForm.description || "No description provided",
      stars: 0,
      installs: 0,
      isMine: true,
    };
    setItems((prev) => [optimistic, ...prev]);
    setInstalled((prev) => new Set(prev).add(optimisticId));
    setPublishLoading(false);
    setPublishOpen(false);
    setPublishForm({ name: "", description: "", type: "", content: "", tags: "" });

    // Persist to backend, swap id on success
    fetch("/api/marketplace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: publishForm.name,
        description: publishForm.description,
        type: publishForm.type,
        content: publishForm.content,
        tags: publishForm.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((created: MarketplaceItem) => {
        if (created?.id && created.id !== optimisticId) {
          setItems((prev) =>
            prev.map((item) => (item.id === optimisticId ? { ...item, id: created.id } : item)),
          );
          setInstalled((prev) => {
            const next = new Set(prev);
            next.delete(optimisticId);
            next.add(created.id);
            return next;
          });
        }
      })
      .catch(() => {});
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
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Store className="size-6 text-muted-foreground" />
            <div>
              <h1 className="text-xl font-semibold">Marketplace</h1>
              <p className="text-sm text-muted-foreground">
                Discover and install archetypes, workflows, prompts, and skills
              </p>
            </div>
          </div>
          <Button size="sm" className="gap-2" onClick={() => setPublishOpen(true)}>
            <Plus className="size-4" />
            Publish to Marketplace
          </Button>
        </div>

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
                              className={`size-3 ${isStarred ? "fill-yellow-400 text-yellow-400" : ""}`}
                            />
                            {item.stars}
                          </span>
                          <span className="flex items-center gap-1">
                            <Download className="size-3" />
                            {item.installs.toLocaleString()}
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
                            isStarred
                              ? "text-yellow-400 hover:text-yellow-300"
                              : "text-muted-foreground"
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
      </div>

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
                placeholder="Paste your archetype definition, workflow config, prompt template, or skill code here..."
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
    </div>
  );
}
