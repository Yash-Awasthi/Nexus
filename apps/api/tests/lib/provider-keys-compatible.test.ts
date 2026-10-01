// SPDX-License-Identifier: Apache-2.0
/**
 * A named OpenAI-compatible connection (base URL plus default model) becomes a
 * driver under its own name, and its endpoint must pass the SSRF guard.
 */
import crypto from "node:crypto";
import http from "node:http";

import { describe, it, expect, beforeAll, afterAll } from "vitest";

const DB = "pglite://:memory:provider-keys-compatible";
process.env.DATABASE_URL = DB;
process.env.NEXUS_SECRETS_KEY = "ab".repeat(32);

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.js");
const { buildUserDriverRegistry, compatibleEndpointError } =
  await import("../../src/lib/provider-keys.js");
const { encryptSecret } = await import("../../src/lib/secret-crypto.js");
const { db } = await import("@nexus/db");
const { userProviderCredentials } = await import("@nexus/db/schema");

const USER = crypto.randomUUID();

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
}, 120_000);

afterAll(async () => {
  await closePgPools();
});

async function save(provider: string, baseUrl: string, models: string[]) {
  await db.insert(userProviderCredentials).values({
    userId: USER,
    provider,
    encryptedKey: encryptSecret("tr-test-key-0123456789"),
    baseUrl,
    models,
  });
}

describe("OpenAI-compatible provider keys", () => {
  it("register under their own name with the first model as default", async () => {
    await save("tokenrouter", "https://api.tokenrouter.com/v1", ["stealth/union-alpha"]);
    const { registry, missing } = await buildUserDriverRegistry(USER, ["tokenrouter"]);
    expect(missing).toEqual([]);
    const driver = registry.get("tokenrouter");
    expect(driver?.provider).toBe("tokenrouter");
    expect(driver?.model).toBe("stealth/union-alpha");
  });

  it("call through the pinned fetch, so a private endpoint is refused at call time", async () => {
    await save("sneaky", "http://127.0.0.1:9/v1", ["m"]);
    const driver = (await buildUserDriverRegistry(USER, ["sneaky"])).registry.get("sneaky");
    const call = driver!.complete({ model: "m", messages: [{ role: "user", content: "hi" }] });
    await expect(call).rejects.toThrow(/SSRF guard/);
  });

  it("refuse a private or malformed base URL, a built-in name, or no default model", async () => {
    expect(
      await compatibleEndpointError("tokenrouter", "https://api.tokenrouter.com/v1", ["m"]),
    ).toBeNull();
    expect(await compatibleEndpointError("tokenrouter", "http://10.0.0.1/v1", ["m"])).toMatch(
      /unsafe/i,
    );
    expect(await compatibleEndpointError("tokenrouter", "file:///etc/passwd", ["m"])).toMatch(
      /unsafe/i,
    );
    expect(await compatibleEndpointError("groq", "https://api.tokenrouter.com/v1", ["m"])).toMatch(
      /built-in/,
    );
    expect(
      await compatibleEndpointError("Bad Name", "https://api.tokenrouter.com/v1", ["m"]),
    ).toMatch(/name/);
    expect(
      await compatibleEndpointError("tokenrouter", "https://api.tokenrouter.com/v1", []),
    ).toMatch(/model/);
  });

  it("on the desktop reach a local server such as Ollama, with no key", async () => {
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: `local ${req.url}` } }] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    process.env.NEXUS_DESKTOP = "1";
    try {
      expect(compatibleEndpointError("ollama", baseUrl, ["llama3.2:1b"])).toBeNull();
      await db
        .insert(userProviderCredentials)
        .values({ userId: USER, provider: "ollama", baseUrl, models: ["llama3.2:1b"] });
      const driver = (await buildUserDriverRegistry(USER, ["ollama"])).registry.get("ollama");
      const out = await driver!.complete({
        model: "llama3.2:1b",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(out.content).toBe("local /v1/chat/completions");
    } finally {
      delete process.env.NEXUS_DESKTOP;
      server.close();
    }
  });
});
