<!-- SPDX-License-Identifier: Apache-2.0 -->
# 0018 — Pinned Base Images, No `latest` Tags

**Status:** Accepted
**Date:** 2026-06-11

## Context
Docker `latest` tags are mutable. A base image update can silently introduce breaking changes or vulnerabilities. Supply-chain attacks via compromised base images are a documented threat.

## Decision
All `FROM` directives in Dockerfiles reference SHA256 digests:
```dockerfile
FROM node:20-alpine@sha256:<digest>
```
Renovate-bot is configured to open auto-PRs when a new digest is available. Humans review the diff and merge.

## Consequences
- Builds are hermetic — the same Dockerfile always builds the same image.
- Security patches require an explicit PR (Renovate automates the detection).
- SHA256 digests are verbose — use build args or a base image file to manage them.
