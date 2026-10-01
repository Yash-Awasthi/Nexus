// SPDX-License-Identifier: Apache-2.0
/**
 * A gzipped ustar archive of a directory, streamed file by file. Regular files
 * and directories only: symlinks are skipped, never followed.
 */

import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";

const BLOCK = 512;

/** ustar keeps a 100-byte name and a 155-byte prefix, split at a "/". */
function splitName(name: string): { prefix: string; base: string } | null {
  if (Buffer.byteLength(name) <= 100) return { prefix: "", base: name };
  for (let i = name.indexOf("/"); i !== -1; i = name.indexOf("/", i + 1)) {
    const prefix = name.slice(0, i);
    const base = name.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(base) <= 100) return { prefix, base };
  }
  return null;
}

function header(name: string, size: number, mtime: Date, dir: boolean): Buffer | null {
  const split = splitName(name);
  if (!split) return null;
  const h = Buffer.alloc(BLOCK);
  const put = (value: string, at: number, len: number) => h.write(value, at, len, "utf8");
  const octal = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
  put(split.base, 0, 100);
  put(octal(dir ? 0o755 : 0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(Math.floor(mtime.getTime() / 1000), 12), 136, 12);
  put("        ", 148, 8);
  put(dir ? "5" : "0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  put(split.prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

async function* entries(
  root: string,
  rel: string,
  skip: (name: string) => boolean,
): AsyncGenerator<Buffer> {
  const dirents = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  dirents.sort((a, b) => a.name.localeCompare(b.name));
  for (const d of dirents) {
    if (skip(d.name)) continue;
    const name = rel ? `${rel}/${d.name}` : d.name;
    const full = path.join(root, name);
    if (d.isDirectory()) {
      const st = await fs.stat(full);
      const h = header(`${name}/`, 0, st.mtime, true);
      if (h) yield h;
      yield* entries(root, name, skip);
    } else if (d.isFile()) {
      const st = await fs.stat(full);
      // ponytail: a path past ustar's 255 bytes is left out; PAX headers would carry it.
      const h = header(name, st.size, st.mtime, false);
      if (!h) continue;
      yield h;
      // Exactly the size the header promised, even if the file changes while it is read.
      let written = 0;
      if (st.size > 0) {
        for await (const chunk of createReadStream(full, {
          end: st.size - 1,
        }) as AsyncIterable<Buffer>) {
          written += chunk.length;
          yield chunk;
        }
      }
      if (written < st.size) yield Buffer.alloc(st.size - written);
      const pad = (BLOCK - (st.size % BLOCK)) % BLOCK;
      if (pad) yield Buffer.alloc(pad);
    }
  }
}

async function* archive(root: string, skip: (name: string) => boolean): AsyncGenerator<Buffer> {
  yield* entries(root, "", skip);
  yield Buffer.alloc(BLOCK * 2);
}

/** `root` as a .tar.gz stream; `skip` drops any file or directory by name. */
export function tarGzDirectory(root: string, skip: (name: string) => boolean): Readable {
  return Readable.from(archive(root, skip)).pipe(createGzip());
}
