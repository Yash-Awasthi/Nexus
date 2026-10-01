<!-- SPDX-License-Identifier: Apache-2.0 -->

# @nexus/auth

Zero-runtime-dependency authentication primitives for NEXUS.

Provides API key verification, HS256 JWT sign/verify, and a Fastify preHandler hook — all implemented on top of Node.js `node:crypto` with no external packages.

## Installation

This package is internal to the NEXUS monorepo. It is consumed by `apps/api`, `apps/worker`, and `services/ingest`.

```ts
import {
  verifyApiKey,
  signJwt,
  verifyJwt,
  authenticate,
  makeFastifyAuthHook,
  AuthError,
} from "@nexus/auth";
```

## API

### `verifyApiKey(token, expected)`

Constant-time API key comparison via `timingSafeEqual`. Returns `true` on match, throws `AuthError("INVALID_TOKEN")` otherwise.

```ts
verifyApiKey(req.headers["x-api-key"], process.env.NEXUS_API_KEY); // true or throws
```

### `signJwt(payload, secret)`

Signs a `NexusTokenPayload` with HMAC-SHA256 and returns a compact JWT string.

```ts
const token = signJwt(
  { sub: "agent-001", role: "agent", exp: Math.floor(Date.now() / 1000) + 3600 },
  process.env.JWT_SECRET,
);
```

### `verifyJwt(token, secret)`

Verifies the HS256 signature and expiry. Returns the decoded `NexusTokenPayload` or throws `AuthError`.

```ts
const payload = verifyJwt(bearerToken, process.env.JWT_SECRET);
// payload.sub, payload.role, payload.exp
```

### `authenticate(authHeader, config)`

Accepts either an API key or a JWT — tries API key first, falls through to JWT.

```ts
const result = authenticate(req.headers.authorization, {
  apiKey: process.env.NEXUS_API_KEY,
  jwtSecret: process.env.JWT_SECRET,
  requiredRole: "agent",
});
// result: { authenticated, subject, role, method }
```

### `makeFastifyAuthHook(config)`

Returns a Fastify `preHandler` hook ready to drop into any route or plugin.

```ts
const authHook = makeFastifyAuthHook({ apiKey: process.env.NEXUS_API_KEY });

await app.register(async (api) => {
  api.addHook("preHandler", authHook);
  api.get("/protected", handler);
});
```

### `NexusRole`

`"admin" | "agent" | "read-only"` with rank ordering (`admin > agent > read-only`). `requiredRole` enforces a minimum rank.

### `AuthError`

```ts
err.code; // "MISSING_TOKEN" | "INVALID_TOKEN" | "EXPIRED_TOKEN" | "INSUFFICIENT_ROLE"
err.httpStatus; // 401 or 403
```

## Testing

```bash
pnpm --filter @nexus/auth test
```

35 tests covering all code paths: AuthError status codes, extractBearerToken edge cases, constant-time key comparison, JWT sign/verify/tamper/expiry, authenticate fallthrough, Fastify hook 401/403 responses.
