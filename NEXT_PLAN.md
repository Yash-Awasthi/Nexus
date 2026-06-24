# Nexus — Next Plan

> Created: 2026-06-23
> Previous commit: d6974ec (Phase 5 core done)
> Branch: claudecode

## What was done (this session)

- [x] 6 security fixes (auth-gating, sandbox env scrubbing, SSE isolation, MCP SSRF, rate limiter, crypto keys)
- [x] 13 frontend-backend API gaps wired
- [x] 4 frontend bluff pages fixed
- [x] Nexus Drive API routes (6 endpoints)
- [x] Agent command audit logging
- [x] FUTURE_PLAN.md (phases 5-8 overview)

## What needs external infra (can't do from code)

| Task | Blocker | Priority |
|------|---------|----------|
| Firecracker microVM spike | Need KVM host (bare metal or nested virt cloud VM) | HIGH |
| gVisor fallback testing | Need Linux host with runsc installed | MEDIUM |
| Docker sandbox e2e test | Docker daemon needed on worker host | MEDIUM |
| Seccomp profile for agent containers | Need to author + test profile on Linux | LOW |
| Redis cluster for rate limiting | Upstash or Redis instance | MEDIUM |
| PgBouncer connection pooling | DB admin to set up | LOW |
| K8s HPA deployment | Need K8s cluster (already have infra/k8s/) | MEDIUM |
| Grafana dashboards deploy | Need Grafana instance (configs in infra/grafana/) | LOW |
| Stripe webhook endpoint verify | Stripe dashboard to set webhook URL | MEDIUM |
| OAuth app registration | GitHub/Google dev consoles for client IDs | LOW |

## Code-only tasks remaining

### Priority 1 — Complete security hardening

- [x] Symlink attack protection in `safeResolve()` — add `fs.realpath` check
- [x] Content Security Policy review — added `form-action`, prod warning
- [ ] Agent `run_tool_script` PTC sandbox — Worker thread isolation for `AsyncFunction` (in progress)
- [ ] Per-user API key rate limiting (not just IP-based) (in progress)
- [x] Audit log rotation + retention policy — documented as infra concern, structured JSON logs

### Priority 2 — Wiring completion

- [x] All naming mismatches resolved — 25 route aliases added to api-bridge.ts
- [x] billing.tsx frontend — already called correct endpoints, backend routes added
- [x] admin-traces.tsx — backend routes created, frontend already calls correct URL
- [x] All other mismatches — backend route aliases added for all 13 groups

### Priority 3 — Nexus Drive worker

- [ ] Create `apps/worker/src/handlers/drive-handler.ts` — BullMQ job handler for drive operations (in progress)
- [ ] Wire drive handler into task-worker.ts dispatcher (in progress)
- [ ] Add drive usage metrics (Prometheus)
- [ ] Drive idle reclamation cron job (30-day policy)
- [ ] Drive backup/export endpoint

### Priority 4 — Package completion

- [ ] `@nexus/video-transcript` package — real YouTube transcript fetch
- [ ] `@nexus/image-transformations` — wire img2img + img2video to providers
- [ ] `@nexus/browser-agent` — task + session management
- [ ] `@nexus/leaderboard` — live model data aggregation

### Priority 5 — Tests

- [ ] `apps/api/tests/routes/sse-tenant.test.ts` — SSE tenant isolation tests
- [ ] `apps/api/tests/routes/drive.test.ts` — Nexus Drive endpoint tests
- [ ] `apps/worker/tests/handlers/agent-tools.sandbox.test.ts` — sandbox env scrubbing tests
- [ ] `apps/api/tests/lib/rate-limiter.atomic.test.ts` — atomic INCR tests
- [ ] `apps/api/tests/routes/mcp-servers.ssrf.test.ts` — SSRF validation tests

## Next session

1. Start with Priority 2 — pick one frontend-backend mismatch, fix end-to-end
2. Then Priority 1 security items
3. Then Priority 4 package completion (video-transcript package)
4. Write tests for changes

## After external infra is ready

1. Firecracker/GVisor spike → wire into `@nexus/sandbox`
2. Deploy to K8s → test multi-tenant isolation
3. Set up Grafana dashboards → SLO monitoring
4. PgBouncer → connection pooling
5. Redis cluster → atomic rate limiting at scale
