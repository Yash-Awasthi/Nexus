/**
 * Web Search — live search across the web with provider selection.
 *
 * API:
 *   GET  /api/web-search/providers — list configured search providers
 *   POST /api/web-search           — execute a web search
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Search,
  Loader2,
  ExternalLink,
  Globe,
  Clock,
  ChevronRight,
  RefreshCw,
  X,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
  source?: string;
}

interface SearchResponse {
  query: string;
  provider: string;
  results: SearchResult[];
  totalResults?: number;
  searchTime?: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function WebSearch() {
  const [query, setQuery] = useState("");
  const [providers, setProviders] = useState<string[]>([]);
  const [preferred, setPreferred] = useState<string>("");
  const [selectedProvider, setSelectedProvider] = useState<string>("auto");
  const [maxResults, setMaxResults] = useState(10);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [history, setHistory] = useState<SearchResponse[]>([]);
  const [err, setErr] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/web-search/providers")
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d) {
          setProviders(d.providers ?? []);
          setPreferred(d.preferred ?? "");
        }
      })
      .catch(() => {});
    inputRef.current?.focus();
  }, []);

  const handleSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setErr("");
    try {
      const r = await fetch("/api/web-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: q,
          provider: selectedProvider === "auto" ? undefined : selectedProvider,
          maxResults,
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setErr(d.error ?? "Search failed");
        return;
      }
      const data: SearchResponse = await r.json();
      setResults(data);
      setHistory(prev => [data, ...prev.filter(h => h.query !== q)].slice(0, 10));
    } catch {
      setErr("Search failed");
    } finally {
      setLoading(false);
    }
  }, [query, selectedProvider, maxResults]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSearch();
  };

  function timeAgo(d?: string) {
    if (!d) return "";
    const diff = Date.now() - new Date(d).getTime();
    const days = Math.floor(diff / 86400000);
    if (days === 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return `${days}d ago`;
    return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Globe className="w-6 h-6 text-sky-500" />
          Web Search
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Live search via {providers.length > 0 ? providers.join(", ") : "configured providers"}
          {preferred && <span> · preferred: <span className="font-medium">{preferred}</span></span>}
        </p>
      </div>

      {/* Search bar */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            ref={inputRef}
            className="pl-9 pr-9"
            placeholder="Search the web…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {query && (
            <button
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setQuery("")}
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {providers.length > 1 && (
          <Select value={selectedProvider} onValueChange={setSelectedProvider}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto</SelectItem>
              {providers.map(p => (
                <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Select value={String(maxResults)} onValueChange={v => setMaxResults(Number(v))}>
          <SelectTrigger className="w-20">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[5, 10, 20, 30].map(n => (
              <SelectItem key={n} value={String(n)}>{n}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button onClick={handleSearch} disabled={loading || !query.trim()}>
          {loading
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : <Search className="w-4 h-4" />}
        </Button>
      </div>

      {err && (
        <p className="text-red-500 text-sm flex items-center gap-2">
          <X className="w-4 h-4" />
          {err}
        </p>
      )}

      {/* Results */}
      {results && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">"{results.query}"</span>
            {results.totalResults !== undefined && <span>{results.totalResults.toLocaleString()} results</span>}
            {results.searchTime !== undefined && (
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {(results.searchTime / 1000).toFixed(2)}s
              </span>
            )}
            <span className="capitalize ml-auto">via {results.provider}</span>
          </div>

          {results.results.length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-8">No results found</p>
          ) : (
            <div className="space-y-2">
              {results.results.map((r, i) => (
                <Card key={i} className="hover:bg-accent/30 transition-colors">
                  <CardContent className="pt-3 pb-3">
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group block"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-blue-600 dark:text-blue-400 group-hover:underline truncate">
                            {r.title}
                          </p>
                          <p className="text-xs text-green-700 dark:text-green-500 mt-0.5 truncate">
                            {r.url}
                          </p>
                          {r.snippet && (
                            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                              {r.snippet}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {r.publishedAt && (
                            <span className="text-xs text-muted-foreground">{timeAgo(r.publishedAt)}</span>
                          )}
                          {r.source && (
                            <Badge variant="outline" className="text-xs">{r.source}</Badge>
                          )}
                          <ExternalLink className="w-3 h-3 text-muted-foreground group-hover:text-foreground" />
                        </div>
                      </div>
                    </a>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Recent searches */}
      {!results && history.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Recent searches</p>
          {history.slice(0, 5).map((h, i) => (
            <button
              key={i}
              className="w-full text-left flex items-center gap-2 text-sm px-3 py-2 rounded-lg hover:bg-accent transition-colors"
              onClick={() => { setQuery(h.query); setResults(h); }}
            >
              <Clock className="w-3 h-3 text-muted-foreground shrink-0" />
              <span className="flex-1">{h.query}</span>
              <span className="text-xs text-muted-foreground">{h.results.length} results</span>
              <ChevronRight className="w-3 h-3 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!results && history.length === 0 && !loading && (
        <div className="text-center py-16 text-muted-foreground">
          <Globe className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Enter a query and press Enter or Search</p>
          {providers.length === 0 && (
            <p className="text-xs mt-2">
              Configure a search provider in .env (BRAVE_SEARCH_API_KEY, SERP_API_KEY, etc.)
            </p>
          )}
        </div>
      )}
    </div>
  );
}
