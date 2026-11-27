// SPDX-License-Identifier: Apache-2.0
/**
 * The navigation registry: one list, two consumers.
 *
 * The sidebar renders it and the command palette searches it. They were the same list of
 * pages in two places before this file existed, which is how a page ends up in one and not
 * the other — a link you can click but not find, or a command that navigates to a 404.
 *
 * `label` is what both surfaces show; `keywords` is only for the palette, so a page can be
 * found by the words a user would type rather than by the words the sidebar had room for.
 */
import {
  Activity,
  BarChart3,
  Boxes,
  Building2,
  Database,
  DollarSign,
  Flag,
  FolderKanban,
  GitFork,
  Hexagon,
  Key,
  KeyRound,
  LayoutDashboard,
  LayoutTemplate,
  MessageSquare,
  MessagesSquare,
  Network,
  ScrollText,
  Server,
  Settings,
  ShieldAlert,
  SquareTerminal,
  Terminal,
  Users as UsersIcon,
  Wrench,
} from "lucide-react";

export interface NavEntry {
  to: string;
  icon: React.ElementType;
  label: string;
  end?: boolean;
  /** Shown only when the server can run it. */
  requires?: "terminal";
  /** Extra words the command palette matches on. Never rendered. */
  keywords?: string[];
}

export interface NavGroup {
  label: string;
  admin?: boolean;
  items: NavEntry[];
}

/** The council leads; everything else supports it. Admin shows to admins only. */
export const navGroups: NavGroup[] = [
  {
    label: "Deliberate",
    items: [
      {
        to: "/dashboard",
        icon: LayoutDashboard,
        label: "Home",
        end: true,
        keywords: ["dashboard", "start"],
      },
      {
        to: "/chat",
        icon: MessageSquare,
        label: "Council",
        keywords: ["chat", "ask", "verdict", "deliberate"],
      },
      {
        to: "/discussion",
        icon: MessagesSquare,
        label: "Discussion",
        keywords: ["debate", "council", "ledger", "rounds"],
      },
      {
        to: "/archetypes",
        icon: Hexagon,
        label: "Archetypes",
        keywords: ["persona", "members", "prompts"],
      },
    ],
  },
  {
    label: "Company",
    items: [
      {
        to: "/org",
        icon: Building2,
        label: "Companies",
        keywords: ["org", "team", "budget", "company"],
      },
      { to: "/projects", icon: FolderKanban, label: "Projects", keywords: ["tasks", "project"] },
      { to: "/workspaces", icon: UsersIcon, label: "Workspaces", keywords: ["members", "invite"] },
    ],
  },
  {
    label: "Automate",
    items: [
      {
        to: "/workflows",
        icon: GitFork,
        label: "Workflows",
        keywords: ["automation", "cron", "run", "steps"],
      },
      {
        to: "/templates",
        icon: LayoutTemplate,
        label: "Templates",
        keywords: ["starter", "preset", "gallery", "scaffold", "company setup"],
      },
      { to: "/skills", icon: Wrench, label: "Skills", keywords: ["tools", "skill"] },
    ],
  },
  {
    label: "Knowledge",
    items: [
      {
        to: "/knowledge",
        icon: Database,
        label: "Knowledge",
        keywords: ["kb", "documents", "rag", "upload"],
      },
    ],
  },
  {
    label: "Tools",
    items: [
      {
        to: "/search",
        icon: Database,
        label: "Search",
        end: false,
        keywords: ["find", "web", "retrieval"],
      },
      { to: "/sandbox", icon: Terminal, label: "Sandbox", keywords: ["code", "run", "execute"] },
      {
        to: "/terminals",
        icon: SquareTerminal,
        label: "Terminals",
        requires: "terminal",
        keywords: ["shell", "pty", "console"],
      },
      {
        to: "/knowledge-graph",
        icon: Network,
        label: "Knowledge graph",
        keywords: ["entities", "graph", "nodes"],
      },
      {
        to: "/costs",
        icon: DollarSign,
        label: "Usage & cost",
        keywords: ["spend", "tokens", "billing"],
      },
    ],
  },
  {
    label: "Settings",
    items: [
      {
        to: "/settings",
        icon: Settings,
        label: "Preferences",
        keywords: ["theme", "profile", "options"],
      },
      {
        to: "/provider-keys",
        icon: KeyRound,
        label: "Models & keys",
        keywords: ["api key", "provider", "byok"],
      },
      { to: "/mcp-servers", icon: Boxes, label: "MCP servers", keywords: ["tools", "mcp"] },
      { to: "/api-tokens", icon: Key, label: "API tokens", keywords: ["token", "programmatic"] },
    ],
  },
  {
    label: "Admin",
    admin: true,
    items: [
      { to: "/admin/users", icon: UsersIcon, label: "Users", keywords: ["accounts", "admin"] },
      {
        to: "/admin/analytics",
        icon: BarChart3,
        label: "Analytics",
        keywords: ["metrics", "usage"],
      },
      { to: "/admin/traces", icon: Activity, label: "Traces", keywords: ["requests", "latency"] },
      {
        to: "/gateway",
        icon: Network,
        label: "Gateway",
        keywords: ["proxy", "models", "upstream"],
      },
      {
        to: "/admin/audit",
        icon: ScrollText,
        label: "Audit log",
        keywords: ["events", "security"],
      },
      {
        to: "/moderation",
        icon: ShieldAlert,
        label: "Content filter",
        keywords: ["moderation", "safety"],
      },
      {
        to: "/admin/feedback",
        icon: MessageSquare,
        label: "Feedback",
        keywords: ["reports", "thumbs"],
      },
      {
        to: "/admin/feature-flags",
        icon: Flag,
        label: "Feature flags",
        keywords: ["flags", "rollout"],
      },
      {
        to: "/admin/system",
        icon: Server,
        label: "System",
        keywords: ["health", "status", "diagnostics"],
      },
    ],
  },
];

/** Every page, flattened, with the group it came from. */
export function allNavItems(): (NavEntry & { group: string; admin: boolean })[] {
  return navGroups.flatMap((group) =>
    group.items.map((item) => ({ ...item, group: group.label, admin: group.admin === true })),
  );
}
