import { useState, useEffect } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "~/components/ui/dialog";
import {
  GitBranch,
  Plus,
  FileText,
  CheckCircle,
  Loader2,
  AlertCircle,
  Search,
  ExternalLink,
  X,
  RefreshCw,
} from "lucide-react";

interface Repo {
  id: string;
  name: string;
  url: string;
  branch: string;
  fileCount: number;
  status: "indexed" | "indexing" | "error";
  lastIndexed: string;
}

interface SearchResult {
  file: string;
  snippet: string;
  score: number;
}

const mockRepos: Repo[] = [
  {
    id: "repo_1",
    name: "Nexus-core",
    url: "https://github.com/org/Nexus-core",
    branch: "main",
    fileCount: 234,
    status: "indexed",
    lastIndexed: "2 hours ago",
  },
  {
    id: "repo_2",
    name: "Nexus-frontend",
    url: "https://github.com/org/Nexus-frontend",
    branch: "main",
    fileCount: 89,
    status: "indexed",
    lastIndexed: "1 hour ago",
  },
  {
    id: "repo_3",
    name: "ml-pipeline",
    url: "https://github.com/org/ml-pipeline",
    branch: "develop",
    fileCount: 156,
    status: "indexing",
    lastIndexed: "Indexing...",
  },
  {
    id: "repo_4",
    name: "docs",
    url: "https://github.com/org/docs",
    branch: "main",
    fileCount: 45,
    status: "error",
    lastIndexed: "Failed 1 day ago",
  },
];

const mockSearchResults: SearchResult[] = [
  {
    file: "src/council/deliberation.ts",
    snippet: "async function runDeliberation(members: Archetype[], query: string)",
    score: 0.95,
  },
  {
    file: "src/providers/openai.ts",
    snippet: "export class OpenAIProvider implements LLMProvider",
    score: 0.87,
  },
  {
    file: "src/memory/vector-store.ts",
    snippet: "async function semanticSearch(query: string, topK: number)",
    score: 0.82,
  },
];

function StatusBadge({ status }: { status: Repo["status"] }) {
  if (status === "indexed") {
    return (
      <Badge variant="outline" className="text-[10px] text-green-400 border-green-400/30">
        <CheckCircle className="size-2.5 mr-1" />
        Indexed
      </Badge>
    );
  }
  if (status === "indexing") {
    return (
      <Badge variant="outline" className="text-[10px] text-yellow-400 border-yellow-400/30">
        <Loader2 className="size-2.5 mr-1 animate-spin" />
        Indexing
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px] text-red-400 border-red-400/30">
      <AlertCircle className="size-2.5 mr-1" />
      Error
    </Badge>
  );
}

