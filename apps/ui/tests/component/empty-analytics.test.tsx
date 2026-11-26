// SPDX-License-Identifier: Apache-2.0
/**
 * A quiet server says so.
 *
 * Both analytics pages used to render zeros for "the log answered and it is
 * empty": `0` requests and `$0.00` spend read exactly like a measured zero, and
 * a page whose only source is an empty log is indistinguishable from a page that
 * measured nothing at all. Each page now names the empty case.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import AdminAnalyticsPage from "../../app/routes/admin-analytics";
import CostsPage from "../../app/routes/costs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: { root: Root; container: HTMLElement }[] = [];

function mount(element: React.ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  act(() => root.render(element));
  return container;
}

beforeEach(() => {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({}), { status: 200 }));
});

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

/** Answer each URL with its own payload; anything unlisted gets `{}`. */
function stubFetch(routes: Record<string, unknown>): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.keys(routes).find((key) => url.includes(key));
    return new Response(JSON.stringify(hit ? routes[hit] : {}), { status: 200 });
  });
}

const EMPTY_OVERVIEW = {
  totalUsers: 1,
  requests: 0,
  tokens: 0,
  costUsd: 0,
  latencyP50ms: null,
  latencyP99ms: null,
  errorRate: null,
  source: "cost-log",
};

const EMPTY_DASHBOARD = {
  totalUsd: 0,
  totalTokens: 0,
  byDay: {},
  byModel: {},
  period: "30d",
  requests: 0,
};

describe("an empty data source renders as empty, not as zero", () => {
  it("says nothing has been recorded on Admin → Analytics and keeps dashes in the cards", async () => {
    stubFetch({ "/api/analytics/overview": EMPTY_OVERVIEW });
    const container = mount(<AdminAnalyticsPage />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="analytics-empty"]')).not.toBeNull();
    expect(container.textContent).toContain("No model traffic recorded yet");
    // The headline numbers stay dashes: no 0 and no $0.00 posing as a measurement.
    expect(container.textContent).not.toContain("$0.00");
    const values = [...container.querySelectorAll("p.text-2xl")].map((el) => el.textContent);
    expect(values).toEqual(["—", "—", "—", "—"]);
  });

  it("shows the numbers once the log has traffic", async () => {
    stubFetch({
      "/api/analytics/overview": { ...EMPTY_OVERVIEW, requests: 42, tokens: 800, costUsd: 1.5 },
    });
    const container = mount(<AdminAnalyticsPage />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="analytics-empty"]')).toBeNull();
    expect(container.textContent).toContain("42");
    expect(container.textContent).toContain("$1.50");
  });

  it("says the cost log is empty on Usage & cost instead of printing $0.00 three times", async () => {
    stubFetch({
      "/api/costs/dashboard": EMPTY_DASHBOARD,
      "/api/costs/limits": {
        limits: { monthly_usd: null, daily_usd: null },
        spent: { monthly_usd: 0, daily_usd: 0 },
        remaining: { monthly_usd: null, daily_usd: null },
        enforced: false,
        note: "",
      },
    });
    const container = mount(<CostsPage />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="costs-empty"]')).not.toBeNull();
    expect(container.textContent).toContain("No model spend recorded yet");
    expect(container.textContent).not.toContain("$0.00");
  });
});
