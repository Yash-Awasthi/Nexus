// SPDX-License-Identifier: Apache-2.0
import {
  Activity,
  BarChart3,
  BookOpen,
  BookOpenCheck,
  Building2,
  ChevronsUpDown,
  Columns3,
  Database,
  DollarSign,
  FileText,
  Flag,
  FolderKanban,
  GitFork,
  HardDrive,
  Hexagon,
  Key,
  KeyRound,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  MessagesSquare,
  Moon,
  Network,
  Plug,
  Plus,
  ScanSearch,
  ScrollText,
  Search,
  Share2,
  Server,
  Settings,
  ShieldAlert,
  SquareTerminal,
  Store,
  Sun,
  Terminal,
  Boxes,
  UserCircle,
  Users as UsersIcon,
  Wrench,
  TrendingUp,
  CloudSun,
  Wand2,
} from "lucide-react";
import { useEffect } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  NavLink,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
  useNavigate,
} from "react-router";

import type { Route } from "./+types/root";

import { NotificationBell } from "~/components/NotificationBell";
import { NexusMark } from "~/components/brand";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  SidebarProvider,
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarFooter,
  SidebarHeader,
  SidebarTrigger,
  useSidebar,
} from "~/components/ui/sidebar";
import { TooltipProvider } from "~/components/ui/tooltip";
import { AuthProvider, bootstrapSession, useAuth } from "~/context/AuthContext";
import { NotificationsProvider } from "~/context/NotificationsContext";
import { ThemeProvider, useTheme } from "~/context/ThemeContext";
import { hostCan } from "~/lib/host";
import { installAuthFetch } from "~/lib/install-auth-fetch";
import "./app.css";

// Attach the session's token to same-origin /api/* calls made via raw fetch
// (runs once, client-only), and settle that session before any page renders.
// Without this, auth-gated bridge routes 401 and pages render empty.
installAuthFetch();
bootstrapSession();

const PUBLIC_PATHS = new Set(["/", "/login", "/register", "/status"]);

function isPublicPath(pathname: string) {
  // A watch link carries its own key, so a viewer needs no account.
  return (
    PUBLIC_PATHS.has(pathname) || pathname.startsWith("/api/") || pathname.startsWith("/live/")
  );
}

/** Full-screen pages drawn without the app shell. */
const isBarePath = (pathname: string) => isPublicPath(pathname) || pathname === "/setup";

