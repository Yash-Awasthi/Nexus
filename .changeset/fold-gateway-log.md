---
"@nexus/gateway-log": major
---

Remove `@nexus/gateway-log`; the gateway audit log now lives in the API.

The package had one importer (`apps/api/src/routes/gateway.ts`), no runtime
dependencies, and one source file, so the workspace boundary cost a
`package.json`, a tsconfig reference and a build-graph edge for every consumer —
and bought nothing, because nothing else ever needed the code.
`MemoryGatewayLog`, `KVGatewayLog`, `LoggingLLMProvider`, `computeStats` and the
types are now `apps/api/src/lib/gateway-log.ts`, with the same behaviour and the
same tests (`apps/api/tests/lib/gateway-log.test.ts`).

This is a breaking change for anyone importing the package directly: the last
published version stays installable on npm, but no later version will ship.
