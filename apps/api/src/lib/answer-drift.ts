// SPDX-License-Identifier: Apache-2.0
/**
 * Per-account, per-model style metrics over council answers (@nexus/stm's
 * RollingMetricTracker), so a model that starts hedging more or rambling
 * longer shows up as drift.
 */
import { RollingMetricTracker, STMMetrics, type RollingMetricSnapshot } from "@nexus/stm";

const METRICS = ["hedgeDensity", "verbosityRatio", "wordCount"] as const;
type Metric = (typeof METRICS)[number];
const WINDOW = 50;
/** Fewer answers than this say nothing about a trend. */
const MIN_ANSWERS = 10;

// ponytail: windows live in process memory, so a restart starts them again; persist the
// extracted values when drift has to span restarts.
const trackers = new Map<string, Map<string, Record<Metric, RollingMetricTracker>>>();

/** Feed one answer from `model` into the caller's windows. */
export function observeAnswer(owner: string, model: string, text: string): void {
  if (!text.trim()) return;
  let byModel = trackers.get(owner);
  if (!byModel) trackers.set(owner, (byModel = new Map()));
  let set = byModel.get(model);
  if (!set) {
    set = Object.fromEntries(
      METRICS.map((m) => [
        m,
        new RollingMetricTracker({ windowSize: WINDOW, label: m, extractFn: STMMetrics[m] }),
      ]),
    ) as Record<Metric, RollingMetricTracker>;
    byModel.set(model, set);
  }
  for (const m of METRICS) set[m].observe(text);
}

/** The latest answer sits more than two standard deviations from the window's mean. */
const drifted = (s: RollingMetricSnapshot) =>
  s.count >= MIN_ANSWERS &&
  s.stddev > 0 &&
  s.latest !== null &&
  Math.abs(s.latest - s.mean) > 2 * s.stddev;

export function driftReport(owner: string) {
  return [...(trackers.get(owner) ?? new Map<string, Record<Metric, RollingMetricTracker>>())].map(
    ([model, set]) => {
      const metrics = Object.fromEntries(METRICS.map((m) => [m, set[m].snapshot()])) as Record<
        Metric,
        RollingMetricSnapshot
      >;
      return {
        model,
        answers: metrics.wordCount.count,
        metrics,
        drifting: METRICS.filter((m) => drifted(metrics[m])),
      };
    },
  );
}
