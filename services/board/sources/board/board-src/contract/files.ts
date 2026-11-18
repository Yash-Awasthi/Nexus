// The sizes a file can be, here so a client reads them without zod.
/** Under Vercel Functions' 4.5 MB request body limit, so an upload fits in one request. */
export const ATTACHMENT_BYTES_MAX = 4 * 1024 * 1024
/**
 * The most a file sync brings over from a platform can be. Sync fetches it on the server and
 * stores it in-process, so no request carries it and the request limit doesn't apply: this bounds
 * what one import holds in memory.
 */
export const IMPORT_BYTES_MAX = 25 * 1024 * 1024
/**
 * The most a direct upload can be: the client sends the bytes straight to the blob store, on a URL
 * the board signs, so no request to the board carries them. Needs a store with `uploadUrl`.
 */
export const DIRECT_UPLOAD_BYTES_MAX = 100 * 1024 * 1024

/** `120 KB`, `3.4 MB`: a file's size the way people read it. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.zip': 'application/zip',
}

/** A file's type from its name, for when nothing better says: browsers leave `.log` untyped. */
export function typeOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return (dot > 0 && TYPES[name.slice(dot).toLowerCase()]) || 'application/octet-stream'
}

/** `shot.png`, as the board stores a name: no paths, no control characters. */
export function fileName(name: string | null): string {
  const base = (name ?? '').split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return base.slice(0, 255) || 'file'
}

/** Characters a name can't hold: invisible formatting (bidi overrides, zero-width), and line and paragraph separators. */
const INVISIBLE = /[\p{Cf}\u2028\u2029]/u

/** Why a stored name can't be `name`, which `fileName` gave: a dotfile, or one that shows other than it reads. */
export function fileNameProblem(name: string): string | undefined {
  if (name.startsWith('.')) return `attachment names can't start with a dot: ${JSON.stringify(name)}`
  if (INVISIBLE.test(name)) return `attachment names can't hold invisible formatting characters: ${JSON.stringify(name)}`
  return undefined
}

/** A platform's file name as sync brings it over: without a leading dot or invisible characters, which no one is there to rename. */
export function importedFileName(name: string): string {
  return fileName(fileName(name).replace(new RegExp(INVISIBLE.source, 'gu'), '').replace(/^[.\s]+/, ''))
}

/** `image/png`, or `application/octet-stream` when the type isn't one. */
export function mediaType(type: string | null): string {
  const value = (type ?? '').split(';')[0]!.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value) && value.length <= 255 ? value : 'application/octet-stream'
}
