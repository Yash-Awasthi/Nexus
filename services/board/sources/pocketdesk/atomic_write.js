import fs from "node:fs";

// Temp file + rename: a crash mid-write leaves the old file intact, never a truncated one.
export function writeFileAtomic(file, data, options) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, data, options);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
