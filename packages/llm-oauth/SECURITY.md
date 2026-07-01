<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@nexus/llm-oauth` — Security & Threat Model

Security review for the official-authentication framework. This is the **hard
gate** for any OAuth live-token work (ROADMAP §4): no live-token persistence or
resolve path ships until the mitigations here are in place. It reviews the code
as it exists in `src/`, and flags what is **not yet built** so the gaps are
explicit rather than assumed-covered.

## 1. Scope & assets

**What this package does.** Authenticate to an LLM provider through a mechanism
the provider *officially* supports for third-party apps (the operator's own
registered OAuth app), exchange the code for tokens, keep the access token fresh,
and map tokens to an existing `@nexus/llm-drivers` credential blob. It is a
library — it holds no server, no routes, no DB (those are the caller's, and are
not built yet; see `index.ts` `TODO(P5-routes)`).

**Assets, most sensitive first:**

| Asset | Lifetime | Where it lives | Blast radius if leaked |
| --- | --- | --- | --- |
| **Refresh token** | Long (until revoked) | Sealed blob, persisted by caller | Full standing access to the user's provider account until revoked |
| Access token | Minutes–1h (`expiresAt`) | In-memory; mapped into driver creds | Bounded by expiry |
| OAuth **client secret** | Operator lifetime | Env (`GOOGLE_OAUTH_CLIENT_SECRET`) + request bodies to the token endpoint | Impersonate the operator's OAuth app |
| Vault master key | Operator lifetime | Env, 32 bytes | Decrypt every sealed token at rest |
| PKCE verifier / CSRF state | One login flow | `PendingAuth`, caller-persisted | Bounded — enables code interception only within one flow |

The **refresh token is the crown jewel**: it is the only long-lived bearer
secret and the only asset that *must* be encrypted at rest.

## 2. Encryption at rest — `AesGcmVault` (`crypto.ts`)

- **Algorithm:** AES-256-GCM. Random **12-byte IV per `seal()`** (`randomBytes(12)`),
  16-byte GCM auth tag. Wire format `base64([iv(12) | tag(16) | ciphertext])`.
- **Authenticated:** `open()` calls `decipher.setAuthTag(tag)` — a tampered or
  wrong-key blob throws in `final()`. There is no unauthenticated-decrypt path.
- **Key size enforced:** the constructor throws unless the key is exactly 32 bytes.
- **Interop, by design:** the wire format is byte-for-byte identical to
  `apps/api/src/lib/secret-crypto.ts` (`encryptWithKey`/`decryptWithKey`). A blob
  sealed here opens there and vice-versa — no second key system, no re-encryption
  at the API boundary.

**Residual risks & required controls**

- **IV reuse under GCM is catastrophic** (nonce reuse breaks confidentiality *and*
  authentication). The IV is a fresh CSPRNG 12 bytes per seal, so at realistic
  token volumes the birthday bound is not a concern. Do **not** refactor `seal()`
  to accept a caller-supplied or counter IV.
- **At-rest encryption does not protect a running process.** An attacker with
  code execution or heap access reads plaintext tokens regardless. Encryption
  defends the **DB-exfil / backup-theft** threat only — state that plainly, don't
  over-claim.

## 3. Master-key handling

- **Source:** `AesGcmVault.fromEnv(envVar)` reads a 32-byte key as **hex (64 chars)
  or base64 (44 chars)**; anything else → `null`, and the caller degrades to
  "vault unavailable" exactly like the BYOK path (it does not crash, and it must
  **not** fall back to storing plaintext).
- **Use a dedicated key, not `NEXUS_SECRETS_KEY`.** Although the wire format is
  interoperable, `secret-crypto.ts` documents *"each purpose (MFA, OAuth) uses its
  own key — no implicit fallback chain."* Provision a separate var (e.g.
  `NEXUS_OAUTH_VAULT_KEY`) so a compromise of one purpose's key does not unseal the
  others, and so keys can be rotated independently.
- **Rotation:** there is **no envelope/DEK layer** — the env key encrypts blobs
  directly. Rotating it therefore requires a decrypt-old → seal-new migration over
  the stored rows. Acceptable at current scale; note it as the upgrade path before
  token volume makes a re-seal migration expensive.
- **Never log the key**, and never echo it in error messages (the current code
  does not).

## 4. Token scoping & flow integrity

- **Sanctioned third-party flow only** (`types.ts` scope guard, `providers.ts`):
  the operator's OWN registered OAuth client, the provider's documented flow, and
  a documented scope. No reuse of an official CLI's embedded client ID, no routing
  of a consumer subscription. Providers without a clear third-party path are
  `supported: false` stubs with a reason — never a workaround.
- **Least privilege:** Google requests exactly `.../auth/cloud-platform` and calls
  Vertex on the **user's own GCP project** (`extra.project`). Widen scopes only
  when a driver genuinely needs it.
- **PKCE S256 + CSRF state:** `startLogin` issues a per-flow PKCE verifier
  (`generatePkce`) and random `state` (`randomState`, 24 CSPRNG bytes).
  `completeLogin` refuses a login with no stored verifier.
- **Caller obligations at the (not-yet-built) route layer — required before go-live:**
  1. **Validate `state`** on the callback against the persisted `PendingAuth`
     (constant-time compare) — the library carries it but cannot enforce the check.
  2. **Allowlist `redirectUri`.** It is passed in by the caller and echoed into the
     auth URL and the token exchange; an open redirect_uri is a token-theft vector.
     Pin it to a fixed registered callback, do not accept it from the user.
  3. Persist `PendingAuth` **server-side**, bound to the session, single-use, TTL'd.

## 5. Refresh path (`refresh.ts`)

- **Stampede & double-rotation guard:** `TokenRefresher` dedups concurrent refreshes
  by `accountKey` — one in-flight refresh, the rest await the same promise. This
  prevents the refresh storm and the double-rotation that can revoke a
  just-issued token (Google rotates refresh tokens under some conditions).
- **Skew:** refreshes when the access token is within 60s of `expiresAt`; unknown
  expiry is treated as still-valid.
- **Refresh-token carry-forward:** Google omits `refresh_token` on a refresh
  response, so `refresh()` carries the prior one forward — the stored long-lived
  secret is never dropped by a successful refresh.
- **Residual:** dedup is **per-process** (in-memory `Map`). Multiple API instances
  can still each fire one refresh — acceptable, but do not assume global
  single-flight. If a provider hard-rotates on every refresh, coordinate via the
  DB row (advisory lock) when persistence lands.

## 6. Logging / secret-leak policy

- **No token material in errors today.** `FetchTokenHttp.postForm` surfaces only the
  provider's `error` / `error_description` and truncates a non-JSON body to 500
  chars; `TokenRefresher` errors name the `accountKey`, not the token.
- **Hard rules for the caller / future routes:**
  - Never log `accessToken`, `refreshToken`, `client_secret`, PKCE verifier, or a
    sealed blob. Log an account id or a token *prefix* only (mirror the BYOK
    `keyPrefix` pattern).
  - Token endpoint requests are `x-www-form-urlencoded` bodies containing the
    client secret and refresh token — ensure request-logging middleware does not
    capture outbound bodies for `oauth2.googleapis.com/token`.
  - The provider token URLs are **compile-time constants**, not user input, so the
    refresh/exchange calls are not an SSRF surface. Keep them constant — do not make
    the token endpoint configurable from user data.

## 7. Revocation — **NOT YET IMPLEMENTED (blocking gap)**

There is no revoke path in the package today. Before persisting live refresh
tokens (ROADMAP §4 item 3), implement:

1. **Delete-at-rest:** remove (or crypto-shred) the sealed refresh-token row on
   user disconnect / account delete. Hard delete, not a soft flag — a soft-deleted
   sealed token is still a live credential.
2. **Provider-side revoke:** best-effort `POST https://oauth2.googleapis.com/revoke`
   with the refresh token so the grant is killed upstream, not just forgotten
   locally. Treat failure as non-fatal but logged (the local delete still must
   succeed).
