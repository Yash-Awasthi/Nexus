import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Attachment, ATTACHMENT_BYTES_MAX, DIRECT_UPLOAD_BYTES_MAX, type Attachment as AttachmentType } from '../contract/schemas.ts'
import { badRequest, HttpError, notFound } from './errors.ts'
import { mediaType } from '../contract/files.ts'
import { uploadName } from './file-names.ts'

/**
 * Where a local board's attachments' bytes live. The board writes each file
 * once, under a key it chose, and never overwrites it.
 */
export type BlobStore = {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>
  /** Null when there's nothing under the key. */
  get(key: string): Promise<{ data: ReadableStream<Uint8Array> | Uint8Array; contentType: string } | null>
  /**
   * For direct uploads, files too big for a request: a URL a client `PUT`s `key`'s bytes to,
   * straight to the store, with `headers`. The store must bind it to `key`, refuse more than
   * `maxBytes`, refuse to overwrite what's there, and stop taking it at `expiresAt`. With `head`,
   * the board takes files up to `DIRECT_UPLOAD_BYTES_MAX`; without, uploads stay at 4 MB.
   */
  uploadUrl?(key: string, options: { contentType: string; maxBytes: number; expiresAt: Date }): Promise<{ url: string; headers: Record<string, string> }>
  /** The size of what's under the key, or null when there's nothing: how the board checks a direct upload landed. */
  head?(key: string): Promise<{ size: number } | null>
}

/** Files in memory, for tests: forgets everything when the process ends. */
export function memoryBlob(): BlobStore {
  const files = new Map<string, { data: Uint8Array; contentType: string }>()
  return {
    put: async (key, data, contentType) => void files.set(key, { data: data.slice(), contentType }),
    get: async (key) => files.get(key) ?? null,
  }
}

/** Files on disk, under `dir`: a local board's, next to its database. */
export function fsBlob(dir: string): BlobStore {
  const path = (key: string) => join(dir, ...key.split('/'))
  return {
    async put(key, data, contentType) {
      await mkdir(dirname(path(key)), { recursive: true })
      await writeFile(path(key), data)
      await writeFile(`${path(key)}.type`, contentType)
    },
    async get(key) {
      try {
        const [data, contentType] = await Promise.all([readFile(path(key)), readFile(`${path(key)}.type`, 'utf8')])
        return { data: new Uint8Array(data), contentType }
      } catch {
        return null
      }
    },
  }
}

const dataKey = (id: string) => `board/attachments/${id}`
/** A direct upload the board signed, until it's finished: what it's called, and who may finish it. */
const ticketKey = (id: string) => `board/uploads/${id}.json`
const metaKey = (id: string) => `board/attachments/${id}.json`

/** A board without a blob store keeps no files: every file route says so. */
const noBlob = () => new HttpError(501, 'no_files', 'this board keeps no files')

/** 128 random bits, base64url, drawn again when they'd start with `-`, which a command line reads as a flag. */
function attachmentId(): string {
  for (;;) {
    const id = randomBytes(16).toString('base64url')
    if (!id.startsWith('-')) return id
  }
}

/** Who sent an upload, as the board recorded it: its principal. */
export type Uploader = { uploadedBy: string | null }

/** Whether an upload is the caller's own, to read and attach before a message carries it: its principal sent it. */
export const ownUpload = (upload: Uploader, caller: { id: string }): boolean => upload.uploadedBy === caller.id

/**
 * Stores an upload under a fresh ID, with its metadata beside it. `uploadedBy`
 * is the principal that sent it, who can read it before any message carries it.
 * `max` is the most it can be: `ATTACHMENT_BYTES_MAX` unless the board's own sync imports it.
 */
export async function writeUpload(
  blob: BlobStore | null,
  input: { data: Uint8Array; name: string | null; type: string | null; uploadedBy?: string },
  max = ATTACHMENT_BYTES_MAX,
): Promise<AttachmentType> {
  if (!blob) throw noBlob()
  if (input.data.byteLength === 0) throw badRequest('the file is empty')
  if (input.data.byteLength > max) throw new HttpError(413, 'too_large', `attachments are at most ${max / 1024 / 1024} MB`)
  const attachment: AttachmentType = {
    id: attachmentId(),
    name: uploadName(input.name),
    type: mediaType(input.type),
    size: input.data.byteLength,
  }
  await blob.put(dataKey(attachment.id), input.data, attachment.type)
  const meta = input.uploadedBy === undefined ? attachment : { ...attachment, uploadedBy: input.uploadedBy }
  await blob.put(metaKey(attachment.id), new TextEncoder().encode(JSON.stringify(meta)), 'application/json')
  return attachment
}

async function bytes(data: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  return data instanceof Uint8Array ? data : new Uint8Array(await new Response(data).arrayBuffer())
}

export const attachmentNotFound = (id: string) => notFound(`no attachment: ${id}`, 'attachment_not_found')

/**
 * An upload's metadata, as the board recorded it, never what a request says,
 * and who uploaded it: null for files the board imported itself, or stored
 * before it recorded that.
 */
