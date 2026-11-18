// The inspector's page: one prebuilt file, `dist/inspect/app.js` in board's package, which the
// standalone CLI reads where board is installed.
import { readFile } from 'node:fs/promises'

/**
 * Next to the CLI in `dist`, or in `dist` when running from source. A bundler that copies files a
 * module names this way (Next.js's Turbopack) copies the first, which is in the package, and
 * fails on a name it can't find: so the second, which is only in a checkout, is put together at run time.
 */
const FILES = [new URL('./inspect/app.js', import.meta.url), new URL(['..', '..', 'dist', 'inspect', 'app.js'].join('/'), import.meta.url)]

/** The page's script where board is installed, or null when there's none beside it. */
export async function page(): Promise<string | null> {
  for (const file of FILES) {
    const script = await readFile(file, 'utf8').catch(() => null)
    if (script !== null) return script
  }
  return null
}
