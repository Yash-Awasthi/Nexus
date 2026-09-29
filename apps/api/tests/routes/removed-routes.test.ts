// SPDX-License-Identifier: Apache-2.0
/** Features that were removed stay removed: none of their routes answer. */
import fs from "node:fs";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { buildServer } = await import("../../src/server.js");

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe("removed features", () => {
  it.each([
    ["GET", "/api/v1/code-repl/sessions"],
    ["GET", "/api/v1/obs/memories"],
    ["POST", "/api/v1/obs/store"],
    ["POST", "/api/v1/autopilot/run"],
    ["GET", "/api/v1/intelligence-hub"],
    ["GET", "/api/v1/orchestration/runs"],
    ["GET", "/api/v1/sse/tasks"],
    ["GET", "/api/v1/sse/signals"],
    ["GET", "/api/v1/sse/verdicts"],
    ["POST", "/api/images/generate"],
    ["GET", "/api/images/providers"],
    ["PUT", "/api/memory/backend"],
    ["POST", "/api/godmode/stream"],
    ["POST", "/api/gauntlet/stream"],
    ["POST", "/api/drift/optimize"],
    ["POST", "/api/v1/drift/compute"],
    ["GET", "/api/simulate/personas"],
    ["GET", "/api/simulate/runs"],
    ["POST", "/api/honesty/reframe"],
    ["GET", "/api/verifiable/info"],
    ["POST", "/api/reasoning/run"],
    ["GET", "/api/symbolic/stats"],
    ["GET", "/api/sop"],
    ["GET", "/api/craft"],
    ["POST", "/api/codegen/generate"],
    ["GET", "/api/council-checkpoints/runs/r1"],
    ["GET", "/api/imr/runs"],
    ["POST", "/api/blind-council/deliberate"],
    ["POST", "/api/prompt-filter/check"],
    ["GET", "/api/member-evolution"],
    ["POST", "/api/cross-memory/retrieve"],
    ["GET", "/api/verbosity/levels"],
    ["GET", "/api/token-conservation/status"],
    ["POST", "/api/skill-selection/select"],
    ["GET", "/api/task-routing/stats"],
    ["GET", "/api/fallback-chains"],
    ["GET", "/api/semantic-cache/stats"],
    ["GET", "/api/extraction/jobs"],
    ["POST", "/api/web-scraping/scrape"],
    ["POST", "/api/web-search"],
    ["GET", "/api/rss/feeds"],
    ["GET", "/api/rooms"],
    ["GET", "/api/contacts"],
    ["POST", "/api/v1/voice/synthesize"],
    ["GET", "/api/v1/image-gen/models"],
    ["GET", "/api/image-transformations/providers"],
    ["POST", "/api/video/transcript"],
    ["POST", "/api/video/search"],
    ["GET", "/api/v1/evals/scorers"],
    ["POST", "/api/fine-tune/initiate"],
    ["POST", "/api/evaluate"],
    ["GET", "/api/repos"],
    ["GET", "/api/v1/gs/jobs"],
    ["GET", "/api/session-graph"],
    ["GET", "/api/v1/knowledge-graph/nodes"],
    ["GET", "/api/v1/domain-feeds/intel/status"],
    ["POST", "/api/negation/detect"],
    ["POST", "/api/echo-chamber/detect"],
    ["GET", "/api/echo-chamber/config"],
    ["POST", "/api/specialisation/detect"],
    ["GET", "/api/sso/config"],
    ["GET", "/api/mfa/status"],
    ["GET", "/api/scim/Users"],
    ["GET", "/api/tenants"],
    ["GET", "/api/whitelabel/config"],
    ["GET", "/api/data-residency/config"],
    ["GET", "/api/webhooks"],
    ["GET", "/api/artifacts"],
    ["GET", "/api/branches"],
    ["GET", "/api/subgraphs"],
    ["POST", "/api/debug/analyze"],
    ["GET", "/api/citations/history"],
  ] as const)("%s %s answers 404", async (method, url) => {
    const r = await app.inject({ method, url, headers: { authorization: "Bearer test" } });
    expect(r.statusCode).toBe(404);
  });

  it.each([
    "agent-orchestrator",
    "corpus-builder",
    "obs-providers",
    "intelligence-hub",
    "run-cost",
    "evals",
    "image-gen",
    "image-transformations",
    "supervisor",
    "video-search",
    "voice",
    "domain-feeds",
  ])("package %s is gone", (name) => {
    expect(fs.existsSync(path.resolve(__dirname, "../../../../packages", name))).toBe(false);
  });
});
