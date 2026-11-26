// SPDX-License-Identifier: Apache-2.0
/** Startup reports every bad secret at once and stays permissive in development. */
import { describe, expect, it } from "vite-plus/test";

import { collectSecretProblems } from "../../src/lib/startup-env.ts";

describe("collectSecretProblems", () => {
  it("requires the API key in every environment", () => {
    expect(collectSecretProblems({}).errors).toEqual(["NEXUS_API_KEY is not set"]);
  });

  it("collects all production problems in one report", () => {
    const { errors, warnings } = collectSecretProblems({
      NODE_ENV: "production",
      NEXUS_API_KEY: "short",
    });
    expect(errors).toHaveLength(3);
    expect(errors.join("\n")).toContain("NEXUS_API_KEY is a placeholder");
    expect(errors.join("\n")).toContain("NEXUS_JWT_SECRET is not set");
    expect(errors.join("\n")).toContain("NEXUS_AUDIT_KEY is not set");
    expect(warnings.join("\n")).toContain("NEXUS_SECRETS_KEY");
  });

  it("accepts strong production values", () => {
    const key = "a".repeat(32);
    expect(
      collectSecretProblems({
        NODE_ENV: "production",
        NEXUS_API_KEY: key,
        NEXUS_JWT_SECRET: key,
        NEXUS_AUDIT_KEY: key,
        NEXUS_SECRETS_KEY: key,
      }),
    ).toEqual({ errors: [], warnings: [] });
  });

  it("does not enforce production rules in development", () => {
    expect(collectSecretProblems({ NODE_ENV: "development", NEXUS_API_KEY: "dev" })).toEqual({
      errors: [],
      warnings: [],
    });
  });
});
