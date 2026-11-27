// SPDX-License-Identifier: Apache-2.0
/**
 * A labelled retrieval corpus: three knowledge bases and fifty queries with the document that
 * actually answers each one.
 *
 * The queries are written the way a person asks — paraphrases, a pronoun, a number in words — not as
 * the document's keywords, because a set that reuses the document's own words measures memory. Each
 * query names every document that would be an acceptable answer (`relevant`, the primary one first)
 * so recall and citation accuracy are scored against the same label.
 *
 * The documents are fictional but internally consistent: a deployment runbook set, a billing policy
 * set and an access-control policy set, each with deliberate near-misses (two docs about the same
 * subsystem) so an engine that only matches the topic still ranks wrongly.
 */

export interface EvalDoc {
  id: string;
  kb: string;
  title: string;
  text: string;
}

export interface EvalQuery {
  id: string;
  kb: string;
  query: string;
  /** The document that answers the question; citation accuracy is scored on this. */
  answer: string;
  /** Everything that would be acceptable, the answer included. */
  relevant: string[];
}

const ops: EvalDoc[] = [
  {
    id: "ops-rollback",
    kb: "ops",
    title: "Rolling back a bad deploy",
    text: "To roll back a release, run `nexus releases rollback <release>`. The command repoints the service to the previous image digest and waits for readiness; it never rebuilds. Rollback is only possible for the last five releases because the registry prunes older digests after a week. If the release changed the schema, roll back the code first and then apply the down-migration by hand, since the pipeline deliberately does not run it for you.",
  },
  {
    id: "ops-restore",
    kb: "ops",
    title: "Restoring Postgres from a snapshot",
    text: "Snapshots are taken nightly at 02:00 UTC and kept for thirty days. A restore always goes into a scratch database first: `db-restore.sh --snapshot <id> --target scratch`. Compare row counts for every table before pointing the application at it. Restoring over the live database requires an incident and a second engineer; the script refuses when the source and target connection strings are equal.",
  },
  {
    id: "ops-migrations",
    kb: "ops",
    title: "Forward-only migrations",
    text: "Migrations are append-only. A migration that removes a column needs a retired-column exception plus an architecture decision record, and the checker fails the build when a column disappears without one. This is not caution for its own sake: the previous release's code is still serving traffic during a rolling deploy, and it still selects the column you just dropped.",
  },
  {
    id: "ops-redis",
    kb: "ops",
    title: "What Redis holds, and what a flush costs",
    text: "Redis holds rate-limit buckets, cache entries and the queue of pending workflow jobs. A flush empties all three. Rate limits reset (users are briefly allowed more), caches refill from Postgres with a latency spike, and queue jobs that have not been picked up are lost unless the worker is idle. Flushing is safe for correctness and expensive for latency; the key families and their owners are listed in the operations guide.",
  },
  {
    id: "ops-alerts",
    kb: "ops",
    title: "Alert routing and escalation",
    text: "A degraded dependency is a task, not a page. Availability below the objective, a queue that is not draining, and an audit-chain breach page the on-call engineer immediately. Everything else lands in the operations channel. If a page is not acknowledged within fifteen minutes it escalates to the secondary, and support is only contacted for customer-visible outages.",
  },
  {
    id: "ops-backups",
    kb: "ops",
    title: "Backup drill record",
    text: "A backup is unproven until a drill has restored it. The drill dumps the database, recreates a scratch instance, restores, and compares every table's row count, then verifies the audit chain. The record table in the runbook starts as unrun on purpose: nobody may mark a drill complete without the wall time and the operator's name, and the test suite fails if the row claims a run that has no numbers.",
  },
  {
    id: "ops-sandbox-image",
    kb: "ops",
    title: "Sandbox image toolchains",
    text: "The sandbox image installs Go and Rust from the projects' own checksum-verified release tarballs, not from the distribution's packages, because the base image's versions were years behind and carried known vulnerabilities. Ruby is compiled from source for the same reason. The build asserts the exact versions it declared and writes them to a file the status endpoint reads, so a stale toolchain fails the build instead of shipping.",
  },
  {
    id: "ops-updates",
    kb: "ops",
    title: "Desktop update channels and waves",
    text: "The desktop client checks an update feed that names a channel and an optional rollout percentage. An install is placed in a wave by hashing its installation id with the version, so a machine cannot flip between waves on the next check. A build with no percentage reaches everyone; a build with a percentage reaches that share and tells everyone else they are not in this wave yet rather than claiming they are up to date.",
  },
  {
    id: "ops-queue",
    kb: "ops",
    title: "When the workflow queue stops draining",
    text: "A queue that grows without bound is usually a worker that is alive but not taking jobs. Check the worker's heartbeat, then the oldest job's age. If jobs are older than the queue objective, restart the worker; jobs are retried from their last checkpoint, so a restart repeats at most the task that was in flight. Do not delete jobs to make the graph look healthy.",
  },
  {
    id: "ops-logs",
    kb: "ops",
    title: "Log retention and where logs live",
    text: "Application logs are shipped to the log store and kept for fourteen days; audit entries are kept for a year and are not deletable by the application. Traces are sampled at ten percent and kept for seven days. A log line must not contain a token, a password or a full request body — the redaction filter runs before the line is written, not after.",
  },
  {
    id: "ops-status-page",
    kb: "ops",
    title: "The status endpoint",
    text: "The status endpoint probes Postgres, Redis, the model provider, the sandbox and the container daemon, and reports one row each. It answers 200 for healthy or degraded and 503 only when a critical dependency is down, so a monitor cannot pull the instance out of rotation because Docker is missing. A broken dependency is cached for fifteen seconds, a healthy one for thirty minutes, so a status page is not a load test.",
  },
  {
    id: "ops-cost",
    kb: "ops",
    title: "Cost ceilings and hard stops",
    text: "A company can set a hard-stop budget. When the spend for the period reaches the ceiling, the API refuses the run rather than only greying out a button in the interface; the refusal is written to the run's own log so it can be read afterwards. Soft limits warn and let the work continue. The ceiling is checked before a run is accepted, not while it is spending.",
  },
];