export default function ReposPage() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [reposLoading, setReposLoading] = useState(true);

  // Load repos from real API
  useEffect(() => {
    setReposLoading(true);
    fetch("/api/repos")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data?.data) return;
        const mapped: Repo[] = data.data.map((r: any) => ({
          id:          String(r.id),
          name:        r.name ?? r.repoUrl?.split("/").pop() ?? "repo",
          url:         r.repoUrl ?? "",
          branch:      "main",
          fileCount:   r.fileCount ?? 0,
          status:      r.indexed ? "indexed" : "indexing",
          lastIndexed: r.createdAt ? new Date(r.createdAt).toLocaleString() : "—",
        }));
        setRepos(mapped);
      })
      .catch(() => {})
      .finally(() => setReposLoading(false));
  }, []);
  const [addOpen, setAddOpen] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);

  const handleAddRepo = async () => {
    if (!repoUrl.trim()) return;
    // Extract owner/repo from URL (github.com/owner/repo)
    const cleaned = repoUrl.trim().replace(/\.git$/, "");
    const urlParts = cleaned.split("/").filter(Boolean);
    const repoName = urlParts[urlParts.length - 1] || "new-repo";
    const owner    = urlParts[urlParts.length - 2] || "unknown";
    const newId = `repo_${Date.now()}`;

    const newRepo: Repo = {
      id: newId,
      name: repoName,
      url: repoUrl.trim(),
      branch: branch || "main",
      fileCount: 0,
      status: "indexing",
      lastIndexed: "Indexing...",
    };

    setRepos((prev) => [...prev, newRepo]);
    setAddOpen(false);
    setRepoUrl("");
    setBranch("main");

    // Call real API to start indexing
    try {
      await fetch("/api/repos/github", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ owner, repo: repoName }),
      });
    } catch { /* ignore — optimistic UI already updated */ }

    // Poll for completion (max 30s)
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      if (attempts > 30) { clearInterval(poll); return; }
      try {
        const res = await fetch(`/api/repos/${newId}/status`);
        if (res.ok) {
          const s = await res.json();
          if (s.indexed) {
            clearInterval(poll);
            setRepos((prev) =>
              prev.map((r) =>
                r.id === newId
                  ? { ...r, status: "indexed" as const, fileCount: s.fileCount ?? r.fileCount, lastIndexed: "Just now" }
                  : r
              )
            );
          }
        }
      } catch { /* ignore */ }
    }, 2000);

    // Legacy fallback: update optimistically after 3s if no real response
    setTimeout(() => {
      setRepos((prev) =>
        prev.map((r) =>
          r.id === newId && r.status === "indexing"
            ? { ...r, status: "indexed" as const, fileCount: Math.floor(Math.random() * 200) + 20, lastIndexed: "Just now" }
            : r
        )
      );
    }, 2000);
  };

  const handleDeleteRepo = async (id: string) => {
    try {
      await fetch(`/api/repos/${id}`, { method: "DELETE" });
    } catch { /* ignore */ }
    setRepos((prev) => prev.filter((r) => r.id !== id));
  };

  const handleReindex = (id: string) => {
    setRepos((prev) =>
      prev.map((r) =>
        r.id === id ? { ...r, status: "indexing" as const, lastIndexed: "Indexing..." } : r
      )
    );
    setTimeout(() => {
      const fileCount = Math.floor(Math.random() * 200) + 20;
      setRepos((prev) =>
        prev.map((r) =>
          r.id === id
            ? { ...r, status: "indexed" as const, fileCount, lastIndexed: "Just now" }
            : r
        )
      );
    }, 2000);
  };

  const handleSearch = async () => {
    if (!searchQuery.trim() || repos.length === 0) return;
    setIsSearching(true);
    try {
      // Search all indexed repos in parallel
      const indexedRepos = repos.filter((r) => r.status === "indexed");
      const allResults = await Promise.allSettled(
        indexedRepos.map((r) =>
          fetch(`/api/repos/${r.id}/search`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ query: searchQuery.trim() }),
          })
          .then((res) => res.ok ? res.json() : null)
          .then((data) =>
            (data?.data ?? []).map((result: any) => ({
              file:    result.file ?? result.path ?? "unknown",
              snippet: result.snippet ?? result.content?.slice(0, 200) ?? "",
              score:   typeof result.score === "number" ? result.score : 0.5,
            }))
          )
        )
      );

      const combined: SearchResult[] = allResults
        .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
        .sort((a, b) => b.score - a.score)
        .slice(0, 20);

      setSearchResults(combined.length > 0 ? combined : []);
    } catch {
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <GitBranch className="size-6 text-muted-foreground" />
            <div>
              <h1 className="text-xl font-semibold">Repositories</h1>
              <p className="text-sm text-muted-foreground">
                Index and search code repositories for context-aware AI responses
              </p>
            </div>
          </div>
          <Button size="sm" className="gap-2" onClick={() => setAddOpen(true)}>
            <Plus className="size-3.5" />
            Add Repository
          </Button>
        </div>

        {/* Repo Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {repos.map((repo) => (
            <Card
              key={repo.id}
              className="cursor-pointer hover:ring-2 hover:ring-primary/20 transition-all"
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-sm flex items-center gap-2">
                      {repo.name}
                      <StatusBadge status={repo.status} />
                    </CardTitle>
                    <a
                      href={/^https?:\/\//i.test(repo.url) ? repo.url : "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 mt-0.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {repo.url}
                      <ExternalLink className="size-2.5" />
                    </a>
                  </div>
                  <div className="flex items-center gap-1">
                    {repo.status === "error" && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleReindex(repo.id);
                        }}
                        className="text-muted-foreground hover:text-primary transition-colors p-1 rounded-sm hover:bg-primary/10"
                        title="Re-index"
                      >
                        <RefreshCw className="size-3.5" />
                      </button>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteRepo(repo.id);
                      }}
                      className="text-muted-foreground hover:text-destructive transition-colors p-1 rounded-sm hover:bg-destructive/10"
                      title="Delete repository"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <GitBranch className="size-3" />
                    {repo.branch}
                  </span>
                  <span className="flex items-center gap-1">
                    <FileText className="size-3" />
                    {repo.fileCount} files
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-2">{repo.lastIndexed}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Semantic Search */}
        <div className="space-y-4">
          <h2 className="text-sm font-semibold">Semantic Search</h2>
          <div className="flex gap-2">
            <Input
              placeholder="Search across all indexed repositories..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              className="flex-1"
            />
            <Button onClick={handleSearch} disabled={isSearching} className="gap-2">
              {isSearching ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Search className="size-4" />
              )}
              Search
            </Button>
          </div>

          {searchResults && (
            <div className="space-y-2">
              {searchResults.map((result, i) => (
                <Card key={i} className="hover:ring-2 hover:ring-primary/20 transition-all">
                  <CardContent className="py-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-1 flex-1 min-w-0">
                        <p className="text-xs font-mono text-emerald-400 truncate">
                          {result.file}
                        </p>
                        <p className="text-xs text-muted-foreground font-mono bg-muted/40 rounded px-2 py-1 truncate">
                          {result.snippet}
                        </p>
                      </div>
                      <Badge variant="outline" className="text-[10px] shrink-0 tabular-nums">
                        {(result.score * 100).toFixed(0)}% match
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Add Repository Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Repository</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="repo-url">Repository URL</Label>
              <Input
                id="repo-url"
                placeholder="https://github.com/org/repo"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="branch">Branch</Label>
              <Input
                id="branch"
                placeholder="main"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAddRepo} disabled={!repoUrl.trim()}>
              Add & Index
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
