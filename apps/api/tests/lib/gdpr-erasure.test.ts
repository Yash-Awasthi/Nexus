// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";

import { handleSelfErasure, type ErasureFn } from "../../src/lib/gdpr-erasure.js";

const fakeLogger = () => ({ info: vi.fn() });

describe("handleSelfErasure", () => {
  it("rejects with 403 when there is no authenticated caller", async () => {
    const erase = vi.fn<ErasureFn>();
    const out = await handleSelfErasure(undefined, "u-1", erase, fakeLogger());
    expect(out.status).toBe(403);
    expect(erase).not.toHaveBeenCalled();
  });

  it("rejects with 403 when the caller is not the target (no cross-user erasure)", async () => {
    const erase = vi.fn<ErasureFn>();
    const out = await handleSelfErasure("u-1", "u-2", erase, fakeLogger());
    expect(out.status).toBe(403);
    expect(erase).not.toHaveBeenCalled();
  });

  it("erases own data with 204 and audits a content-free log line", async () => {
    const erase = vi.fn<ErasureFn>().mockResolvedValue([
      { table: "messages", deleted: 12 },
      { table: "threads", deleted: 2 },
    ]);
    const log = fakeLogger();
    const out = await handleSelfErasure("u-1", "u-1", erase, log);
    expect(out.status).toBe(204);
    expect(erase).toHaveBeenCalledWith("u-1");
    expect(log.info).toHaveBeenCalledWith(
      {
        event: "user_data_erased",
        userId: "u-1",
        tables: [
          { table: "messages", deleted: 12 },
          { table: "threads", deleted: 2 },
        ],
      },
      "GDPR erasure complete",
    );
  });

  it("maps a failing erase to 500 without leaking details", async () => {
    const erase = vi.fn<ErasureFn>().mockRejectedValue(new Error("pg boom"));
    const out = await handleSelfErasure("u-1", "u-1", erase, fakeLogger());
    expect(out.status).toBe(500);
    if (out.status === 500) {
      expect(out.body).toEqual({ code: "ERASURE_FAILED", message: "Erasure failed" });
    }
  });
});
