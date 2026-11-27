<!-- SPDX-License-Identifier: Apache-2.0 -->

# 0021 — A judged eval gate for the council, with its calibration published

**Status:** Accepted
**Date:** 2026-11-25

## Context

`scripts/verify.mjs` had 28 gates and none of them measured the quality of a council answer. Retrieval got one
first (`docs/EVALS.md`): a labelled set, Recall@1/5 and a citation rate. The council has a harder problem — the
output is prose, so "was it good" needs a rubric, a judge, and a reason to believe the judge.

Two failure modes had to be avoided, and both are common:

- **A gate that measures the harness.** Scoring the scripted transport's own output would produce a beautiful 100%
  that says nothing about model quality.
- **A judge whose agreement is assumed.** A rubric judge with no labelled set is an opinion with a percentage sign.

## Decision

1. **Thirty golden prompts** (`packages/council/src/eval/golden.ts`), split across five categories, with one
   prompt deliberately unanswerable so a confident fabrication is scored as failure rather than as coverage.
2. **Five weighted criteria** (coverage 0.30, specificity 0.20, tradeoff 0.20, action 0.20, honesty 0.10), scored
   by a deterministic judge (`judge.ts`), with `ACCEPT_SCORE = 3`.
3. **The judge is calibrated against 53 hand-labelled answers** (`labels.ts`): agreement **92.5%**, Cohen's κ
   **0.849**, **zero false positives**. `judgeIsTrusted` refuses to publish a quality number below κ 0.4, and the
   review-pass calibration (84.9% / 0.696) is published **beside** the current one rather than replaced by it —
   four labels were corrected after the judge disagreed with them and one annotator is an upper bound on
   agreement, both of which a reader needs to interpret 0.849.
4. **The gate fails on regression, not on absolute quality**, with noise set to the summed Wilson half-widths
   (~±0.11 at n=30). A gate tighter than its sample fails on reshuffling and gets deleted; this one is
   deliberately loose and demonstrably fires (0.58 → 0.50 trips three findings).
5. The report is generated into `docs/COUNCIL-EVALS.md` between markers and checked by the `council-evals:check`
   gate in CI and in `make verify`, so the published tables cannot drift from the code that produced them.

## Consequences

- Adding a criterion or a golden prompt changes measured numbers in a committed document. That is the point: the
  diff shows the consequence of the rubric edit.
- The scripted transport means the tables measure **the protocol** — tally, rounds, cost arithmetic, the gate —
  and not model quality. This is stated in the first paragraph of the document, and swapping in a provider
  replaces one function without changing the report shape.
- A single annotator limits the κ to an upper bound; a release gate would want a second one. Recorded rather than
  glossed.
- Every new gate is a minute of CI. Accepted: the alternative is a quality claim nobody re-checks.
