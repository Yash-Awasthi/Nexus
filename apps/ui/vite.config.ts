// SPDX-License-Identifier: Apache-2.0
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { resolve } from "path";

const API_TARGET = process.env.NEXUS_API_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    // Deduplicate React so pnpm's nested copies don't hand radix-ui / lobehub a
    // second React instance (its dispatcher is null → "Cannot read properties of
    // null (reading 'useRef')" on every dialog-based Configuration page).
    dedupe: ["react", "react-dom"],
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
    // A transitive dep drags in react-router-dom@5 (Docusaurus-era), which the
    // app never imports. pnpm mis-links it against react-router@7, so pre-bundling
    // it explodes on missing v5 exports (Switch/useHistory/…). Skip it entirely.
    exclude: ["react-router-dom"],
  },
  server: {
    port: 5173,
    // Proxy all /api/* calls to the Nexus API backend in dev mode.
    // In production this is handled by nginx: location /api/ { proxy_pass ... }
    proxy: {
      "/api": {
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
