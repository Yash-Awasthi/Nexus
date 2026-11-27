---
"@nexus/trigger-engine": major
---

Remove `@nexus/trigger-engine`; the cron and interval triggers now live in the API.

The package had two importers, both in `apps/api` (`src/lib/org-scheduler.ts` and
`src/routes/workflows.ts`), no runtime dependencies, and two source files, so the
workspace boundary cost a `package.json`, a tsconfig reference and a build-graph
edge for one consumer — and bought nothing, because nothing outside the app ever
needed the code. `parseCron`, `cronMatches`, `nextCronRun`, `minuteKey`, `isDue`
and the `Trigger` type are now `apps/api/src/lib/trigger-engine/index.ts` (with
`cron.ts` beside it), with the same behaviour and the same tests
(`apps/api/tests/lib/trigger-engine/`).

This is a breaking change for anyone importing the package directly: the last
published version stays installable on npm, but no later version will ship.
