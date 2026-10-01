// SPDX-License-Identifier: Apache-2.0
/**
 * Named secrets, per user, encrypted at rest — and never readable back over
 * HTTP.
 *
 * Nexus could already store BYOK provider keys, but nothing else: an agent that
 * needed a webhook signing key or a database password had one place to get it,
 * which was to ask the user to type it into the conversation. A secret pasted
 * into a transcript is in the transcript forever, in the logs, and in whatever
 * the transcript is later summarised into.
 *
 * Two rules make this different from a key-value store:
 *
 *   A value goes in and does not come out. `resolveSecret` is for server-side
 *   consumers inside this process. No route returns a value, and
 *   `apps/api/tests/routes/secrets.test.ts` asserts that for every route.
 *
 *   An agent asks; a human answers. `requestSecret` records what is needed and
 *   why, and leaves a request the owner fills in themselves. The agent learns
 *   that the secret now exists, never what it says.
 *
 * Encryption is the existing AES-256-GCM helper, which fails closed: with no
 * NEXUS_SECRETS_KEY configured, storing a secret throws rather than writing
 * plaintext.
 */

import crypto from "node:crypto";

import { PersistentStore } from "./persistent-store.js";
import { decryptSecret, encryptSecret, isSecretCryptoAvailable } from "./secret-crypto.js";

/** What a caller may see: everything about a secret except the secret. */
interface SecretMetadata {
  id: string;
  ownerId: string;
  name: string;
  description?: string;
  /** First eight hex of the value's SHA-256: enough to confirm a rotation. */
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

interface SecretRecord extends SecretMetadata {
  /** AES-256-GCM, base64. Never leaves this module. */
  sealed: string;
}

interface SecretRequest {
  id: string;
  ownerId: string;
  name: string;
  /** Why the secret is needed, shown to the person filling it in. */
  reason: string;
  status: "pending" | "fulfilled" | "cancelled";
  createdAt: string;
  fulfilledAt?: string;
}

const _secrets = new PersistentStore<SecretRecord>("secrets");
const _requests = new PersistentStore<SecretRequest>("secret-requests");
let _loaded: Promise<void> | null = null;

export function loadSecretStore(): Promise<void> {
  _loaded ??= Promise.all([_secrets.load(), _requests.load()]).then(() => undefined);
  return _loaded;
}

/** Reset the load latch. Tests use this to prove records survive a restart. */
export function _resetSecretStoreForTests(): void {
  _loaded = null;
}

export class SecretEncryptionUnavailableError extends Error {
  readonly code = "encryption_unavailable";
  constructor() {
    super(
      "No secret-encryption key configured. Set NEXUS_SECRETS_KEY to a 64-char hex string; " +
        "storing a secret unencrypted is not an option.",
    );
    this.name = "SecretEncryptionUnavailableError";
  }
}

/** Names are used in URLs and in config; keep them boring and comparable. */
const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

export function isValidSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

function fingerprint(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function key(ownerId: string, name: string): string {
  return `${ownerId}:${name}`;
}

function publicView(record: SecretRecord): SecretMetadata {
  const { sealed: _sealed, ...metadata } = record;
  return metadata;
}

/** Store or rotate a secret. Returns metadata only — never the value. */
export function putSecret(
  ownerId: string,
  name: string,
  value: string,
  description?: string,
  now: number = Date.now(),
): SecretMetadata {
  if (!isSecretCryptoAvailable()) throw new SecretEncryptionUnavailableError();

  const existing = _secrets.get(key(ownerId, name));
  const record: SecretRecord = {
    id: existing?.id ?? crypto.randomUUID(),
    ownerId,
    name,
    ...(description !== undefined
      ? { description }
      : existing?.description !== undefined
        ? { description: existing.description }
        : {}),
    fingerprint: fingerprint(value),
    createdAt: existing?.createdAt ?? new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    ...(existing?.lastUsedAt ? { lastUsedAt: existing.lastUsedAt } : {}),
    sealed: encryptSecret(value),
  };
  _secrets.set(key(ownerId, name), record);

  // Storing the value answers any outstanding request for that name.
  for (const request of _requests.values()) {
    if (request.ownerId !== ownerId || request.name !== name) continue;
    if (request.status !== "pending") continue;
    _requests.set(request.id, {
      ...request,
      status: "fulfilled",
      fulfilledAt: new Date(now).toISOString(),
    });
  }

  return publicView(record);
}

export function listSecrets(ownerId: string): SecretMetadata[] {
  return [..._secrets.values()]
    .filter((r) => r.ownerId === ownerId)
    .map(publicView)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function deleteSecret(ownerId: string, name: string): boolean {
  const id = key(ownerId, name);
  if (!_secrets.has(id)) return false;
  _secrets.delete(id);
  return true;
}

/**
 * The decrypted value, for a consumer inside this process.
 *
 * Every caller of this is a server-side integration — never a route handler
 * returning it to a client. Reading stamps `lastUsedAt`, so an owner can see
 * that a secret is in use without seeing what it says.
 */
export function resolveSecret(
  ownerId: string,
  name: string,
  now: number = Date.now(),
): string | null {
  const record = _secrets.get(key(ownerId, name));
  if (!record) return null;
  _secrets.set(key(ownerId, name), { ...record, lastUsedAt: new Date(now).toISOString() });
  return decryptSecret(record.sealed);
}

/** Record that a secret is needed, for its owner to fill in themselves. */
export function requestSecret(
  ownerId: string,
  name: string,
  reason: string,
  now: number = Date.now(),
): SecretRequest {
  const open = [..._requests.values()].find(
    (r) => r.ownerId === ownerId && r.name === name && r.status === "pending",
  );
  if (open) return open;

  const request: SecretRequest = {
    id: crypto.randomUUID(),
    ownerId,
    name,
    reason,
    status: "pending",
    createdAt: new Date(now).toISOString(),
  };
  _requests.set(request.id, request);
  return request;
}

export function listSecretRequests(ownerId: string): SecretRequest[] {
  return [..._requests.values()]
    .filter((r) => r.ownerId === ownerId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function cancelSecretRequest(ownerId: string, id: string): SecretRequest | null {
  const request = _requests.get(id);
  if (!request || request.ownerId !== ownerId || request.status !== "pending") return null;
  const cancelled: SecretRequest = { ...request, status: "cancelled" };
  _requests.set(id, cancelled);
  return cancelled;
}
