// SPDX-License-Identifier: Apache-2.0
import { resolve } from "path";

import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "~": resolve(import.meta.dirname, "./app"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
