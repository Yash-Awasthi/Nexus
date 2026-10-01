// SPDX-License-Identifier: Apache-2.0
/** The Docker probe answers false, never rejects, when the OS refuses to spawn the CLI at all. */
import { expect, it, vi } from "vitest";

vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawn: () => {
    throw new Error("spawn UNKNOWN");
  },
}));

const { isDockerAvailable } = await import("../src/index.js");

it("resolves false when spawn throws", async () => {
  await expect(isDockerAvailable()).resolves.toBe(false);
});
