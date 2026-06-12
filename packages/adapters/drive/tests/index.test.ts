// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { driveAdapter } from "../src/index.js";
import type { IExecutionContext } from "@nexus/plugin-sdk";
import { AdapterConfigError, AdapterHttpError } from "@nexus/plugin-sdk";

function makeCtx(env: Record<string, string> = {}): IExecutionContext {
  return {
    taskId: "task-test",
    startTime: new Date(),
    attempt: 1,
    environment: env,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

function mockFetch(status: number, body: unknown) {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    json: vi.fn().mockResolvedValue(body),
  };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  return response;
}

const ENV = { GOOGLE_ACCESS_TOKEN: "ya29.drive-test" };

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("driveAdapter", () => {
  describe("metadata", () => {
    it("has the correct name", () => expect(driveAdapter.name).toBe("nexus-adapter-drive"));
    it("exposes storage capabilities", () => {
      expect(driveAdapter.capabilities).toContain("storage.read");
      expect(driveAdapter.capabilities).toContain("storage.write");
    });
  });

  describe("canExecute()", () => {
    it("handles drive.upload", () => expect(driveAdapter.canExecute("drive.upload")).toBe(true));
    it("handles drive.download", () =>
      expect(driveAdapter.canExecute("drive.download")).toBe(true));
    it("handles drive.list", () => expect(driveAdapter.canExecute("drive.list")).toBe(true));
    it("handles drive.create-folder", () =>
      expect(driveAdapter.canExecute("drive.create-folder")).toBe(true));
    it("rejects unknown types", () => expect(driveAdapter.canExecute("gmail.send")).toBe(false));
  });

  describe("execute() — drive.list", () => {
    it("lists files in Drive and returns file metadata", async () => {
      mockFetch(200, { files: [{ id: "file-1", name: "report.pdf" }] });
      const result = await driveAdapter.execute({ taskType: "drive.list" }, makeCtx(ENV));
      expect(result).toBeDefined();
    });

    it("throws AdapterConfigError when GOOGLE_ACCESS_TOKEN is missing", async () => {
      await expect(driveAdapter.execute({ taskType: "drive.list" }, makeCtx({}))).rejects.toThrow(
        AdapterConfigError,
      );
    });

    it("throws AdapterHttpError on HTTP failure", async () => {
      mockFetch(401, "Unauthorized");
      await expect(driveAdapter.execute({ taskType: "drive.list" }, makeCtx(ENV))).rejects.toThrow(
        AdapterHttpError,
      );
    });
  });

  describe("execute() — drive.create-folder", () => {
    it("creates a folder and returns metadata", async () => {
      mockFetch(200, {
        id: "folder-1",
        name: "Reports",
        mimeType: "application/vnd.google-apps.folder",
      });
      const result = await driveAdapter.execute(
        { taskType: "drive.create-folder", name: "Reports" },
        makeCtx(ENV),
      );
      expect(result).toBeDefined();
    });
  });
});
