<!-- SPDX-License-Identifier: Apache-2.0 -->
# 0006 — License: Apache-2.0

**Status:** Accepted
**Date:** 2026-06-11

## Context
All four absorbed repos use MIT. NEXUS needs a license for the combined work.

## Decision
Apache-2.0. Rationale: the explicit patent grant in Apache-2.0 provides better protection for contributors and users than MIT, particularly relevant for AI/ML systems where patent risk is non-trivial. Apache-2.0 is compatible with all four upstream MIT licenses — MIT code can be relicensed under Apache-2.0 when combined.

## Consequences
- All new files carry the SPDX header `// SPDX-License-Identifier: Apache-2.0`.
- NOTICE file attributes the four upstream MIT repos with their original license text.
- Third-party contributions are automatically Apache-2.0 via the DCO.
