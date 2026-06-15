// SPDX-License-Identifier: Apache-2.0
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Nexus design tokens
        surface: "#0f1117",
        card: "#161b27",
        border: "#1e2535",
        muted: "#334155",
        subtle: "#64748b",
        body: "#94a3b8",
        heading: "#e2e8f0",
        brand: {
          DEFAULT: "#7c3aed",
          light: "#c4b5fd",
          dark: "#5b21b6",
          faint: "rgba(124,58,237,0.12)",
        },
        success: "#16a34a",
        warning: "#d97706",
        danger: "#dc2626",
        info: "#2563eb",
      },
      fontFamily: {
        sans: ["system-ui", "-apple-system", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "monospace"],
      },
      borderRadius: {
        DEFAULT: "8px",
        card: "10px",
        pill: "9999px",
      },
      boxShadow: {
        card: "0 1px 3px rgba(0,0,0,0.4)",
        glow: "0 0 16px rgba(124,58,237,0.3)",
      },
    },
  },
  plugins: [],
};
