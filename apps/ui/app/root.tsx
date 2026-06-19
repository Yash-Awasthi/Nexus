// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, useCallback, useRef } from "react";
import { useEasterEggs } from "~/hooks/useEasterEggs";
import { EasterEggToast } from "~/components/EasterEggToast";
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
import {
  MessageSquare,
  LayoutDashboard,
  Brain,
  GitFork,
  FileText,
  Database,
  Store,
  Users as UsersIcon,
  Settings,
  UserCircle,
  BarChart3,
  Server,
  ScrollText,
  Hexagon,
  BookOpen,
  Wrench,
  GitBranch,
  FolderOpen,
  ClipboardCheck,
  LogOut,
  Sun,
  Moon,
  Eye,
  Hammer,
  Zap,
  Code2,
  SlidersHorizontal,
  FlaskConical,
  Search,
  Plug,
  RefreshCcw,
  MemoryStick,
  Bell,
  X,
  ImageIcon,
  Activity,
  Trophy,
  Network,
  Cpu,
  Swords,
  CreditCard,
  Globe,
  Radio,
  Terminal,
  Bot,
  Key,
  Flag,
  BookOpenCheck,
  Bug,
  ShieldCheck,
  Wand2,
  DollarSign,
  ShieldAlert,
  Braces,
  Waves,
  History,
  Rss,
  PenTool,
  Video,
  Route as RouteIcon,
  PauseCircle,
  EyeOff,
  GitMerge,
  Scale,
  ClipboardList,
  Filter,
  TrendingUp,
  AlertTriangle,
  Volume2,
  Minimize2,
  Microscope,
} from "lucide-react";

import { TooltipProvider } from "~/components/ui/tooltip";
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
} from "~/components/ui/sidebar";
import { ThemeProvider, useTheme } from "~/context/ThemeContext";
import { StoreProvider } from "~/context/StoreContext";
import { AuthProvider, useAuth } from "~/context/AuthContext";

import type { Route } from "./+types/root";
import "./app.css";

const PUBLIC_PATHS = new Set(["/", "/login", "/register", "/setup"]);

function isPublicPath(pathname: string) {
  return (
    PUBLIC_PATHS.has(pathname) || pathname.startsWith("/product/") || pathname.startsWith("/api/")
  );
}

export const links: Route.LinksFunction = () => [
  { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap",
  },
];

