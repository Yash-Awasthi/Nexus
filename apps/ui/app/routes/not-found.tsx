// SPDX-License-Identifier: Apache-2.0
/**
 * The page for a URL the app does not know.
 *
 * This is a route rather than the root `ErrorBoundary`, and that is the point: a boundary replaces
 * the whole document, so visiting a mistyped URL used to swap out the shell and hydrate against
 * markup that was not there (React #418, then a full re-render). A splat route renders *inside* the
 * app like every other page, so the sidebar stays, the navigation still works, and the URL is a
 * 404 rather than a crash.
 *
 * The root `ErrorBoundary` is still the right place for a page that throws — that is an error, not
 * a missing page.
 */
import { Compass } from "lucide-react";
import { Link, useLocation } from "react-router";

import { Button } from "~/components/ui/button";
import { allNavItems } from "~/lib/nav";

export default function NotFound() {
  const { pathname } = useLocation();
  // Offer the pages that exist rather than a dead end: the most common reason for a 404 here is a
  // bookmark from before a route was renamed.
  const suggestions = allNavItems().slice(0, 4);

  return (
    <div className="mx-auto flex max-w-lg flex-col items-center justify-center gap-5 py-24 text-center">
      <div className="flex size-16 items-center justify-center rounded-2xl bg-muted">
        <Compass className="size-7 text-muted-foreground" aria-hidden="true" />
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">404</p>
        <h1 className="text-2xl font-semibold tracking-tight">This page does not exist</h1>
        <p className="text-sm text-muted-foreground">
          Nothing is mapped to{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{pathname}</code>. It may have
          been renamed, or the link may be out of date.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button asChild>
          <Link to="/dashboard">Go home</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link to="/search">Search everything</Link>
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        {suggestions.map((item) => (
          <Link key={item.to} to={item.to} className="underline-offset-4 hover:underline">
            {item.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
