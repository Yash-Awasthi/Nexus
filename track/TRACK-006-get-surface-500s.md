# TRACK-006 — GET-surface 500s (exposed by the _getPool fix + DB migration)

After fixing `_getPool` (TRACK: pool bug), GETs actually hit the DB — surfacing 6 × 500 on the full
243-route GET sweep. Two classes.

## Class D — code (fixed)
| Route | Cause | Fix |
|-------|-------|-----|
| GET /api/v1/memory | empty `query` → embed "" → Ollama empty embedding → EMBED_FAILED 500 | blank query → `manager.list()` (no embed) |
| GET /api/v1/admin/traces | `gatewayLog.query()` "fetch failed" (obs backend down) → 500 | wrap → `{entries:[],degraded:true}` |
| GET /api/v1/admin/traces/stats | `gatewayLog.stats()` "fetch failed" → 500 | wrap → `{total:0,degraded:true}` |

## Class E — schema drift (fixed by migration, not code)
DB (Neon) was migrated only through ~0006; schema + migrations 0010–0013 existed but were unapplied.
| Route | Root DB error |
|-------|---------------|
| GET /api/v1/billing/keys | `column "monthly_cost_cap_usd" does not exist` (added in 0010_usage_token_breakdown) |
| GET /api/v1/billing/usage/by-model-day | same usage-table drift |
| GET /api/v1/orchestration/runs | `orchestration_runs` table missing (added in 0013_orchestration_runs) |

**Fix:** `DATABASE_URL=… pnpm --filter @nexus/db exec drizzle-kit migrate` → applied 0007–0013.
All three now 200. **This also means any other feature depending on tables from 0007–0013 was broken
before and is now live** (agent_sessions, oauth_credentials, mcp_servers, prompts/build_tasks, etc.).

## Verification
- memory / admin traces / traces-stats → 200.
- billing/keys, billing/usage/by-model-day, orchestration/runs → 200.
- Re-running full GET sweep to confirm 0 × 500.

## Status: ✅ code fixed + DB migrated. Re-sweep pending confirm.
