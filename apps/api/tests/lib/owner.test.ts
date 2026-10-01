// SPDX-License-Identifier: Apache-2.0
/** Rows from before owner scoping belong to no one on a shared server, and to the user on the desktop. */
import { afterEach, describe, expect, it } from "vitest";

import { ownsRow } from "../../src/lib/owner.js";

afterEach(() => {
  delete process.env.NEXUS_DESKTOP;
});

describe("ownsRow", () => {
  it("matches the caller's own rows only", () => {
    expect(ownsRow({ nexusUserId: "a" }, { ownerId: "a" })).toBe(true);
    expect(ownsRow({ nexusUserId: "b" }, { ownerId: "a" })).toBe(false);
    expect(ownsRow({}, { ownerId: "a" })).toBe(false);
  });

  it("gives an ownerless row to no one on a shared server and to the desktop's user", () => {
    expect(ownsRow({ nexusUserId: "a" }, {})).toBe(false);
    expect(ownsRow({ nexusUserId: "a" }, { ownerId: null })).toBe(false);
    expect(ownsRow({}, {})).toBe(true);
    process.env.NEXUS_DESKTOP = "1";
    expect(ownsRow({ nexusUserId: "a" }, {})).toBe(true);
  });
});
