// SPDX-License-Identifier: Apache-2.0
/** On a host without Docker, drive commands run in the built-in shell, confined to the drive. */
import crypto from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const SECRET = "drive-shell-secret";
process.env.NEXUS_JWT_SECRET = SECRET;
const ROOT = mkdtempSync(path.join(tmpdir(), "drive-shell-"));
process.env.NEXUS_DRIVE_ROOT = ROOT;
delete process.env.ALLOW_UNSANDBOXED_EXEC;

vi.mock("@nexus/code-repl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nexus/code-repl")>()),
  isDockerAvailable: async () => false,
}));

const { buildServer } = await import("../../src/server.ts");
let app: FastifyInstance;

function auth(userId: string) {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return { authorization: `Bearer ${head}.${body}.${sig}` };
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

it("runs commands in the built-in shell, inside the drive only", async () => {
  const headers = auth(crypto.randomUUID());
  const status = await app.inject({ method: "GET", url: "/api/v1/drive/status", headers });
  expect(status.json()).toMatchObject({
    dockerAvailable: false,
    shell: "builtin",
  });
  const { root } = status.json<{ root: string }>();

  const exec = (command: string, cwd?: string) =>
    app.inject({
      method: "POST",
      url: "/api/v1/drive/exec",
      headers,
      payload: { command, ...(cwd ? { cwd } : {}) },
    });
  const made = await exec(
    "mkdir -p notes && echo hello > notes/a.txt && cp notes/a.txt notes/b.txt",
  );
  expect(made.statusCode, made.body).toBe(200);
  expect(made.json()).toMatchObject({ exitCode: 0, timedOut: false });
  expect(readFileSync(path.join(root, "notes", "b.txt"), "utf8")).toBe("hello\n");

  const inside = await exec("pwd && cat b.txt | tr a-z A-Z", "notes");
  expect(inside.json()).toMatchObject({ stdout: "/notes\nHELLO", exitCode: 0 });

  const escape = await exec("cat ../../../../etc/hostname; echo x > ../../../outside.txt; ls /");
  expect(escape.json().stdout).toBe("notes\noutside.txt");
}, 60_000);
