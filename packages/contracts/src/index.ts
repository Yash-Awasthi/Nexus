// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/contracts — inter-service type contracts
 *
 * Authoritative shared types for cross-package and cross-service communication.
 * Import from here, never from individual packages directly.
 */
export * from "./scrape.js";
export * from "./council.js";

// Generated from the live route table (openapi.yaml). Regenerate with
// `pnpm types:generate`; CI fails when the committed copy drifts.
export type * from "./generated/openapi.js";
