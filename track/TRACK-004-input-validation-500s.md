# TRACK-004 — Class B (DB) + Class C (undefined) 500s → 400 hardening

Same root class as TRACK-001: unvalidated input reaches code/DB that throws → 500. Fix = validate → 400.

## Class C — undefined access (missing required array)
| Route | Crash | Fix |
|-------|-------|-----|
| POST /api/v1/scraping/bulk | `urls.map` of undefined | guard `urls[]` → 400 |
| POST /api/godmode/stream | `members.map` of undefined | guard `question`+`members[]` → 400 |
| POST /api/negation/add | `patterns is not iterable` | guard `convId`+`patterns[]` → 400 |

## Class B — DB constraint / cast → 500
| Route | Root DB error | Fix |
|-------|---------------|-----|
| POST /api/v1/ingest/events | NOT NULL source/event_type/payload | guard → 400 |
| POST /api/v1/ingest/signals | NOT NULL signal_type/summary | guard → 400 |
| POST /api/v1/runtime/tasks | NOT NULL type/payload | guard → 400 |
| POST /api/v1/governance/approvals | `invalid input syntax for type uuid: "d1"` (entity_id is uuid col) | field guard + try/catch insert → 400 |
| POST /api/v1/council/trigger | uuid cast error on signalId lookup | try/catch select → 400 |

## Verification
Regression on all 11 formerly-500 routes → **0 × 500**:
- nlp/entities, nlp/relationships → 200; knowledge-graph/ingest → 201 (Class A, local Ollama)
- council/trigger, governance/approvals, ingest/events, ingest/signals, runtime/tasks, scraping/bulk,
  godmode/stream, negation/add → 400 on bad input
- Valid-input spot checks: ingest/events→202, ingest/signals→201, runtime/tasks→201,
  governance/approvals(valid UUID)→201.

## Status: ✅ DONE. Whole POST surface now has zero 500s on the swept routes.

## Remaining (TRACK-003, lower severity — NOT 500 crashes)
- `/api/v1/llm/complete` → **502** (llm.ts uses llm-router `nexus/fast`→groq w/ null fallback; should
  route to local Ollama like nlp/kg now do). Same root cause as TRACK-002; same fix pattern.
- `/api/v1/council/deliberate` → 400 (BYOK: `buildUserDriverRegistry` needs stored provider keys;
  confirm whether local Ollama is in COUNCIL_PROVIDERS so deliberations work key-free locally).
- `/api/v1/gateway/*` → 200 but may degrade to null in local mode (verify real output).
