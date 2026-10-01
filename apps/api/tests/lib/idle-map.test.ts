// SPDX-License-Identifier: Apache-2.0
/** A per-account cache lets go of accounts that went quiet, and releases what they held. */
import { afterEach, expect, it, vi } from "vitest";

import { IdleMap } from "../../src/lib/idle-map.js";

afterEach(() => {
  vi.useRealTimers();
});

it("drops entries idle longer than the limit and keeps the ones in use", () => {
  vi.useFakeTimers();
  const released: string[] = [];
  const m = new IdleMap<string, string>(1_000, (v) => released.push(v));
  m.set("quiet", "q");
  m.set("busy", "b");
  vi.advanceTimersByTime(600);
  expect(m.get("busy")).toBe("b");
  vi.advanceTimersByTime(600);
  m.set("new", "n");
  expect(m.get("quiet")).toBeUndefined();
  expect(m.get("busy")).toBe("b");
  expect(released).toEqual(["q"]);
  expect(m.size).toBe(2);
});
