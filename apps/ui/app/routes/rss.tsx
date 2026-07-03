// SPDX-License-Identifier: Apache-2.0
/**
 * RSS Feeds — subscribe to and read RSS/Atom feeds.
 *
 * Manage feed subscriptions, poll for new items, mark as read,
 * and view feed items in an inbox-style reader.
 *
 * API:
 *   GET    /api/rss/feeds
 *   POST   /api/rss/feeds
 *   DELETE /api/rss/feeds/:id
 *   POST   /api/rss/feeds/:id/poll
 *   GET    /api/rss/feeds/:id/items
 *   PATCH  /api/rss/items/:id/read
 */
import { useState, useEffect, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import {
  Rss,
  Plus,
  Trash2,
  RefreshCw,
  Loader2,
  ExternalLink,
  CheckCheck,
  ChevronRight,
  Circle,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Feed {
  id: string;
  url: string;
  title?: string;
  description?: string;
  lastPolled?: string;
  unreadCount?: number;
  enabled: boolean;
}

interface FeedItem {
  id: string;
  title: string;
  link?: string;
  summary?: string;
  publishedAt?: string;
  read: boolean;
  author?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function RssFeeds() {
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [loadingFeeds, setLoadingFeeds] = useState(true);
  const [selectedFeed, setSelectedFeed] = useState<Feed | null>(null);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);

  // Add feed
  const [newUrl, setNewUrl] = useState("");
  const [adding, setAdding] = useState(false);

  // Polling
  const [polling, setPolling] = useState<string | null>(null);

  // Deleting
  const [deleting, setDeleting] = useState<string | null>(null);

  const [err, setErr] = useState("");

  const loadFeeds = useCallback(async () => {
    setLoadingFeeds(true);
    const r = await fetch("/api/rss/feeds").catch(() => null);
    if (r?.ok) {
      const d = await r.json();
      setFeeds(d.feeds ?? d);
    }
    setLoadingFeeds(false);
  }, []);

  useEffect(() => {
    loadFeeds();
  }, [loadFeeds]);

  const loadItems = useCallback(async (feed: Feed) => {
    setSelectedFeed(feed);
    setLoadingItems(true);
    setItems([]);
    const r = await fetch(`/api/rss/feeds/${feed.id}/items`).catch(() => null);
    if (r?.ok) {
      const d = await r.json();
      setItems(d.items ?? d);
    }
    setLoadingItems(false);
  }, []);

  const addFeed = useCallback(async () => {
    if (!newUrl.trim()) return;
    setAdding(true);
    setErr("");
    const r = await fetch("/api/rss/feeds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: newUrl.trim() }),
    }).catch(() => null);
    if (r?.ok) {
      setNewUrl("");
      loadFeeds();
    } else setErr("Failed to add feed");
    setAdding(false);
  }, [newUrl, loadFeeds]);

  const pollFeed = useCallback(
    async (feedId: string) => {
      setPolling(feedId);
      const r = await fetch(`/api/rss/feeds/${feedId}/poll`, { method: "POST" }).catch(() => null);
      if (r?.ok) {
        loadFeeds();
        if (selectedFeed?.id === feedId) loadItems(selectedFeed);
      }
      setPolling(null);
    },
    [selectedFeed, loadFeeds, loadItems],
  );

  const deleteFeed = useCallback(
    async (id: string) => {
      if (!confirm("Remove this feed?")) return;
      setDeleting(id);
      await fetch(`/api/rss/feeds/${id}`, { method: "DELETE" }).catch(() => {});
      setFeeds((prev) => prev.filter((f) => f.id !== id));
      if (selectedFeed?.id === id) {
        setSelectedFeed(null);
        setItems([]);
      }
      setDeleting(null);
    },
    [selectedFeed],
  );

  const markRead = useCallback(
    async (itemId: string) => {
      await fetch(`/api/rss/items/${itemId}/read`, { method: "PATCH" }).catch(() => {});
      setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, read: true } : i)));
      if (selectedFeed) {
        setFeeds((prev) =>
          prev.map((f) =>
            f.id === selectedFeed.id
              ? { ...f, unreadCount: Math.max(0, (f.unreadCount ?? 0) - 1) }
              : f,
          ),
        );
      }
    },
    [selectedFeed],
  );

  const totalUnread = feeds.reduce((sum, f) => sum + (f.unreadCount ?? 0), 0);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Rss className="w-6 h-6 text-orange-500" />
            RSS Feeds
            {totalUnread > 0 && (
              <Badge className="bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400">
                {totalUnread} unread
              </Badge>
            )}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Subscribe to RSS/Atom feeds and read items inline
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={loadFeeds}>
          <RefreshCw className={`w-4 h-4 ${loadingFeeds ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Add feed */}
      <div className="flex gap-2">
        <Input
          placeholder="https://example.com/feed.xml"
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addFeed()}
          className="flex-1"
        />
        <Button onClick={addFeed} disabled={adding || !newUrl.trim()}>
          {adding ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Plus className="w-4 h-4 mr-1" />
          )}
          {adding ? "" : "Subscribe"}
        </Button>
      </div>
      {err && <p className="text-red-500 text-xs">{err}</p>}

      <div className="grid md:grid-cols-3 gap-4">
        {/* Feed list */}
        <div className="space-y-2 md:col-span-1">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Feeds ({feeds.length})
          </h2>
          {loadingFeeds ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm py-4">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading…
            </div>
          ) : feeds.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">No feeds yet. Add one above.</p>
          ) : (
            feeds.map((feed) => (
              <div
                key={feed.id}
                className={`border rounded-lg p-3 cursor-pointer transition-colors hover:bg-muted/50 ${selectedFeed?.id === feed.id ? "bg-muted border-primary/30" : ""}`}
                onClick={() => loadItems(feed)}
              >
                <div className="flex items-start justify-between gap-1">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{feed.title ?? feed.url}</p>
                    <p className="text-xs text-muted-foreground truncate">{feed.url}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {(feed.unreadCount ?? 0) > 0 && (
                      <Badge className="text-xs bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400">
                        {feed.unreadCount}
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 mt-1.5">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 text-muted-foreground hover:text-foreground"
                    onClick={(e) => {
                      e.stopPropagation();
                      pollFeed(feed.id);
                    }}
                    disabled={polling === feed.id}
                  >
                    <RefreshCw className={`w-3 h-3 ${polling === feed.id ? "animate-spin" : ""}`} />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 text-red-400 hover:bg-red-50"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteFeed(feed.id);
                    }}
                    disabled={deleting === feed.id}
                  >
                    {deleting === feed.id ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Trash2 className="w-3 h-3" />
                    )}
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Items */}
        <div className="md:col-span-2 space-y-2">
          {!selectedFeed ? (
            <div className="flex items-center justify-center h-48 text-muted-foreground border rounded-lg border-dashed">
              <div className="text-center">
                <Rss className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p className="text-sm">Select a feed to read items</p>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">{selectedFeed.title ?? selectedFeed.url}</h2>
                {items.some((i) => !i.read) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs h-7"
                    onClick={() => items.filter((i) => !i.read).forEach((i) => markRead(i.id))}
                  >
                    <CheckCheck className="w-3 h-3 mr-1" />
                    Mark all read
                  </Button>
                )}
              </div>
              {loadingItems ? (
                <div className="flex items-center gap-2 text-muted-foreground text-sm py-8 justify-center">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading items…
                </div>
              ) : items.length === 0 ? (
                <Card>
                  <CardContent className="pt-8 pb-8 text-center text-muted-foreground">
                    No items in this feed
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-1.5 max-h-[600px] overflow-y-auto pr-1">
                  {items.map((item) => (
                    <div
                      key={item.id}
                      className={`border rounded-lg p-3 cursor-pointer transition-colors hover:bg-muted/50 ${item.read ? "opacity-60" : ""}`}
                      onClick={() => !item.read && markRead(item.id)}
                    >
                      <div className="flex items-start gap-2">
                        {!item.read && (
                          <Circle className="w-2 h-2 text-orange-500 shrink-0 mt-1.5 fill-current" />
                        )}
                        {item.read && <div className="w-2 h-2 shrink-0 mt-1.5" />}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <p className={`text-sm ${!item.read ? "font-medium" : ""} flex-1`}>
                              {item.title}
                            </p>
                            {item.link && (
                              <a
                                href={item.link}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-muted-foreground hover:text-foreground shrink-0"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                              </a>
                            )}
                          </div>
                          {item.summary && (
                            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                              {item.summary}
                            </p>
                          )}
                          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                            {item.author && <span>{item.author}</span>}
                            {item.publishedAt && (
                              <span>{new Date(item.publishedAt).toLocaleDateString()}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
