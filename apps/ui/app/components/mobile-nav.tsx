// SPDX-License-Identifier: Apache-2.0
/**
 * The phone navigation: five destinations and a way to everything else.
 *
 * A sidebar that slides out is the right control once you know your way around; on a phone it
 * is a drawer you have to open before every move. This bar puts the five things people actually
 * do on the thumb side and keeps the drawer behind "More".
 *
 * The destinations come from `lib/nav.ts`, like the sidebar and the palette, so a renamed route
 * cannot leave a dead tab here. It renders nothing at `md` and up — a desktop with a bottom bar
 * is a phone layout that forgot to stop.
 */
import { Menu } from "lucide-react";

import { Link, useLocation } from "react-router";

import { Button } from "~/components/ui/button";
import { useSidebar } from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";

/** The five tabs, in thumb order. Every one is a route in `lib/nav.ts`. */
export const MOBILE_TABS: { to: string; label: string }[] = [
  { to: "/dashboard", label: "Home" },
  { to: "/chat", label: "Council" },
  { to: "/discussion", label: "Discuss" },
  { to: "/knowledge", label: "Knowledge" },
  { to: "/workflows", label: "Workflows" },
];

/** True when `pathname` is this tab's page or one of its children. */
export function isTabActive(to: string, pathname: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}

export function MobileNav() {
  const { pathname } = useLocation();
  const { setOpenMobile } = useSidebar();

  return (
    <nav
      aria-label="Primary"
      className="flex shrink-0 items-stretch justify-between gap-0.5 border-t bg-background px-1 md:hidden"
      // The home indicator sits on top of the last row of pixels; without the inset the
      // labels are half under it on an iPhone.
      style={{ paddingBottom: "max(0.35rem, env(safe-area-inset-bottom))" }}
    >
      {MOBILE_TABS.map((tab) => {
        const active = isTabActive(tab.to, pathname);
        return (
          <Link
            key={tab.to}
            to={tab.to}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-w-0 flex-1 flex-col items-center rounded-md px-1 py-1.5 text-[11px] font-medium",
              active ? "text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="truncate">{tab.label}</span>
          </Link>
        );
      })}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpenMobile(true)}
        className="flex flex-1 flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-[11px] font-medium text-muted-foreground"
        aria-label="All pages"
      >
        <Menu className="size-4" aria-hidden="true" />
        More
      </Button>
    </nav>
  );
}
