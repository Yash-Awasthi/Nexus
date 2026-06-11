// SPDX-License-Identifier: Apache-2.0
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      2,
      "always",
      [
        "runtime", "council", "governance", "db", "memory", "auth",
        "shared", "contracts", "plugin-sdk", "pipeline-signal", "telemetry",
        "api", "worker", "web", "cli", "docs-site",
        "adapter-slack", "adapter-github", "adapter-linear", "adapter-gmail",
        "adapter-calendar", "adapter-drive", "adapter-neon", "adapter-supabase",
        "adapter-vercel", "adapter-cloudflare", "adapter-doppler", "adapter-betterstack",
        "adapter-groq", "adapter-tavily", "adapter-ingest", "adapter-council",
        "ingest", "infra", "ci", "release", "deps", "root"
      ],
    ],
    "body-max-line-length": [1, "always", 120],
  },
};
