// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";

import type { useContextMention } from "~/hooks/useContextMention";
import { cn } from "~/lib/utils";

interface PickerResult {
  label: string;
  value: string;
  meta?: string;
}

const ENDPOINT = { file: "files", symbol: "symbols", web: "web", kb: "kb" } as const;

const KINDS = [
  ["@file:", "Project files"],
  ["@symbol:", "Functions and exports"],
  ["@web:", "A web search"],
  ["@kb:", "A knowledge base"],
] as const;

/** Suggestions for an @-mention, shown above the composer it belongs to. */
export function ContextPicker({
  mention,
  onSelect,
}: {
  mention: ReturnType<typeof useContextMention>;
  onSelect: (label: string, value: string) => void;
}) {
  const [results, setResults] = useState<PickerResult[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = results.length ? Math.min(mention.selectedIndex, results.length - 1) : 0;

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const kind = mention.mentionType;
    if (!kind) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/context/${ENDPOINT[kind]}?q=${encodeURIComponent(mention.query ?? "")}`,
        );
        if (!res.ok) throw new Error("context lookup failed");
        interface Row {
          name?: string;
          title?: string;
          path?: string;
          url?: string;
          kind?: string;
          file?: string;
          domain?: string;
        }
        const data = (await res.json()) as { results?: Row[] } | Row[];
        const rows: (Row | string)[] = Array.isArray(data) ? data : (data.results ?? []);
        setResults(
          rows.slice(0, 8).map((r) =>
            typeof r === "string"
              ? { label: r, value: r }
              : {
                  label: r.name ?? r.title ?? r.path ?? "",
                  value: r.path ?? r.url ?? r.name ?? "",
                  meta: r.kind ?? r.file ?? r.domain,
                },
          ),
        );
      } catch {
        setResults([]);
      }
      setLoading(false);
    }, 150);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [mention.mentionType, mention.query]);

  // Enter or Tab in the composer takes the highlighted row.
  const taken = useRef(mention.commitRequest);
  useEffect(() => {
    if (mention.commitRequest === taken.current) return;
    taken.current = mention.commitRequest;
    const row = results[active];
    if (row) onSelect(row.label, row.value);
  }, [mention.commitRequest, results, active, onSelect]);

  return (
    <div className="absolute bottom-full left-0 z-30 mb-2 w-80 max-w-full overflow-hidden rounded-lg border bg-popover text-sm shadow-lg">
      <div className="flex items-center justify-between border-b px-3 py-1.5 text-xs text-muted-foreground">
        <span>{mention.mentionType ? `Search ${mention.mentionType}` : "Add context"}</span>
        {loading && <span>Searching…</span>}
      </div>
      {!mention.mentionType ? (
        <ul className="p-1">
          {KINDS.map(([cmd, hint]) => (
            <li key={cmd} className="flex gap-3 rounded-md px-2 py-1.5">
              <code className="w-16 shrink-0 text-xs text-primary">{cmd}</code>
              <span className="text-muted-foreground">{hint}</span>
            </li>
          ))}
        </ul>
      ) : results.length === 0 && !loading ? (
        <p className="px-3 py-3 text-muted-foreground">
          {mention.query ? "No matches" : "Type to search"}
        </p>
      ) : (
        <ul className="max-h-64 overflow-y-auto p-1">
          {results.map((r, i) => (
            <li key={r.value + i}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onSelect(r.label, r.value)}
                className={cn(
                  "flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-accent",
                  i === active && "bg-accent",
                )}
              >
                <span className="truncate">{r.label}</span>
                {r.meta && <span className="truncate text-xs text-muted-foreground">{r.meta}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="border-t px-3 py-1 text-[11px] text-muted-foreground">
        ↑↓ move · Enter pick · Esc close
      </p>
    </div>
  );
}
