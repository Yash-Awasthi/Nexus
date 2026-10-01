// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  NexusError,
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  BudgetExceededError,
  GovernanceViolationError,
} from "../src/errors.js";

describe("NexusError", () => {
  it("sets message, code, and name", () => {
    const err = new NexusError("something failed", "SOME_CODE");
    expect(err.message).toBe("something failed");
    expect(err.code).toBe("SOME_CODE");
    expect(err.name).toBe("NexusError");
    expect(err instanceof Error).toBe(true);
  });

  it("carries optional context", () => {
    const ctx = { detail: "extra" };
    const err = new NexusError("msg", "CODE", ctx);
    expect(err.context).toEqual(ctx);
  });
});

describe("ValidationError", () => {
  it("has VALIDATION_ERROR code and correct name", () => {
    const err = new ValidationError("bad input");
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.name).toBe("ValidationError");
    expect(err instanceof NexusError).toBe(true);
  });

  it("forwards optional context", () => {
    const err = new ValidationError("oops", { field: "email" });
    expect(err.context).toEqual({ field: "email" });
  });
});

describe("NotFoundError", () => {
  it("formats message and stores resource/id in context", () => {
    const err = new NotFoundError("User", "abc-123");
    expect(err.message).toBe("User not found: abc-123");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.name).toBe("NotFoundError");
    expect(err.context).toEqual({ resource: "User", id: "abc-123" });
  });
});

describe("UnauthorizedError", () => {
  it("uses default message", () => {
    const err = new UnauthorizedError();
    expect(err.message).toBe("Unauthorized");
    expect(err.code).toBe("UNAUTHORIZED");
    expect(err.name).toBe("UnauthorizedError");
  });

  it("accepts a custom message", () => {
    const err = new UnauthorizedError("token expired");
    expect(err.message).toBe("token expired");
  });
});

describe("BudgetExceededError", () => {
  it("has BUDGET_EXCEEDED code and correct name", () => {
    const err = new BudgetExceededError();
    expect(err.code).toBe("BUDGET_EXCEEDED");
    expect(err.name).toBe("BudgetExceededError");
    expect(err.message).toContain("budget exceeded");
  });

  it("stores optional context", () => {
    const err = new BudgetExceededError({ budget: 100 });
    expect(err.context).toEqual({ budget: 100 });
  });
});

describe("GovernanceViolationError", () => {
  it("embeds policy name in message", () => {
    const err = new GovernanceViolationError("no-root-access");
    expect(err.message).toContain("no-root-access");
    expect(err.code).toBe("GOVERNANCE_VIOLATION");
    expect(err.name).toBe("GovernanceViolationError");
  });

  it("stores optional context", () => {
    const err = new GovernanceViolationError("policy-x", { agent: "worker" });
    expect(err.context).toEqual({ agent: "worker" });
  });
});
