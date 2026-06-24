# Nexus — Future Plan

> Last revised: 2026-06-23
> Branch: `claudecode`
> Current phase: 4 (learning-loop review)

## Phase summary

| Phase | Status | What |
|-------|--------|------|
| 0 | ✅ Done | DB layer, migrations, schemas |
| 1 | ✅ Done | Agent-runtime loop, native tool-calling (PTC) |
| 2 | ✅ Done | Session persistence, resume, SSE streaming |
| 3 | ✅ Done | Worktree-backed agent workspaces, merge-gating |
| 3b | ✅ Done | Run-server supervisor, worker→API SSE relay |
| 4 | ✅ Done | Programmatic tool calling, learning-loop review |
| **5** | **← NOW** | **Security hardening + sandbox wiring** |
| 6 | Planned | Nexus Drive — per-user Firecracker sandbox |
| 7 | Planned | Production multi-tenant hardening |
| 8 | Planned | Plugin marketplace + federation protocol |

---

## Phase 5 — Security hardening + sandbox wiring (IN PROGRESS)

### 5a: Agent sandbox (done this session)
- ✅ Dropped `...process.env` leak in agent `run_command` → scrubbed env via `buildSafeEnv()`
- ✅ Wired `createDockerRunner()` from `@nexus/sandbox` as optional `dockerConfig` in `CodingToolsOptions`
- ✅ Agent `run_command` now runs with: `--network=none`, `--cap-drop=ALL`, `no-new-privileges`, memory+PID caps

### 5b: Auth hardening (done this session)
- ✅ Auth-gated all `/api/*` legacy routes in api-bridge.ts (plugin-level `requireAuth`)
- ✅ SSE tenant isolation: agent/task streams verify session ownership via DB
- ✅ SSE firehose routes gated to enterprise tier
- ✅ MCP server endpoint URL validation (SSRF protection)
- ✅ Rate limiter: atomic Redis INCR+EXPIRE replaces read-check-set race
- ✅ Crypto key: removed implicit fallback chain, `NEXUS_SECRETS_KEY` only

### 5c: API wiring (in progress)
- ✅ Frontend-backend gap analysis (13 high-impact mismatches found)
- 🔄 Creating missing route handlers (video-transcript, billing extension, context, etc.)
- 🔄 Fixing route name mismatches in api-bridge.ts

### 5d: Frontend bluff fixes (in progress)
- 🔄 contacts.tsx → wire to backend
- 🔄 llm-leaderboard.tsx → wire to live data
- 🔄 archetypes.tsx → add backend persistence
- 🔄 infra-calculator.tsx → add live pricing data

### 5e: Remaining security work
- [ ] Symlink attack protection in `safeResolve()`
- [ ] Seccomp profile for Docker sandbox
- [ ] Read-only rootfs for Docker sandbox
- [ ] User namespace remapping in Docker sandbox
- [ ] Audit log for all agent `run_command` executions
- [ ] Per-user API key rate limiting (not just IP-based)

---

## Phase 6 — Nexus Drive: per-user sandboxed CLI + storage

### Architecture
```
┌─────────────────────────────────────────┐
│  Nexus API (Fastify)                     │
│  /api/v1/drive/*                         │
│    POST /create     — provision sandbox  │
│    POST /exec       — execute in sandbox │
│    GET  /ls         — list files         │
│    GET  /quota      — usage stats        │
│    DELETE /destroy  — tear down          │
└──────────────┬──────────────────────────┘
               │ BullMQ
┌──────────────▼──────────────────────────┐
│  Worker: drive.exec                      │
│  ┌─────────────────────────────────┐    │
│  │ Firecracker microVM (primary)   │    │
│  │  - 512 MB ext4 loopback volume  │    │
│  │  - KVM-based isolation          │    │
│  │  - Network: egress allowlist    │    │
│  │  - CPU: 1 vCPU, RAM: 256 MB     │    │
│  │  - PID limit: 64                │    │
│  │  - Seccomp: default + custom    │    │
│  └─────────────────────────────────┘    │
│  Fallback: gVisor → Docker              │
└─────────────────────────────────────────┘
```

