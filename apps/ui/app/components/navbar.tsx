// SPDX-License-Identifier: Apache-2.0
import { Link, useLocation } from "react-router";
import { useState, useRef, useEffect } from "react";
import { useTheme } from "~/context/ThemeContext";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sun,
  Moon,
  ChevronDown,
  MessageSquare,
  Search,
  Workflow,
  Plug,
  Code2,
  Layers,
  Monitor,
  Users,
  FileText,
  BarChart3,
  Calculator,
  Activity,
  MessageCircle,
  Building2,
  Briefcase,
  Mail,
  BookOpen,
  Menu,
  X,
  Sparkles,
  Shield,
  Lightbulb,
} from "lucide-react";
import { Button } from "~/components/ui/button";

const GithubIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
  </svg>
);

const productItems = [
  {
    label: "Core Features",
    items: [
      {
        name: "AI Council",
        desc: "Multi-agent deliberation engine",
        href: "/product/council",
        icon: Users,
      },
      {
        name: "Knowledge Bases",
        desc: "RAG-powered knowledge retrieval",
        href: "/product/knowledge",
        icon: Search,
      },
      {
        name: "Workflows",
        desc: "Visual DAG workflow builder",
        href: "/product/workflows",
        icon: Workflow,
      },
      {
        name: "Archetypes",
        desc: "14 distinct agent personalities",
        href: "/product/archetypes",
        icon: Sparkles,
      },
    ],
  },
  {
    label: "More",
    items: [
      {
        name: "Connectors",
        desc: "19 LLM providers, 51 data sources",
        href: "/product/connectors",
        icon: Plug,
      },
      {
        name: "Developer Platform",
        desc: "API, MCP & SDK access",
        href: "/product/developer-platform",
        icon: Code2,
      },
      {
        name: "Deliberation Modes",
        desc: "5 thinking styles for every task",
        href: "/product/deliberation-modes",
        icon: Lightbulb,
      },
      {
        name: "Desktop App",
        desc: "Native app for all platforms",
        href: "/product/desktop-app",
        icon: Monitor,
      },
    ],
  },
];

const resourceItems = [
  {
    name: "Docs",
    href: "https://github.com/Yash-Awasthi/Nexus/wiki",
    icon: BookOpen,
    external: true,
  },
  { name: "Blog", href: "/blog", icon: FileText },
  { name: "LLM Leaderboard", href: "/llm-leaderboard", icon: BarChart3 },
  { name: "Infra Calculator", href: "/infra-calculator", icon: Calculator },
  { name: "Status", href: "/status", icon: Activity },
  { name: "Discord", href: "https://discord.gg/Nexus", icon: MessageCircle, external: true },
];

const companyItems = [
  { name: "About", href: "/about", icon: Building2 },
  { name: "Careers", href: "/careers", icon: Briefcase },
  { name: "Contact", href: "/contact", icon: Mail },
];

const dropdownVariants = {
  hidden: { opacity: 0, y: -8, scale: 0.96 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.18, ease: [0.23, 1, 0.32, 1] as [number, number, number, number] },
  },
  exit: {
    opacity: 0,
    y: -6,
    scale: 0.97,
    transition: { duration: 0.12, ease: "easeIn" as const },
  },
};