const billing: EvalDoc[] = [
  {
    id: "bill-invoices",
    kb: "billing",
    title: "When invoices are issued",
    text: "An invoice is issued on the first day of the month for the previous month's usage. Usage is metered continuously but invoiced once, so the balance you see during the month is an estimate and the invoice is the record. A correction to a closed invoice appears as a credit note on the next one rather than an edit to the original.",
  },
  {
    id: "bill-proration",
    kb: "billing",
    title: "Mid-cycle plan changes",
    text: "Changing a plan mid-cycle prorates both halves: the unused remainder of the old plan is credited and the remaining days of the new plan are charged at the new rate. Proration is calculated to the second. Downgrades take effect immediately for the price and at the end of the cycle for the features, so a team cannot keep an enterprise feature by downgrading on the last day.",
  },
  {
    id: "bill-refunds",
    kb: "billing",
    title: "Refund policy",
    text: "A refund is available within fourteen days of an invoice for an annual plan, and never for usage that has already been consumed. Refunds are returned to the original payment method; if that method has expired, the balance is held as credit. Requests are reviewed by a person, and a refund larger than one month is escalated to finance.",
  },
  {
    id: "bill-tax",
    kb: "billing",
    title: "Tax and VAT",
    text: "Tax is calculated from the billing address at the time the invoice closes. A VAT number supplied after the invoice is issued cannot change that invoice; it applies from the next one. Reverse-charge applies to business customers in another member state who supply a valid number, and the invoice is then issued without tax and marked as the customer's responsibility.",
  },
  {
    id: "bill-seats",
    kb: "billing",
    title: "Counting seats",
    text: "A seat is a person who can sign in, not a person who has signed in. Adding a seat mid-month charges for the remainder of the month; removing one frees the seat immediately but does not credit the month. Invited people who never accept the invitation do not count, and suspended accounts do not count while they are suspended.",
  },
  {
    id: "bill-usage",
    kb: "billing",
    title: "How model usage is metered",
    text: "Model usage is measured in tokens, priced per model, and rounded to the nearest thousand at the end of the month so a single short request does not produce a line item. Cached input tokens are priced at a fraction of fresh input. Prices are published per model and a price change is announced one month before it applies to usage.",
  },
  {
    id: "bill-budgets",
    kb: "billing",
    title: "Budgets and alerts",
    text: "A budget is a monthly ceiling per company or per project. At eighty percent the owners receive an alert; at one hundred percent the budget either warns or refuses work, depending on the policy the company chose. A budget never deletes data or suspends an account. The spend attributed to a run includes every model call it made, including the ones that failed after producing tokens.",
  },
  {
    id: "bill-dunning",
    kb: "billing",
    title: "Failed payments",
    text: "When a card is declined the account enters a grace period of seven days during which work continues. Retries happen on days one, three and seven. After the grace period the account becomes read-only: existing data is visible and exportable but no new runs start. Deleting data for non-payment takes a further thirty days and is announced by email first.",
  },
  {
    id: "bill-currency",
    kb: "billing",
    title: "Currencies and exchange rates",
    text: "Prices are quoted in United States dollars and settled in the customer's currency at the rate on the invoice date. The rate is the daily reference rate plus a small conversion margin that is shown on the invoice. Customers on annual plans may lock the rate for the year at signing.",
  },
  {
    id: "bill-credits",
    kb: "billing",
    title: "Promotional credit",
    text: "Credit granted by support or a promotion expires after twelve months, is applied before any card is charged, and is not refundable in cash. Credit cannot be transferred between companies. An invoice paid entirely with credit still shows the tax, because tax is due on the sale whether or not money moved.",
  },
  {
    id: "bill-annual",
    kb: "billing",
    title: "Annual plans",
    text: "An annual plan is paid in advance and costs ten months instead of twelve. It renews automatically unless it is cancelled at least thirty days before the end date. A cancelled annual plan keeps its features until the end date; nothing is refunded for the unused remainder unless the fourteen-day rule applies.",
  },
  {
    id: "bill-exports",
    kb: "billing",
    title: "Downloading invoices and statements",
    text: "Invoices are available as PDF and as machine-readable JSON from the billing page, and a statement listing every charge for a period can be exported for accounting. Exports are generated on demand and expire after seven days. A finance contact can be added so invoices are also emailed there.",
  },
];

