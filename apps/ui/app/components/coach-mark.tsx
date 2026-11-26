// SPDX-License-Identifier: Apache-2.0
/**
 * The coach mark as rendered: a quiet card under the page header that says one thing once.
 *
 * It renders nothing when the page has no hint or this user dismissed it, so a page can drop
 * `<CoachMark page="/knowledge" />` in unconditionally and forget about it.
 */
import { Lightbulb, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { useAuth } from "~/context/AuthContext";
import { dismissCoachMark, pendingCoachMark, type CoachMark } from "~/lib/coach-marks";

export function CoachMark({ page }: { page: string }) {
  const { user } = useAuth();
  const [mark, setMark] = useState<CoachMark | null>(null);

  // Read storage after mount: the renderer has no localStorage during SSR, and reading it in a
  // lazy initialiser would crash the first paint of the route.
  useEffect(() => {
    if (typeof window === "undefined") return;
    setMark(pendingCoachMark(page, user?.id, window.localStorage) ?? null);
  }, [page, user?.id]);

  if (!mark) return null;

  const dismiss = () => {
    dismissCoachMark(page, user?.id, window.localStorage);
    setMark(null);
  };

  return (
    <div
      role="note"
      aria-label={mark.title}
      className="flex gap-3 rounded-lg border border-dashed bg-muted/40 p-3 text-sm print:hidden"
    >
      <Lightbulb className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden="true" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">{mark.title}</p>
        <p className="text-muted-foreground">{mark.body}</p>
      </div>
      <div className="ml-auto flex items-start gap-1">
        {mark.action && (
          <Button size="sm" variant="outline" onClick={dismiss} className="hidden sm:inline-flex">
            {mark.action}
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          onClick={dismiss}
          aria-label={`Dismiss hint: ${mark.title}`}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
