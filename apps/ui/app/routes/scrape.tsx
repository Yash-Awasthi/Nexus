// SPDX-License-Identifier: Apache-2.0
/**
 * Web Scraping — URL scraping, website crawling, and Exa semantic search.
 *
 * Powered by Firecrawl (scrape/crawl) and Exa (semantic search + content extraction).
 *
 * API:
 *   GET  /api/web-scraping/providers   — list available providers
 *   POST /api/web-scraping/scrape      — scrape a single URL
 *   POST /api/web-scraping/crawl       — crawl a website
 *   POST /api/web-scraping/exa/search  — Exa semantic search
 *   POST /api/web-scraping/exa/contents — Exa content extraction
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Globe,
  Loader2,
  Search,
  Bug,
  FileText,
  ExternalLink,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  X,
  Layers,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScrapeResult {
  url: string;
  title?: string;
  content: string;
  markdown?: string;
  html?: string;
  metadata?: Record<string, unknown>;
  success: boolean;
  error?: string;
}

interface CrawlResult {
  url: string;
  pages: ScrapeResult[];
  totalPages: number;
  success: boolean;
  error?: string;
}

interface ExaResult {
  title: string;
  url: string;
  snippet?: string;
  content?: string;
  publishedDate?: string;
  score?: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Scrape() {
  const [tab, setTab] = useState<"scrape" | "crawl" | "exa">("scrape");
  const [providers, setProviders] = useState<string[]>([]);

  // Scrape
  const [scrapeUrl, setScrapeUrl] = useState("");
  const [scrapeFormat, setScrapeFormat] = useState<"markdown" | "html" | "text">("markdown");
  const [scraping, setScraping] = useState(false);
  const [scrapeResult, setScrapeResult] = useState<ScrapeResult | null>(null);
  const [expandedContent, setExpandedContent] = useState(false);
  const [copied, setCopied] = useState(false);

  // Crawl
  const [crawlUrl, setCrawlUrl] = useState("");
  const [maxPages, setMaxPages] = useState("10");
  const [crawling, setCrawling] = useState(false);
  const [crawlResult, setCrawlResult] = useState<CrawlResult | null>(null);
  const [selectedPage, setSelectedPage] = useState<ScrapeResult | null>(null);

  // Exa
  const [exaQuery, setExaQuery] = useState("");
  const [exaType, setExaType] = useState<"search" | "contents">("search");
  const [exaSearching, setExaSearching] = useState(false);
  const [exaResults, setExaResults] = useState<ExaResult[]>([]);
  const [exaUrls, setExaUrls] = useState("");

  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/web-scraping/providers")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        const raw: unknown[] = Array.isArray(d.providers) ? d.providers : [];
        setProviders(
          raw
            .map((p) =>
              typeof p === "string"
                ? p
                : (((p as Record<string, unknown>).name ??
                    (p as Record<string, unknown>).id ??
                    "") as string),
            )
            .filter(Boolean),
        );
      })
      .catch(() => {});
  }, []);

  const handleScrape = useCallback(async () => {
    const url = scrapeUrl.trim();
    if (!url) return;
    setScraping(true);
    setErr("");
    setScrapeResult(null);
    try {
      const r = await fetch("/api/web-scraping/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, format: scrapeFormat }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setErr(d.error ?? "Scrape failed");
        return;
      }
      const raw = await r.json();
      // Normalize backend shape {text, status, html, ...} → frontend ScrapeResult
      setScrapeResult({
        url: raw.url ?? url,
        title: raw.title ?? raw.metadata?.title ?? "",
        content: raw.content ?? raw.text ?? raw.markdown ?? "",
        markdown: raw.markdown ?? raw.text ?? "",
        html: raw.html ?? "",
        metadata: raw.metadata ?? { statusCode: raw.statusCode, engine: raw.engine },
        success: raw.success ?? (raw.status !== "error" && raw.status !== "failed"),
        error: raw.error,
      });
    } catch {
      setErr("Scrape failed");
    } finally {
      setScraping(false);
    }
  }, [scrapeUrl, scrapeFormat]);

  const handleCrawl = useCallback(async () => {
    const url = crawlUrl.trim();
    if (!url) return;
    setCrawling(true);
    setErr("");
    setCrawlResult(null);
    setSelectedPage(null);
    try {
      const r = await fetch("/api/web-scraping/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, maxPages: parseInt(maxPages) || 10 }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setErr(d.error ?? "Crawl failed");
        return;
      }
      const raw = await r.json();
      // Normalize: backend returns {pages, total} but interface expects {pages, totalPages}
      setCrawlResult({
        url: raw.url ?? url,
        pages: (raw.pages ?? []).map((p: Record<string, unknown>) => ({
          url: p.url ?? "",
          title: String(p.title ?? ""),
          content: String(p.content ?? p.text ?? ""),
          markdown: String(p.markdown ?? p.text ?? ""),
          success: p.success ?? p.status !== "error",
        })),
        totalPages: raw.totalPages ?? raw.total ?? (raw.pages ?? []).length,
        success: raw.success ?? true,
      });
    } catch {
      setErr("Crawl failed");
    } finally {
      setCrawling(false);
    }
  }, [crawlUrl, maxPages]);

  const handleExaSearch = useCallback(async () => {
    if (!exaQuery.trim() && !exaUrls.trim()) return;
    setExaSearching(true);
    setErr("");
    setExaResults([]);
    try {
      const endpoint =
        exaType === "search" ? "/api/web-scraping/exa/search" : "/api/web-scraping/exa/contents";
      const body =
        exaType === "search"
          ? { query: exaQuery.trim(), numResults: 10 }
          : {
              urls: exaUrls
                .split("\n")
                .map((u) => u.trim())
                .filter(Boolean),
            };
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setErr(d.error ?? "Exa request failed");
        return;
      }
      const d = await r.json();
      setExaResults(d.results ?? d);
    } catch {
      setErr("Exa request failed");
    } finally {
      setExaSearching(false);
    }
  }, [exaQuery, exaType, exaUrls]);

  const copyContent = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  const content = scrapeResult?.markdown || scrapeResult?.content || "";

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Bug className="w-6 h-6 text-orange-500" />
            Web Scraping
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Extract content from any URL, crawl websites, or run semantic search via Exa
            {providers.length > 0 && (
              <span className="ml-2">
                · <span className="font-medium">{providers.join(", ")}</span> available
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-1">
          {(["scrape", "crawl", "exa"] as const).map((t) => (
            <Button
              key={t}
              size="sm"
              variant={tab === t ? "default" : "outline"}
              onClick={() => setTab(t)}
              className="capitalize"
            >
              {t}
            </Button>
          ))}
        </div>
      </div>

      {err && (
        <p className="text-red-500 text-sm flex items-center gap-2">
          <X className="w-4 h-4 shrink-0" />
          {err}
        </p>
      )}

      {/* ── Scrape Tab ── */}
      {tab === "scrape" && (
        <div className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="https://example.com/article"
              value={scrapeUrl}
              onChange={(e) => setScrapeUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleScrape()}
              className="flex-1"
            />
            <Select value={scrapeFormat} onValueChange={(v) => setScrapeFormat(v as any)}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="markdown">Markdown</SelectItem>
                <SelectItem value="text">Plain text</SelectItem>
                <SelectItem value="html">HTML</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={handleScrape} disabled={scraping || !scrapeUrl.trim()}>
              {scraping ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Globe className="w-4 h-4" />
              )}
            </Button>
          </div>

          {scrapeResult && (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-sm line-clamp-1">
                      {scrapeResult.title ?? scrapeResult.url}
                    </CardTitle>
                    <a
                      href={scrapeResult.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-500 hover:underline"
                    >
                      {scrapeResult.url}
                    </a>
                  </div>
                  <div className="flex gap-2">
                    <Badge
                      variant={scrapeResult.success ? "default" : "destructive"}
                      className="text-xs"
                    >
                      {scrapeResult.success ? "OK" : "Error"}
                    </Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => copyContent(content)}
                    >
                      {copied ? (
                        <Check className="w-3 h-3 mr-1 text-green-500" />
                      ) : (
                        <Copy className="w-3 h-3 mr-1" />
                      )}
                      Copy
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {scrapeResult.error ? (
                  <p className="text-sm text-red-500">{scrapeResult.error}</p>
                ) : (
                  <div>
                    <pre
                      className={`text-xs font-mono whitespace-pre-wrap overflow-auto bg-muted/50 rounded p-3 ${
                        expandedContent ? "" : "max-h-80"
                      }`}
                    >
                      {content.slice(0, expandedContent ? undefined : 3000)}
                      {!expandedContent && content.length > 3000 && "…"}
                    </pre>
                    {content.length > 3000 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mt-2 w-full text-xs"
                        onClick={() => setExpandedContent(!expandedContent)}
                      >
                        {expandedContent ? (
                          <>
                            <ChevronUp className="w-3 h-3 mr-1" />
                            Show less
                          </>
                        ) : (
                          <>
                            <ChevronDown className="w-3 h-3 mr-1" />
                            Show all ({Math.round(content.length / 1000)}K chars)
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ── Crawl Tab ── */}
      {tab === "crawl" && (
        <div className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="https://docs.example.com"
              value={crawlUrl}
              onChange={(e) => setCrawlUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCrawl()}
              className="flex-1"
            />
            <Select value={maxPages} onValueChange={setMaxPages}>
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["5", "10", "25", "50"].map((n) => (
                  <SelectItem key={n} value={n}>
                    {n} pages
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={handleCrawl} disabled={crawling || !crawlUrl.trim()}>
              {crawling ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-1" />
                  Crawling…
                </>
              ) : (
                <>
                  <Layers className="w-4 h-4 mr-1" />
                  Crawl
                </>
              )}
            </Button>
          </div>

          {crawlResult && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Page list */}
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {crawlResult.totalPages} pages crawled
                </p>
                <div className="max-h-96 overflow-y-auto space-y-1">
                  {crawlResult.pages.map((page, i) => (
                    <button
                      key={i}
                      className={`w-full text-left text-xs p-2 rounded-md hover:bg-accent transition-colors flex items-center gap-2 ${
                        selectedPage === page ? "bg-accent" : ""
                      }`}
                      onClick={() => setSelectedPage(page)}
                    >
                      <FileText className="w-3 h-3 shrink-0 text-muted-foreground" />
                      <span className="truncate">
                        {page.title ?? page.url.replace(/https?:\/\//, "")}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Page content */}
              <div className="lg:col-span-2">
                {selectedPage ? (
                  <Card>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <div>
                          <CardTitle className="text-sm">
                            {selectedPage.title ?? selectedPage.url}
                          </CardTitle>
                          <a
                            href={selectedPage.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-500 hover:underline"
                          >
                            {selectedPage.url}
                          </a>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7"
                          onClick={() =>
                            copyContent(selectedPage.markdown ?? selectedPage.content ?? "")
                          }
                        >
                          <Copy className="w-3 h-3" />
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <pre className="text-xs font-mono whitespace-pre-wrap overflow-auto bg-muted/50 rounded p-3 max-h-80">
                        {(selectedPage.markdown ?? selectedPage.content ?? "").slice(0, 3000)}
                      </pre>
                    </CardContent>
                  </Card>
                ) : (
                  <div className="h-64 border-2 border-dashed rounded-lg flex items-center justify-center text-muted-foreground">
                    Select a page to view content
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Exa Tab ── */}
      {tab === "exa" && (
        <div className="space-y-4">
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={exaType === "search" ? "default" : "outline"}
              onClick={() => setExaType("search")}
            >
              Semantic search
            </Button>
            <Button
              size="sm"
              variant={exaType === "contents" ? "default" : "outline"}
              onClick={() => setExaType("contents")}
            >
              Extract content
            </Button>
          </div>

          {exaType === "search" ? (
            <div className="flex gap-2">
              <Input
                placeholder="Latest AI research on reasoning models…"
                value={exaQuery}
                onChange={(e) => setExaQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleExaSearch()}
                className="flex-1"
              />
              <Button onClick={handleExaSearch} disabled={exaSearching || !exaQuery.trim()}>
                {exaSearching ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Search className="w-4 h-4" />
                )}
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <Textarea
                placeholder="https://example.com/article&#10;https://another.com/page"
                value={exaUrls}
                onChange={(e) => setExaUrls(e.target.value)}
                rows={4}
                className="font-mono text-sm resize-none"
              />
              <Button
                onClick={handleExaSearch}
                disabled={exaSearching || !exaUrls.trim()}
                className="w-full"
              >
                {exaSearching ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    Extracting…
                  </>
                ) : (
                  <>
                    <FileText className="w-4 h-4 mr-2" />
                    Extract content
                  </>
                )}
              </Button>
            </div>
          )}

          {exaResults.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">{exaResults.length} results</p>
              {exaResults.map((r, i) => (
                <Card key={i}>
                  <CardContent className="pt-3 pb-3">
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <a
                          href={r.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm font-medium text-blue-600 hover:underline"
                        >
                          {r.title}
                        </a>
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">{r.url}</p>
                        {r.snippet && (
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-3">
                            {r.snippet}
                          </p>
                        )}
                        {r.content && (
                          <pre className="text-xs font-mono mt-2 bg-muted/50 rounded p-2 max-h-32 overflow-auto whitespace-pre-wrap">
                            {r.content.slice(0, 1000)}
                          </pre>
                        )}
                      </div>
                      <div className="shrink-0 flex flex-col items-end gap-1">
                        {r.score !== undefined && (
                          <Badge variant="outline" className="text-xs">
                            {r.score.toFixed(3)}
                          </Badge>
                        )}
                        {r.publishedDate && (
                          <span className="text-xs text-muted-foreground">
                            {new Date(r.publishedDate).toLocaleDateString()}
                          </span>
                        )}
                        <a href={r.url} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="w-3 h-3 text-muted-foreground hover:text-foreground" />
                        </a>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {!exaSearching && exaResults.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <Search className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">
                {exaType === "search"
                  ? "Enter a semantic search query to find relevant web pages"
                  : "Paste URLs to extract their full content"}
              </p>
              {providers.length === 0 && (
                <p className="text-xs mt-2">Configure EXA_API_KEY in .env to enable Exa</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