const security: EvalDoc[] = [
  {
    id: "sec-keys",
    kb: "security",
    title: "Provider keys at rest",
    text: "Provider keys are encrypted with a key-encryption key from the environment, and the database stores only the ciphertext and a version. Rotating the key material re-encrypts every stored key under a new version on the next read; the old version stays readable until the migration retires it. Deleting a key is a soft delete so an audit trail survives, and no endpoint returns the secret after it is stored.",
  },
  {
    id: "sec-mfa",
    kb: "security",
    title: "Multi-factor authentication",
    text: "TOTP secrets are encrypted when a key is configured; without that key they are stored in plain text and the server says so at startup. Recovery codes are single-use and hashed. A second factor can be required per organisation, and an administrator cannot disable another person's factor without an audit entry.",
  },
  {
    id: "sec-sessions",
    kb: "security",
    title: "Session lifetime and revocation",
    text: "An access token lives for fifteen minutes and a refresh token for thirty days. Signing out revokes the refresh token, not the access token, which is why a stolen access token is useless after a few minutes. An administrator can revoke every session of a user, and that revocation is recorded with who did it and why.",
  },
  {
    id: "sec-isolation",
    kb: "security",
    title: "Tenant isolation",
    text: "Every durable record is owned by one user or one company, and every item route checks that ownership before it reads. The test suite enumerates each collection with item routes and fails when a new one has no cross-account fixture, so a forgotten check is a failing build rather than a silent leak. A resource that cannot be reached by id is additionally pinned by an owner test.",
  },
  {
    id: "sec-injection",
    kb: "security",
    title: "Prompt injection from documents",
    text: "Text from a document is untrusted input. It is screened for instruction overrides, role reassignment, chat-template delimiters, tool-call markup and exfiltration requests before it reaches a model, and it is framed as data with an explicit note that it is not instructions. The guard's own test feeds twenty hostile documents through the same prompt function the council uses and asserts that no outbound request is made.",
  },
  {
    id: "sec-ssrf",
    kb: "security",
    title: "Fetching a URL on a user's behalf",
    text: "Any outbound fetch of a caller-supplied URL goes through one guard that resolves the host and refuses loopback, link-local, private and metadata addresses. Redirects are followed by hand, one hop at a time, and each hop is checked as if it were the first: a redirect to the metadata service is refused without the second request being made. A loop is capped rather than followed forever.",
  },
  {
    id: "sec-rate-limits",
    kb: "security",
    title: "Rate limits",
    text: "Limits are per address and per user, with a separate bucket for expensive route families. A refused request answers 429 with a retry-after that counts down as the window drains, and the same request is allowed again at the boundary. Traffic inside the window cannot extend it. The bucketed token never appears in a response header.",
  },
  {
    id: "sec-audit",
    kb: "security",
    title: "What the audit log records",
    text: "Registration, sign-in, key addition and removal, permission and budget changes, exports, deletions and every administrative action are recorded as events. Each entry is hash-chained to the previous one, so removing a row breaks the chain and a verification probe notices. Audit entries survive account deletion and cannot be deleted by the application.",
  },
  {
    id: "sec-redaction",
    kb: "security",
    title: "Redaction before the model call",
    text: "Personal data and credentials are detected and redacted on the way in, before the text is sent to a model, not in the response on the way out. A test asserts the redaction happens first by stubbing the model client and checking the bytes it received. Redaction covers email addresses, phone numbers and common key formats, and the finding is recorded with the field but not its value.",
  },
  {
    id: "sec-export",
    kb: "security",
    title: "Account export and deletion",
    text: "An account can export everything it owns — sessions, files, memories, audit entries — as one archive. Deletion removes every durable row the user owns and reports what is retained and why: audit entries are kept for the compliance window, and billing records are kept because tax law requires them. The report names each store, its reason and the date the row will be gone.",
  },
  {
    id: "sec-encryption",
    kb: "security",
    title: "Encryption in transit and at rest",
    text: "Traffic is encrypted in transit at the proxy. At rest, the database depends on the provider's volume encryption plus column encryption for provider keys and multi-factor secrets. Backups are encrypted with the same key hierarchy. A key-material version is stored beside each ciphertext so a rotation can find the rows that still need re-encrypting.",
  },
  {
    id: "sec-permissions",
    kb: "security",
    title: "Roles and permissions",
    text: "Roles are owner, administrator and member. An administrator can manage people and budgets but cannot read another person's private sessions; an owner can do everything except remove the last owner. Permission checks happen at the route, not in the interface, and a change to a role is an audit event with the previous and new role.",
  },
];

