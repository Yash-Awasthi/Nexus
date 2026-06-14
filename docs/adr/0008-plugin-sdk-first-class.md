<!-- SPDX-License-Identifier: Apache-2.0 -->

# 0008 — Plugin SDK is First-Class

**Status:** Accepted
**Date:** 2026-06-11

## Context

GhostStack's adapters implement `IExecutionAdapter` directly — there is no published SDK for third parties to build against. workspace's agents are internal. Neither supports external plugin authors.

## Decision

`@nexus/plugin-sdk` is a published, versioned package. Every first-party adapter uses it. The public API (`defineAdapter`, `capability`, `mockContext`) is stable across minor versions. Breaking changes require a major version bump and a migration guide. The plugin author guide (`docs/plugin-author-guide.md`) is a first-class deliverable.

## Consequences

- Third-party adapters are a supported use case from v1.0.0.
- Internal refactors of `@nexus/runtime` must not break the plugin SDK surface.
- The SDK gets its own changelog and semver.
