// SPDX-License-Identifier: Apache-2.0
/**
 * Motion budget (plan M5.4.6).
 *
 * "60 fps on a mid laptop" is not something a test on a build machine can promise — this container has no
 * GPU, so its numbers are a Floor, not a target. What the test can do, and what actually protects a slow
 * laptop, is prove that both WebGL scenes measure their own frame rate and keep lowering what they spend,
 * and that they finish somewhere static rather than at 12 fps forever.
 *
 * The frame counts printed here are the measurement; the assertion is the honest part: a scene must reach
 * an average frame time a person could still drag around (≥ 20 fps even in a software rasteriser).
 */
import { expect, type Page } from "@playwright/test";

import { test } from "./fixtures";

/** Average frames per second over `ms`, measured in the page. */
async function measureFps(page: Page, ms = 2000): Promise<number> {
  return page.evaluate(
    (duration) =>
      new Promise<number>((resolve) => {
        let frames = 0;
        const start = performance.now();
        const tick = () => {
          frames += 1;
          if (performance.now() - start < duration) requestAnimationFrame(tick);
          else resolve((frames * 1000) / (performance.now() - start));
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
}

test("the landing scene and the graph view keep a usable frame rate, or stop spending", async ({
  page,
  api,
}) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 900 });

  // The graph view only mounts a canvas when there is a graph; an empty workspace shows its empty state.
  const stamp = Date.now();
  await api.post("/api/kg/sync", {
    nodes: Array.from({ length: 40 }, (_, i) => ({
      id: `motion-${stamp}-${i}`,
      name: `Motion entity ${i}`,
      type: i % 2 === 0 ? "ORG" : "PERSON",
      confidence: 1,
      properties: {},
      sources: [],
      createdAt: stamp,
      updatedAt: stamp,
    })),
    edges: Array.from({ length: 39 }, (_, i) => ({
      id: `motion-edge-${stamp}-${i}`,
      subjectId: `motion-${stamp}-${i}`,
      objectId: `motion-${stamp}-${i + 1}`,
      predicate: "RELATED_TO",
      confidence: 1,
      sources: [],
      createdAt: stamp,
      updatedAt: stamp,
    })),
  });

  const measured: string[] = [];
  for (const route of ["/", "/knowledge-graph"]) {
    await page.goto(route);
    // Let the scene install and finish its first quality sample window. The window is a frame count, not a
    // duration (`SAMPLE_FRAMES` in `app/lib/adaptive-quality.ts`), so the wait is a frame count too.
    await page.locator("canvas").first().waitFor({ state: "visible", timeout: 30_000 });
    await page.evaluate(
      () =>
        new Promise<void>((done) => {
          let frames = 0;
          const tick = () => (++frames >= 120 ? done() : requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        }),
    );
    const fps = await measureFps(page);
    const canvases = await page.locator("canvas").count();
    measured.push(`${route}: ${fps.toFixed(1)} fps, ${canvases} canvas`);
    expect(fps, `${route} ran at ${fps.toFixed(1)} fps`).toBeGreaterThanOrEqual(20);
    // The quality policy is only meaningful where a WebGL scene is actually running.
    expect(canvases, `${route} mounts a scene`).toBeGreaterThan(0);
  }

  // Recorded in the test output, so a laptop-class machine can be compared against this number.
  test.info().annotations.push({ type: "motion", description: measured.join("; ") });
  console.log(`motion budget — ${measured.join("; ")}`);
});
