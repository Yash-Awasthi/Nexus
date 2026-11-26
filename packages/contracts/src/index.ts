// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/contracts — inter-service type contracts
 *
 * Authoritative shared types for cross-package and cross-service communication.
 * Import from here, never from individual packages directly.
 */
export * from "./scrape.ts";
export * from "./council.ts";
export * from "./shared/models.ts";
export * from "./shared/errors.ts";
export * from "./shared/stm.ts";
export * from "./shared/math.ts";
export * from "./shared/untrusted.ts";
export * from "./shared/retention.ts";

// Generated from the live route table (openapi.yaml). Regenerate with
// `pnpm types:generate`; CI fails when the committed copy drifts.
export type * from "./generated/openapi.ts";
