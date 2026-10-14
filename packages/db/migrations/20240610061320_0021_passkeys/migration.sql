-- SPDX-License-Identifier: Apache-2.0
-- Migration 0021: passkeys
--
-- WebAuthn credentials for passwordless sign-in. The public key is stored, never a secret; the
-- counter lets the server notice a cloned authenticator.

CREATE TABLE IF NOT EXISTS "passkeys" (
  "id"           text PRIMARY KEY,
  "user_id"      uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "public_key"   text NOT NULL,
  "counter"      bigint NOT NULL DEFAULT 0,
  "transports"   text[] NOT NULL DEFAULT '{}',
  "name"         text NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "passkeys_user_id_idx" ON "passkeys" ("user_id");
