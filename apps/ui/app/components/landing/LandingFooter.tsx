// SPDX-License-Identifier: Apache-2.0
import { Link } from "react-router";

const columns = [
  {
    title: "Product",
    links: [
      { label: "Features", href: "#features" },
      { label: "How It Works", href: "#how-it-works" },
      { label: "The Council", href: "#council" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "#" },
      { label: "Blog", href: "#" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy", href: "#" },
      { label: "Terms", href: "#" },
    ],
  },
];

export function LandingFooter() {
  return (
    <footer className="border-t border-white/5 py-12">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col md:flex-row justify-between gap-10">
          {/* Logo */}
          <div className="flex-shrink-0">
            <Link to="/" className="inline-flex items-center gap-2">
              <span className="text-lg font-bold tracking-tight text-white">Nexus</span>
            </Link>
            <p className="mt-2 text-xs text-white/30">Multi-perspective AI deliberation platform</p>
          </div>

          {/* Link columns */}
          <div className="flex gap-16">
            {columns.map((col) => (
              <div key={col.title}>
                <h4 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3">
                  {col.title}
                </h4>
                <ul className="space-y-2">
                  {col.links.map((link) => (
                    <li key={link.label}>
                      <a
                        href={link.href}
                        className="text-sm text-white/30 hover:text-white/60 transition-colors"
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-10 pt-6 border-t border-white/5 text-center">
          <p className="text-xs text-white/20">&copy; 2025 JUDICA. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}