export async function readUpload(blob: BlobStore | null, id: string): Promise<{ attachment: AttachmentType } & Uploader> {
  if (!blob) throw noBlob()
  const found = Attachment.shape.id.safeParse(id).success ? await blob.get(metaKey(id)) : null
  if (!found) throw attachmentNotFound(id)
  const meta = JSON.parse(new TextDecoder().decode(await bytes(found.data))) as { uploadedBy?: unknown }
  return { attachment: Attachment.parse(meta), uploadedBy: typeof meta.uploadedBy === 'string' ? meta.uploadedBy : null }
}

/** An attachment's bytes. */
export async function readAttachmentData(blob: BlobStore | null, id: string): Promise<Uint8Array> {
  if (!blob) throw noBlob()
  const found = await blob.get(dataKey(id))
  if (!found) throw attachmentNotFound(id)
  return bytes(found.data)
}

/** An attachment's bytes as the store keeps them, a stream or the bytes, for board() to serve. */
export async function attachmentBody(blob: BlobStore | null, id: string): Promise<ReadableStream<Uint8Array> | Uint8Array> {
  if (!blob) throw noBlob()
  const found = await blob.get(dataKey(id))
  if (!found) throw attachmentNotFound(id)
  return found.data
}

/** How long a direct upload's URL takes bytes: long enough for 100 MB on a slow link. */
const DIRECT_UPLOAD_TTL_MS = 30 * 60 * 1000

type Ticket = { id: string; name: string; type: string; size: number; uploadedBy: string; expiresAt: string }

const noDirectUploads = () =>
  new HttpError(501, 'no_direct_uploads', `this board's blob store can't take direct uploads, so files are at most ${ATTACHMENT_BYTES_MAX / 1024 / 1024} MB`)

/**
 * Starts a direct upload: a fresh ID, and a URL in the store to `PUT` its bytes to. The board
 * keeps what the request said the file is until `finishUpload` checks the store has it.
 */
export async function startUpload(
  blob: BlobStore | null,
  input: { name: string | null; type: string | null; size: number; uploadedBy: string },
): Promise<{ id: string; url: string; headers: Record<string, string>; expiresAt: string }> {
  if (!blob) throw noBlob()
  if (!blob.uploadUrl || !blob.head) throw noDirectUploads()
  if (input.size > DIRECT_UPLOAD_BYTES_MAX) throw new HttpError(413, 'too_large', `direct uploads are at most ${DIRECT_UPLOAD_BYTES_MAX / 1024 / 1024} MB`)
  const expires = new Date(Date.now() + DIRECT_UPLOAD_TTL_MS)
  const ticket: Ticket = {
    id: attachmentId(),
    name: uploadName(input.name),
    type: mediaType(input.type),
    size: input.size,
    uploadedBy: input.uploadedBy,
    expiresAt: expires.toISOString(),
  }
  await blob.put(ticketKey(ticket.id), new TextEncoder().encode(JSON.stringify(ticket)), 'application/json')
  const { url, headers } = await blob.uploadUrl(dataKey(ticket.id), { contentType: ticket.type, maxBytes: ticket.size, expiresAt: expires })
  // The type the URL was signed for, which the PUT must send as it is.
  return { id: ticket.id, url, headers: { ...headers, 'content-type': ticket.type }, expiresAt: ticket.expiresAt }
}

/**
 * Finishes a direct upload: once the store has exactly the bytes its start said, the board records
 * the attachment, as `writeUpload` does. Only its uploader may finish it (`ownUpload`); a second
 * finish answers the same attachment. It never reads the record before writing it: a store with a
 * cache (Vercel Blob's CDN) would keep that miss, and the post that names the file would find nothing.
 */
export async function finishUpload(blob: BlobStore | null, id: string, caller: { id: string }): Promise<AttachmentType> {
  if (!blob) throw noBlob()
  const found = Attachment.shape.id.safeParse(id).success ? await blob.get(ticketKey(id)) : null
  const ticket = found ? (JSON.parse(new TextDecoder().decode(await bytes(found.data))) as Ticket) : null
  if (!ticket || !ownUpload(ticket, caller)) throw notFound(`no upload: ${id}`, 'upload_not_found')
  if (!blob.head) throw noDirectUploads()
  const stored = await blob.head(dataKey(id))
  if (!stored) throw new HttpError(409, 'not_uploaded', `nothing's been uploaded for ${id} yet: PUT the file to its URL first`)
  if (stored.size !== ticket.size)
    throw badRequest(`the store has ${stored.size} bytes for ${id}, but its upload said ${ticket.size}`, 'size_mismatch')
  const attachment: AttachmentType = { id, name: ticket.name, type: ticket.type, size: stored.size }
  try {
    await blob.put(metaKey(id), new TextEncoder().encode(JSON.stringify({ ...attachment, uploadedBy: ticket.uploadedBy })), 'application/json')
  } catch (error) {
    // Finished before: a store that never overwrites refuses the record, which is there to read.
    const done = await blob.get(metaKey(id)).catch(() => null)
    if (!done) throw error
    return Attachment.parse(JSON.parse(new TextDecoder().decode(await bytes(done.data))))
  }
  return attachment
}
