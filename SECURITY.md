<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security Policy

## Supported versions

| Version              | Supported |
| -------------------- | --------- |
| `main` (pre-release) | ✅        |
| Older tags           | ❌        |

Once NEXUS reaches v1.0.0, a formal N-2 minor version support policy will be adopted.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities via GitHub's private vulnerability reporting:
**Settings → Security → Report a vulnerability**

Or email: **yashawasthi12032006@gmail.com**

Please include:

- Description of the vulnerability
- Steps to reproduce
- Affected versions / components
- Suggested severity (Critical / High / Medium / Low)
- Any suggested mitigations

## Response timeline

| Action                | Target                     |
| --------------------- | -------------------------- |
| Acknowledgement       | 48 hours                   |
| Initial assessment    | 5 business days            |
| Patch (Critical/High) | 14 days                    |
| Patch (Medium/Low)    | 90 days                    |
| Public disclosure     | After patch ships + 7 days |

## Cosign public key

Release artefacts (Docker images, GitHub Releases) are signed with cosign. The public key will be published here once v1.0.0 ships.

## Scope

In scope: `packages/*`, `apps/*`, `services/ingest`, `infra/docker`, authentication flows, governance/approval logic, audit log integrity.

Out of scope: third-party dependencies (report upstream), documentation sites, demo instances.

## Recognition

Reporters of valid Critical or High vulnerabilities will be acknowledged in the release notes and SECURITY.md (unless they prefer anonymity).
