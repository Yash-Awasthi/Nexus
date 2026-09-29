// SPDX-License-Identifier: Apache-2.0
/** Dictation hands each final phrase to the caller and reports when listening ends. */
import { afterEach, describe, expect, it } from "vitest";

import { dictationSupported, startDictation } from "../../app/lib/dictation";

type Handler = ((e: unknown) => void) | null;

class FakeRecognizer {
  static last: FakeRecognizer | null = null;
  lang = "";
  interimResults = true;
  continuous = false;
  onresult: Handler = null;
  onend: Handler = null;
  onerror: Handler = null;
  started = false;
  constructor() {
    FakeRecognizer.last = this;
  }
  start() {
    this.started = true;
  }
  stop() {
    this.onend?.({});
  }
  say(...phrases: [string, boolean][]) {
    const results = phrases.map(([transcript, isFinal]) =>
      Object.assign([{ transcript }], { isFinal }),
    );
    this.onresult?.({ resultIndex: 0, results });
  }
}

const win = globalThis as unknown as Record<string, unknown>;

afterEach(() => {
  delete win.SpeechRecognition;
  delete win.webkitSpeechRecognition;
  delete win.window;
});

describe("dictation", () => {
  it("is unavailable without a speech recognizer", () => {
    win.window = globalThis;
    expect(dictationSupported()).toBe(false);
    expect(
      startDictation(
        () => {},
        () => {},
      ),
    ).toBeNull();
  });

  it("passes final phrases on, ignores interim ones, and stops on request", () => {
    win.window = globalThis;
    win.webkitSpeechRecognition = FakeRecognizer;
    expect(dictationSupported()).toBe(true);
    const heard: string[] = [];
    let ended = 0;
    const stop = startDictation(
      (t) => heard.push(t),
      () => ended++,
    );
    const rec = FakeRecognizer.last!;
    expect(rec.started).toBe(true);
    expect(rec.interimResults).toBe(false);
    rec.say(["half a thou", false], ["compare these two plans", true]);
    expect(heard).toEqual(["compare these two plans"]);
    stop!();
    expect(ended).toBe(1);
  });
});
