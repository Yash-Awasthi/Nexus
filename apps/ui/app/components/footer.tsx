import { Link } from "react-router";
import { AnimatedIcon, DottedGrid } from "~/components/animations";

const GithubIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
  </svg>
);

const XIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.747l7.73-8.835L1.254 2.25H8.08l4.259 5.622L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z"/>
  </svg>
);

const footerLinks = {
  Product: [
    { name: "AI Council", href: "/product/council" },
    { name: "Knowledge Bases", href: "/product/knowledge" },
    { name: "Workflows", href: "/product/workflows" },
    { name: "Archetypes", href: "/product/archetypes" },
    { name: "Connectors", href: "/product/connectors" },
    { name: "Developer Platform", href: "/product/developer-platform" },
    { name: "Deliberation Modes", href: "/product/deliberation-modes" },
  ],
  Resources: [
    { name: "Documentation", href: "https://github.com/Yash-Awasthi/Nexus/wiki", external: true },
    { name: "Blog", href: "/blog" },
    { name: "LLM Leaderboard", href: "/llm-leaderboard" },
    { name: "Infra Calculator", href: "/infra-calculator" },
    { name: "Status", href: "/status" },
    { name: "GitHub", href: "https://github.com/Yash-Awasthi/Nexus", external: true },
  ],
  Company: [
    { name: "About", href: "/about" },
    { name: "Careers", href: "/careers" },
    { name: "Contact", href: "/contact" },
    { name: "Pricing", href: "/pricing" },
  ],
  "Get Started": [
    { name: "Sign In", href: "/login" },
    { name: "Register", href: "/register" },
    { name: "Desktop App", href: "/product/desktop-app" },
  ],
};

export function Footer() {
  return (
    <footer className="relative border-t border-border/30 bg-background overflow-hidden">
      {/* Top gradient glow line */}
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-blue-500/50 to-transparent" />
      <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-violet-500/20 to-transparent blur-sm" />

      {/* Dotted grid background */}
      <DottedGrid className="opacity-30" />

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-8">
          {/* Brand */}
          <div className="col-span-2 md:col-span-4 lg:col-span-1 mb-4 lg:mb-0">
            <Link to="/" className="flex items-center gap-2.5 mb-4">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-foreground">
                <span className="text-xs font-bold text-background">AI</span>
              </div>
              <span className="font-display text-xl font-bold tracking-tight">Nexus</span>
            </Link>
            <p className="text-sm text-muted-foreground max-w-xs">
              Open-source multi-agent AI platform. Don't trust one AI — make them debate.
            </p>
            <div className="flex gap-3 mt-4">
              <a
                href="https://github.com/Yash-Awasthi/Nexus"
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <AnimatedIcon icon={GithubIcon} animation="glow" size={20} />
              </a>
              <a
                href="https://twitter.com/Nexus"
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <AnimatedIcon icon={XIcon} animation="glow" size={20} />
              </a>
            </div>
          </div>

          {/* Links */}
          {Object.entries(footerLinks).map(([title, links]) => (
            <div key={title}>
              <h3 className="text-sm font-semibold mb-3">{title}</h3>
              <ul className="space-y-2.5">
                {links.map((link) => (
                  <li key={link.name}>
                    {"external" in link && link.external ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-muted-foreground hover:text-foreground hover:translate-x-1 inline-block transition-all duration-200"
                      >
                        {link.name}
                      </a>
                    ) : (
                      <Link
                        to={link.href}
                        className="text-sm text-muted-foreground hover:text-foreground hover:translate-x-1 inline-block transition-all duration-200"
                      >
                        {link.name}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 pt-8 border-t border-border/50 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs text-muted-foreground">
            &copy; {new Date().getFullYear()} JUDICA. Open source under the MIT License.
          </p>
          <div className="flex gap-4">
            <Link to="/about" className="text-xs text-muted-foreground hover:text-foreground hover:translate-x-0.5 inline-block transition-all duration-200">
              Privacy
            </Link>
            <Link to="/about" className="text-xs text-muted-foreground hover:text-foreground hover:translate-x-0.5 inline-block transition-all duration-200">
              Terms
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
