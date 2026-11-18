// What a board's policy finds in Node's environment, loaded the first time a board serves: the
// OIDC tokens made out to it, and its own Vercel project.
export { oidcTokens } from './tokens.ts'
export { discoveryIdentity, ownProjectId, ownTeamId } from './identity.ts'
