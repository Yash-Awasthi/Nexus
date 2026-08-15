# plan.md

merge done. branch `fresh` built off `ollama` tip (9418999), pulled in main + 2 live
dependabot branch (setup-node-7, setup-python-7, devdeps-50baa80161). 3 clean merge,
zero conflict. old dependabot branch from task note (24659e0b9c, ea593dfa71) gone from
remote already, replaced by these 3, so merged the ones that exist now.

push to origin blocked: PAT token missing `workflow` scope, github reject push that
touch `.github/workflows/*.yml`. branch `fresh` sit local only, not on origin yet.
man must bump token scope (repo settings → PAT → add `workflow`) then push:
`git push origin fresh`.

## hard call, not done, man pick

1. DEPLOY-DOC — two file, two truth. root `DEPLOYMENT.md` (8KB, interview/demo runbook,
   Vercel+Railway+Neon+Redis+Browserbase stack map) vs `docs/DEPLOYMENT.md` (4KB, env-var
   ref + link to `docs/runbook.md`). pick one master, kill other or link it.

2. BRANCH-FOLD — local-dirty vs main. confirmed: local-dirty = ollama + 1 commit
   (d78e459) that touch same 8 file as working-tree dirt, 0 insertion 0 deletion
   (filemode flip only, husky hooks + chaos/codegen script lost exec bit on windows
   checkout). no real diff. safe to drop, but man confirm.

3. STALE-BRANCH — `ollama`. no upstream tracking, orphan. fresh already carry all its
   commit. keep or delete, man decide (folded into fresh either way).

4. STALE-BRANCH x2 — old dependabot ref from task note (24659e0b9c, ea593dfa71) already
   gone from origin, superseded by 3 new dependabot branch. all 3 new one now merged
   into fresh, clean. nothing left to decide here, done.

5. DIRTY-STATE — 8 file (husky hook, chaos script, codegen, dev script, release script)
   flip exec bit on every windows checkout, filemode-only, no content change, no
   conflict marker. touches deploy/release/infra path so man still eyeball before
   trusting, but confirmed empty diff each time re-checked.

## what's broken / half-built (carried from ollama track notes, still true on fresh)

- GET surface: 242 route audited, several still 0x500 (memory embed on empty query,
  admin/traces) — partial fix landed (TRACK-006/007) but not full sweep.
- mail-ingest start path returns 503 not 500 when IMAP unconfigured — fixed, verify
  under real IMAP config still open.
- `_getPool` sentinel fix landed, raw-pg route confirmed alive, no regression test yet.
- council deliberation run key-free on local Ollama — API-key path (Groq/Gemini/
  Mistral/OpenRouter per DEPLOYMENT.md) not re-verified against this merge, task ask
  both to work together — needs a real end-to-end check, not done here.
- UI agents + knowledge-graph crash fix (a5f0e9d) and JWT-on-raw-fetch fix (f2f6946)
  landed, no test added.

## next concrete step

1. man add `workflow` scope to PAT, run `git push origin fresh`.
2. pick DEPLOY-DOC master (#1), delete/link the loser.
3. run ollama path + API-key path (Groq/Gemini/Mistral/OpenRouter) side by side once,
   confirm both work post-merge — this was the actual point of the merge.
4. once fresh verified good, decide on `ollama`, `local-dirty`, `main` — keep one,
   fold or delete rest.