### Implementation plan
1. **Isolation spike** (2 weeks) — prove Firecracker + 512 MB FS quota works
   - Test KVM availability in target deploy environment
   - Build rootfs image with Claude Code preinstalled
   - Verify quota enforcement at FS layer
2. **API layer** (1 week) — `/api/v1/drive/*` routes + BullMQ job type
3. **Worker** (1 week) — `drive.exec` handler with VM lifecycle
4. **UI** (1 week) — terminal panel + file browser (frontend sandbox.tsx already exists)
5. **Persistence** (1 week) — volume lifecycle, idle reclamation (30-day), backup
6. **Hardening** (1 week) — egress policy, audit logging, abuse detection

### Key decisions (locked)
- Isolation: Firecracker (primary), gVisor (fallback), Docker (dev only)
- Storage: 512 MB per user, FS-level quota (not app-level)
- Quota behavior: soft warn at 90%, grace overage, hard block
- Idle reclamation: 30 days idle → warn → reclaim
- API keys: user-supplied via `.env` in sandbox, never logged

---

## Phase 7 — Production multi-tenant hardening

### 7a: Database
- Connection pooling with PgBouncer
- Read replicas for analytics queries
- Point-in-time recovery (PITR)
- Encryption at rest (TDE)

### 7b: Auth
- RS256 JWT for multi-service deployments
- OAuth device flow for CLI auth
- Session revocation + audit trail
- Brute-force protection (exponential backoff)

### 7c: Observability
- Distributed tracing (OTel) across all services
- SLO dashboards (availability, latency, error rate)
- Alerting: PagerDuty/webhook integration
- Cost attribution per user/tenant

### 7d: Infrastructure
- Kubernetes HPA for API + worker
- Multi-AZ Postgres + Redis
- CDN for static assets
- DDoS protection (Cloudflare/rate limiting at edge)

### 7e: Compliance
- SOC 2 readiness (audit logging, access controls)
- GDPR: data residency, right-to-deletion
- Privacy: no LLM data logged, BYOK only

---

## Phase 8 — Plugin marketplace + federation

### 8a: Plugin marketplace
- Package registry for `@nexus/*` adapters
- Version management + dependency resolution
- Review/approval process for community plugins
- Sandboxed plugin execution (Deno isolates?)

### 8b: Federation protocol
- Cross-instance agent delegation
- Federated council (models across instances)
- Shared knowledge graph sync (CRDT-based)
- Identity federation (OIDC/SAML trust)

### 8c: Desktop app
- Electron shell wrapping the React UI
- Local worker for offline agent runs
- Native filesystem access for workspaces
- System tray + notifications

---

## Technology radar

| Tech | Status | When |
|------|--------|------|
| Firecracker | Evaluate | Phase 6 spike |
| gVisor | Fallback | Phase 6 if Firecracker blocked |
| K8s + Helm | Ready (infra/k8s/) | Phase 7 |
| PgBouncer | Adopt | Phase 7 |
| OTel | Ready (infra/otel/) | Phase 7 |
| RS256 JWT | Adopt | Phase 7 |
| Deno isolates | Explore | Phase 8 |
| CRDT sync | Explore | Phase 8 |
| Electron | Explore | Phase 8 |

---

## Risk register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Firecracker KVM unavailable in deploy env | Blocks Phase 6 | gVisor fallback; Docker MVP |
| Multi-tenant isolation breach | Critical | Defense in depth: VM + seccomp + egress policy + audit |
| LLM API key exfiltration via agent | Critical | Sandbox egress allowlist; env scrubbing; audit logging |
| Token cost runaway | High | Per-user budget caps; hard limits in gateway |
| Dependency supply chain attack | Medium | Lockfiles; SBOM; Dependabot/Renovate; `pnpm audit` in CI |
| Data residency violation | Medium | Configurable region; no LLM data logged; BYOK |

---

## Immediate next actions (this session)

1. ✅ Complete Phase 5a–5b (security hardening)
2. 🔄 Complete Phase 5c (API wiring gaps)
3. 🔄 Complete Phase 5d (frontend bluff fixes)
4. [ ] Wire new routes into server.ts
5. [ ] Run typecheck + tests
6. [ ] Commit changes
