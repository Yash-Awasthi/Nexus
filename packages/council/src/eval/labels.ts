// SPDX-License-Identifier: Apache-2.0
/**
 * Fifty hand-labelled verdicts, written to calibrate the judge in `judge.ts`.
 *
 * Provenance, stated plainly because it decides how much these numbers are worth: one annotator (the author
 * of this file) wrote each answer *and* its label, against the rubric in `golden.ts`, before running the
 * judge. That makes the labels internally consistent but not independent — a second annotator would
 * disagree with some of them, and the κ reported in `docs/COUNCIL-EVALS.md` is an upper bound on what a
 * crowd would show. The set exists so a judge change cannot land without its agreement being re-measured;
 * replacing these labels with a second person's is a one-file change and is the right next step.
 *
 * The answers are deliberately uneven: fluent-but-empty, numeric-but-one-sided, honest-but-useless, and
 * genuinely good. A set of only good and only terrible answers makes any judge look accurate.
 */

import type { LabelledCase } from "./judge.ts";

export const LABELLED_CASES: LabelledCase[] = [
  {
    id: "c01",
    promptId: "g01",
    answer:
      "The export takes 20 minutes and peak writes land at 03:00, so a 04:00 start runs into the busiest hour and leaves two hours for the ledger job to finish before 06:00. I would move it to 04:30 instead, which keeps the ledger deadline and misses most of the write peak. The cost is a tighter margin if the export slows down.",
    accept: true,
    why: "Uses every fact, names the deadline, offers a different time with its cost.",
  },
  {
    id: "c02",
    promptId: "g01",
    answer:
      "Yes, moving it later makes sense because the system will be less busy then and the job should run faster.",
    accept: false,
    why: "No numbers, no deadline, no concession — could describe any job.",
  },
  {
    id: "c03",
    promptId: "g02",
    answer:
      "With Postgres at 55% CPU, sending uncached traffic of 380 ms per request at it is risky, but the eviction storm means the cache is not helping anyway. Bypass for the incident, then re-enable once evictions settle. Watch database CPU and page someone if it passes 75%.",
    accept: true,
    why: "Both numbers, both sides, a step and a guard.",
  },
  {
    id: "c04",
    promptId: "g02",
    answer: "Turning the cache off is the right call during an incident.",
    accept: false,
    why: "A verdict with no reasoning is not a verdict.",
  },
  {
    id: "c05",
    promptId: "g03",
    answer:
      "Raising the timeout does not help: the p99 is 95 s and the load balancer drops idle connections at 100 s, so a 120 s timeout only means the client waits for a connection the proxy already closed. Fix the slow councils or stream progress instead. If the timeout must change, raise the proxy limit first.",
    accept: true,
    why: "Rejects the proposal with the exact reason, and says what to do instead.",
  },
  {
    id: "c06",
    promptId: "g03",
    answer:
      "A 120 s timeout gives slow councils room to finish. The median is 45 s so most runs are unaffected. Downside: clients may hold connections longer.",
    accept: true,
    why: "Engages the median and names a cost, even though it misses the proxy limit.",
  },
  {
    id: "c07",
    promptId: "g04",
    answer:
      "Do not restore the full backup. The WAL is intact, so point-in-time recovery to just before the migration reclaims the 12,000 rows without losing the 24 h of work since. A full restore is simpler and I would take it only if the WAL turns out to be unreadable.",
    accept: true,
    why: "Correct recommendation, both options, precise about the mechanism.",
  },
  {
    id: "c08",
    promptId: "g04",
    answer: "Restore from the backup — that is what backups are for.",
    accept: false,
    why: "Ignores the 24 h of data loss and the 40-minute window.",
  },
  {
    id: "c09",
    promptId: "g05",
    answer:
      "Deleting 6 GB of rows older than 18 months breaks the hash chain that links every row to its predecessor and violates the stated 24-month retention, so not this. Compress older partitions or add a volume instead; if disk pressure is the real problem, that is the cheaper fix at 100 GB.",
    accept: true,
    why: "Names the retention, the chain, the size, and a better option.",
  },
  {
    id: "c10",
    promptId: "g05",
    answer:
      "Freeing 6 GB is worthwhile, but audit data is sensitive so make sure it is done carefully.",
    accept: false,
    why: "Concession without a consequence; ignores the chain entirely.",
  },
  {
    id: "c11",
    promptId: "g06",
    answer:
      "Session storage is 12,000 ops/s against 300 for the queue, so the queue is not what stresses Redis; splitting adds a component for little gain. If queue spikes are the pain, use a separate logical database first. Move to a second instance only when queue ops exceed roughly a tenth of session volume.",
    accept: true,
    why: "Proportionate, gives a threshold, names the operational cost.",
  },
  {
    id: "c12",
    promptId: "g06",
    answer:
      "Splitting the queue onto its own Redis isolates it from session load, which is worth the extra instance, but it does add one more thing to operate.",
    accept: false,
    why: "Reject after review: answers the question without the 12,000-to-300 ratio that makes it a question.",
  },
  {
    id: "c13",
    promptId: "g07",
    answer:
      "Annual revenue is 22% of the total and up-front payment funds 4 months of runway, so switching to monthly removes that cushion exactly when growth spending is planned. Involuntary churn rising from 0.4% to 1.1% makes it worse. Keep annual up front and offer a monthly option only to accounts that ask.",
    accept: true,
    why: "All four facts, both sides, a concrete middle path.",
  },
  {
    id: "c14",
    promptId: "g07",
    answer:
      "Monthly billing is friendlier for customers and would probably reduce churn, so it is worth considering despite the cash-flow impact.",
    accept: false,
    why: "Gets the churn direction backwards and gives no numbers.",
  },
  {
    id: "c15",
    promptId: "g08",
    answer:
      "A 10% fee targets the 12% of invoices paid late, but three accounts are most of that, and the median lateness is 9 days — a 30-day trigger never reaches them. Charge those three accounts interest instead, or shorten their terms. The fee mostly punishes people who are already early.",
    accept: true,
    why: "Finds that the policy misses its target and says what would hit it.",
  },
  {
    id: "c16",
    promptId: "g08",
    answer: "A late fee is standard practice and will encourage prompt payment.",
    accept: false,
    why: "Generic, no engagement with the actual accounts or timing.",
  },
  {
    id: "c17",
    promptId: "g09",
    answer:
      "Refund the 4,000-credit overage. It came from a retry loop in the customer's client, which our terms do not cover fairly, and 14 months on a $99 plan is worth more than the overage. Then add a retry cap to the docs so the next customer does not repeat it.",
    accept: true,
    why: "Takes a position, names the cause and the precedent.",
  },
  {
    id: "c18",
    promptId: "g09",
    answer:
      "Our terms bill overage, so the charge stands; refunding sets a precedent for every client-side bug. The customer has paid for 14 months, which argues the other way, but a rule applied only when it is convenient is not a rule.",
    accept: true,
    why: "The opposite decision, argued with the same facts.",
  },
  {
    id: "c19",
    promptId: "g10",
    answer:
      "Usage pricing fits the 30× spread between accounts better than 6 seats, but it makes revenue lumpy and the daily billing pipeline is too coarse to meter by request. Keep seats for now, and price the next tier on usage once metering is hourly.",
    accept: true,
    why: "Names the spread, the pipeline limit, and a sequenced path.",
  },
  {
    id: "c20",
    promptId: "g10",
    answer:
      "Usage-based pricing aligns cost with value and is the modern approach; the team should adopt it.",
    accept: false,
    why: "Slogan, no numbers, no constraint acknowledged.",
  },
  {
    id: "c21",
    promptId: "g11",
    answer:
      "Writing off the $18,000 clears 30 accounts from collections at a cost of $4,000 a year chasing an 8% recovery — about $1,440 back. That is a losing trade, so write it off, but do it after one final dunning pass on the six accounts that are still active.",
    accept: true,
    why: "Does the arithmetic and keeps the recoverable part.",
  },
  {
    id: "c22",
    promptId: "g11",
    answer:
      "Writing off is an accounting decision; keep pursuing the balance since $18,000 is material.",
    accept: false,
    why: "Ignores the cost of pursuit that makes the decision.",
  },
  {
    id: "c23",
    promptId: "g12",
    answer:
      "A blanket 20% authority on a $14,000 deal hands away $2,800 at 71% margin, and the 4 hours per approval is the real cost — 60 a month is 240 hours. Delegate 10% and keep 20% on approval, then review the discount distribution after a quarter.",
    accept: true,
    why: "Prices the discount and the hours, proposes a split.",
  },
  {
    id: "c24",
    promptId: "g12",
    answer:
      "Yes — approvals are slow and reps know their deals better. Some margin will leak, but speed closes more business, so let them discount up to 20%.",
    accept: false,
    why: "Reject after review: an opinion with none of the four figures that make the decision.",
  },
  {
    id: "c25",
    promptId: "g13",
    answer:
      "Two of last year's breaches came from long-lived tokens, so 365 days reopens exactly that window; the 80% of tokens used by CI rotate quarterly anyway, so the toil saving is small. Cap at 90 days with an override for the CI jobs that cannot rotate.",
    accept: true,
    why: "Uses the breach history and the real distribution.",
  },
  {
    id: "c26",
    promptId: "g13",
    answer:
      "Long-lived tokens are convenient and tokens are hashed at rest, so a 365-day lifetime is acceptable if scopes are narrow.",
    accept: false,
    why: "Hashing at rest does nothing about a stolen token, and the breaches are ignored.",
  },
  {
    id: "c27",
    promptId: "g14",
    answer:
      "Two of the last three incidents began with password-only login, so removing MFA takes away the control that would have stopped them; 3% blocked sign-ins is not a reason to do that. Fix the legacy VPN instead. If it must be relaxed, do it for that VPN range only, with a review date.",
    accept: true,
    why: "Weighs the friction against the incidents and narrows the exception.",
  },
  {
    id: "c28",
    promptId: "g14",
    answer:
      "Turning MFA off for engineering is a bad idea; security should not be traded for convenience.",
    accept: false,
    why: "Right direction, no engagement with the facts given.",
  },
  {
    id: "c29",
    promptId: "g15",
    answer:
      "Read-only and logged is a real control, but 40 support staff seeing IPs and emails widens the personal-data circle beyond what 900 tickets a week requires. Give them a redacted tail of the log and escalate to security for the rest.",
    accept: true,
    why: "Weighs scope against volume and proposes a narrower capability.",
  },
  {
    id: "c30",
    promptId: "g15",
    answer:
      "Support needs the data to answer tickets, so allow access; the logging means misuse would be visible.",
    accept: false,
    why: "Reject after review: no numbers and no concession, only a safeguard-shaped sentence.",
  },
  {
    id: "c31",
    promptId: "g16",
    answer:
      "Nightly backups go to object storage, so keeping the encrypted keys in the same database puts the ciphertext and its backup on one path; a stolen backup then needs only the environment key. Move the wrapped keys to a separate secret store, and automate the rotation that is currently manual.",
    accept: true,
    why: "Identifies the actual coupling and the manual gap.",
  },
  {
    id: "c32",
    promptId: "g16",
    answer:
      "Keeping keys in the same database is simpler to operate and they are encrypted anyway.",
    accept: false,
    why: "Misses that backups widen exposure; 'encrypted' is not a control against a stolen backup.",
  },
  {
    id: "c33",
    promptId: "g17",
    answer:
      "No to shared-namespace egress: the sandbox has no network so that a single customer's build cannot exfiltrate across a shared kernel. Preinstall the packages they need in an image, or give them a build step on their own infrastructure. If egress is unavoidable, it has to come with per-customer isolation first.",
    accept: true,
    why: "Names the exact risk and offers two alternatives.",
  },
  {
    id: "c34",
    promptId: "g17",
    answer:
      "Allowing outbound access for one customer is a reasonable accommodation if it is monitored.",
    accept: false,
    why: "Monitoring does not contain a shared-kernel escape; no alternative offered.",
  },
  {
    id: "c35",
    promptId: "g18",
    answer:
      "Add the second admin. Three people and one on-call admin is a single point of failure, and the HMAC chain means both accounts' actions are auditable. Keep a break-glass credential offline as the third path, reviewed quarterly.",
    accept: true,
    why: "Decides, uses the audit fact, adds the missing control.",
  },
  {
    id: "c36",
    promptId: "g18",
    answer:
      "A second admin account makes sense for a three-person team, though it doubles what an attacker can reach.",
    accept: false,
    why: "Reject after review: balanced but does not name one fact or one next step.",
  },
  {
    id: "c37",
    promptId: "g19",
    answer:
      "The graph view costs 90 ms on a mid laptop, so shipping it to every tier spends performance on the 92% who are not paying. It is the top request in 200 tickets, though, which is adoption evidence. Ship it free behind a quality floor (static scene below 30 fps) and keep export and history as the paid reason.",
    accept: true,
    why: "Prices the cost, reads the demand, preserves an upgrade path.",
  },
  {
    id: "c38",
    promptId: "g19",
    answer: "Give it to everyone; features should not be paywalled and adoption will follow.",
    accept: false,
    why: "A principle, not an answer to a 90 ms cost on non-paying accounts.",
  },
  {
    id: "c39",
    promptId: "g20",
    answer:
      "The sidebar is used in 62% of sessions against 11% for the palette, so replacing it would remove what most people reach for to save 40 lines of state. Put the palette alongside the sidebar as a shortcut instead.",
    accept: true,
    why: "Uses both usage numbers to reject the framing.",
  },
  {
    id: "c40",
    promptId: "g20",
    answer:
      "A command palette is the better interaction for power users and reduces code, so make the switch.",
    accept: false,
    why: "Ignores that 62% of sessions use the thing being removed.",
  },
  {
    id: "c41",
    promptId: "g21",
    answer:
      "Red/blue earns 0.2 in blind ratings on 6% of runs, which is a small sample; a fourth mode adds 400 lines and a support burden for that. Improve the existing modes before adding one. Revisit if the 6% grows.",
    accept: true,
    why: "Proportionate, with a condition for revisiting.",
  },
  {
    id: "c42",
    promptId: "g21",
    answer: "Adding a fourth mode is worth it because variety in reasoning improves outcomes.",
    accept: false,
    why: "Asserts the benefit the context does not show.",
  },
  {
    id: "c43",
    promptId: "g22",
    answer:
      "Showing cost first on a dashboard that starts 70% of sessions prevents the surprise that stops 9% of runs mid-flight, but it may also talk people out of the runs that pay for the product. Put the estimate next to the run button rather than above the results.",
    accept: true,
    why: "Both risks, and a placement that answers both.",
  },
  {
    id: "c44",
    promptId: "g22",
    answer:
      "Users should see cost before results so there are no surprises; transparency builds trust and 9% hitting a budget stop is too many.",
    accept: true,
    why: "One-sided but engages the numbers and states a reason.",
  },
  {
    id: "c45",
    promptId: "g23",
    answer:
      "2 GB a month is manageable, but search at 900 ms over 50,000 threads will not improve by keeping everything; it degrades with volume. Keep archives for a year and move older threads to cold storage that is searchable on demand.",
    accept: true,
    why: "Engages the growth and the search cost, proposes a tier.",
  },
  {
    id: "c46",
    promptId: "g23",
    answer: "Keep them forever — storage is cheap and users expect their history to be there.",
    accept: false,
    why: "A cost claim contradicted by the 900 ms search and 2 GB a month.",
  },
  {
    id: "c47",
    promptId: "g24",
    answer:
      "1,100 lines with 60% overlap is worth merging, but the module that is only covered through routes needs direct tests first, or the merge hides the regressions it introduces. Four engineers can review it if it lands as three steps rather than one 1,100-line diff.",
    accept: true,
    why: "Sequences the work and names the actual risk.",
  },
  {
    id: "c48",
    promptId: "g25",
    answer:
      "The client is 2,400 lines and drifts from the spec monthly, so generation pays for itself; the cost is a build step everyone must run and a codegen dependency. Generate it in CI and commit the output so the dependency stays out of the developer loop.",
    accept: true,
    why: "Pays the drift against the toolchain and resolves it.",
  },
  {
    id: "c49",
    promptId: "g26",
    answer:
      "The last three regressions were in code at 90% coverage, so the 70% floor is not what is failing; 300 new tests in two packages at 71% would buy a week of work and no regression protection. Raise the floor to 78% to stop it sliding and spend the week on the routes that broke.",
    accept: true,
    why: "Uses the counter-evidence in the context instead of the headline number.",
  },
  {
    id: "c50",
    promptId: "g29",
    answer:
      "0.3% on one route with 0.31% of the 0.5% monthly budget already used is inside the allowance, and nobody is awake to confirm a deploy, so a page would wake someone for a blip. Watch it until morning; page only if it crosses 0.5% or spreads beyond the route.",
    accept: true,
    why: "Reads the budget correctly and sets a trigger.",
  },
  {
    id: "c51",
    promptId: "g29",
    answer: "Any error increase should be paged immediately — the SLO is there to protect users.",
    accept: false,
    why: "Ignores the budget position and the single route.",
  },
  {
    id: "c52",
    promptId: "g30",
    answer:
      "There is no usage data yet, so any number is an estimate: I would guess 5–15% of active accounts in the first month, assuming the export is discoverable from where people already work. State the assumption and revisit after two weeks.",
    accept: true,
    why: "Refuses false precision and gives a range with its basis.",
  },
  {
    id: "c53",
    promptId: "g30",
    answer:
      "Expect about 12% of customers to use the new export feature based on typical adoption curves.",
    accept: false,
    why: "Invites a number the context cannot support, with no hedge.",
  },
];