export const EVAL_DOCS: EvalDoc[] = [...ops, ...billing, ...security];

export const EVAL_QUERIES: EvalQuery[] = [
  // ── ops (17) ──
  {
    id: "q01",
    kb: "ops",
    query: "how do I undo a release that broke production",
    answer: "ops-rollback",
    relevant: ["ops-rollback"],
  },
  {
    id: "q02",
    kb: "ops",
    query: "can I go back more than five versions",
    answer: "ops-rollback",
    relevant: ["ops-rollback"],
  },
  {
    id: "q03",
    kb: "ops",
    query: "recover the database from last night's copy",
    answer: "ops-restore",
    relevant: ["ops-restore"],
  },
  {
    id: "q04",
    kb: "ops",
    query: "how long are backups kept",
    answer: "ops-restore",
    relevant: ["ops-restore"],
  },
  {
    id: "q05",
    kb: "ops",
    query: "is it okay to drop a column in a migration",
    answer: "ops-migrations",
    relevant: ["ops-migrations"],
  },
  {
    id: "q06",
    kb: "ops",
    query: "what happens to pending jobs if redis is cleared",
    answer: "ops-redis",
    relevant: ["ops-redis"],
  },
  {
    id: "q07",
    kb: "ops",
    query: "which failures wake someone up at night",
    answer: "ops-alerts",
    relevant: ["ops-alerts"],
  },
  {
    id: "q08",
    kb: "ops",
    query: "who gets contacted during a customer outage",
    answer: "ops-alerts",
    relevant: ["ops-alerts"],
  },
  {
    id: "q09",
    kb: "ops",
    query: "has anyone actually tested that we can restore",
    answer: "ops-backups",
    relevant: ["ops-backups", "ops-restore"],
  },
  {
    id: "q10",
    kb: "ops",
    query: "why does the sandbox build ruby from scratch",
    answer: "ops-sandbox-image",
    relevant: ["ops-sandbox-image"],
  },
  {
    id: "q11",
    kb: "ops",
    query: "why does only some percentage of installs get the new build",
    answer: "ops-updates",
    relevant: ["ops-updates"],
  },
  {
    id: "q12",
    kb: "ops",
    query: "the worker is running but jobs are piling up",
    answer: "ops-queue",
    relevant: ["ops-queue"],
  },
  {
    id: "q13",
    kb: "ops",
    query: "how long do we keep traces and logs",
    answer: "ops-logs",
    relevant: ["ops-logs"],
  },
  {
    id: "q14",
    kb: "ops",
    query: "should a monitor treat missing docker as an outage",
    answer: "ops-status-page",
    relevant: ["ops-status-page"],
  },
  {
    id: "q15",
    kb: "ops",
    query: "block work when a team has spent its monthly allowance",
    answer: "ops-cost",
    relevant: ["ops-cost", "bill-budgets"],
  },
  {
    id: "q16",
    kb: "ops",
    query: "what does the status page probe",
    answer: "ops-status-page",
    relevant: ["ops-status-page"],
  },
  {
    id: "q17",
    kb: "ops",
    query: "can a stale cached health answer hide a broken database",
    answer: "ops-status-page",
    relevant: ["ops-status-page"],
  },

  // ── billing (17) ──
  {
    id: "q18",
    kb: "billing",
    query: "when am I actually billed for last month",
    answer: "bill-invoices",
    relevant: ["bill-invoices"],
  },
  {
    id: "q19",
    kb: "billing",
    query: "can an old invoice be corrected instead of credited",
    answer: "bill-invoices",
    relevant: ["bill-invoices"],
  },
  {
    id: "q20",
    kb: "billing",
    query: "we upgraded halfway through the month what do we pay",
    answer: "bill-proration",
    relevant: ["bill-proration"],
  },
  {
    id: "q21",
    kb: "billing",
    query: "if we downgrade do we keep the features until the end",
    answer: "bill-proration",
    relevant: ["bill-proration"],
  },
  {
    id: "q22",
    kb: "billing",
    query: "can I get my money back after two weeks",
    answer: "bill-refunds",
    relevant: ["bill-refunds"],
  },
  {
    id: "q23",
    kb: "billing",
    query: "I added my VAT number after the bill arrived",
    answer: "bill-tax",
    relevant: ["bill-tax"],
  },
  {
    id: "q24",
    kb: "billing",
    query: "does an invited person who never logs in cost a seat",
    answer: "bill-seats",
    relevant: ["bill-seats"],
  },
  {
    id: "q25",
    kb: "billing",
    query: "why is cached input cheaper",
    answer: "bill-usage",
    relevant: ["bill-usage"],
  },
  {
    id: "q26",
    kb: "billing",
    query: "what happens at eighty percent of a budget",
    answer: "bill-budgets",
    relevant: ["bill-budgets", "ops-cost"],
  },
  {
    id: "q27",
    kb: "billing",
    query: "the card was declined how long until we lose access",
    answer: "bill-dunning",
    relevant: ["bill-dunning"],
  },
  {
    id: "q28",
    kb: "billing",
    query: "how many days of service does an annual plan include for free",
    answer: "bill-annual",
    relevant: ["bill-annual", "bill-proration"],
  },
  {
    id: "q29",
    kb: "billing",
    query: "can promotional credit be paid out in cash",
    answer: "bill-credits",
    relevant: ["bill-credits"],
  },
  {
    id: "q30",
    kb: "billing",
    query: "which exchange rate is used when I am billed in euros",
    answer: "bill-currency",
    relevant: ["bill-currency"],
  },
  {
    id: "q31",
    kb: "billing",
    query: "how do I give my accountant the charges for a quarter",
    answer: "bill-exports",
    relevant: ["bill-exports", "bill-invoices"],
  },
  {
    id: "q32",
    kb: "billing",
    query: "when does the annual plan renew and how do I stop it",
    answer: "bill-annual",
    relevant: ["bill-annual"],
  },
  {
    id: "q33",
    kb: "billing",
    query: "does tax get charged when credit pays for everything",
    answer: "bill-credits",
    relevant: ["bill-credits", "bill-tax"],
  },
  {
    id: "q34",
    kb: "billing",
    query: "are failed runs that produced tokens still charged",
    answer: "bill-budgets",
    relevant: ["bill-budgets", "bill-usage"],
  },

  // ── security (16) ──
  {
    id: "q35",
    kb: "security",
    query: "how are third party api secrets stored",
    answer: "sec-keys",
    relevant: ["sec-keys", "sec-encryption"],
  },
  {
    id: "q36",
    kb: "security",
    query: "what happens to keys when the encryption key is rotated",
    answer: "sec-keys",
    relevant: ["sec-keys", "sec-encryption"],
  },
  {
    id: "q37",
    kb: "security",
    query: "are authenticator secrets encrypted or plain",
    answer: "sec-mfa",
    relevant: ["sec-mfa"],
  },
  {
    id: "q38",
    kb: "security",
    query: "how long does a login last before it expires",
    answer: "sec-sessions",
    relevant: ["sec-sessions"],
  },
  {
    id: "q39",
    kb: "security",
    query: "can another company read my sessions by guessing an id",
    answer: "sec-isolation",
    relevant: ["sec-isolation", "sec-permissions"],
  },
  {
    id: "q40",
    kb: "security",
    query: "a document told the model to ignore its instructions",
    answer: "sec-injection",
    relevant: ["sec-injection"],
  },
  {
    id: "q41",
    kb: "security",
    query: "someone pasted a link to our internal metadata address",
    answer: "sec-ssrf",
    relevant: ["sec-ssrf"],
  },
  {
    id: "q42",
    kb: "security",
    query: "how does the api tell a client to back off",
    answer: "sec-rate-limits",
    relevant: ["sec-rate-limits"],
  },
  {
    id: "q43",
    kb: "security",
    query: "which actions leave a tamper evident record",
    answer: "sec-audit",
    relevant: ["sec-audit"],
  },
  {
    id: "q44",
    kb: "security",
    query: "is personal data removed before or after the model sees it",
    answer: "sec-redaction",
    relevant: ["sec-redaction"],
  },
  {
    id: "q45",
    kb: "security",
    query: "what survives when an account is deleted",
    answer: "sec-export",
    relevant: ["sec-export", "sec-audit"],
  },
  {
    id: "q46",
    kb: "security",
    query: "how can I get all of my data out in one file",
    answer: "sec-export",
    relevant: ["sec-export"],
  },
  {
    id: "q47",
    kb: "security",
    query: "can an admin read a colleague's private chats",
    answer: "sec-permissions",
    relevant: ["sec-permissions", "sec-isolation"],
  },
  {
    id: "q48",
    kb: "security",
    query: "is the database volume encrypted as well as the keys",
    answer: "sec-encryption",
    relevant: ["sec-encryption"],
  },
  {
    id: "q49",
    kb: "security",
    query: "a stolen access token after logout still works?",
    answer: "sec-sessions",
    relevant: ["sec-sessions"],
  },
  {
    id: "q50",
    kb: "security",
    query: "does a redirect to localhost get fetched anyway",
    answer: "sec-ssrf",
    relevant: ["sec-ssrf"],
  },
];

/** The three corpora the runner indexes, keyed by knowledge base id. */
export const EVAL_KBS = ["ops", "billing", "security"] as const;
