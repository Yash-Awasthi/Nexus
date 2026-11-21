// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vite-plus";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      "~": resolve(import.meta.dirname, "./app"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["tests/**/*.test.ts"],
  },
});
