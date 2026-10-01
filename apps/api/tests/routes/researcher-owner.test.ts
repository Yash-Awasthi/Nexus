// SPDX-License-Identifier: Apache-2.0
/** A research run is found only by the account that made it. */
import { describe, it, expect } from "vitest";

const { loadRun, persistRun } = await import("../../src/routes/researcher.js");

describe("research runs", () => {
  it("are read back only by their owner", async () => {
    await persistRun({
      runId: "run-owned",
      ownerId: "alice",
      query: "alice's due diligence",
      finding: {} as never,
      citations: [],
      createdAt: new Date().toISOString(),
    });
    expect((await loadRun("run-owned", "alice"))?.query).toBe("alice's due diligence");
    expect(await loadRun("run-owned", "bob")).toBeNull();
  });
});

describe("POST /researcher/research without a search backend", () => {
  it("says what it needs instead of returning a placeholder result", async () => {
    const Fastify = (await import("fastify")).default;
    const { researcherRoutes } = await import("../../src/routes/researcher.js");
    const app = Fastify();
    await app.register(researcherRoutes);
    await app.ready();
    const r = await app.inject({
      method: "POST",
      url: "/researcher/research",
      payload: { query: "anything" },
    });
    expect(r.statusCode).toBe(503);
    expect(r.body).not.toContain("example.com");
    await app.close();
  });
});
