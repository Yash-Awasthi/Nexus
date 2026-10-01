// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { isDue, minuteKey } from "../src/index.js";

describe("isDue", () => {
  const at = new Date(2026, 8, 28, 9, 0, 30); // cron reads local time

  it("fires a cron trigger in a matching minute, once", () => {
    expect(isDue({ cron: "0 9 * * *" }, at)).toBe(true);
    expect(isDue({ cron: "0 9 * * *", lastFiredMinute: minuteKey(at) }, at)).toBe(false);
    expect(isDue({ cron: "5 9 * * *" }, at)).toBe(false);
  });

  it("fires an interval trigger once the interval has passed since it last ran", () => {
    const since = new Date(at.getTime() - 61_000);
    expect(isDue({ intervalSec: 60, since }, at)).toBe(true);
    expect(isDue({ intervalSec: 120, since }, at)).toBe(false);
    expect(isDue({ intervalSec: 60, since, lastFiredMinute: minuteKey(at) }, at)).toBe(false);
  });

  it("never fires without a schedule", () => {
    expect(isDue({}, at)).toBe(false);
  });
});
