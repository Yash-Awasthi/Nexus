// SPDX-License-Identifier: Apache-2.0
import { useState, useEffect } from "react";
import { Link } from "react-router";

export function LandingNavbar() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? "bg-[oklch(0.08_0.02_260/0.85)] backdrop-blur-xl border-b border-white/5"
          : "bg-transparent"
      }`}
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#4d7cff]/15 relative">
              <span className="text-xs font-bold text-[#4d7cff]">ai</span>
              <div className="absolute inset-0 rounded-lg bg-[#4d7cff]/10 blur-sm" />
            </div>
            <span className="text-lg font-bold tracking-tight text-white">Nexus</span>
          </Link>

          {/* Desktop nav */}
          <div className="hidden md:flex items-center gap-8">
            <a
              href="#features"
              className="text-sm text-white/60 hover:text-white transition-colors"
            >
              Features
            </a>
            <a
              href="#how-it-works"
              className="text-sm text-white/60 hover:text-white transition-colors"
            >
              How It Works
            </a>
            <a href="#council" className="text-sm text-white/60 hover:text-white transition-colors">
              The Council
            </a>
          </div>

          {/* Desktop CTAs */}
          <div className="hidden md:flex items-center gap-3">
            <Link
              to="/login"
              className="text-sm text-white/70 hover:text-white transition-colors px-3 py-1.5"
            >
              Sign In
            </Link>
            <Link
              to="/register"
              className="text-sm font-medium text-white bg-[#4d7cff] hover:bg-[#3d6cef] px-4 py-2 rounded-lg transition-colors"
            >
              Get Started
            </Link>
          </div>

          {/* Mobile hamburger */}
          <button
            className="md:hidden text-white/70 hover:text-white p-2"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              {menuOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
          </button>
        </div>

        {/* Mobile menu */}
        {menuOpen && (
          <div className="md:hidden border-t border-white/5 py-4 space-y-3">
            <a
              href="#features"
              className="block text-sm text-white/60 hover:text-white py-1"
              onClick={() => setMenuOpen(false)}
            >
              Features
            </a>
            <a
              href="#how-it-works"
              className="block text-sm text-white/60 hover:text-white py-1"
              onClick={() => setMenuOpen(false)}
            >
              How It Works
            </a>
            <a
              href="#council"
              className="block text-sm text-white/60 hover:text-white py-1"
              onClick={() => setMenuOpen(false)}
            >
              The Council
            </a>
            <div className="flex gap-3 pt-2">
              <Link to="/login" className="text-sm text-white/70 hover:text-white px-3 py-1.5">
                Sign In
              </Link>
              <Link
                to="/register"
                className="text-sm font-medium text-white bg-[#4d7cff] px-4 py-2 rounded-lg"
              >
                Get Started
              </Link>
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}
