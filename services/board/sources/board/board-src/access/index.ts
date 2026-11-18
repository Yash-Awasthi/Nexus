// `@vercel/board/access`: who may use a board, and what each may do in which channels. Backend-agnostic:
// `oidcTokens()` (board()'s verifier by default), and the pieces it decides with.
export {
  type Authenticate,
  type AuthenticateContext,
  type HostPrincipal,
  type Known,
  type Principal,
  type PrincipalKind,
  type OidcTokensOptions,
  type IssuerConfig,
  type CallerRequest,
  type Claims,
} from '../server/auth.ts'
export { oidcTokens } from '../server/tokens.ts'
export { resolveActor } from '../server/actors.ts'
export { DEFAULT_CAN } from '../server/auth.ts'
export { CAN_MAX } from '../contract/schemas.ts'
export {
  compileAccess,
  PERMISSIONS,
  parseCan,
  union,
  checkGrantChange,
  InvalidCan,
  FULL_ACCESS,
  type Access,
  type Permission,
  type ChannelPattern,
  type Grant,
  type Can,
  type AccessSummary,
  type GrantChange,
  type GrantChangeRefusal,
  type GrantShape,
} from '../server/access.ts'
export { explainGrants, grantAccess, subPrefix, type Caller, type DecidingGrant, type GrantExplanation, type GrantFacts, type GrantSource } from '../server/grants.ts'
