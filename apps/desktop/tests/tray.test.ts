// SPDX-License-Identifier: Apache-2.0
/**
 * The tray and the deep links. Both answer questions about text the OS hands us, so both are
 * tested as functions: a link that is refused here is refused before it can become a URL load.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  copyableApiBase,
  deepLinkFromArgs,
  deepLinkTarget,
  PROTOCOL,
  statusLabel,
  trayMenu,
  trayTitle,
  trayTooltip,
  type TrayState,
} from "../src/tray.ts";

const idle: TrayState = { running: 0, failed: 0, apiBase: "http://127.0.0.1:4100", local: true };
const busy: TrayState = { ...idle, running: 3, failed: 1 };
const broken: TrayState = { ...idle, failed: 2 };

describe("the tray says what the app is doing", () => {
  it("is Idle when nothing runs and nothing failed", () => {
    expect(statusLabel(idle)).toBe("Idle");
    expect(trayTooltip(idle)).toBe("Nexus — Idle");
    expect(trayTitle(idle)).toBe("");
  });

  it("counts the runs in progress, in words a person reads", () => {
    expect(statusLabel({ ...idle, running: 1 })).toBe("Working — 1 run in progress");
    expect(statusLabel(busy)).toBe("Working — 3 runs in progress");
    expect(trayTitle(busy)).toBe("3");
  });

  it("reports a failure even when the app is otherwise idle", () => {
    expect(statusLabel({ ...idle, failed: 1 })).toBe("Idle — last run failed");
    expect(statusLabel(broken)).toBe("Idle — 2 runs failed");
  });

  it("offers the API base, and copies it without a trailing slash", () => {
    const copied: string[] = [];
    const menu = trayMenu(idle, { copyApiBase: () => copied.push(copyableApiBase(idle.apiBase)) });
    const copy = menu.find((item) => item.label === "Copy API base");
    expect(copy).toBeDefined();
    copy!.click!();
    expect(copied).toEqual(["http://127.0.0.1:4100"]);

    expect(copyableApiBase("http://127.0.0.1:4100///")).toBe("http://127.0.0.1:4100");
  });

  it("says whether the API is embedded or remote, so 'copy base' is not a mystery", () => {
    const local = trayMenu(idle, { copyApiBase: () => {} });
    expect(local[1]!.label).toContain("Local API");
    expect(local[1]!.label).toContain("127.0.0.1:4100");

    const remote = trayMenu({ ...idle, local: false, apiBase: "https://nexus.example.com" }, {
      copyApiBase: () => {},
    });
    expect(remote[1]!.label).toContain("Remote API");
  });

  it("shows state as a label, not as a clickable action that does nothing", () => {
    const menu = trayMenu(busy, { copyApiBase: () => {} });
    expect(menu[0]!.label).toBe("Working — 3 runs in progress");
    expect(menu[0]!.enabled).toBe(false);
    expect(menu[0]!.click).toBeUndefined();
  });
});

describe("the queue and the workspace in the tray", () => {
  const idle = { running: 0, failed: 0, apiBase: "http://127.0.0.1:41000", local: true };

  it("says how many prompts are waiting, and whether they can be sent yet", () => {
    const offline = trayMenu(
      { ...idle, queued: 2, online: false },
      { copyApiBase: () => {}, flushQueued: () => {} },
    );
    const row = offline.find((item) => item.label.includes("queued"))!;
    expect(row.label).toBe("2 prompts queued — waiting for the API");
    // Nothing to send while the API is unreachable, so the row is a label rather than a button.
    expect(row.enabled).toBe(false);

    const online = trayMenu(
      { ...idle, queued: 1, online: true },
      { copyApiBase: () => {}, flushQueued: () => {} },
    );
    const ready = online.find((item) => item.label.includes("queued"))!;
    expect(ready.label).toBe("1 prompt queued — send now");
    expect(ready.enabled).toBe(true);
  });

  it("omits the queue row entirely when nothing is queued", () => {
    const menu = trayMenu({ ...idle, queued: 0 }, { copyApiBase: () => {} });
    expect(menu.some((item) => item.label.includes("queued"))).toBe(false);
    expect(trayTooltip({ ...idle, queued: 0 })).toBe("Nexus — Idle");
    expect(trayTooltip({ ...idle, queued: 2, online: false })).toBe("Nexus — offline, 2 queued");
  });

  it("offers the folder when none is chosen, and names it once one is", () => {
    let asked = 0;
    const bare = trayMenu({ ...idle, workspace: null }, {
      copyApiBase: () => {},
      chooseWorkspace: () => {
        asked += 1;
      },
    });
    const choose = bare.find((item) => item.label.startsWith("Choose workspace"))!;
    choose.click?.();
    expect(asked).toBe(1);
    expect(bare.some((item) => item.label.startsWith("Forget"))).toBe(false);

    let forgotten = 0;
    const chosen = trayMenu({ ...idle, workspace: "/home/yash/nexus" }, {
      copyApiBase: () => {},
      chooseWorkspace: () => {},
      forgetWorkspace: () => {
        forgotten += 1;
      },
    });
    expect(chosen.find((item) => item.label.startsWith("Workspace:"))!.label).toBe(
      "Workspace: /home/yash/nexus",
    );
    chosen.find((item) => item.label === "Forget workspace")!.click?.();
    expect(forgotten).toBe(1);
  });
});

describe("deep links", () => {
  it("turns a session link into the chat route", () => {
    expect(deepLinkTarget("nexus://session/abc123")).toBe("/chat/abc123");
    // The forms shells produce: three slashes, a trailing slash, stray whitespace.
    expect(deepLinkTarget("nexus:///session/abc123")).toBe("/chat/abc123");
    expect(deepLinkTarget("  nexus://session/abc123/  ")).toBe("/chat/abc123");
    expect(deepLinkTarget("NEXUS://session/abc123")).toBe("/chat/abc123");
  });

  it("refuses anything that is not a session link", () => {
    for (const link of [
      "https://evil.example.com/session/abc",
      "file:///etc/passwd",
      "nexus://settings/abc",
      "nexus://",
      "nexus://session",
      "",
    ]) {
      expect(deepLinkTarget(link), link).toBeNull();
    }
  });

  it("refuses an id that would become a different route or a path traversal", () => {
    for (const link of [
      "nexus://session/../../admin",
      "nexus://session/a/b",
      "nexus://session/a%2Fb",
      "nexus://session/abc?x=1",
      "nexus://session/abc#frag",
      `nexus://session/${"a".repeat(129)}`,
    ]) {
      expect(deepLinkTarget(link), link).toBeNull();
    }
  });

  it("finds the link in an argv array, wherever the OS put it", () => {
    const argv = ["--no-sandbox", "C:\\Program Files\\Nexus\\nexus.exe", "nexus://session/x9"];
    expect(deepLinkFromArgs(argv)).toBe("/chat/x9");
    // A launch with no link (double-clicking the icon) is not an error.
    expect(deepLinkFromArgs(["nexus.exe", "--flag"])).toBeNull();
  });

  it("names the protocol it registers for", () => {
    expect(PROTOCOL).toBe("nexus");
    expect(deepLinkTarget(`${PROTOCOL}://session/p`)).toBe("/chat/p");
  });
});
