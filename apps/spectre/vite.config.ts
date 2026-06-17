// SPDX-License-Identifier: Apache-2.0
import path from "path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Point directly to source so parseltongue doesn't need a separate build step
      "@nexus/parseltongue": path.resolve(__dirname, "../../packages/parseltongue/src/index.ts"),
      "@nexus/client": path.resolve(__dirname, "../../packages/client/src/index.ts"),
    },
  },
  server: {
    port: 5174,
    proxy: {
      "/api": "http://localhost:3000",
      "/health": "http://localhost:3000",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
