// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/shared — base error classes used across all packages.
 */

export class NexusError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "NexusError";
  }
}

export class ValidationError extends NexusError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "VALIDATION_ERROR", context);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends NexusError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, "NOT_FOUND", { resource, id });
    this.name = "NotFoundError";
  }
}

export class UnauthorizedError extends NexusError {
  constructor(message = "Unauthorized") {
    super(message, "UNAUTHORIZED");
    this.name = "UnauthorizedError";
  }
}

export class BudgetExceededError extends NexusError {
  constructor(context?: Record<string, unknown>) {
    super("Council deliberation budget exceeded", "BUDGET_EXCEEDED", context);
    this.name = "BudgetExceededError";
  }
}

export class GovernanceViolationError extends NexusError {
  constructor(policy: string, context?: Record<string, unknown>) {
    super(`Governance policy violation: ${policy}`, "GOVERNANCE_VIOLATION", context);
    this.name = "GovernanceViolationError";
  }
}
