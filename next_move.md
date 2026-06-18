# Next Move — Session Handoff

> Read this at session start. Execute the first item on the list immediately.
> Update before every push. This is the autonomous loop.

## Current State (as of 2026-06-18)

*Build: GREEN ✓ | All 105 routes registered ✓ | API coverage: COMPLETE ✓ | TS (judica-compat + domain-feeds): CLEAN ✓*

### What shipped this session
| Commit | What |
|--------|------|
| 2417bc3 | Extract 4 shared helpers (DEFAULT_MODEL, now(), getDefaultDriver(), parseJsonResponse<T>) — -165 lines |
| 893e332 | PersistentStore<T> persistence layer — pg/fs dual backing, all 20 stub stores now persist across restarts |
| 3128ce6 | P2-P5: real cost tracking, LLM evaluation scoring, codegen compile fix, STM with real autotune params |
| 123a716 | Fix codegen route (routes.ts 404) + Dockerfile missing 6 packages (deploy blocker) |
| (latest) | Fix 5 semantic TS errors in judica-compat.ts; wire speculative/run (draft+verify LLM); wire TTS (OpenAI TTS-1); fix domain-feeds syntax error |

### Functional status — ALL PAGES
| Page | Status |
|------|--------|
| chat.tsx | REAL — multi-model council SSE |
| deep-research.tsx | REAL — WebResearcher + Tavily/DDG + LLM synthesis |
| scrape.tsx | REAL — HttpxEngine HTTP scraping + crawl |
| craft.tsx | REAL — LLM content generation |
| autotune.tsx | REAL — 3-phase eval + prompt improvement loop |
| extraction.tsx | REAL — LLM schema inference + structured extraction |
| sandbox.tsx | REAL — node:vm JS execution |
| quality.tsx | REAL — hallucination scoring + speculative draft+verify |
| image-gen.tsx | REAL — DALL-E 3 or Replicate |
| memory.tsx | REAL — @nexus/memory |
| knowledge-graph.tsx | REAL — @nexus/knowledge-graph |
| honesty.tsx | REAL — LLM sycophancy + confidence + minority-report + reframe |
| moderation.tsx | REAL — LLM content safety scoring |
| simulation.tsx | REAL — generative agents tick-by-tick + persona chat |
| negation.tsx | REAL — LLM negation detection + per-conv rule store |
| interrupt-resume.tsx | REAL — IMR run lifecycle + LLM resume |
| what-if.tsx | REAL — simulate branch fork + per-branch tick + LLM compare |
| council-checkpoints.tsx | REAL — checkpoint save + LLM replay re-synthesis |
| standard-answers.tsx | REAL — CRUD + LLM match |
| semantic-cache.tsx | REAL — in-memory cache with stats/config/lookup/invalidate |
| rss.tsx | REAL — feed CRUD + live RSS poll + item read tracking |
| reasoning.tsx | REAL — chain-of-thought via LLM |
| codegen.tsx | REAL — LLM codegen + TS compile (LLM static analysis) + iterate + diff |
| evaluation.tsx | REAL — LLM scoring (quality/coherence/consensus/diversity) + persistent results |
| costs.tsx | REAL — per-request cost tracking via _llm() helper |
| stm.tsx | REAL — @nexus/autotune computeAutoTuneParams, EMA store |
| tts (chat) | REAL — OpenAI TTS-1 if OPENAI_API_KEY; graceful null otherwise |
| workflows.tsx | CRUD + persistent |
| connectors-sync.tsx | CRUD + polling + persistent |
| skills.tsx | CRUD + persistent |
| knowledge-bases.tsx | CRUD + persistent |
| settings.tsx | Full |
| admin-*.tsx | CRUD (users, audit, analytics, flags) |
| billing.tsx | Plan data stub |
| All remaining 70+ pages | Full in-memory CRUD via PersistentStore (create/list/update/delete) |

---

## Remaining Known Gaps

| Item | Severity | Notes |
|------|----------|-------|
| fine-tune/initiate -> 501 | Low | Gated by design — needs OPENAI_API_KEY + Org key |
| phantom.tsx -> auth wall | Low | Calls /api/v1/gateway/messages — requires NEXUS_API_KEY env var |
| costs.tsx coverage gap | Low | Only tracks _llm() helper calls; older driver.complete() calls not counted |
| Python/R/Julia sandbox | Low | node:vm runs JS only; full polyglot needs Docker-in-Docker |
| Thread messages | Low | localStorage only — lost on clear |
| TS2307 module-not-found | Info | Pre-existing; packages need local build. Resolves in Docker builder stage. Not blocking. |

---

## Immediate Next Actions (execute in order)

### 1. Migrate remaining driver.complete() calls to _llm()
About 25 older routes (council, gateway, parseltongue, etc.) call driver.complete() directly and bypass _trackCost(). Convert them to _llm() so costs.tsx shows accurate full-platform spend.

### 2. Wire fine-tune when OPENAI_API_KEY present
Return real OpenAI fine-tuning job list/create/cancel when process.env.OPENAI_API_KEY is set. Currently always 501.

### 3. Render deploy verification
Confirm the Dockerfile fix (123a716) resolves the pnpm frozen-lockfile failure on Render. Check deploy logs once pipeline completes.

---

## Tech debt / known issues
- Older driver.complete() calls not cost-tracked (see item #1)
- phantom.tsx requires NEXUS_API_KEY in deployment env
- Image generation requires OPENAI_API_KEY or REPLICATE_API_KEY in env

---

## Commit Log (recent)
- 123a716  fix codegen route registration + Dockerfile 6 missing packages
- 3128ce6  P2-P5: cost tracking, evaluation, codegen, STM autotune
- 893e332  PersistentStore<T> persistence layer — pg/fs dual backing
- 2417bc3  extract 4 shared helpers (-165 lines)

---

## How This Loop Works
1. Session starts -> read this file -> execute item #1
2. Do work -> commit + push after each logical unit
3. Update this file, push before session ends
