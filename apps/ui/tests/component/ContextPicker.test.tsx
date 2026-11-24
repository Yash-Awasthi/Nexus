// SPDX-License-Identifier: Apache-2.0
/** The symbol picker marks LSP results and drops the symbol kind when no server can answer. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ContextPicker } from "../../app/components/ContextPicker";
import type { useContextMention } from "../../app/hooks/useContextMention";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: { root: Root; container: HTMLElement }[] = [];

function mention(
  overrides: Partial<ReturnType<typeof useContextMention>> = {},
): ReturnType<typeof useContextMention> {
  return {
    isOpen: true,
    query: "parse",
    mentionType: "symbol",
    commitRequest: 0,
    selectedIndex: 0,
    setSelectedIndex: () => {},
    openPicker: () => {},
    closePicker: () => {},
    onKeyDown: () => false,
    onTextareaChange: () => {},
    ...overrides,
  };
}

function stub(status: unknown, results: unknown[]) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/lsp/status")) {
      return new Response(JSON.stringify(status), { status: 200 });
    }
    return new Response(JSON.stringify({ results }), { status: 200 });
  });
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  return fetch;
}

async function render(ui: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => {
    root.render(ui);
  });
  // Results land after the picker's 150 ms debounce, status after a probe.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  return container;
}

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("ContextPicker", () => {
  it("badges an LSP result and leaves a regex result plain", async () => {
    stub({ enabled: true, servers: [], languages: [{ language: "typescript", available: true }] }, [
      { name: "parseConfig", kind: "function", path: "src/config.ts", source: "lsp" },
      { name: "parseArgs", kind: "function", path: "src/args.ts", source: "regex" },
    ]);

    const container = await render(<ContextPicker mention={mention()} onSelect={() => {}} />);

    expect(container.textContent).toContain("parseConfig");
    expect(container.textContent).toContain("parseArgs");
    const badges = [...container.querySelectorAll("span")].filter((el) => el.textContent === "lsp");
    expect(badges).toHaveLength(1);
  });

  it("offers the symbol kind when a language server is available", async () => {
    stub(
      {
        enabled: true,
        servers: [],
        languages: [{ language: "typescript", available: true }],
      },
      [],
    );

    const container = await render(
      <ContextPicker mention={mention({ mentionType: null, query: "" })} onSelect={() => {}} />,
    );

    expect(container.textContent).toContain("@symbol:");
    expect(container.textContent).not.toContain("Symbol search unavailable");
  });

  it("hides the symbol kind and names the missing variable when no server is available", async () => {
    const reason = "Set NEXUS_LSP_TYPESCRIPT_BIN to the typescript-language-server command.";
    stub(
      {
        enabled: true,
        servers: [],
        languages: [{ language: "typescript", available: false, reason }],
      },
      [],
    );

    const container = await render(
      <ContextPicker mention={mention({ mentionType: null, query: "" })} onSelect={() => {}} />,
    );

    expect(container.textContent).not.toContain("@symbol:");
    const notice = [...container.querySelectorAll("li")].find(
      (el) => el.textContent === "Symbol search unavailable",
    );
    expect(notice?.getAttribute("title")).toBe(reason);
  });
});
