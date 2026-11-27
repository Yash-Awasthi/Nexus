// SPDX-License-Identifier: Apache-2.0
/**
 * The golden set: thirty decision prompts with the points a good verdict must make.
 *
 * This is the content half of the council evaluation — the half that cannot be computed. Each prompt is a
 * decision a person would actually bring to the council (a migration, a spend, a policy change), and
 * `mustMention` holds the specific things a verdict has to contain to be worth reading: a number, a
 * constraint, the tradeoff. A verdict that is fluent but never mentions any of them is not a good verdict,
 * however well it is written, which is why the score is driven by these points rather than by length.
 *
 * Prompts are deliberately drawn from the three bodies of knowledge the product ships (operations, billing
 * policy, access policy) plus product decisions, because a council that only shines on abstract questions
 * has not been tested on the ones people ask it.
 */

export type CouncilCategory = "operations" | "billing" | "security" | "product" | "engineering";

export interface RubricCriterion {
  id: "coverage" | "specificity" | "tradeoff" | "action" | "honesty";
  /** What a 5 looks like, in one sentence. */
  five: string;
}

export interface GoldenPrompt {
  id: string;
  category: CouncilCategory;
  proposal: string;
  context: string;
  /** Facts, numbers or constraints a good verdict has to engage with. */
  mustMention: string[];
  /** What a person would weigh before deciding, used by the judge for the tradeoff criterion. */
  tradeoff: string;
  /** Whether the question is answerable from the context given. An unanswerable one must be hedged. */
  answerable: boolean;
}

export const RUBRIC: RubricCriterion[] = [
  {
    id: "coverage",
    five: "Engages every fact that makes this decision hard, not just the first one.",
  },
  {
    id: "specificity",
    five: "Names numbers, components and timeframes rather than saying 'the system' and 'soon'.",
  },
  {
    id: "tradeoff",
    five: "States what the recommendation costs, and what would make the other option right instead.",
  },
  {
    id: "action",
    five: "Ends with something the reader can do, or a condition under which to do it.",
  },
  {
    id: "honesty",
    five: "Does not claim more certainty than the context supports.",
  },
];

