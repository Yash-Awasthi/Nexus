// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vite-plus/test";

// @ts-expect-error -- probe is plain ESM, shared with pnpm check:offline
import { probeLsp, resolveLspCommand } from "../../../scripts/offline-lsp-probe.mjs";

const EMPTY_PATH = join(tmpdir(), "nexus-lsp-empty-path-does-not-exist");

describe("offline LSP probe", () => {
  it("reports skip when the binary is missing without spawning", async () => {
    expect(resolveLspCommand({ PATH: EMPTY_PATH }, process.platform)).toBeUndefined();

    const result = await probeLsp({ env: { PATH: EMPTY_PATH }, platform: process.platform });
    expect(result.status).toBe("skip");
    expect(result.detail).toContain("no binary");
  });
});
