<!-- SPDX-License-Identifier: Apache-2.0 -->

# 0015 — Piston for Languages Outside the Docker Sandbox

**Status:** Accepted
**Date:** 2026-09-28

## Context

The sandbox runs Python, R, Julia and shell in locked-down Docker containers (read-only root, no network, memory and process caps). Users also want Ruby, TypeScript and dozens of other languages, and maintaining an image per language is not worth it.

## Decision

Languages without a Docker image are sent to a Piston instance (`PISTON_URL`). The public emkc.org endpoint became whitelist-only on 2026-02-15, so only an explicitly configured, self-hosted Piston counts; without one, those languages answer with a setup hint instead of pretending to run.

## Consequences

- One service covers 70+ languages with its own isolation.
- A deployment that wants them runs Piston (`docker run -p 2000:2000 ghcr.io/engineer-man/piston`).
- Code sent to Piston leaves the API process, so Piston must be on a trusted network.
