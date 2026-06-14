// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import { ACLEnforcer, ACLError, InMemoryACLStore, type Principal } from "../src/index.js";

const ALICE: Principal = { type: "user", id: "alice" };
const BOB: Principal = { type: "user", id: "bob" };
const ADMINS: Principal = { type: "group", id: "admins" };
const PUBLIC: Principal = { type: "public" };

function makeEnforcer() {
  return new ACLEnforcer(new InMemoryACLStore());
}

describe("ACLEnforcer.grant + canAccess", () => {
  it("grants read to user and allows access", async () => {
    const e = makeEnforcer();
    await e.grant("doc-1", ALICE, "read");
    expect(await e.canAccess("doc-1", ALICE, "read")).toBe(true);
  });

  it("denies access to user not granted", async () => {
    const e = makeEnforcer();
    await e.grant("doc-1", ALICE, "read");
    expect(await e.canAccess("doc-1", BOB, "read")).toBe(false);
  });

  it("returns false for unknown document", async () => {
    const e = makeEnforcer();
    expect(await e.canAccess("nonexistent", ALICE, "read")).toBe(false);
  });

  it("admin permission satisfies read and write", async () => {
    const e = makeEnforcer();
    await e.grant("doc-1", ALICE, "admin");
    expect(await e.canAccess("doc-1", ALICE, "read")).toBe(true);
    expect(await e.canAccess("doc-1", ALICE, "write")).toBe(true);
    expect(await e.canAccess("doc-1", ALICE, "admin")).toBe(true);
  });

  it("write permission satisfies read but not admin", async () => {
    const e = makeEnforcer();
    await e.grant("doc-1", ALICE, "write");
    expect(await e.canAccess("doc-1", ALICE, "read")).toBe(true);
    expect(await e.canAccess("doc-1", ALICE, "write")).toBe(true);
    expect(await e.canAccess("doc-1", ALICE, "admin")).toBe(false);
  });

  it("read does not satisfy write", async () => {
    const e = makeEnforcer();
    await e.grant("doc-1", ALICE, "read");
    expect(await e.canAccess("doc-1", ALICE, "write")).toBe(false);
  });

  it("public principal grants access to any caller", async () => {
    const e = makeEnforcer();
    await e.grant("doc-1", PUBLIC, "read");
    expect(await e.canAccess("doc-1", ALICE, "read")).toBe(true);
    expect(await e.canAccess("doc-1", BOB, "read")).toBe(true);
    expect(await e.canAccess("doc-1", ADMINS, "read")).toBe(true);
  });

  it("group access works", async () => {
    const e = makeEnforcer();
    await e.grant("doc-1", ADMINS, "admin");
    expect(await e.canAccess("doc-1", ADMINS, "read")).toBe(true);
  });

  it("re-granting upgrades permission", async () => {
    const e = makeEnforcer();
    await e.grant("doc-1", ALICE, "read");
    await e.grant("doc-1", ALICE, "admin");
    expect(await e.canAccess("doc-1", ALICE, "admin")).toBe(true);
  });
});

describe("ACLEnforcer.revoke", () => {
  it("revoke removes access", async () => {
    const e = makeEnforcer();
    await e.grant("doc-1", ALICE, "read");
    await e.revoke("doc-1", ALICE);
    expect(await e.canAccess("doc-1", ALICE, "read")).toBe(false);
  });

  it("revoke on nonexistent doc does not throw", async () => {
    const e = makeEnforcer();
    await expect(e.revoke("ghost", ALICE)).resolves.toBeUndefined();
  });

  it("revoke only removes the target principal", async () => {
    const e = makeEnforcer();
    await e.grant("doc-1", ALICE, "read");
    await e.grant("doc-1", BOB, "read");
    await e.revoke("doc-1", ALICE);
    expect(await e.canAccess("doc-1", BOB, "read")).toBe(true);
  });
});

describe("ACLEnforcer.assertAccess", () => {
  it("does not throw when access is allowed", async () => {
    const e = makeEnforcer();
    await e.grant("doc-1", ALICE, "read");
    await expect(e.assertAccess("doc-1", ALICE, "read")).resolves.toBeUndefined();
  });

  it("throws ACLError with code ACCESS_DENIED when permission insufficient", async () => {
    const e = makeEnforcer();
    await e.grant("doc-1", ALICE, "read");
    try {
      await e.assertAccess("doc-1", ALICE, "write");
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ACLError);
      expect((err as ACLError).code).toBe("ACCESS_DENIED");
    }
  });

  it("throws ACLError with code NOT_FOUND for unknown document", async () => {
    const e = makeEnforcer();
    try {
      await e.assertAccess("ghost", ALICE, "read");
      expect.fail("should throw");
    } catch (err) {
      expect((err as ACLError).code).toBe("NOT_FOUND");
    }
  });
});

describe("ACLEnforcer.filterDocuments", () => {
  it("filters to only accessible docs", async () => {
    const e = makeEnforcer();
    await e.grant("d1", ALICE, "read");
    await e.grant("d2", BOB, "read");
    await e.grant("d3", ALICE, "admin");
    const allowed = await e.filterDocuments(["d1", "d2", "d3"], ALICE, "read");
    expect(allowed).toContain("d1");
    expect(allowed).not.toContain("d2");
    expect(allowed).toContain("d3");
  });

  it("returns empty array when no docs accessible", async () => {
    const e = makeEnforcer();
    const result = await e.filterDocuments(["x", "y"], ALICE, "read");
    expect(result).toEqual([]);
  });
});

describe("ACLError", () => {
  it("carries documentId, principal, requiredPermission", () => {
    const err = new ACLError("ACCESS_DENIED", "doc-1", ALICE, "write");
    expect(err.documentId).toBe("doc-1");
    expect(err.principal).toBe(ALICE);
    expect(err.requiredPermission).toBe("write");
    expect(err.message).toMatch(/doc-1/);
  });
});
