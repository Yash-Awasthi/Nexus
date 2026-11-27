# Personal data and audit: where it goes, and what proves it

Two promises make up this page, and both are tested rather than asserted: **personal data is removed before a
message reaches a model**, and **the events a review asks about are written to the hash-chained audit log**.
The tests are named here so a reader can go straight to the evidence.

## 1. Personal data on the way to a model

### What counts

`apps/api/src/lib/chat-safety.ts` holds one list of shapes: PEM private keys, provider keys (`sk-`, `gsk_`,
`nxk_`, `pk_`, `rk_` prefixes), GitHub and Slack tokens, Google API keys, JWTs, e-mail addresses, Luhn-valid
card numbers, US SSNs and phone numbers. `findPii` reports what it found; `redactPii` replaces each match with
a typed placeholder (`[EMAIL]`, `[CARD_NUMBER]`) so the sentence still reads.

The key pattern is deliberately loose and gated by a check rather than a clever regex: a credential ends in
one long run, a package name ends in a word. `sk-learn-pipelines-2024` is a name, `sk-proj-…` is a key, and
the difference is decided by the length of the final segment — a rule this page can state in a sentence and a
test can pin in two lines.

### Where it is applied

`POST /api/chat/stream` (`apps/api/src/routes/chat.ts`) reads the user's preferences and behaves in three ways:

| Preferences                                  | What happens                                                           | What the model sees  |
| -------------------------------------------- | ---------------------------------------------------------------------- | -------------------- |
| `piiDetection: false`                        | nothing                                                                | the message as typed |
| `piiDetection: true`, `autoAnonymize: false` | a notice naming the kinds found, asking the user to enable anonymizing | the message as typed |
| both on                                      | a notice saying what was removed, then the request                     | the redacted message |

The order matters and is the whole test: detection and redaction run **before** the member drivers are
invoked, so the redacted string is what leaves the process. Redacting a transcript afterwards would leave the
address in the provider's request while making our own record look clean.

`apps/api/tests/security/pii-before-model.test.ts` (6 tests) drives the real route with a scripted driver and
reads the prompts that driver was asked — the only place where "before the model" can be observed:

- with auto-anonymize on, no driver prompt contains the card number or the address, and every one carries the
  placeholders;
- with detection on and anonymize off, the user is asked first and the prompt still carries the data;
- with detection off, nothing is reported and nothing is changed.

It also pins the false-positive cases: a Luhn-invalid 16-digit reference is not a card, and a hyphenated
package name is not a credential.

### What this does not cover

- **Other routes that send text to a model.** Knowledge-base ingest, document decomposition and the council's
  seeded context do not run this filter; they are internal paths with their own inputs (uploaded documents,
  workspace content) and are listed in the threat model's residual risks. The claim on this page is about what
  a person types into chat.
- **The provider's own retention.** Redaction happens on our side of the boundary; it does not control what a
  model provider logs after the request. That is a contract question, not a code one.

## 2. The audit log, and what must be in it

`apps/api/src/lib/audit-emitter.ts` appends one HMAC-chained row per event (`payload_hash` then
`chain_hash = HMAC(key, prev + payload_hash)`), so an entry cannot be edited or removed without breaking the
chain that `GET /audit/log/verify` re-derives.

`apps/api/src/lib/audit-events.ts` is the checklist: one row per action a reviewer asks about, naming the file
that emits it and why it matters. Today it covers registration, sign-in, provider key add and remove,
workspace role change, budget policy change, audit export, account deletion and admin suspension.

`apps/api/tests/security/audit-completeness.test.ts` holds it in both directions:

- **Source.** Every catalogue row must still name a file that contains its action string. Deleting an emission
  fails a test instead of quietly removing evidence. (Verified by changing `provider_key.delete` to
  `provider_key.remove`: two failures, one naming the missing emission.)
- **Behaviour.** Against an embedded Postgres, the test registers and signs in a user, then adds and removes a
  provider key over HTTP and reads the audit table: the rows exist, the actor is the account that acted, the
  hashes are 64 hex, and the key's material and prefix never appear in the payload.

Four categories — permission change, budget change, audit export and admin action — are pinned by the source
half only, because driving them needs a workspace owner, a company, an S3 bucket and an admin session that
this suite does not stand up. They are listed as such rather than implied to be end-to-end.

### Gaps this work found and closed

- `DELETE /api/v1/user/provider-keys/:id` removed a key with no audit entry at all — the one action an
  intruder would take on the way out. Now `provider_key.delete`, with the provider but never the prefix.