export const GOLDEN_PROMPTS: GoldenPrompt[] = [
  {
    id: "g01",
    category: "operations",
    proposal: "Move the nightly billing export from 02:00 to 04:00 UTC",
    context:
      "The export reads the orders table for 20 minutes. Peak writes are 03:00–05:00 UTC at about 900 rows/s. The downstream ledger job must finish before 06:00.",
    mustMention: ["20 minutes", "03:00", "ledger", "06:00"],
    tradeoff: "Later start avoids peak writes but crowds the ledger deadline.",
    answerable: true,
  },
  {
    id: "g02",
    category: "operations",
    proposal: "Turn off the Redis cache for the customer list endpoint during the incident",
    context:
      "The endpoint answers in 40 ms cached and 380 ms uncached. Postgres is at 55% CPU. The incident is a cache-node eviction storm.",
    mustMention: ["380 ms", "55%", "Postgres", "eviction"],
    tradeoff: "Bypassing the cache removes the storm but moves load onto the database.",
    answerable: true,
  },
  {
    id: "g03",
    category: "operations",
    proposal: "Raise the request timeout from 30 s to 120 s for the council route",
    context:
      "Council runs take a median of 45 s and a p99 of 95 s. The load balancer closes idle connections at 100 s.",
    mustMention: ["45 s", "95 s", "100 s", "load balancer"],
    tradeoff: "A longer timeout lets slow councils finish but exceeds the proxy's idle limit.",
    answerable: true,
  },
  {
    id: "g04",
    category: "operations",
    proposal: "Restore the database from yesterday's backup after a bad migration",
    context:
      "The bad migration ran 40 minutes ago and changed 12,000 rows. A logical backup from 24 h ago exists; the WAL is intact.",
    mustMention: ["12,000", "24 h", "WAL", "40 minutes"],
    tradeoff:
      "A full restore is simple but loses a day; point-in-time recovery is precise but slower to verify.",
    answerable: true,
  },
  {
    id: "g05",
    category: "operations",
    proposal: "Delete the oldest audit rows to free disk",
    context:
      "The audit table is 40 GB of a 100 GB volume. Rows older than 18 months are 6 GB. The retention policy says 24 months, and the hash chain links every row to its predecessor.",
    mustMention: ["40 GB", "6 GB", "24 months", "hash chain"],
    tradeoff: "Deleting frees space but breaks the chain and the stated retention.",
    answerable: true,
  },
  {
    id: "g06",
    category: "operations",
    proposal: "Move the worker queue to a second Redis instance",
    context:
      "The queue shares Redis with session storage. Session reads are 12,000 ops/s; the queue does 300 ops/s. A second instance doubles the operational surface.",
    mustMention: ["12,000 ops/s", "300 ops/s", "session", "operational surface"],
    tradeoff: "Isolation protects sessions from queue spikes but adds a component to run.",
    answerable: true,
  },
  {
    id: "g07",
    category: "billing",
    proposal: "Bill annual plans monthly instead of up front",
    context:
      "Annual plans are 22% of revenue. Up-front payment funds 4 months of runway. Monthly billing raises involuntary churn from 0.4% to an estimated 1.1%.",
    mustMention: ["22%", "4 months", "0.4%", "1.1%"],
    tradeoff: "Monthly billing is friendlier but costs cash flow and churn.",
    answerable: true,
  },
  {
    id: "g08",
    category: "billing",
    proposal: "Add a 10% late fee to invoices unpaid after 30 days",
    context:
      "12% of invoices are paid late, mostly by three accounts. Median lateness is 9 days. Support handles 40 billing tickets a week.",
    mustMention: ["12%", "three accounts", "9 days", "40"],
    tradeoff: "The fee changes behaviour but may sour the accounts that pay the most.",
    answerable: true,
  },
  {
    id: "g09",
    category: "billing",
    proposal: "Refund a customer who used 4,000 of 500 included credits",
    context:
      "The overage was caused by a retry loop in the customer's client. Our terms bill overage; the customer is on a $99 plan and has paid for 14 months.",
    mustMention: ["4,000", "500", "retry loop", "14 months"],
    tradeoff: "A refund keeps a long customer but sets a precedent for client-side bugs.",
    answerable: true,
  },
  {
    id: "g10",
    category: "billing",
    proposal: "Move from per-seat to usage-based pricing",
    context:
      "Median account has 6 seats and 40,000 requests a month. Seat revenue is predictable; usage varies 30× between accounts. The billing pipeline bills once a day.",
    mustMention: ["6 seats", "40,000", "30×", "once a day"],
    tradeoff: "Usage pricing matches value but makes revenue lumpy and needs finer metering.",
    answerable: true,
  },
  {
    id: "g11",
    category: "billing",
    proposal: "Write off $18,000 of uncollected invoices older than a year",
    context:
      "The invoices belong to 30 accounts, 24 of which are dormant. Collections cost about $4,000 a year to pursue and recover roughly 8%.",
    mustMention: ["$18,000", "30 accounts", "$4,000", "8%"],
    tradeoff: "Writing off cleans the books but abandons recoverable money.",
    answerable: true,
  },
  {
    id: "g12",
    category: "billing",
    proposal: "Give the sales team a 20% discount authority without approval",
    context:
      "Average deal size is $14,000 a year. Gross margin is 71%. The finance team currently approves 60 discounts a month at about 4 hours each.",
    mustMention: ["$14,000", "71%", "60", "4 hours"],
    tradeoff: "Delegation speeds deals but spends margin without review.",
    answerable: true,
  },
  {
    id: "g13",
    category: "security",
    proposal: "Allow API tokens to live for 365 days",
    context:
      "Tokens are scoped and hashed at rest. 80% of active tokens are used by CI jobs that rotate quarterly. Two breaches last year came from long-lived tokens.",
    mustMention: ["365", "hashed", "80%", "two breaches"],
    tradeoff: "Longer tokens reduce CI toil but lengthen the window a stolen token is useful.",
    answerable: true,
  },
  {
    id: "g14",
    category: "security",
    proposal: "Turn off MFA enforcement for the engineering org",
    context:
      "MFA blocks about 3% of sign-ins, mostly from a legacy VPN. Two of the last three incidents began with a password-only login.",
    mustMention: ["3%", "legacy VPN", "two of the last three", "password-only"],
    tradeoff:
      "Turning it off removes a friction point and removes the control that stopped the incidents.",
    answerable: true,
  },
  {
    id: "g15",
    category: "security",
    proposal: "Let support staff read customer audit logs",
    context:
      "Support has 40 staff and handles 900 tickets a week. Audit logs contain IP addresses and account emails. Access would be read-only and logged.",
    mustMention: ["40", "900", "IP addresses", "logged"],
    tradeoff: "Access shortens tickets but widens the circle of people who can see personal data.",
    answerable: true,
  },
  {
    id: "g16",
    category: "security",
    proposal: "Store provider API keys in the same database as the rest of the data",
    context:
      "Keys are currently encrypted with a key from the environment. The database is backed up nightly to object storage. Rotation exists but is manual.",
    mustMention: ["environment", "nightly", "object storage", "manual"],
    tradeoff:
      "One store is simpler to back up but puts ciphertext and the wrapped key on the same path.",
    answerable: true,
  },
  {
    id: "g17",
    category: "security",
    proposal: "Open the sandbox to outbound network access for one customer",
    context:
      "The sandbox has no egress by design. The customer needs to install packages at build time. Their code runs on our infrastructure with a shared kernel namespace.",
    mustMention: ["egress", "install packages", "shared kernel", "one customer"],
    tradeoff: "Egress unblocks the build but opens the exfiltration path the design closed.",
    answerable: true,
  },
  {
    id: "g18",
    category: "security",
    proposal: "Add a second admin account for the primary engineer",
    context:
      "Admin actions are audited with an HMAC chain. The team is three people. The current admin is on call 24/7 and there is no break-glass path.",
    mustMention: ["HMAC", "three people", "break-glass", "audited"],
    tradeoff:
      "A second admin removes a single point of failure and doubles the accounts to protect.",
    answerable: true,
  },
  {
    id: "g19",
    category: "product",
    proposal: "Ship the knowledge graph view to every plan tier",
    context:
      "The 3-D view costs about 90 ms of extra main-thread work on a mid laptop. It is the most-requested feature in 200 support tickets. The paid tier is 8% of accounts.",
    mustMention: ["90 ms", "200", "8%", "mid laptop"],
    tradeoff:
      "Free access drives adoption but removes an upgrade reason and costs performance everywhere.",
    answerable: true,
  },
  {
    id: "g20",
    category: "product",
    proposal: "Replace the deliberation sidebar with a command palette",
    context:
      "62% of sessions open the sidebar; the palette is used by 11% of users. The sidebar costs 40 lines of state and one render per keystroke in search.",
    mustMention: ["62%", "11%", "40 lines", "keystroke"],
    tradeoff: "The palette is faster for experts and invisible to the majority who use the list.",
    answerable: true,
  },
  {
    id: "g21",
    category: "product",
    proposal: "Add a fourth reasoning mode to the council",
    context:
      "Three modes exist; red/blue is used in 6% of runs and scores 0.2 higher in blind ratings. Each mode is about 400 lines and a support burden.",
    mustMention: ["6%", "0.2", "400 lines", "blind ratings"],
    tradeoff: "A new mode may raise quality for a few and adds surface for everyone.",
    answerable: true,
  },
  {
    id: "g22",
    category: "product",
    proposal: "Make the dashboard show cost before results",
    context:
      "Cost is currently a separate page. Users run a median of 4 councils a day; 9% hit a budget stop. The dashboard is the landing page for 70% of sessions.",
    mustMention: ["4 councils", "9%", "budget stop", "70%"],
    tradeoff:
      "Showing cost first prevents surprises and may discourage the runs that pay for the product.",
    answerable: true,
  },
  {
    id: "g23",
    category: "product",
    proposal: "Keep archived deliberations forever",
    context:
      "Archives grow about 2 GB a month. A deliberation is 40 KB on average. Search over archives takes 900 ms at 50,000 threads.",
    mustMention: ["2 GB", "40 KB", "900 ms", "50,000"],
    tradeoff:
      "Keeping everything is honest to the user and makes search slower and storage unbounded.",
    answerable: true,
  },
  {
    id: "g24",
    category: "engineering",
    proposal: "Merge the three cache modules into one",
    context:
      "The modules have 1,100 lines total and 60% overlap. Two of them have separate tests; the third is covered only through routes. The team is four engineers.",
    mustMention: ["1,100 lines", "60%", "four engineers", "covered only through routes"],
    tradeoff: "One module is easier to reason about and is a large diff to review and regress.",
    answerable: true,
  },
  {
    id: "g25",
    category: "engineering",
    proposal: "Replace the hand-written API client with a generated one",
    context:
      "The client is 2,400 lines and drifts from the OpenAPI spec about once a month. Generation adds a build step and a codegen dependency; the spec is generated from route schemas.",
    mustMention: ["2,400 lines", "once a month", "build step", "OpenAPI"],
    tradeoff: "Generation removes drift and adds a toolchain everyone must run.",
    answerable: true,
  },
  {
    id: "g26",
    category: "engineering",
    proposal: "Raise the test coverage floor from 70% to 85%",
    context:
      "Current coverage is 78%. The last three regressions were in code covered at 90%. Two packages sit at 71% and would need about 300 new tests.",
    mustMention: ["78%", "90%", "71%", "300"],
    tradeoff:
      "A higher floor catches more and spends a week of work where regressions have not happened.",
    answerable: true,
  },
  {
    id: "g27",
    category: "engineering",
    proposal: "Move the monorepo from pnpm workspaces to a task runner with remote cache",
    context:
      "CI takes 14 minutes, of which 9 are tests. The team merges 25 pull requests a week. Remote cache needs a token and a service to trust.",
    mustMention: ["14 minutes", "9", "25", "remote cache"],
    tradeoff: "Caching cuts waits and adds a dependency on a service holding build artefacts.",
    answerable: true,
  },
  {
    id: "g28",
    category: "engineering",
    proposal: "Adopt a stricter lint rule set that fails on any explicit any",
    context:
      "There are 15 existing `any`s in production code and 40 in tests. The team ships about 30 files a week. The rule is already available in the current plugin version.",
    mustMention: ["15", "40", "30 files", "plugin version"],
    tradeoff:
      "Strictness prevents new escape hatches and blocks work until the existing ones are typed.",
    answerable: true,
  },
  {
    id: "g29",
    category: "operations",
    proposal: "Decide whether to page someone tonight about a 0.3% error increase",
    context:
      "The increase started 20 minutes ago and affects one route. The SLO allows 0.5% for the month and 0.31% has been used. Nobody is awake to confirm a deploy.",
    mustMention: ["0.3%", "0.5%", "0.31%", "one route"],
    tradeoff: "Paging protects the budget and may wake someone for a blip.",
    answerable: true,
  },
  {
    id: "g30",
    category: "product",
    proposal: "Estimate how many customers will use the new export feature",
    context:
      "The feature shipped yesterday. No usage data exists yet and no comparable feature has shipped.",
    mustMention: ["yesterday", "no usage data"],
    tradeoff: "Any number is a guess; the honest answer is a range with its assumption stated.",
    answerable: false,
  },
];

/** Prompts where the context cannot support a confident answer; a verdict must say so. */
export const UNANSWERABLE = GOLDEN_PROMPTS.filter((prompt) => !prompt.answerable).map((p) => p.id);
