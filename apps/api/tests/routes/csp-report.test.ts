// SPDX-License-Identifier: Apache-2.0
/** NX-FEAT-013: browsers report CSP violations to the API, which logs them without query strings. */
import Fastify from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

import { cspReportRoutes, normalizeCspReports } from "../../src/routes/csp-report.ts";

const app = Fastify();

beforeAll(async () => {
  await app.register(cspReportRoutes, { prefix: "/api/v1" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

it("reads both the report-uri and the Reporting API formats, dropping query strings", () => {
  expect(
    normalizeCspReports({
      "csp-report": {
        "document-uri": "https://nexus.test/chat?token=secret",
        "effective-directive": "script-src-elem",
        "blocked-uri": "https://evil.example/x.js?k=v",
        "source-file": "https://nexus.test/assets/app.js",
        "line-number": 12,
      },
    }),
  ).toEqual([
    {
      document: "https://nexus.test/chat",
      directive: "script-src-elem",
      blocked: "https://evil.example/x.js",
      source: "https://nexus.test/assets/app.js",
      line: 12,
    },
  ]);
  expect(
    normalizeCspReports([
      {
        type: "csp-violation",
        body: {
          documentURL: "https://nexus.test/a#frag",
          effectiveDirective: "img-src",
          blockedURL: "inline",
        },
      },
      { type: "deprecation", body: {} },
    ]),
  ).toEqual([
    {
      document: "https://nexus.test/a",
      directive: "img-src",
      blocked: "inline",
      source: null,
      line: null,
    },
  ]);
  expect(normalizeCspReports("nonsense")).toEqual([]);
});

it("accepts both report content types without a session", async () => {
  for (const [type, body] of [
    ["application/csp-report", { "csp-report": { "effective-directive": "img-src" } }],
    [
      "application/reports+json",
      [{ type: "csp-violation", body: { effectiveDirective: "img-src" } }],
    ],
  ] as const) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/csp-report",
      headers: { "content-type": type },
      payload: JSON.stringify(body),
    });
    expect(res.statusCode, res.body).toBe(204);
  }
});

it("refuses an oversized report", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/csp-report",
    headers: { "content-type": "application/csp-report" },
    payload: JSON.stringify({ "csp-report": { "blocked-uri": "x".repeat(20_000) } }),
  });
  expect(res.statusCode).toBe(413);
});
