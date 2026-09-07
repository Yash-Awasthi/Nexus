// SPDX-License-Identifier: Apache-2.0
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { resolve } from "path";

const API_TARGET = process.env.NEXUS_API_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    // Deduplicate React (and react-router, which has two 7.18.x minors in the
    // pnpm tree) so nested copies don't hand radix-ui / lobehub / the router a
    // second React instance — its dispatcher is null → "Cannot read properties
    // of null (reading 'useRef'/'useContext')" on render.
    dedupe: ["react", "react-dom", "react-is", "react-router", "@remix-run/router"],
    alias: {
      "~": resolve(__dirname, "./app"),
      // Force any react-router-dom resolution to react-router v7. A transitive
      // (Docusaurus-era) react-router-dom@5 otherwise gets pulled in and explodes
      // on missing v5 exports. The UI never uses the v5 API.
      "react-router-dom": "react-router",
    },
  },
  define: {
    // Prevent build errors from packages that reference __filename
    __filename: "'index.ts'",
  },
  optimizeDeps: {
    // noDiscovery + the full include list below: pre-bundle every dependency
    // exactly once at startup and never re-run the optimizer mid-session.
    // Discovery-based optimization re-bundles react under a new hash whenever a
    // not-yet-seen import shows up (e.g. the first client-side navigation to a
    // lazy route), which strands the open page on the old hash — a second React
    // instance whose dispatcher is null → "Cannot read properties of null
    // (reading 'useContext')". With discovery off, the optimizer cannot rerun.
    noDiscovery: true,
    // A transitive dep drags in react-router-dom@5 (Docusaurus-era), which the
    // app never imports. pnpm mis-links it against react-router@7, so pre-bundling
    // it explodes on missing v5 exports (Switch/useHistory/…). Skip it entirely.
    exclude: ["react-router-dom"],
    // Pre-bundle framer-motion + recharts at startup: both are imported by
    // shared/lazy components but were discovered only mid-session, which made
    // the dep optimizer re-run while pages were open, delete the old bundles,
    // and leave the open page with 504'd chunks + a duplicate React instance
    // (the "Cannot read properties of null (reading 'useContext')" crash).
    // Recharts (dashboard + admin charts) must resolve against the SAME
    // optimized React as the app or lazy-mounting it crashes with an invalid
    // hook call.
    include: [
      // Same rationale as above, extended to every route-only dependency the
      // static scan cannot see (lazy routes): if any of these is discovered
      // mid-session the optimizer re-bundles react under a new hash while the
      // open page still holds the old one → duplicate React → "Cannot read
      // properties of null (reading 'useContext')" on the next client-side
      // navigation. Pre-bundling them all at startup keeps the first visit to
      // chat / council / workflows / dashboard crash-free.
      // Every remaining direct dependency that only route modules import is
      // listed below so the crawler cannot discover any of them mid-session.
      "framer-motion",
      "recharts",
      "@ai-sdk/react",
      "ai",
      "react-markdown",
      "remark-gfm",
      "echarts",
      "echarts-for-react",
      "@tanstack/react-table",
      "@xyflow/react",
      "papaparse",
      "@monaco-editor/react",
      "date-fns",
      "lucide-react",
      "radix-ui",
      "class-variance-authority",
      "clsx",
      "tailwind-merge",
      // CSS-only; never a JS import, so it cannot be pre-bundled.
      // ("tw-animate-css")
      "@lobehub/icons",
      "@lobehub/ui",
      "react-is",
      "isbot",
      "lodash-es",
      "nanoid",
      "zod",
      // React itself: with noDiscovery the crawler is off, so react and its
      // runtimes must be explicit or nothing pre-bundles them.
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "react-router",
      "@remix-run/router",
    ],
  },
  server: {
    port: 5173,
    host: "127.0.0.1",
    // Poll instead of inotify/ReadDirectoryChangesW: this repo lives on a
    // junction-relocated tree where the native watcher silently dies, leaving
    // the dev server serving stale modules after edits (observed: HMR ws 400s
    // and edits never reaching the browser until a full server restart).
    watch: {
      usePolling: true,
      interval: 300,
    },
    // Proxy all /api/* calls to the Nexus API backend in dev mode.
    // In production this is handled by nginx: location /api/ { proxy_pass ... }
    proxy: {
      // "/api/" (trailing slash) — NOT "/api": UI routes like /api-tokens,
      // /api/auth/* start with /api but are app pages, not backend endpoints.
      "/api/": {
        target: API_TARGET,
        changeOrigin: true,
      },
      // Proxy /health and /health/* to the API for the status page
      "/health": {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
});
