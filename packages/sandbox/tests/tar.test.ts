// SPDX-License-Identifier: Apache-2.0
/** A drive backup unpacks to the same files, and no archive can write outside its target. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { extractTarGz, tarGzDirectory } from "../src/tar.ts";

const made: string[] = [];
const tmp = async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-tar-"));
  made.push(d);
  return d;
};
afterEach(async () => {
  for (const d of made.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe("extractTarGz", () => {
  it("restores what tarGzDirectory packed, nested folders and empty files included", async () => {
    const src = await tmp();
    await fs.mkdir(path.join(src, "notes", "deep"), { recursive: true });
    await fs.writeFile(path.join(src, "readme.md"), "hello");
    await fs.writeFile(path.join(src, "notes", "deep", "big.bin"), Buffer.alloc(70_000, 7));
    await fs.writeFile(path.join(src, "notes", "empty.txt"), "");
    await fs.writeFile(path.join(src, ".env"), "SECRET=1");

    const dest = await tmp();
    await extractTarGz(
      tarGzDirectory(src, (n) => n === ".env"),
      dest,
    );

    expect(await fs.readFile(path.join(dest, "readme.md"), "utf8")).toBe("hello");
    expect(await fs.readFile(path.join(dest, "notes", "deep", "big.bin"))).toEqual(
      Buffer.alloc(70_000, 7),
    );
    expect(await fs.readFile(path.join(dest, "notes", "empty.txt"), "utf8")).toBe("");
    await expect(fs.access(path.join(dest, ".env"))).rejects.toThrow();
  });

  it("refuses an entry that climbs out of the target", async () => {
    const h = Buffer.alloc(512);
    h.write("../escaped.txt", 0);
    h.write("0000644\0", 100);
    h.write("00000000005\0", 124);
    h.write("0", 156);
    h.write("ustar\0", 257);
    const body = Buffer.concat([h, Buffer.from("owned"), Buffer.alloc(507), Buffer.alloc(1024)]);
    const dest = await tmp();
    await expect(extractTarGz(Readable.from([gzipSync(body)]), dest)).rejects.toThrow(/escapes/);
    await expect(fs.access(path.join(dest, "..", "escaped.txt"))).rejects.toThrow();
  });
});
