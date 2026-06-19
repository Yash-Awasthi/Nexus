// SPDX-License-Identifier: Apache-2.0
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { resolve } from "path";

const API_TARGET = process.env.NEXUS_API_URL ?? "http://localhost:3001";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    alias: {
      "~": resolve(__dirname, "./app"),
    },
  },
  define: {
    // Prevent build errors from packages that reference __filename
    __filename: "'index.ts'",
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
    },
  },
});