const navGroups = [
  {
    label: "Intelligence",
    items: [
      { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard", end: true },
      { to: "/chat", icon: MessageSquare, label: "Deliberations" },
      { to: "/archetypes", icon: Hexagon, label: "Archetypes" },
    ],
  },
  {
    label: "Automation",
    items: [
      { to: "/workflows", icon: GitFork, label: "Workflows" },
      { to: "/prompts", icon: FileText, label: "Prompts" },
      { to: "/skills", icon: Wrench, label: "Skills" },
    ],
  },
  {
    label: "Knowledge",
    items: [
      { to: "/knowledge-bases", icon: Database, label: "Knowledge Bases" },
      { to: "/repos", icon: GitBranch, label: "Repositories" },
      { to: "/memory", icon: BookOpen, label: "Memory" },
    ],
  },
  {
    label: "Connectors",
    items: [
      { to: "/connectors/onboarding", icon: Plug, label: "Add Connector" },
      { to: "/connectors/sync", icon: RefreshCcw, label: "Sync Status" },
    ],
  },
  {
    label: "G0DM0D3",
    items: [
      { to: "/god-mode", icon: Eye, label: "God Mode" },
      { to: "/gauntlet", icon: Zap, label: "Gauntlet" },
      { to: "/redteam", icon: Code2, label: "Red Team" },
      { to: "/stm", icon: MemoryStick, label: "STM" },
      { to: "/drift", icon: SlidersHorizontal, label: "Drift" },
      { to: "/blind-council", icon: EyeOff, label: "Blind Council" },
    ],
  },
  {
    label: "Research",
    items: [
      { to: "/deep-research", icon: Search, label: "Deep Research" },
      { to: "/ab-compare", icon: Trophy, label: "A/B Arena" },
      { to: "/simulation", icon: Swords, label: "Simulation" },
      { to: "/knowledge-graph", icon: Network, label: "Knowledge Graph" },
      { to: "/agents", icon: Bot, label: "Agents" },
    ],
  },
  {
    label: "Workspace",
    items: [
      { to: "/projects", icon: FolderOpen, label: "Projects" },
      { to: "/evaluation", icon: ClipboardCheck, label: "Evaluation" },
      { to: "/marketplace", icon: Store, label: "Marketplace" },
      { to: "/build", icon: Hammer, label: "Build" },
      { to: "/sandbox", icon: Terminal, label: "Sandbox" },
      { to: "/fine-tune", icon: Cpu, label: "Fine-Tune" },
      { to: "/image-gen", icon: ImageIcon, label: "Image Gen" },
    ],
  },
  {
    label: "Quality",
    items: [
      { to: "/quality", icon: ShieldCheck, label: "Quality Center" },
      { to: "/moderation", icon: ShieldAlert, label: "Moderation" },
      { to: "/semantic-cache", icon: Database, label: "Semantic Cache" },
      { to: "/fallback-chains", icon: GitBranch, label: "Fallback Chains" },
    ],
  },
  {
    label: "Configuration",
    items: [
      { to: "/language-models", icon: Brain, label: "Language Models" },
      { to: "/settings", icon: Settings, label: "Settings" },
      { to: "/profile", icon: UserCircle, label: "Profile" },
      { to: "/billing", icon: CreditCard, label: "Billing" },
      { to: "/costs", icon: DollarSign, label: "Cost Analytics" },
      { to: "/api-tokens", icon: Key, label: "API Tokens" },
      { to: "/standard-answers", icon: BookOpenCheck, label: "Standard Answers" },
      { to: "/web-search", icon: Globe, label: "Web Search" },
      { to: "/scrape", icon: Bug, label: "Scraping" },
      { to: "/rooms", icon: Radio, label: "Rooms" },
    ],
  },
  {
    label: "Admin",
    items: [
      { to: "/admin/users", icon: UsersIcon, label: "Users" },
      { to: "/admin/analytics", icon: BarChart3, label: "Analytics" },
      { to: "/admin/system", icon: Server, label: "System" },
      { to: "/admin/audit", icon: ScrollText, label: "Audit Log" },
      { to: "/admin/traces", icon: Activity, label: "Traces" },
      { to: "/admin/feature-flags", icon: Flag, label: "Feature Flags" },
      { to: "/admin/feedback", icon: MessageSquare, label: "Feedback" },
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
        <meta name="theme-color" content="#09090b" />
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
              var theme = localStorage.getItem('nexus_theme') || 'default-dark';
              var root  = document.documentElement;
              // Remove prior state
              root.classList.remove('dark');
              root.removeAttribute('data-theme');
              if (theme === 'default-dark') {
                root.classList.add('dark');
              } else if (theme === 'matrix' || theme === 'glyph') {
                root.classList.add('dark');
                root.setAttribute('data-theme', theme);
              }
              // legacy 'dark' value compat
              if (theme === 'dark') root.classList.add('dark');
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

function NavItem({
  item,
}: {
  item: { to: string; icon: React.ElementType; label: string; end?: boolean };
}) {
  const location = useLocation();
  const isActive = item.end ? location.pathname === item.to : location.pathname.startsWith(item.to);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isActive} tooltip={item.label}>
        <NavLink to={item.to} end={item.end}>
          <item.icon className="size-4" />
          <span>{item.label}</span>
        </NavLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function ThemeToggleButton() {
  const { theme, toggleTheme } = useTheme();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={toggleTheme}
        tooltip={theme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode"}
        className="flex items-center gap-2 text-muted-foreground hover:text-foreground cursor-pointer"
      >
        {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
        <span className="group-data-[collapsible=icon]:hidden text-xs">
          {theme === "dark" ? "Light Mode" : "Dark Mode"}
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

// ── Notification bell ─────────────────────────────────────────────────────────

interface Notif {
  id: number;
  type: string;
  title: string;
  message?: string;
  isRead: boolean;
  createdAt: string;
}

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch unread count (lightweight — runs on interval)
  const fetchCount = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications/count");
      if (res.ok) {
        const data = await res.json();
        setUnread(data.unreadCount ?? 0);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Fetch full notification list (only when panel opens)
  const fetchList = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await fetch("/api/notifications?limit=8");
      if (res.ok) {
        const data = await res.json();
        setNotifs(data.notifications ?? []);
        setUnread(data.unreadCount ?? 0);
      }
    } catch {
      /* ignore */
    }
    setLoadingList(false);
  }, []);

  // Poll count every 60 s
  useEffect(() => {
    fetchCount();
    timerRef.current = setInterval(fetchCount, 60_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchCount]);

  // Fetch full list when opened
  useEffect(() => {
    if (open) fetchList();
  }, [open, fetchList]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const markRead = async (id: number) => {
    try {
      await fetch(`/api/notifications/${id}/read`, { method: "POST" });
      setNotifs((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
      setUnread((c) => Math.max(0, c - 1));
    } catch {
      /* ignore */
    }
  };

  const dismiss = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await fetch(`/api/notifications/${id}/dismiss`, { method: "POST" });
      setNotifs((prev) => prev.filter((n) => n.id !== id));
      setUnread((c) => Math.max(0, c - 1));
    } catch {
      /* ignore */
    }
  };

  const dismissAll = async () => {
    try {
      await fetch("/api/notifications/dismiss-all", { method: "POST" });
      setNotifs([]);
      setUnread(0);
    } catch {
      /* ignore */
    }
  };

  return (
    <div ref={panelRef} className="relative group-data-[collapsible=icon]:hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative flex items-center justify-center size-7 rounded-md hover:bg-muted/60 transition-colors text-muted-foreground hover:text-foreground"
        title="Notifications"
      >
        <Bell className="size-3.5" />
        {unread > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 flex items-center justify-center rounded-full bg-destructive text-[9px] font-bold text-destructive-foreground"
            style={{ minWidth: "14px", height: "14px", padding: "0 2px" }}
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute left-full top-0 ml-2 z-50 rounded-xl shadow-xl"
          style={{
            width: "280px",
            background: "hsl(var(--popover))",
            border: "1px solid hsl(var(--border))",
          }}
        >
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
            <span className="text-xs font-semibold">Notifications</span>
            {notifs.length > 0 && (
              <button
                onClick={dismissAll}
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              >
                Dismiss all
              </button>
            )}
          </div>

          <div className="max-h-72 overflow-y-auto">
            {loadingList ? (
              <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
                Loading…
              </div>
            ) : notifs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 gap-2">
                <Bell className="size-5 text-muted-foreground/30" />
                <p className="text-xs text-muted-foreground">No notifications</p>
              </div>
            ) : (
              notifs.map((n) => (
                <div
                  key={n.id}
                  onClick={() => {
                    if (!n.isRead) markRead(n.id);
                  }}
                  className="flex items-start gap-2 px-3 py-2.5 cursor-pointer hover:bg-muted/40 transition-colors group/item"
                  style={{ borderBottom: "1px solid hsl(var(--border)/0.4)" }}
                >
                  {!n.isRead && (
                    <span className="mt-1.5 size-1.5 rounded-full bg-primary shrink-0" />
                  )}
                  <div className={`flex-1 min-w-0 ${n.isRead ? "pl-3.5" : ""}`}>
                    <p
                      className={`text-xs font-medium leading-tight ${n.isRead ? "text-muted-foreground" : ""}`}
                    >
                      {n.title}
                    </p>
                    {n.message && (
                      <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">
                        {n.message}
                      </p>
                    )}
                    <p className="text-[10px] text-muted-foreground/60 mt-1">
                      {new Date(n.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <button
                    onClick={(e) => dismiss(n.id, e)}
                    className="shrink-0 mt-0.5 opacity-0 group-hover/item:opacity-100 text-muted-foreground hover:text-foreground transition-all"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AppSidebar() {
  const { user, logout } = useAuth();
  const displayName = user?.username ?? "Guest";
  const initials = displayName.slice(0, 2).toUpperCase();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="px-3 py-4">
        <div className="flex items-center justify-between">
          <NavLink
            to="/dashboard"
            className="flex items-center gap-2 group-data-[collapsible=icon]:justify-center"
          >
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-bold">
              N
            </div>
            <span className="text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
              NEXUS
            </span>
          </NavLink>
          <NotificationBell />
        </div>
      </SidebarHeader>
      <SidebarContent>
        {navGroups.map((group) => (
          <SidebarGroup key={group.label}>
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
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip={displayName}>
              <NavLink to="/profile" className="flex items-center gap-2">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground text-[10px] font-medium">
                  {initials}
                </div>
                <div className="flex flex-col group-data-[collapsible=icon]:hidden">
                  <span className="text-xs font-medium leading-none">{displayName}</span>
                  <span className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                    {user?.role ?? ""}
                  </span>
                </div>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <ThemeToggleButton />
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Logout">
              <button
                onClick={() => logout()}
                className="flex w-full items-center gap-2 text-muted-foreground hover:text-foreground"
              >
                <LogOut className="size-4" />
                <span className="group-data-[collapsible=icon]:hidden text-xs">Logout</span>
              </button>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const { egg, dismiss } = useEasterEggs();

  // Register PWA service worker
  useEffect(() => {
    if (typeof window !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        /* non-fatal in dev */
      });
    }
  }, []);

  // In Electron, skip landing page and go straight to /chat
  useEffect(() => {
    if (location.pathname === "/" && typeof window !== "undefined" && (window as any).molecule) {
      navigate("/chat", { replace: true });
      return;
    }
    // Client-side auth guard — redirect to /setup if no user profile exists
    if (isPublicPath(location.pathname)) return;
    const profile = localStorage.getItem("nexus_user");
    if (!profile) {
      navigate("/setup", { replace: true });
    }
  }, [location.pathname]);

  if (isPublicPath(location.pathname)) {
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
        <StoreProvider>
          <TooltipProvider>
            <SidebarProvider>
              <AppSidebar />
              <main className="flex-1 overflow-auto">
                <div className="flex items-center gap-2 border-b border-border px-4 py-2 md:hidden">
                  <SidebarTrigger />
                  <span className="text-sm font-semibold">NEXUS</span>
                </div>
                <Outlet />
              </main>
              <EasterEggToast egg={egg} dismiss={dismiss} />
            </SidebarProvider>
          </TooltipProvider>
        </StoreProvider>
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
