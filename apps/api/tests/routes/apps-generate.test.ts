// SPDX-License-Identifier: Apache-2.0
/**
 * App generation writes a themed starter into the caller's drive, with the design the model
 * chose from the fixed options, then runs the coding agent on it; the folder exports alone.
 */
import crypto from "node:crypto";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB = "pglite://:memory:apps-generate";
const SECRET = "apps-generate-test-secret";
const DRIVES = mkdtempSync(join(tmpdir(), "apps-generate-"));
process.env.DATABASE_URL = DB;
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_SECRETS_KEY = "cd".repeat(32);
process.env.NEXUS_DESKTOP = "1";
process.env.NEXUS_DRIVE_ROOT = DRIVES;
delete process.env.NEXUS_EXEC_MODE;
delete process.env.REDIS_URL;

const { userDrivePath } = await import("@nexus/sandbox");
const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { getPgPool } = await import("../../src/lib/pg-pool.js");
const { buildServer } = await import("../../src/server.js");
const { appFolderName, fallbackDesign, parseDesign, pickDesign, scaffoldApp } =
  await import("../../src/lib/app-scaffold.js");

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

describe("design and scaffold", () => {
  it("accepts only designs made of allowed options", () => {
    expect(parseDesign({ style: "bold", color: "teal", font: "lora", radius: "xl" })).toEqual({
      style: "bold",
      color: "teal",
      font: "lora",
      radius: "xl",
    });
    expect(parseDesign({ style: "bold", color: "neon", font: "lora", radius: "xl" })).toBeNull();
    expect(
      parseDesign({ style: "bold", color: "toString", font: "lora", radius: "xl" }),
    ).toBeNull();
  });

  it("falls back to a stable design when the model answers outside the options", async () => {
    const d = await pickDesign("a bakery site", async () => '{"style":"wild"}');
    expect(d).toEqual(fallbackDesign("a bakery site"));
    expect(parseDesign(d)).toEqual(d);
  });

  it("names folders by prompt and never overwrites an edited file", async () => {
    expect(appFolderName("u1", "A Bakery Site!")).toMatch(/^a-bakery-site-[0-9a-f]{6}$/);
    const dir = mkdtempSync(join(tmpdir(), "scaffold-"));
    const design = fallbackDesign("x");
    await scaffoldApp(dir, "x", design);
    await fs.writeFile(join(dir, "src/App.tsx"), "edited");
    await scaffoldApp(dir, "x", design);
    expect(readFileSync(join(dir, "src/App.tsx"), "utf8")).toBe("edited");
  });
});

describe("POST /apps/generate", () => {
  let app: FastifyInstance;
  let model: http.Server;
  const USER = crypto.randomUUID();

  beforeAll(async () => {
    await migrateEmbedded(getPgPool(DB)!);
    model = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const design = body.includes("Choose a visual design");
        const content = design
          ? '{"style":"brutalist","color":"teal","font":"lora","radius":"xl"}'
          : "all done";
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
    app = await buildServer();
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    model.close();
  });

  it("scaffolds the model's design into the drive, runs the agent and exports the folder", async () => {
    const auth = { authorization: `Bearer ${tokenFor(USER)}` };
    const port = (model.address() as { port: number }).port;
    const saved = await app.inject({
      method: "POST",
      url: "/api/user/provider-keys",
      headers: auth,
      payload: { provider: "localllm", baseUrl: `http://127.0.0.1:${port}/v1`, models: ["tiny"] },
    });
    expect(saved.statusCode, saved.body).toBe(201);

    const prompt = "a recipe box";
    const generate = (approvalId?: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/apps/generate",
        headers: auth,
        payload: {
          prompt,
          provider: "localllm",
          model: "tiny",
          sessionId: "recipe-app-01",
          approvalId,
        },
      });
    const { approvalId } = (await generate()).json<{ approvalId: string }>();
    expect(approvalId).toBeTruthy();
    await app.inject({
      method: "POST",
      url: `/api/v1/exec/approvals/${approvalId}/approve`,
      headers: auth,
    });
    const r = await generate(approvalId);
    expect(r.statusCode, r.body).toBe(202);

    const name = appFolderName(USER, prompt);
    expect(r.json()).toMatchObject({ app: `apps/${name}`, design: { color: "teal" } });
    const dir = join(userDrivePath(USER), "apps", name);
    const css = readFileSync(join(dir, "src/index.css"), "utf8");
    expect(css).toContain("#0d9488");
    expect(css).toContain("--color-card: var(--card);");
    expect(readFileSync(join(dir, "index.html"), "utf8")).toContain("family=Lora");

    const { sessionId } = r.json<{ sessionId: string }>();
    await expect
      .poll(
        async () => {
          const { rows } = await getPgPool(DB)!.query(
            "SELECT status FROM agent_sessions WHERE id = $1",
            [sessionId],
          );
          return rows[0]?.status;
        },
        { timeout: 20_000 },
      )
      .toBe("completed");

    await fs.mkdir(join(dir, "node_modules/x"), { recursive: true });
    const tar = await app.inject({
      method: "GET",
      url: `/api/v1/drive/export?dir=${encodeURIComponent(`apps/${name}`)}`,
      headers: auth,
    });
    expect(tar.statusCode).toBe(200);
    expect(tar.headers["content-disposition"]).toContain(`${name}.tar.gz`);
    const listing = gunzipSync(tar.rawPayload).toString("latin1");
    expect(listing).toContain("package.json");
    expect(listing).not.toContain("node_modules/");

    const escape = await app.inject({
      method: "GET",
      url: "/api/v1/drive/export?dir=../..",
      headers: auth,
    });
    expect(escape.statusCode).toBe(403);
  });
});
