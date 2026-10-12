-- SPDX-License-Identifier: Apache-2.0
-- Migration 0003: Enterprise auth — users, refresh_tokens, workspaces, workspace_members, workspace_invitations

-- ── users ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email             TEXT        NOT NULL,
  password_hash     TEXT        NOT NULL,
  name              TEXT,
  role              TEXT        NOT NULL DEFAULT 'member'
                    CHECK (role IN ('owner','admin','member','viewer')),
  tier              TEXT        NOT NULL DEFAULT 'free'
                    CHECK (tier IN ('free','pro','enterprise')),
  email_verified    BOOLEAN     NOT NULL DEFAULT false,
  totp_secret       TEXT,
  mfa_enabled       BOOLEAN     NOT NULL DEFAULT false,
  stripe_customer_id TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_udx ON users (email);
CREATE INDEX IF NOT EXISTS users_tier_idx ON users (tier);
CREATE INDEX IF NOT EXISTS users_role_idx ON users (role);
CREATE INDEX IF NOT EXISTS users_stripe_customer_id_idx ON users (stripe_customer_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── refresh_tokens ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  TEXT        NOT NULL,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revoked_at  TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ NOT NULL,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_token_hash_udx ON refresh_tokens (token_hash);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_id_idx ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_expires_at_idx ON refresh_tokens (expires_at);

-- Periodic cleanup: delete expired tokens older than 90 days
-- (run as a cron job or via pg_cron)
-- DELETE FROM refresh_tokens WHERE expires_at < now() - INTERVAL '90 days';

-- ── workspaces ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspaces (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               TEXT        NOT NULL,
  name               TEXT        NOT NULL,
  owner_id           UUID        NOT NULL REFERENCES users(id),
  tier               TEXT        NOT NULL DEFAULT 'free'
                     CHECK (tier IN ('free','pro','enterprise')),
  stripe_customer_id TEXT,
  data_region        TEXT,
  custom_domain      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_slug_udx
  ON workspaces (slug) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS workspaces_owner_id_idx ON workspaces (owner_id);

-- ── workspace_members ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspace_members (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT        NOT NULL DEFAULT 'member'
                CHECK (role IN ('owner','admin','member','viewer')),
  invited_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_workspace_user_udx
  ON workspace_members (workspace_id, user_id);
CREATE INDEX IF NOT EXISTS workspace_members_user_id_idx ON workspace_members (user_id);
CREATE INDEX IF NOT EXISTS workspace_members_workspace_id_idx ON workspace_members (workspace_id);

-- ── workspace_invitations ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspace_invitations (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email               TEXT        NOT NULL,
  role                TEXT        NOT NULL DEFAULT 'member'
                      CHECK (role IN ('admin','member','viewer')),
  token_hash          TEXT        NOT NULL,
  invited_by_user_id  UUID        NOT NULL REFERENCES users(id),
  expires_at          TIMESTAMPTZ NOT NULL,
  accepted_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_invitations_token_hash_udx
  ON workspace_invitations (token_hash);
CREATE INDEX IF NOT EXISTS workspace_invitations_workspace_id_idx
  ON workspace_invitations (workspace_id);
CREATE INDEX IF NOT EXISTS workspace_invitations_email_idx
  ON workspace_invitations (email);