- Budget policies could be set and deleted with nothing recorded. Now `budget.policy_set` and
  `budget.policy_deleted`, carrying the policy as submitted.
- The scheduled audit export copied evidence out of the database without saying so. Now `audit.exported` with
  the entry count, and an empty tick writes nothing — a log full of "nothing happened" hides the rows that
  matter.

### Account deletion is admin-initiated only

Self-service deletion lives at `DELETE /api/v1/users/:id/data` (self-only, 403 otherwise): it runs the erasure
cascade, empties the key-value stores, ends every session, writes `account.erased`, and answers **200 with a
receipt** — the rows removed by table, plus `RETAINED_AFTER_DELETION` from `apps/api/src/lib/user-export.ts`,
which names what survives and why (audit entries, billing records, earlier backups, aggregate counters, server
logs). A bare 204 would leave the person asking "so what is left of me?".

`admin.user_deleted` remains the operator path for an account that has to be removed without its owner
participating.

## 3. Leaving with your data

`GET /api/v1/users/:id/export` (self-only) returns one JSON archive: account row, sessions as timestamps,
provider keys as provider-and-date, API keys as name/prefix/scope, memories, verdicts, the account's own audit
entries, and every key-value record it owns. The two rules that make it safe are in the SQL rather than in a
review: each `SELECT` lists its columns, so a new secret column cannot join every export by default, and
credential-shaped fields in key-value records are replaced by name (`scrubSecrets`) rather than by value.

`apps/api/tests/routes/account-export-delete.test.ts` (4 tests) drives both routes over HTTP and asserts the
_absences_ — no password hash, no refresh-token hash, no provider prefix, and nothing belonging to another
account — because a positive-only test passes on a route that dumps the whole table.

## 4. Encryption at rest, and how the key is replaced

Provider keys are stored as AES-256-GCM ciphertext under `NEXUS_SECRETS_KEY` (`packages/db/src/secret-crypto.ts`),
written as a `v1:`-prefixed envelope. Rows written before the envelope existed are bare base64 and still decrypt,
which is why the ciphertext carries a version (`user_provider_credentials.key_material_version`, added in
migration 0023) instead of the application guessing at the shape.

A rotation is **two deploys**, and `apps/api/src/lib/secret-rotation.ts` is the middle step:

1. deploy with `NEXUS_SECRETS_KEY` (new) and `NEXUS_SECRETS_KEY_PREVIOUS` (old) — reads try the new key and fall
   back, writes use the new one;
2. run `node apps/api/src/rotate-secrets.ts` (add `--dry-run` first) — every row is re-encrypted and marked
   version 2; rows nothing can decrypt are _reported and left alone_, never deleted;
3. deploy again without the previous variable.

`apps/api/tests/lib/secret-rotation.test.ts` (9 tests) pins the properties that make that safe: the pass is
idempotent, a dry run writes nothing, an undecryptable row is skipped rather than replaced, and a failed write
leaves the old ciphertext in place. The full operator procedure, with its checkboxes, is `docs/runbook.md` §11.4.

## 5. How long each store keeps data

`packages/contracts/src/shared/retention.ts` is the single statement; every row below is a value in that file,
and `apps/api/tests/lib/retention.test.ts` reads the file each policy names and fails if the enforcing symbol is
gone — a document describing a control that stopped existing is the failure this avoids.

| Store          | Policy                                                                         | Enforced by                                                                                                 |
| -------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Request traces | newest 1000, oldest evicted                                                    | `request-traces.ts` reading `RETENTION.traces.maxEntries`                                                   |
| Notifications  | 30-day expiry, on the item and on the index pointing at it                     | `notifications-store.ts` stamping `RETENTION.notifications.ttlMs`                                           |
| Audit log      | never pruned by time or count; removed only by an audited erasure request      | database triggers `audit_log_no_delete` / `audit_log_no_update`                                             |
| Sessions       | 30 days; the cookie's Max-Age and the row's `expires_at` are the same constant | `auth-users.ts` and `sign-in-finish.ts` reading `RETENTION.sessions.ttlMs`                                  |
| Sandbox drives | reclaimed after 30 idle days                                                   | `DRIVE_IDLE_MS` in `packages/sandbox/src/drive-fs.ts`, asserted equal to `RETENTION.sandboxArtefacts.ttlMs` |
| Logs           | the deployment's window; the API writes to stdout and has no file sink         | asserted by the absence of `pino.destination(` in the API                                                   |

Two rows say "the deployment decides" in effect — logs, and backups in the table above them — because inventing
a number this process cannot enforce would be the same mistake as documenting a control that does not exist.
