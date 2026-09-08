<!-- SPDX-License-Identifier: Apache-2.0 -->

# Spec: Agentic Browser (§15.4) — `stealth-browser`

Status: **spec — no code until scaffolding decision** (ROADMAP §15.4, Tier 3).

## Goal

A headless, scriptable browser surface the Nexus agent can drive: navigate,
click, fill, extract, screenshot, and — the differentiator — complete
multi-step web tasks (login → navigate → act → verify) with anti-bot-resilient
defaults, all behind the same capability/audit seams as every other Nexus
surface.

## Why it fits Nexus

- `@nexus/sandbox` + `buildDockerArgs` already isolate arbitrary code; a
  browser worker is one more BullMQ job type.
- Playwright is the only credible driver (Chromium + Firefox + WebKit from one
  API); it runs fine headless inside the existing Docker sandbox story.
- The capability system (`@nexus/plugin-sdk` AdapterCapability) needs one new
  capability — `browser.navigate` — rather than a bespoke permission scheme.
- Agent integration reuses the existing tool-call loop: browser actions are
  tools, not a new runtime.

## Proposed architecture

```
packages/stealth-browser        — driver layer (Playwright wrapper)
  BrowserSession                — one page + context, per-task lifecycle
  actions: navigate/click/fill/extract/screenshot/waitFor/download
  StealthPolicy                 — UA/viewport/locale/webGL noise, per-session
  TaskScript                    — declarative multi-step plan (JSON) the agent emits
apps/worker/src/handlers/browser-handler.ts — BullMQ job type "browser.task"
apps/api/src/routes/browser.ts — POST /browser/tasks, GET /browser/tasks/:id
  (auth + rate limits like /drive/*; results never include credentials)
apps/ui/app/routes/browser.tsx  — task list + live screenshot stream (SSE)
```

## Anti-bot posture (the "stealth" part — honest scoping)

In scope: realistic fingerprint baseline (UA, viewport, locale, timezone),
human-ish input cadence, referer hygiene, per-session cookie jars, robots.txt
awareness, rate-limit ceilings per target domain.

Explicitly out of scope (never build): CAPTCHA solving services, credential
stuffing, scraping behind paywalls/logins the user does not own, fingerprint
*spoofing* designed to defeat fraud controls. The tool exists for the user's
own automation on sites they may use — the capability model + audit log are the
guardrails.

## Capability + audit wiring

- New capability: `browser.navigate` (add to `KNOWN_CAPABILITIES`).
- Every session logs: target host, action sequence hash, bytes transferred,
  screenshots retained (configurable TTL), and the originating user id —
  content-free, same convention as the GDPR audit line.
- Egress: browser worker inherits the §8.6 deny-by-default egress allowlist;
  per-task domain allowlist is part of the task spec.

## Scaffolding decision needed before code

1. **Playwright in which image?** A dedicated `nexus-browser` Docker image
   (Playwright + fonts + chromium deps, ~1.2 GB) vs. installing browsers into
   the existing sandbox image. Recommendation: dedicated image; the sandbox
   image stays lean.
2. **Where do sessions run?** Worker-host local Chromium (simplest, matches
   Firecracker-later plan) vs. browserless-style remote endpoint. Recommendation:
   worker-local first; the `BrowserSession` seam keeps a remote driver swappable.
3. **TaskScript expressiveness.** Start declarative (JSON steps, no arbitrary
   JS) — safer to audit, enough for 80% of flows. Arbitrary-script mode is a
   later, capability-gated add-on.

## Milestones

1. **M1 — driver + session lifecycle:** `BrowserSession` with the six actions,
   per-task context, screenshots to a temp volume. Tests: action unit tests
   against a local static file server (no external sites).
2. **M2 — worker + route:** BullMQ job, `/browser/tasks` CRUD + status,
   screenshot SSE. Tests: mocked Playwright (`BrowserSession` behind an
   interface), route contract tests.
3. **M3 — TaskScript runner:** declarative step executor with retries +
   verification steps; agent tool-schema for the step vocabulary.
4. **M4 — stealth policy:** fingerprint baseline + cadence; per-domain rate
   ceilings. Tests: policy unit tests (no live sites).
5. **M5 — UI panel.**

## Gates

- Any live third-party site probe (even example.com) is a Gate — all tests stay
  local/mocked until the user opens it.
- Playwright browser download in CI/dev is a host-mutating install (Gate).

## Risks

- Playwright + Chromium in constrained CI: flaky font/locale issues → pin the
  image digest, run screenshot tests with `--deterministic-screenshots` flags.
- Site structural drift breaks TaskScripts: verification steps + explicit
  failure artifacts (screenshot + DOM snapshot) so the agent can re-plan.
