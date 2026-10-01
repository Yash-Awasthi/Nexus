// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import { findPii, maskProfanity, redactPii } from "../../src/lib/chat-safety.js";

describe("findPii / redactPii", () => {
  const msg =
    "Mail jane.doe@example.com or call (415) 555-0132. Card 4111 1111 1111 1111, SSN 123-45-6789.";

  it("finds each kind once", () => {
    expect(findPii(msg).map((p) => p.type)).toEqual(["email", "card number", "SSN", "phone"]);
  });

  it("redacts them", () => {
    expect(redactPii(msg)).toBe("Mail [EMAIL] or call [PHONE]. Card [CARD_NUMBER], SSN [SSN].");
  });

  it("leaves ordinary numbers alone", () => {
    expect(findPii("Order 1234567890123 shipped in 2026, version 3.10.0")).toEqual([]);
  });
});

describe("maskProfanity", () => {
  it("masks words but not ones that merely contain them", () => {
    expect(maskProfanity("This is shit, Scunthorpe classic")).toBe(
      "This is s***, Scunthorpe classic",
    );
  });
});