function DropdownMenu({
  label,
  children,
  isOpen,
  onToggle,
  onClose,
}: {
  label: string;
  children: React.ReactNode;
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen, onClose]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={onToggle}
        className="group flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors px-3 py-2 relative"
      >
        {label}
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
        />
        {/* Hover underline animation */}
        <span className="absolute bottom-0 left-3 right-3 h-px bg-gradient-to-r from-blue-500 to-violet-500 scale-x-0 group-hover:scale-x-100 transition-transform duration-300 origin-left" />
      </button>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            variants={dropdownVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="absolute top-full left-0 mt-1 bg-popover/95 backdrop-blur-xl border border-border/50 rounded-lg shadow-lg shadow-black/10 z-50"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function NavLink({
  to,
  children,
  isActive,
}: {
  to: string;
  children: React.ReactNode;
  isActive: boolean;
}) {
  return (
    <Link
      to={to}
      className={`relative text-sm font-medium px-3 py-2 transition-colors group ${
        isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
      {/* Hover underline animation */}
      <span
        className={`absolute bottom-0 left-3 right-3 h-px bg-gradient-to-r from-blue-500 to-violet-500 transition-transform duration-300 origin-left ${
          isActive ? "scale-x-100" : "scale-x-0 group-hover:scale-x-100"
        }`}
      />
    </Link>
  );
}

export function Navbar() {
  const { theme, toggleTheme } = useTheme();
  const location = useLocation();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setOpenMenu(null);
    setMobileOpen(false);
  }, [location.pathname]);

  const toggle = (menu: string) => setOpenMenu((prev) => (prev === menu ? null : menu));

  return (
    <header className="sticky top-0 z-50 w-full bg-background/60 backdrop-blur-xl">
      {/* Bottom glow line removed — visible against Spline hero background */}

      <nav className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2.5">
            <div className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-foreground">
              <span className="text-xs font-bold text-background">AI</span>
              {/* Pulse glow on logo badge */}
              <span className="absolute inset-0 rounded-lg animate-[logoPulse_3s_ease-in-out_infinite] pointer-events-none" />
              <style>{`
                @keyframes logoPulse {
                  0%, 100% { box-shadow: 0 0 0px 0px rgba(99,102,241,0); }
                  50% { box-shadow: 0 0 12px 3px rgba(99,102,241,0.4), 0 0 24px 6px rgba(139,92,246,0.15); }
                }
              `}</style>
            </div>
            <span className="font-display text-xl font-bold tracking-tight">Nexus</span>
          </Link>

          {/* Desktop Nav */}
          <div className="hidden lg:flex items-center gap-0.5">
            <DropdownMenu
              label="Product"
              isOpen={openMenu === "product"}
              onToggle={() => toggle("product")}
              onClose={() => setOpenMenu(null)}
            >
              <div className="grid grid-cols-2 gap-0 p-2 w-[520px]">
                {productItems.map((group) => (
                  <div key={group.label} className="p-2">
                    <p className="text-xs font-medium text-muted-foreground mb-2 px-2">
                      {group.label}
                    </p>
                    {group.items.map((item) => (
                      <Link
                        key={item.href}
                        to={item.href}
                        className="flex items-start gap-3 rounded-md px-2 py-2.5 hover:bg-accent transition-colors"
                      >
                        <item.icon className="h-5 w-5 mt-0.5 text-muted-foreground" />
                        <div>
                          <p className="text-sm font-medium">{item.name}</p>
                          <p className="text-xs text-muted-foreground">{item.desc}</p>
                        </div>
                      </Link>
                    ))}
                  </div>
                ))}
              </div>
            </DropdownMenu>

            <DropdownMenu
              label="Resources"
              isOpen={openMenu === "resources"}
              onToggle={() => toggle("resources")}
              onClose={() => setOpenMenu(null)}
            >
              <div className="p-2 w-[200px]">
                {resourceItems.map((item) =>
                  item.external ? (
                    <a
                      key={item.name}
                      href={item.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm hover:bg-accent transition-colors"
                    >
                      <item.icon className="h-4 w-4 text-muted-foreground" />
                      {item.name}
                    </a>
                  ) : (
                    <Link
                      key={item.name}
                      to={item.href}
                      className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm hover:bg-accent transition-colors"
                    >
                      <item.icon className="h-4 w-4 text-muted-foreground" />
                      {item.name}
                    </Link>
                  ),
                )}
              </div>
            </DropdownMenu>

            <DropdownMenu
              label="Company"
              isOpen={openMenu === "company"}
              onToggle={() => toggle("company")}
              onClose={() => setOpenMenu(null)}
            >
              <div className="p-2 w-[180px]">
                {companyItems.map((item) => (
                  <Link
                    key={item.name}
                    to={item.href}
                    className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm hover:bg-accent transition-colors"
                  >
                    <item.icon className="h-4 w-4 text-muted-foreground" />
                    {item.name}
                  </Link>
                ))}
              </div>
            </DropdownMenu>

            <NavLink to="/pricing" isActive={location.pathname === "/pricing"}>
              Pricing
            </NavLink>
          </div>

          {/* Right side */}
          <div className="flex items-center gap-2">
            <a
              href="https://github.com/Yash-Awasthi/Nexus"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden sm:flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors px-2 py-1.5 rounded-md"
            >
              <GithubIcon className="h-4 w-4" />
              <span className="text-xs font-medium">GitHub</span>
            </a>

            {/* Theme toggle with rotation animation */}
            <motion.button
              onClick={toggleTheme}
              className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              aria-label="Toggle theme"
              whileTap={{ rotate: 180 }}
              transition={{ duration: 0.35, ease: [0.23, 1, 0.32, 1] }}
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={theme}
                  initial={{ opacity: 0, rotate: -90, scale: 0.5 }}
                  animate={{ opacity: 1, rotate: 0, scale: 1 }}
                  exit={{ opacity: 0, rotate: 90, scale: 0.5 }}
                  transition={{ duration: 0.25 }}
                  className="block"
                >
                  {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                </motion.span>
              </AnimatePresence>
            </motion.button>

            <div className="hidden sm:flex items-center gap-2 ml-2">
              <Button variant="ghost" size="sm" asChild>
                <Link to="/login">Sign In</Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link to="/demo">Try Demo</Link>
              </Button>
              <Button size="sm" asChild>
                <Link to="/register">Try for Free</Link>
              </Button>
            </div>

            {/* Mobile menu */}
            <button
              onClick={() => setMobileOpen(!mobileOpen)}
              className="lg:hidden p-2 rounded-md text-muted-foreground hover:text-foreground"
            >
              {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {/* Mobile menu */}
        <AnimatePresence>
          {mobileOpen && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.25, ease: "easeInOut" }}
              className="lg:hidden border-t border-border/50 overflow-hidden"
            >
              <div className="py-4 space-y-4">
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2 px-1">Product</p>
                  {productItems
                    .flatMap((g) => g.items)
                    .map((item) => (
                      <Link
                        key={item.href}
                        to={item.href}
                        className="block px-1 py-2 text-sm hover:text-foreground text-muted-foreground"
                      >
                        {item.name}
                      </Link>
                    ))}
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2 px-1">Resources</p>
                  {resourceItems.map((item) =>
                    item.external ? (
                      <a
                        key={item.name}
                        href={item.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block px-1 py-2 text-sm hover:text-foreground text-muted-foreground"
                      >
                        {item.name}
                      </a>
                    ) : (
                      <Link
                        key={item.name}
                        to={item.href}
                        className="block px-1 py-2 text-sm hover:text-foreground text-muted-foreground"
                      >
                        {item.name}
                      </Link>
                    ),
                  )}
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2 px-1">Company</p>
                  {companyItems.map((item) => (
                    <Link
                      key={item.name}
                      to={item.href}
                      className="block px-1 py-2 text-sm hover:text-foreground text-muted-foreground"
                    >
                      {item.name}
                    </Link>
                  ))}
                </div>
                <Link to="/pricing" className="block px-1 py-2 text-sm font-medium">
                  Pricing
                </Link>
                <div className="flex gap-2 pt-2">
                  <Button variant="outline" size="sm" asChild className="flex-1">
                    <Link to="/login">Sign In</Link>
                  </Button>
                  <Button size="sm" asChild className="flex-1">
                    <Link to="/register">Try for Free</Link>
                  </Button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </nav>
    </header>
  );
}
