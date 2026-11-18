// IDs a handle derives for its posts, with WebCrypto, so they work in a browser too.

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

/** SHA-256 of `text`, in hex. */
export async function sha256(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
}

/**
 * A UUIDv8 from `parts`, exactly as A2's `idempotentId` makes one: the IDs a board derives for the
 * writes its own code makes, which no request may post with.
 */
export async function derivedId(...parts: string[]): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)))).slice(0, 16)
  bytes[6] = (bytes[6]! & 15) | 128
  bytes[8] = (bytes[8]! & 63) | 128
  const text = hex(bytes)
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20, 32)}`
}

/** A derived ID's shape. */
export const DERIVED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * A post's ID, from one derived for it, under `principal`: a board takes a `key:<principal>:` ID
 * only from that principal, so no one else can post with it first.
 */
export const keyId = async (principal: string, derived: string) => `key:${principal}:${(await sha256(`board-key\u001f${derived}`)).slice(0, 32)}`

/**
 * Whether `id` is exactly the shape `keyId` makes for `principal`. A prefix check isn't enough:
 * a principal's ID can be the start of another's (`oidc:gitlab.com:acme` and `oidc:gitlab.com:acme:ci`).
 */
export const isKeyIdOf = (id: string, principal: string) =>
  id.startsWith(`key:${principal}:`) && /^[0-9a-f]{32}$/.test(id.slice(`key:${principal}:`.length))
