// SPDX-License-Identifier: Apache-2.0
/**
 * One keyboard entry point to the whole app: pages, actions, and the things you made
 * (sessions, deliberations, workflows, knowledge bases) in one ranked list.
 *
 * Three keys, and the reason each one exists:
 *   ⌘K / Ctrl+K  open it from anywhere — the universal "do something" gesture
 *   ↑ ↓ ↵        move and run, without reaching for the mouse
 *   Esc          leave without running anything
 *
 * The list is computed, never stored: pages come from the shared nav registry, actions from
 * the small table below, and "things you made" from `GET /api/v1/search` — debounced, and
 * only once the query is long enough to be worth a request. An empty query shows pages and
 * actions, because that is what a person looking for a page types first.
 *
 * Matching is a scored substring — the whole label, then the start of it, then anywhere in it
 * or in the words a page added for search — not a fuzzy match. At forty entries, fuzzy
 * matching returns more surprises than conveniences ("run" should find Workflows, not
 * Sandbox).
 */
import {
  ArrowRight,
  BookOpen,
  CornerDownLeft,
  GitFork,
  Loader2,
  MessageSquare,
  Moon,
  Plus,
  Search as SearchIcon,
  Sun,
  Terminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { Dialog, DialogContent, DialogTitle } from "~/components/ui/dialog";
import { useAuth } from "~/context/AuthContext";
import { useTheme } from "~/context/ThemeContext";
import { apiFetch } from "~/lib/api";
import { useLocalPlane } from "~/lib/local-plane";
import { allNavItems } from "~/lib/nav";
import { cn } from "~/lib/utils";

type CommandKind = "page" | "action" | "result";

interface Command {
  id: string;
  kind: CommandKind;
  label: string;
  hint?: string;
  /** What the palette matches on, lowercased once. */
  haystack: string;
  icon: React.ElementType;
  run: () => void;
}

interface SearchResult {
  type: string;
  id: string;
  title: string;
  snippet: string;
  link: string;
}

const KIND_LABEL: Record<CommandKind, string> = {
  page: "Pages",
  action: "Actions",
  result: "Your work",
};

/**
 * Score one command against a lowercased query; 0 means it does not match.
 *
 * Three tiers, because that is how many a substring search can honestly distinguish:
 * the whole label, the start of it, anywhere in it (or in the words the page added for
 * search). A "starts a word inside the label" tier would sit between the last two and score
 * exactly the same as the last one — every word-start is also a substring — so it is not here.
 */
export function scoreCommand(command: { label: string; haystack: string }, query: string): number {
  if (!query) return 1;
  const label = command.label.toLowerCase();
  if (label === query) return 100;
  if (label.startsWith(query)) return 80;
  if (label.includes(query)) return 60;
  if (command.haystack.includes(query)) return 30;
  return 0;
}

const RESULT_ICON: Record<string, React.ElementType> = {
  session: MessageSquare,
  discussion: MessageSquare,
  workflow: GitFork,
  knowledge_base: BookOpen,
  document: BookOpen,
  graph_node: SearchIcon,
};

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const { user, logout } = useAuth();
  const local = useLocalPlane() === true;
  const isAdmin = user?.role === "admin" || user?.role === "owner";

  const go = useCallback(
    (to: string) => {
      setOpen(false);
      setQuery("");
      navigate(to);
    },
    [navigate],
  );

  const pages = useMemo<Command[]>(
    () =>
      allNavItems()
        .filter((item) => !item.admin || isAdmin)
        // Terminals spawn host processes; the API refuses them off a local install, so the
        // palette must not offer a page that would answer 403.
        .filter((item) => item.requires !== "terminal" || local)
        .map((item) => ({
          id: `page:${item.to}`,
          kind: "page",
          label: item.label,
          hint: item.group,
          haystack: [item.label, item.group, item.to, ...(item.keywords ?? [])]
            .join(" ")
            .toLowerCase(),
          icon: item.icon,
          run: () => go(item.to),
        })),
    [go, isAdmin, local],
  );

  const actions = useMemo<Command[]>(() => {
    const list: Command[] = [
      {
        id: "action:new-session",
        kind: "action",
        label: "New deliberation",
        hint: "Council",
        haystack: "new session chat deliberation ask start",
        icon: Plus,
        run: () => go("/chat"),
      },
      {
        id: "action:theme",
        kind: "action",
        label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
        hint: "Appearance",
        haystack: "theme dark light appearance toggle",
        icon: theme === "dark" ? Sun : Moon,
        run: () => {
          toggleTheme();
          setOpen(false);
        },
      },
      {
        id: "action:search",
        kind: "action",
        label: "Search documents and the web",
        hint: "Retrieval",
        haystack: "search documents web knowledge retrieve",
        icon: SearchIcon,
        run: () => go("/search"),
      },
    ];
    if (local) {
      list.push({
        id: "action:sandbox",
        kind: "action",
        label: "Open the sandbox",
        hint: "Code",
        haystack: "sandbox code execute run shell",
        icon: Terminal,
        run: () => go("/sandbox"),
      });
    }
    list.push({
      id: "action:sign-out",
      kind: "action",
      label: "Sign out",
      hint: "Account",
      haystack: "sign out logout leave account",
      icon: CornerDownLeft,
      run: () => {
        setOpen(false);
        logout();
      },
    });
    return list;
  }, [go, local, logout, theme, toggleTheme]);

  const resultCommands = useMemo<Command[]>(
    () =>
      results.map((result) => ({
        id: `result:${result.type}:${result.id}`,
        kind: "result",
        label: result.title,
        hint: result.type.replace(/_/g, " "),
        haystack: `${result.title} ${result.snippet} ${result.type}`.toLowerCase(),
        icon: RESULT_ICON[result.type] ?? SearchIcon,
        run: () => go(result.link),
      })),
    [go, results],
  );

  const commands = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const scored = [...pages, ...actions, ...resultCommands]
      .map((command) => ({ command, score: scoreCommand(command, needle) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.command.label.localeCompare(b.command.label));
    // Grouped in the order kind matters: what you typed, then where to go, then what to do.
    const order: CommandKind[] = needle ? ["result", "page", "action"] : ["page", "action"];
    return order.flatMap((kind) =>
      scored.filter((entry) => entry.command.kind === kind).map((entry) => entry.command),
    );
  }, [actions, pages, query, resultCommands]);

  // ⌘K / Ctrl+K toggles from anywhere, including inside an input: an escape hatch that does
  // not work while typing is an escape hatch you cannot reach.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((wasOpen) => !wasOpen);
        return;
      }
      if (event.key === "Escape" && open) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (open) {
      setCursor(0);
      // Focus after the dialog mounts, or the browser puts the caret behind it.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Search the account's own stores, debounced: one request per pause, not per keystroke.
  useEffect(() => {
    const needle = query.trim();
    if (!open || needle.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      void apiFetch<{ results?: SearchResult[] }>(
        `/api/v1/search?q=${encodeURIComponent(needle)}&limit=8`,
      )
        .then((payload) => {
          if (!cancelled) setResults(payload.results ?? []);
        })
        .catch(() => {
          // A palette that shows an error instead of your pages is worse than one that shows
          // only your pages: the failure is silent here and visible on /search itself.
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query]);

  // Keep the highlighted row inside the scroll box as the cursor moves.
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const runAt = (index: number) => {
    const command = commands[index];
    if (command) command.run();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((current) => (commands.length ? (current + 1) % commands.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((current) =>
        commands.length ? (current - 1 + commands.length) % commands.length : 0,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      runAt(cursor);
    } else if (event.key === "Tab") {
      // Tab completes to the highlighted label instead of leaving the box: the palette is
      // keyboard-first, and Tab is the key a keyboard-first user reaches for next.
      event.preventDefault();
      const command = commands[cursor];
      if (command) setQuery(command.label);
    }
  };

  let lastGroup: string | null = null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="top-[15%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0 sm:top-[20%]"
        showCloseButton={false}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <div className="flex items-center gap-2 border-b px-3">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search pages, actions and your work…"
            aria-label="Command palette"
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {searching && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />}
          <kbd className="hidden shrink-0 rounded border px-1.5 py-0.5 text-3xs text-muted-foreground sm:block">
            esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[min(60vh,26rem)] overflow-y-auto py-1">
          {commands.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {query.trim().length >= 2
                ? `Nothing matches “${query.trim()}”.`
                : "Type to search, or pick a page."}
            </p>
          ) : (
            commands.map((command, index) => {
              const groupLabel = KIND_LABEL[command.kind];
              const showsGroup = groupLabel !== lastGroup;
              lastGroup = groupLabel;
              return (
                <div key={command.id}>
                  {showsGroup && (
                    <p className="px-3 pt-2 pb-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                      {groupLabel}
                    </p>
                  )}
                  <button
                    type="button"
                    data-active={index === cursor}
                    onMouseMove={() => setCursor(index)}
                    onClick={() => command.run()}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm",
                      index === cursor ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                    )}
                  >
                    <command.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{command.label}</span>
                    {command.hint && (
                      <span className="shrink-0 text-xs text-muted-foreground">{command.hint}</span>
                    )}
                    {index === cursor && (
                      <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between border-t px-3 py-1.5 text-2xs text-muted-foreground">
          <span className="flex items-center gap-3">
            <span>↑↓ move</span>
            <span>↵ open</span>
            <span className="hidden sm:inline">tab complete</span>
          </span>
          <a href="/settings" className="hover:text-foreground">
            Shortcuts
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
