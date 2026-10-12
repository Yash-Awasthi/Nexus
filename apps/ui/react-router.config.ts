// SPDX-License-Identifier: Apache-2.0
import type { Config } from "@react-router/dev/config";

export default {
  // SPA mode — served as static files by nginx in production.
  // SSR not needed since all data fetching is client-side via /api/*.
  ssr: false,
  future: {
    v8_middleware: true,
    v8_splitRouteModules: true,
    v8_viteEnvironmentApi: true,
    v8_passThroughRequests: true,
    v8_trailingSlashAwareDataRequests: true,
  },
} satisfies Config;
