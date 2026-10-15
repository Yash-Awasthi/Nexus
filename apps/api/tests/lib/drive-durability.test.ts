// SPDX-License-Identifier: Apache-2.0
/** A drive lost with the instance's disk comes back from its newest backup, never as an empty one. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, expect, it } from "vitest";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-durable-"));
process.env.NEXUS_DRIVE_ROOT = path.join(root, "drives");

const { tarGzDirectory, userDrivePath } = await import("@nexus/sandbox");
const { ensureDrive } = await import("../../src/lib/drive-durability.ts");

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function packed(files: Record<string, string>): Promise<Buffer> {
  const src = await fs.mkdtemp(path.join(root, "src-"));
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(src, name)), { recursive: true });
    await fs.writeFile(path.join(src, name), body);
  }
  const chunks: Buffer[] = [];
  for await (const c of tarGzDirectory(src, () => false)) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function bucket(objects: Record<string, Buffer>, fail = false) {
  const calls: string[] = [];
  return {
    calls,
    store: {
      list: async (prefix: string) => {
        calls.push(`list ${prefix}`);
        if (fail) throw new Error("S3 GET 503");
        return Object.keys(objects)
          .filter((k) => k.startsWith(prefix))
          .map((key) => ({ key, at: 0 }));
      },
      get: async (key: string) => objects[key] ?? null,
      put: async () => {},
      remove: async () => {},
    },
  };
}

it("restores a missing drive from its newest backup", async () => {
  const dirName = path.basename(userDrivePath("user-a"));
  const b = bucket({
    [`drives/${dirName}/2026-10-01T00-00-00-000Z.tar.gz`]: await packed({ "notes.md": "old" }),
    [`drives/${dirName}/2026-10-15T00-00-00-000Z.tar.gz`]: await packed({ "notes.md": "new" }),
  });
  const dir = await ensureDrive("user-a", b.store);
  expect(await fs.readFile(path.join(dir, "notes.md"), "utf8")).toBe("new");

  await ensureDrive("user-a", b.store);
  expect(b.calls).toHaveLength(1);
});

it("refuses to stand up an empty drive when the backup cannot be read", async () => {
  const b = bucket({}, true);
  await expect(ensureDrive("user-b", b.store)).rejects.toThrow(/503/);
  await expect(fs.access(userDrivePath("user-b"))).rejects.toThrow();
});

it("starts an empty drive for an account with no backup", async () => {
  const dir = await ensureDrive("user-c", bucket({}).store);
  expect(await fs.readdir(dir)).toEqual([]);
});
