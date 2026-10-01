// SPDX-License-Identifier: Apache-2.0
import { Link, Outlet, useLocation } from "react-router";

import { NexusMark } from "~/components/brand";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export default function MarketingLayout() {
  // The home page is a dark stage for the 3D scene whatever theme the app is in.
  const home = useLocation().pathname === "/";
  return (
    <div className={cn("flex min-h-svh flex-col bg-background text-foreground", home && "dark")}>
      <header
        className={cn(
          "sticky top-0 z-40 border-b backdrop-blur",
          home ? "border-white/10 bg-background/35" : "bg-background/80",
        )}
      >
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2">
            <NexusMark className="size-7" />
            <span className="font-semibold tracking-tight">Nexus</span>
          </Link>
          <nav className="hidden items-center gap-5 text-sm text-muted-foreground md:flex">
            <a href="/#seat" className="hover:text-foreground">
              How it works
            </a>
            <a href="/#demo" className="hover:text-foreground">
              Demo
            </a>
            <a href="/#features" className="hover:text-foreground">
              Features
            </a>
            <a href="/#local" className="hover:text-foreground">
              Desktop
            </a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link to="/login">Sign in</Link>
            </Button>
            <Button asChild size="sm">
              <Link to="/register">Get started</Link>
            </Button>
          </div>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <footer
        className={cn(
          "relative z-10 border-t",
          home && "border-white/10 bg-background/80 backdrop-blur",
        )}
      >
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:px-6">
          <div className="flex items-center gap-2">
            <NexusMark className="size-5" />
            <span>Nexus — a council of models, and a company of agents to act on it.</span>
          </div>
          <nav className="flex gap-5 sm:ml-auto">
            <Link to="/status" className="hover:text-foreground">
              Status
            </Link>
            <Link to="/login" className="hover:text-foreground">
              Sign in
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
