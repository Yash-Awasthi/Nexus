// SPDX-License-Identifier: Apache-2.0
/** Compression runs on user prompts and tool output, so no input shape may make it slow. */
import { expect, it } from "vitest";

import {
  COMPRESSION_MODES,
  PRESETS,
  compressAuto,
  compressForTool,
  compressMode,
  compressPreset,
  type CompressionModeName,
  type PresetName,
} from "../src/index.js";

const N = 64 * 1024;
const INPUTS: Record<string, string> = {
  spaces: " ".repeat(N) + "x",
  tabs: "\t".repeat(N) + "x",
  newlineSpaces: "\n" + " ".repeat(N) + "x",
  slashes: "/".repeat(N) + "!",
  dots: ".".repeat(N) + "x",
  words: "a ".repeat(N / 2) + "!",
};

const RUNS: [string, (s: string) => unknown][] = [
  ["auto", compressAuto],
  ...Object.keys(PRESETS).map(
    (p) =>
      [`preset ${p}`, (s: string) => compressPreset(s, p as PresetName)] as [
        string,
        (s: string) => unknown,
      ],
  ),
  ...Object.keys(COMPRESSION_MODES).map(
    (m) =>
      [`mode ${m}`, (s: string) => compressMode(s, m as CompressionModeName)] as [
        string,
        (s: string) => unknown,
      ],
  ),
  ["tool bash", (s) => compressForTool("bash", s, { allowLossy: true })],
];

it.each(RUNS)(
  "%s stays fast on hostile input",
  (_name, run) => {
    const slow: string[] = [];
    for (const [shape, input] of Object.entries(INPUTS)) {
      const t = performance.now();
      run(input);
      const ms = performance.now() - t;
      if (ms > 250) slow.push(`${shape} ${Math.round(ms)}ms`);
    }
    expect(slow).toEqual([]);
  },
  120_000,
);
