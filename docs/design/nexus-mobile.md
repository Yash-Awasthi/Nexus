<!-- SPDX-License-Identifier: Apache-2.0 -->

# Spec: Nexus Mobile (§15.6) — React Native + push

Status: **spec — no code until scaffolding decision** (ROADMAP §15.6, Tier 3).

## Goal

A React Native app giving mobile access to the Nexus surfaces that matter away
from a desk: conversations/missions status, alerts (domain feeds + system),
approvals (agent waiting-on-human), and quick prompts — with push notifications
as the primary interaction loop.

## Why it fits Nexus

- The API surface is already auth-token based (RS256 §14.1) and rate-limited —
  the app is another first-party client.
- SSE-driven surfaces (missions, codegen) map to push: the server-side event
  the web UI streams is the same event the push relay fan-outs.
- The GDPR/audit posture (§14.4) already defines per-user data scopes; the app
  adds no new data category.

## Proposed architecture

```
apps/mobile/                 — Expo (RN) app
  app/                       — expo-router screens: Missions, Alerts, Approvals, Chat
  lib/api.ts                 — typed client over /api/* (token in SecureStore)
  lib/push.ts                — Expo push token registration + per-device topics
apps/api/src/routes/push.ts  — POST /push/register, DELETE /push/register
apps/worker/src/handlers/push-handler.ts — event → push fan-out (BullMQ)
infra/                       — push relay config (Expo push or FCM/APNs direct)
```

## Push model (the core design decision)

- **Relay:** Expo's push service first (single API for FCM/APNs, no native
  modules); a direct FCM/APNs path is a later swap behind the same
  `PushSink` interface.
- **What gets pushed (opt-in per category, default minimal):**
  - `approval.required` — an agent is waiting on human input (highest value).
  - `mission.completed` / `mission.failed` — terminal states only, no spam.
  - `alert.<domain>` — domain-feed alerts the user explicitly subscribed to,
    severity ≥ high only (§13 adapters already carry severity).
- **Never pushed:** message content. Payloads carry ids + titles only; the app
  fetches content after auth. Same content-free audit principle as §14.4.
- **Quiet hours + per-device mute** enforced server-side (the relay honors
  device state, but the server is the source of truth).

## Auth on mobile

- Login via the existing OAuth flows (§4.3) using the OS browser +
  deep-link redirect (`nexus://auth/callback`) — no webview login (rejected by
  app-store policy and worse security).
- Token storage in `expo-secure-store` (Keychain/Keystore). Refresh follows the
  existing RS256 rotation; device revocation reuses the §14.3 revocation
  registry with a `deviceId` claim.

## Scaffolding decisions needed before code

1. **Expo vs bare RN.** Recommendation: Expo (managed workflow + EAS builds) —
   the app is UI + API calls + push; no native modules beyond Expo's own.
2. **Push relay**: Expo push vs self-hosted FCM/APNs. Recommendation: Expo push
   first, `PushSink` interface so a self-hosted relay can replace it without
   touching route/worker code.
3. **Codepush/OTA updates**: Expo Updates (JS-only OTA) — native releases stay
   store-gated.

## Milestones

1. **M1 — auth + read-only surfaces:** login, mission list/detail, alerts list.
   Tests: API client contract tests against mocked fetch; route tests for
   `/push/register`.
2. **M2 — push loop:** register/unregister, worker fan-out handler, quiet
   hours, category opt-ins. Tests: handler unit tests with a fake PushSink.
3. **M3 — approvals:** approve/reject with audit lines; biometric gate
   (device passcode/biometrics via Expo LocalAuthentication) for approvals.
4. **M4 — chat:** streaming responses over the existing SSE surface, adapted
   to RN's fetch streaming limitations (long-poll fallback documented).

## Gates

- Apple Developer account + APNs key, Google Play/Firebase project — operator
  action before any device push can fire.
- App-store review (if distributed publicly) — operator action.
- Live device testing — user action; all unit tests stay on mocks.

## Risks

- RN fetch streaming (SSE) is unreliable on Android → design the chat transport
  behind a `Transport` seam with an SSE adapter and a polling fallback from M4
  day one.
- Push fatigue → server-side rate ceilings per category (reuse the §14.3
  throttle pattern), digest mode for low-severity alerts.
