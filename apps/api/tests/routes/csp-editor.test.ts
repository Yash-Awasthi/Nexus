// SPDX-License-Identifier: Apache-2.0
/** The prompt editor (Monaco) loads its stylesheet and icon font from jsDelivr; the CSP must let them in. */
import { expect, it, vi } from "vitest";

vi.mock("@nexus/db", () => ({ db: { execute: vi.fn().mockResolvedValue([]) } }));
vi.mock("pg", () => {
  class FakePool {
    query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    on = vi.fn().mockReturnThis();
    end = vi.fn().mockResolvedValue(undefined);
  }
  return { Pool: FakePool };
});

const { buildServer } = await import("../../src/server.ts");

it("allows the editor's stylesheet and font from jsDelivr", async () => {
  const app = await buildServer();
  await app.ready();
  const csp = String(
    (await app.inject({ method: "GET", url: "/health" })).headers["content-security-policy"],
  );
  await app.close();
  expect(csp).toMatch(/style-src [^;]*https:\/\/cdn\.jsdelivr\.net\/npm\//);
  expect(csp).toMatch(/font-src [^;]*https:\/\/cdn\.jsdelivr\.net\/npm\//);
});
