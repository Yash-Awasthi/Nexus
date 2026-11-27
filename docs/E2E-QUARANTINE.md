<!-- verified: eeef071 2026-11-26 -->

# Quarantined E2E specs

A quarantined test still exists and is listed here until it is fixed or deleted. Quarantine
is `test.fixme` with the reason and the failing step written in the spec (see
`docs/TESTING.md`); nothing is retried in place and nothing is deleted to make a run green.

| spec                                   | test                                                            | quarantined | failing step                                                                                                      | unquarantine condition                                                                |
| -------------------------------------- | --------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/ui/tests/e2e/states.spec.ts:112` | `every route shows one offline bar when the network disappears` | 2026-11-26  | `locator('main, nav')` never became visible (fixtures.ts:102), and `waitForPaint` was still requesting after 20 s | A full-suite run that passes the test 5 of 5 on a quiet machine, not isolated reruns. |

## Failure lines

Both under full-suite load, contending host, 03:09-04:35 2026-11-26.

`run2.json`, 20978 ms:

```
TimeoutError: locator.waitFor: Timeout 20000ms exceeded ... locator('main, nav').first() ... at fixtures.ts:102
```

`run5.json`, 169879 ms:

```
Error: waitForPaint: still requesting after 20s - /api/local/status, /api/v1/admin/security/posture, /api/system/config
```