export const links: Route.LinksFunction = () => [
  { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
];

interface NavEntry {
  to: string;
  icon: React.ElementType;
  label: string;
  end?: boolean;
}

// The council leads; everything else supports it. Admin shows to admins only.
const navGroups: { label: string; admin?: boolean; items: NavEntry[] }[] = [
  {
    label: "Deliberate",
    items: [
      { to: "/dashboard", icon: LayoutDashboard, label: "Home", end: true },
      { to: "/chat", icon: MessageSquare, label: "Council" },
      { to: "/discussion", icon: MessagesSquare, label: "Discussion" },
      { to: "/archetypes", icon: Hexagon, label: "Archetypes" },
    ],
  },
  {
    label: "Company",
    items: [
      { to: "/org", icon: Building2, label: "Companies" },
      { to: "/projects", icon: FolderKanban, label: "Projects" },
      { to: "/workspaces", icon: UsersIcon, label: "Workspaces" },
    ],
  },
  {
    label: "Automate",
    items: [
      { to: "/workflows", icon: GitFork, label: "Workflows" },
      { to: "/skills", icon: Wrench, label: "Skills" },
      { to: "/prompts", icon: FileText, label: "Prompts" },
      { to: "/marketplace", icon: Store, label: "Marketplace" },
    ],
  },
  {
    label: "Knowledge",
    items: [
      { to: "/search", icon: ScanSearch, label: "Search" },
      { to: "/deep-research", icon: Search, label: "Deep research" },
      { to: "/knowledge-bases", icon: Database, label: "Knowledge bases" },
      { to: "/memory", icon: BookOpen, label: "Memory" },
      { to: "/knowledge-graph", icon: Share2, label: "Knowledge graph" },
      { to: "/markets", icon: TrendingUp, label: "Prediction markets" },
      { to: "/standard-answers", icon: BookOpenCheck, label: "Curated answers" },
      { to: "/connectors/sync", icon: Plug, label: "Connectors" },
    ],
  },
  {
    label: "Tools",
    items: [
      { to: "/playground/compare", icon: Columns3, label: "Model compare" },
      { to: "/sandbox", icon: Terminal, label: "Sandbox" },
      { to: "/terminals", icon: SquareTerminal, label: "Terminals" },
      { to: "/drive", icon: HardDrive, label: "Drive" },
      { to: "/app-builder", icon: Wand2, label: "App builder" },
      { to: "/weather", icon: CloudSun, label: "Weather" },
    ],
  },
  {
    label: "Settings",
    items: [
      { to: "/settings", icon: Settings, label: "Preferences" },
      { to: "/provider-keys", icon: KeyRound, label: "Models & keys" },
      { to: "/costs", icon: DollarSign, label: "Usage & cost" },
      { to: "/mcp-servers", icon: Boxes, label: "MCP servers" },
      { to: "/api-tokens", icon: Key, label: "API tokens" },
    ],
  },
  {
    label: "Admin",
    admin: true,
    items: [
      { to: "/admin/users", icon: UsersIcon, label: "Users" },
      { to: "/admin/analytics", icon: BarChart3, label: "Analytics" },
      { to: "/admin/traces", icon: Activity, label: "Traces" },
      { to: "/gateway", icon: Network, label: "Gateway" },
      { to: "/admin/audit", icon: ScrollText, label: "Audit log" },
      { to: "/moderation", icon: ShieldAlert, label: "Moderation" },
      { to: "/admin/feedback", icon: MessageSquare, label: "Feedback" },
      { to: "/admin/feature-flags", icon: Flag, label: "Feature flags" },
      { to: "/admin/system", icon: Server, label: "System" },
    ],
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Phase 3.15 — PWA manifest */}
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#1c1d22" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Nexus" />
        <Meta />
        <Links />
        <script
          dangerouslySetInnerHTML={{
            __html: `
          (function() {
            try {
              var saved = localStorage.getItem('nexus_theme');
              var dark = saved
                ? saved === 'dark' || saved === 'default-dark'
                : window.matchMedia('(prefers-color-scheme: dark)').matches;
              document.documentElement.classList.toggle('dark', dark);
            } catch(e) {}
          })();
        `,
          }}
        />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

function NavItem({ item }: { item: NavEntry }) {
  const location = useLocation();
  const isActive = item.end ? location.pathname === item.to : location.pathname.startsWith(item.to);
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isActive} tooltip={item.label}>
        <NavLink to={item.to} end={item.end} onClick={() => isMobile && setOpenMobile(false)}>
          <item.icon />
          <span>{item.label}</span>
        </NavLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const displayName = user?.username ?? user?.email?.split("@")[0] ?? "Guest";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
            {displayName.slice(0, 1).toUpperCase()}
          </div>
          <div className="grid min-w-0 flex-1 text-left leading-tight">
            <span className="truncate text-sm font-medium">{displayName}</span>
            {user?.email && (
              <span className="truncate text-xs text-muted-foreground">{user.email}</span>
            )}
          </div>
          <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
      >
        <DropdownMenuItem asChild>
          <NavLink to="/profile">
            <UserCircle /> Profile
          </NavLink>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={toggleTheme}>
          {theme === "dark" ? <Sun /> : <Moon />}
          {theme === "dark" ? "Light theme" : "Dark theme"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => logout()}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AppSidebar() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const isAdmin = user?.role === "admin" || user?.role === "owner";

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="gap-3 px-3 pt-4">
        <div className="flex items-center justify-between">
          <NavLink to="/dashboard" className="flex items-center gap-2.5">
            <NexusMark className="size-7 shrink-0" />
            <span className="text-[15px] font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
              Nexus
            </span>
          </NavLink>
          <NotificationBell />
        </div>
        <Button
          className="w-full justify-start group-data-[collapsible=icon]:hidden"
          onClick={() => navigate("/chat")}
        >
          <Plus /> New deliberation
        </Button>
      </SidebarHeader>
      <SidebarContent className="gap-0 pb-2">
        {navGroups
          .filter((group) => !group.admin || isAdmin)
          .map((group) => (
            <SidebarGroup key={group.label} className="py-1.5">
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => (
                    <NavItem key={item.to} item={item} />
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem>
            <UserMenu />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();

  // Register PWA service worker — production only. The SW caches Vite's
  // content-hashed dep chunks under immutable keys; in dev a re-optimization
  // invalidates those URLs server-side while the SW keeps serving the old
  // copies, stranding pages on two React copies (recurring cold-load crash).
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    const isDev =
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1" ||
      import.meta.env.DEV;
    if (isDev) {
      // Unregister any SW a previous dev session installed and clear its caches.
      void navigator.serviceWorker
        .getRegistrations()
        .then((regs) => Promise.all(regs.map((r) => r.unregister())))
        .catch(() => undefined);
      void caches
        .keys()
        .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
        .catch(() => undefined);
      return;
    }
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      /* non-fatal */
    });
  }, []);

  // A host that owns the session has no marketing landing page to show.
  useEffect(() => {
    if (location.pathname === "/" && hostCan("localAccount")) {
      navigate("/dashboard", { replace: true });
      return;
    }
    // Client-side auth guard: a first visit signs up, a returning one signs in.
    if (isPublicPath(location.pathname)) return;
    const setupDone = localStorage.getItem("nexus_setup_done") === "1";
    // A host-owned session is signed in without a stored profile.
    const signedIn = hostCan("localAccount") || !!localStorage.getItem("nexus_user");
    if (!signedIn) navigate(setupDone ? "/login" : "/register", { replace: true });
  }, [location.pathname]);

  if (isBarePath(location.pathname)) {
    return (
      <AuthProvider>
        <ThemeProvider>
          <Outlet />
        </ThemeProvider>
      </AuthProvider>
    );
  }

  return (
    <AuthProvider>
      <ThemeProvider>
        <NotificationsProvider>
          <TooltipProvider>
            <SidebarProvider>
              <AppSidebar />
              {/* Pages fill the area under the phone header with h-full, never h-screen. */}
              <main className="flex h-svh min-w-0 flex-1 flex-col overflow-hidden">
                <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3 md:hidden">
                  <SidebarTrigger />
                  <NexusMark className="size-6" />
                  <span className="text-sm font-semibold tracking-tight">Nexus</span>
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  <Outlet />
                </div>
              </main>
            </SidebarProvider>
          </TooltipProvider>
        </NotificationsProvider>
      </ThemeProvider>
    </AuthProvider>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404 ? "The requested page could not be found." : error.statusText || details;
  } else if (error && error instanceof Error) {
    details = error.message;
    stack = import.meta.env.DEV ? error.stack : undefined;
  }

  const is404 = isRouteErrorResponse(error) && error.status === 404;

  return (
    <main className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="mx-auto size-20 rounded-2xl bg-destructive/10 flex items-center justify-center">
          <span className="text-4xl font-bold text-destructive">{is404 ? "404" : "!"}</span>
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{message}</h1>
          <p className="text-sm text-muted-foreground leading-relaxed">{details}</p>
        </div>
        <div className="flex items-center justify-center gap-3">
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Go Home
          </a>
          <button
            onClick={() => window.history.back()}
            className="inline-flex items-center justify-center rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
          >
            Go Back
          </button>
        </div>
        {stack && (
          <details className="text-left">
            <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
              Stack Trace
            </summary>
            <pre className="mt-2 w-full p-3 rounded-md bg-muted text-xs overflow-x-auto">
              <code className="text-muted-foreground">{stack}</code>
            </pre>
          </details>
        )}
      </div>
    </main>
  );
}
