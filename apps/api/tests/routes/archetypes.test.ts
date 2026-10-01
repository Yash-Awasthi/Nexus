// SPDX-License-Identifier: Apache-2.0
/**
 * Stage D1 — the /archetypes surface, moved out of api-bridge.ts into a
 * durable per-user registry.
 *
 * These tests run against the shared process store, so each one creates its own
 * archetype and cleans it up rather than asserting on the whole collection.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../../src/server.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

interface ArchetypeBody {
  id: string;
  name: string;
  builtin: boolean;
  ownerId: string;
  model?: string;
  temperature?: number;
  systemPrompt: string;
}

async function create(overrides: Record<string, unknown> = {}): Promise<ArchetypeBody> {
  const res = await app.inject({
    method: "POST",
    url: "/api/archetypes",
    payload: {
      name: `Test Archetype ${Math.random().toString(36).slice(2, 8)}`,
      thinkingStyle: "Test-first",
      description: "Created by the archetype route tests.",
      systemPrompt: "You are a test archetype.",
      ...overrides,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json<ArchetypeBody>();
}

describe("GET /api/archetypes", () => {
  it("lists the seeded built-in personas", async () => {
    const res = await app.inject({ method: "GET", url: "/api/archetypes" });
    expect(res.statusCode).toBe(200);
    const { archetypes } = res.json<{ archetypes: ArchetypeBody[] }>();
    const architect = archetypes.find((a) => a.id === "architect");
    expect(architect?.builtin).toBe(true);
    expect(architect?.systemPrompt).toContain("You are The Architect");
  });

  it("returns only the caller's own rows when custom=true", async () => {
    const mine = await create();
    const res = await app.inject({ method: "GET", url: "/api/archetypes?custom=true" });
    const { archetypes } = res.json<{ archetypes: ArchetypeBody[] }>();
    expect(archetypes.every((a) => !a.builtin)).toBe(true);
    expect(archetypes.some((a) => a.id === mine.id)).toBe(true);

    await app.inject({ method: "DELETE", url: `/api/archetypes/${mine.id}` });
  });
});

describe("POST /api/archetypes", () => {
  it("keeps the model and temperature the caller assigned", async () => {
    const created = await create({ model: "claude-sonnet-4-6", temperature: 0.2 });
    expect(created.model).toBe("claude-sonnet-4-6");
    expect(created.temperature).toBe(0.2);
    expect(created.builtin).toBe(false);

    await app.inject({ method: "DELETE", url: `/api/archetypes/${created.id}` });
  });

  it("ignores caller-supplied ownership fields", async () => {
    const created = await create({ id: "spoofed", ownerId: "someone-else", builtin: true });
    expect(created.id).not.toBe("spoofed");
    expect(created.ownerId).not.toBe("someone-else");
    expect(created.builtin).toBe(false);

    await app.inject({ method: "DELETE", url: `/api/archetypes/${created.id}` });
  });
});

describe("updating an archetype", () => {
  // StoreContext.tsx sends PATCH and archetypes.tsx sends PUT; only PUT existed
  // on the bridge, so every StoreContext edit silently 404'd.
  for (const method of ["PUT", "PATCH"] as const) {
    it(`accepts ${method}`, async () => {
      const created = await create();
      const res = await app.inject({
        method,
        url: `/api/archetypes/${created.id}`,
        payload: { name: "Renamed", model: "gpt-4o" },
      });
      expect(res.statusCode).toBe(200);
      const updated = res.json<ArchetypeBody>();
      expect(updated.name).toBe("Renamed");
      expect(updated.model).toBe("gpt-4o");
      expect(updated.systemPrompt).toBe("You are a test archetype.");

      await app.inject({ method: "DELETE", url: `/api/archetypes/${created.id}` });
    });
  }

  it("404s on an unknown id", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/archetypes/does-not-exist",
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("refuses to edit a built-in persona", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/archetypes/architect",
      payload: { name: "Hijacked" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toBe("readonly");
  });
});

describe("DELETE /api/archetypes/:id", () => {
  it("removes a custom archetype", async () => {
    const created = await create();
    const res = await app.inject({ method: "DELETE", url: `/api/archetypes/${created.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean }>().ok).toBe(true);

    const list = await app.inject({ method: "GET", url: "/api/archetypes?custom=true" });
    const { archetypes } = list.json<{ archetypes: ArchetypeBody[] }>();
    expect(archetypes.some((a) => a.id === created.id)).toBe(false);
  });

  it("refuses to delete a built-in persona", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/archetypes/contrarian" });
    expect(res.statusCode).toBe(403);
  });
});