3. **Invalidate in-flight:** evict the `accountKey` from any `TokenRefresher` so a
   racing refresh cannot resurrect a revoked grant.

## 8. Threat checklist (summary)

| Threat | Mitigation | Status |
| --- | --- | --- |
| DB exfil / backup theft reveals refresh tokens | AES-256-GCM at rest, authenticated | ✅ in code |
| Tampered ciphertext accepted | GCM auth tag verified on `open()` | ✅ in code |
| Vault key shared across purposes | Dedicated env key, no fallback chain | ⚠️ operator config — document & enforce |
| CSRF on callback | `state` issued; check is caller's | ⚠️ route layer (not built) |
| Open redirect / token theft | `redirect_uri` allowlist | ⚠️ route layer (not built) |
| Auth-code interception | PKCE S256 | ✅ in code |
| Refresh stampede / double-rotation | Per-key single-flight | ✅ in code (per-process) |
| Tokens in logs | Errors carry no token material | ✅ code; ⚠️ enforce in routes/middleware |
| SSRF via token endpoint | Endpoints are constants | ✅ by construction |
| Lingering access after disconnect | Local delete + provider revoke | ❌ **not built — §7** |

## 9. Sign-off condition

Live refresh-token persistence may proceed once §4 caller-obligations (state check,
redirect allowlist, server-side single-use `PendingAuth`) and §7 revocation are
implemented and tested, and a **dedicated** vault key is provisioned. Until then
the package is safe to build and unit-test against mock transports (no live calls),
which is its current state.
