// SPDX-License-Identifier: Apache-2.0
/**
 * Passkey ceremonies through the browser's own WebAuthn JSON helpers, so no client library is
 * needed. A host that owns the session (the desktop app) signs in its own way.
 */
import { apiFetch } from "~/lib/api";
import { hostCan } from "~/lib/host";

export function passkeysSupported(): boolean {
  return (
    typeof PublicKeyCredential !== "undefined" &&
    "parseRequestOptionsFromJSON" in PublicKeyCredential &&
    !hostCan("localAccount")
  );
}

/** Create a passkey on this device and register it under `name`. */
export async function addPasskey(name: string): Promise<void> {
  const options = await apiFetch<PublicKeyCredentialCreationOptionsJSON>(
    "/api/v1/auth/passkeys/register/options",
    { method: "POST" },
  );
  const credential = (await navigator.credentials.create({
    publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options),
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was created");
  await apiFetch("/api/v1/auth/passkeys/register", {
    method: "POST",
    json: { name, response: credential.toJSON() },
  });
}

/** Sign in with a passkey this device holds; the session is the same as a password sign-in. */
export async function signInWithPasskey<U>(): Promise<{ accessToken: string; user: U }> {
  const { challengeId, options } = await apiFetch<{
    challengeId: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  }>("/api/v1/auth/passkeys/login/options", { method: "POST" });
  const credential = (await navigator.credentials.get({
    publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options),
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was chosen");
  return apiFetch("/api/v1/auth/passkeys/login", {
    method: "POST",
    json: { challengeId, response: credential.toJSON() },
  });
}
