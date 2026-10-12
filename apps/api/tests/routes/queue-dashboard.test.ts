// SPDX-License-Identifier: Apache-2.0
/**
 * The BullMQ dashboard is a browser page, so it is guarded by HTTP Basic auth rather than the
 * API's bearer tokens; without the password configured it is not mounted at all.
 */
import { afterAll, expect, it, vi } from "vitest";

// No Redis in unit tests; Bull Board accepts any queue that reports a bullmq version.
vi.mock("bullmq", () => ({
  Queue: vi.fn(function (this: object, name: string) {
    return Object.assign(this, {
      name,
      metaValues: { version: "bullmq:6" },
      close: vi.fn(async () => {}),
    });
  }),
}));

process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.NEXUS_QUEUE_DASHBOARD_PASSWORD = "board-secret";
const { buildServer } = await import("../../src/server.ts");
const { basicAuthMatches } = await import("../../src/routes/queue-dashboard.ts");

const app = await buildServer();
afterAll(async () => {
  await app.close();
  delete process.env.NEXUS_QUEUE_DASHBOARD_PASSWORD;
});

const basic = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

it("asks for Basic credentials", async () => {
  const res = await app.inject({ method: "GET", url: "/admin/queues" });
  expect(res.statusCode).toBe(401);
  expect(res.headers["www-authenticate"]).toContain("Basic");
});

it("rejects a wrong password", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/admin/queues",
    headers: { authorization: basic("admin", "nope") },
  });
  expect(res.statusCode).toBe(401);
});

it("serves the dashboard to admin with the configured password", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/admin/queues",
    headers: { authorization: basic("admin", "board-secret") },
  });
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toContain("text/html");
});

it("matches only the exact admin credentials", () => {
  expect(basicAuthMatches(basic("admin", "board-secret"), "board-secret")).toBe(true);
  expect(basicAuthMatches(basic("root", "board-secret"), "board-secret")).toBe(false);
  expect(basicAuthMatches("Bearer board-secret", "board-secret")).toBe(false);
  expect(basicAuthMatches(undefined, "board-secret")).toBe(false);
});
