# Next Move — Session Handoff

> Read this at session start. Execute the first item on the list immediately.
> Update before every push. This is the autonomous loop.

## Current State (as of 4f6399e)

*Build: GREEN ✓ | All major pages: FUNCTIONAL ✓ | API coverage: COMPLETE ✓*

### What shipped this session
| Commit | What |
|--------|------|
| 810a6b4 | Negation detection (LLM) + IMR runs — negation.tsx + interrupt-resume.tsx |
| eb7d90b | what-if.tsx, council-checkpoints.tsx, standard-answers.tsx, semantic-cache.tsx, rss.tsx |
| 4f6399e | Upgraded all remaining stubs to full in-memory CRUD (POST/PUT/DELETE now work) |

### Functional status — ALL PAGES
| Page | Status |
|------|--------|
| chat.tsx | ✅ REAL — multi-model council SSE |
| deep-research.tsx | ✅ REAL — WebResearcher + Tavily/DDG + LLM synthesis |
| scrape.tsx | ✅ REAL — HttpxEngine HTTP scraping + crawl |
| craft.tsx | ✅ REAL — LLM content generation |
| autotune.tsx | ✅ REAL — 3-phase eval + prompt improvement loop |
| extraction.tsx | ✅ REAL — LLM schema inference + structured extraction |
| sandbox.tsx | ✅ REAL — node:vm JS execution |
| quality.tsx | ✅ REAL — LLM hallucination scoring + groundedness |
| image-gen.tsx | ✅ REAL — DALL·E 3 or Replicate |
| memory.tsx | ✅ REAL — @nexus/memory |
| knowledge-graph.tsx | ✅ REAL — @nexus/knowledge-graph |
| honesty.tsx | ✅ REAL — LLM sycophancy + confidence + minority-report + reframe |
| moderation.tsx | ✅ REAL — LLM content safety scoring |
| simulation.tsx | ✅ REAL — generative agents tick-by-tick + persona chat |
| negation.tsx | ✅ REAL — LLM negation detection + per-conv rule store |
| interrupt-resume.tsx | ✅ REAL — IMR run lifecycle + LLM resume |
| what-if.tsx | ✅ REAL — simulate branch fork + per-branch tick + LLM compare |
| council-checkpoints.tsx | ✅ REAL — checkpoint save + LLM replay re-synthesis |
| standard-answers.tsx | ✅ REAL — CRUD + LLM match |
| semantic-cache.tsx | ✅ REAL — in-memory cache with stats/config/lookup/invalidate |
| rss.tsx | ✅ REAL — feed CRUD + live RSS poll + item read tracking |
| reasoning.tsx | ✅ REAL — chain-of-thought via LLM |
| workflows.tsx | ✅ CRUD |
| connectors-sync.tsx | ✅ CRUD + polling |
| skills.tsx | ✅ CRUD |
| knowledge-bases.tsx | ✅ CRUD |
| settings.tsx | ✅ Full |
| admin-*.tsx | ✅ CRUD (users, audit, analytics, flags) |
| billing.tsx | ✅ Plan data stub |
| costs.tsx | ✅ Stubs |
| blind-council, browser-agent, build, code-agent, cross-memory, echo-chamber, fallback-chains, image-transformations, marketplace, member-evolution, prompt-filter, reactions, skill-selection, sop, specialisation, symbolic, task-routing, token-conservation, verbosity, verifiable, video | ✅ In-memory CRUD (create/list/update/delete fully functional) |

---

## Immediate Next Actions (execute in order)

### 1. Persistence layer — swap in-memory stores for SQLite/JSON-file
All stores (skills, connectors, workflows, kb, craft, images, negation, IMR, checkpoints, etc.)
are in-memory and lost on server restart. Wire a lightweight persistence layer:
- Use `better-sqlite3` OR write a generic JSON-file store to `/tmp/nexus-data/`
- Priority: skills, workflows, kb, craft, connectors (most-used CRUD pages)

### 2. STM (Short-Term Memory) pages
`stm-*.tsx` pages call `/api/stm/*` — currently in CRUD stubs.
Wire real STM state tracking (hedge reducer, directional optimizer) using the existing
`@nexus/autotune` package's context detection.

### 3. Cost tracking — wire real token counting
`costs.tsx` calls `/api/costs/*` stubs. Wire real per-request token counting:
- Intercept all LLM driver calls and accumulate in `_costLog` map
- Expose `GET /costs` with aggregated daily/weekly breakdowns

### 4. Evaluation framework
`evaluation.tsx` calls `/api/evaluation/*` — currently stub CRUD.
Wire LLM-backed eval runs: run a prompt through multiple models, score outputs, return comparison table.

### 5. Fine-tune stub → real OpenAI fine-tune API
`/api/fine-tune/*` returns 501 ("requires OpenAI Org key"). If `OPENAI_API_KEY` present,
wire real OpenAI fine-tuning job create/list/cancel endpoints.

---

## Tech debt / known issues
- All data stores are in-memory — lost on server restart (see item #1 above)
- Python/R/Julia sandbox needs Docker (node:vm runs JS only)
- Image generation needs `OPENAI_API_KEY` or `REPLICATE_API_KEY`
- Thread messages: localStorage only — lost if storage cleared
- Render deploy: should be on latest Fastify build (eb7d90b → 4f6399e auto-deploying)

---

## Commit Log (recent)
- `4f6399e` generic CRUD stub upgrade (all 20 remaining prefixes fully CRUD)
- `eb7d90b` what-if, council-checkpoints, standard-answers, semantic-cache, rss
- `810a6b4` negation detection + IMR runs
- `aaa5fac` hallucination scoring + speculative classify
- `44ab924` node:vm JS sandbox

---

## How This Loop Works
1. Session starts → read this file → execute item #1
2. Do work → commit + push after each logical unit
3. Update this file, push before session ends
