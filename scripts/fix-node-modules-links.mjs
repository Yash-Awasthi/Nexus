// SPDX-License-Identifier: Apache-2.0
/**
 * Repair node_modules symlinks whose targets still point at a pre-move
 * absolute location (e.g. after relocating this checkout, every pnpm
 * intra-store symlink still embeds the old absolute path and module
 * resolution fails with ERR_MODULE_NOT_FOUND / "Cannot find package").
 *
 * For each symlink under node_modules whose target does not resolve:
 *   1. rewrite the old checkout prefix (OLD_ROOT) with the current one when
 *      the rewritten target exists;
 *   2. otherwise rebuild the target relative to the symlink's own directory
 *      by package name — sibling packages live under
 *      node_modules/.pnpm/<pkg>@<ver>/node_modules/<name>.
 *
 * Dry-run by default: pass --apply to write changes.
 *
 * Usage:  node scripts/fix-node-modules-links.mjs [--apply]
 */

import fs from "node:fs";
import path from "node:path";

const APPLY = process.argv.includes("--apply");
const ROOT = process.cwd();
const NODE_MODULES = path.join(ROOT, "node_modules");
const PNPM_DIR = path.join(NODE_MODULES, ".pnpm");

// Default assumption for this repo's history: the checkout moved from
// <repo-parent>\Desktop\PROJECTS\... to its current location, so the stale
// prefix is the current root with "Desktop" inserted before "PROJECTS".
// Override with OLD_ROOT env var for any other layout.
function defaultOldRoot(root) {
  const sep = path.sep;
  const seg = root.split(sep);
  if (seg.length < 4) return null;
  const head = seg.slice(0, seg.length - 3);
  const tail = seg.slice(seg.length - 3);
  return [...head, "Desktop", ...tail].join(sep);
}
const OLD_ROOT = process.env.OLD_ROOT ?? defaultOldRoot(ROOT);

let scanned = 0;
let dead = 0;
let fixed = 0;
let unfixable = 0;

function statNoFollow(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function resolves(target, linkDir) {
  const abs = path.isAbsolute(target) ? target : path.join(linkDir, target);
  try {
    fs.statSync(abs);
    return true;
  } catch {
    return false;
  }
}

/** Try to find <pkg>@<ver> store dirs for a package name. */
function storeDirsFor(name) {
  const enc = name.replace("/", "+");
  let out = [];
  try {
    out = fs.readdirSync(PNPM_DIR).filter((d) => d === `${enc}@` || d.startsWith(`${enc}@`));
  } catch {
    return [];
  }
  return out;
}

function relinkTargetFor(name) {
  const candidates = storeDirsFor(name);
  if (candidates.length === 0) return null;
  // Highest version last after sort; prefer the one without peer suffixes.
  candidates.sort();
  const dir = candidates[candidates.length - 1];
  const dest = path.join(PNPM_DIR, dir, "node_modules", name);
  try {
    fs.statSync(dest);
    return dest;
  } catch {
    return null;
  }
}

function walk(dir, depth) {
  if (depth > 6) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      scanned++;
      const raw = fs.readlinkSync(p);
      const target = raw.startsWith("\\\\?\\") ? raw.slice(4) : raw;
      if (resolves(target, path.dirname(p))) continue;
      dead++;
      const linkDir = path.dirname(p);
      let newTarget = null;
      // 1) prefix rewrite
      if (target.includes(OLD_ROOT)) {
        const rewritten = target.split(OLD_ROOT).join(ROOT);
        if (resolves(rewritten, linkDir)) newTarget = rewritten;
      }
      // 2) rebuild by package name from the store
      if (newTarget === null) {
        const rel = path.relative(NODE_MODULES, linkDir); // e.g. ".pnpm\vite@5/node_modules/@vitest" or "" for top-level
        const name = path.basename(p);
        const scope =
          path.basename(linkDir) === "@scope" || path.basename(linkDir).startsWith("@")
            ? path.basename(linkDir) + "/" + name
            : name;
        const candidate = relinkTargetFor(scope);
        if (candidate !== null) newTarget = candidate;
      }
      if (newTarget === null) {
        unfixable++;
        if (process.env.VERBOSE) console.log("unfixable:", p, "->", target);
        continue;
      }
      fixed++;
      if (APPLY) {
        fs.unlinkSync(p);
        fs.symlinkSync(newTarget, p, "junction");
      }
    } else if (e.isDirectory()) {
      walk(p, depth + 1);
    }
  }
}

if (!fs.existsSync(NODE_MODULES)) {
  console.error("no node_modules here:", NODE_MODULES);
  process.exit(1);
}
walk(NODE_MODULES, 0);
console.log({ scanned, dead, fixed, unfixable, apply: APPLY });
if (dead > 0 && !APPLY) {
  console.log("dry run — re-run with --apply to rewrite links");
}
process.exit(unfixable > 0 ? 1 : 0);
