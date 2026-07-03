// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  VoiceError,
  VoiceSession,
  NullTranscribeProvider,
  NullSynthesizeProvider,
  GroqTranscribeProvider,
  ElevenLabsSynthesizeProvider,
  EnergyVadProvider,
  NullVadProvider,
  SilenceVadProvider,
  createAudioBuffer,
  type TranscribeProvider,
  type TranscribeResult,
  type SynthesizeProvider,
  type VoiceHandler,
  type VoiceHooks,
  type VadProvider,
  type FetchFn,
  type AudioBuffer,
} from "../src/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fakeAudio(bytes = 100, format: AudioBuffer["format"] = "wav"): AudioBuffer {
  return { data: new Uint8Array(bytes).fill(1), format, sampleRate: 16000 };
}

function makeFetch(
  responses: Array<{ ok: boolean; status?: number; body?: unknown; arrayBuffer?: Uint8Array }>,
): FetchFn {
  let idx = 0;
  return vi.fn(async () => {
    const r = responses[idx++] ?? { ok: true, status: 200, body: {} };
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 400),
      json: async () => r.body ?? {},
      arrayBuffer: async () => (r.arrayBuffer ?? new Uint8Array(0)).buffer,
    } as Response;
  });
}

function makeHooks(): VoiceHooks {
  return { emit: vi.fn().mockResolvedValue({ handled: 1, aborted: false, errors: [] }) };
}

function echoVoiceHandler(text: string): Promise<string> {
  return Promise.resolve(`Echo: ${text}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// VoiceError
// ─────────────────────────────────────────────────────────────────────────────

describe("VoiceError", () => {
  it("is an Error with name VoiceError", () => {
    const e = new VoiceError("TRANSCRIBE_FAILED", "bad audio");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("VoiceError");
  });

  it("exposes code and message", () => {
    const e = new VoiceError("HANDLER_FAILED", "crash");
    expect(e.code).toBe("HANDLER_FAILED");
    expect(e.message).toBe("crash");
  });

  it("stores optional context", () => {
    const e = new VoiceError("INVALID_AUDIO", "empty", { bytes: 0 });
    expect(e.context).toEqual({ bytes: 0 });
  });

  it("context is undefined when omitted", () => {
    const e = new VoiceError("SYNTHESIZE_FAILED", "err");
    expect(e.context).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createAudioBuffer
// ─────────────────────────────────────────────────────────────────────────────

describe("createAudioBuffer", () => {
  it("creates AudioBuffer from Uint8Array", () => {
    const data = new Uint8Array([1, 2, 3]);
    const buf = createAudioBuffer(data, "wav");
    expect(buf.data).toEqual(data);
    expect(buf.format).toBe("wav");
    expect(buf.sampleRate).toBe(16000);
  });

  it("creates AudioBuffer from number array", () => {
    const buf = createAudioBuffer([1, 2, 3], "mp3");
    expect(buf.data).toBeInstanceOf(Uint8Array);
    expect(buf.data.length).toBe(3);
  });

  it("creates AudioBuffer from ArrayBuffer", () => {
    const ab = new Uint8Array([10, 20]).buffer;
    const buf = createAudioBuffer(ab, "flac", 44100);
    expect(buf.sampleRate).toBe(44100);
    expect(buf.data[0]).toBe(10);
  });

  it("sets durationSeconds when provided", () => {
    const buf = createAudioBuffer(new Uint8Array(1), "wav", 16000, 2.5);
    expect(buf.durationSeconds).toBe(2.5);
  });

  it("defaults sampleRate to 16000", () => {
    const buf = createAudioBuffer(new Uint8Array(1), "ogg");
    expect(buf.sampleRate).toBe(16000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NullTranscribeProvider
// ─────────────────────────────────────────────────────────────────────────────

describe("NullTranscribeProvider", () => {
  it("has name 'null-transcribe'", () => {
    expect(new NullTranscribeProvider().name).toBe("null-transcribe");
  });

  it("returns fixed transcript", async () => {
    const p = new NullTranscribeProvider("hello world");
    const result = await p.transcribe(fakeAudio());
    expect(result.transcript).toBe("hello world");
  });

  it("returns empty transcript by default", async () => {
    const p = new NullTranscribeProvider();
    const result = await p.transcribe(fakeAudio());
    expect(result.transcript).toBe("");
  });

  it("returns latencyMs:0", async () => {
    const result = await new NullTranscribeProvider("x").transcribe(fakeAudio());
    expect(result.latencyMs).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NullSynthesizeProvider
// ─────────────────────────────────────────────────────────────────────────────

describe("NullSynthesizeProvider", () => {
  it("has name 'null-synthesize'", () => {
    expect(new NullSynthesizeProvider().name).toBe("null-synthesize");
  });

  it("returns zero-byte data", async () => {
    const result = await new NullSynthesizeProvider().synthesize("hello");
    expect(result.data.length).toBe(0);
  });

  it("defaults format to mp3", async () => {
    const result = await new NullSynthesizeProvider().synthesize("x");
    expect(result.format).toBe("mp3");
  });

  it("respects opts.format override", async () => {
    const result = await new NullSynthesizeProvider().synthesize("x", { format: "wav" });
    expect(result.format).toBe("wav");
  });

  it("returns sampleRate 24000", async () => {
    const result = await new NullSynthesizeProvider().synthesize("x");
    expect(result.sampleRate).toBe(24000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GroqTranscribeProvider
// ─────────────────────────────────────────────────────────────────────────────

describe("GroqTranscribeProvider", () => {
  const okResponse = {
    ok: true,
    body: { text: "  hello world  ", language: "en", duration: 2.5 },
  };

  it("has name 'groq-whisper'", () => {
    expect(new GroqTranscribeProvider({ apiKey: "k" }).name).toBe("groq-whisper");
  });

  it("throws INVALID_AUDIO on empty buffer", async () => {
    const p = new GroqTranscribeProvider({ apiKey: "k", fetch: makeFetch([]) });
    await expect(
      p.transcribe({ data: new Uint8Array(0), format: "wav", sampleRate: 16000 }),
    ).rejects.toMatchObject({ code: "INVALID_AUDIO" });
  });

  it("POSTs to Groq transcriptions endpoint", async () => {
    const fetchFn = makeFetch([okResponse]);
    const p = new GroqTranscribeProvider({ apiKey: "key-1", fetch: fetchFn });
    await p.transcribe(fakeAudio());
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain(
      "groq.com/openai/v1/audio/transcriptions",
    );
  });

  it("sends Authorization Bearer header", async () => {
    const fetchFn = makeFetch([okResponse]);
    const p = new GroqTranscribeProvider({ apiKey: "mykey", fetch: fetchFn });
    await p.transcribe(fakeAudio());
    const headers = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.headers as Record<
      string,
      string
    >;
    expect(headers["Authorization"]).toBe("Bearer mykey");
  });

  it("returns trimmed transcript", async () => {
    const fetchFn = makeFetch([okResponse]);
    const p = new GroqTranscribeProvider({ apiKey: "k", fetch: fetchFn });
    const result = await p.transcribe(fakeAudio());
    expect(result.transcript).toBe("hello world");
  });

  it("returns language and durationSeconds from API", async () => {
    const fetchFn = makeFetch([okResponse]);
    const p = new GroqTranscribeProvider({ apiKey: "k", fetch: fetchFn });
    const result = await p.transcribe(fakeAudio());
    expect(result.language).toBe("en");
    expect(result.durationSeconds).toBe(2.5);
  });

  it("throws PROVIDER_AUTH_FAILED on 401", async () => {
    const fetchFn = makeFetch([{ ok: false, status: 401 }]);
    const p = new GroqTranscribeProvider({ apiKey: "bad", fetch: fetchFn });
    await expect(p.transcribe(fakeAudio())).rejects.toMatchObject({
      code: "PROVIDER_AUTH_FAILED",
    });
  });

  it("throws TRANSCRIBE_FAILED on non-401 HTTP error", async () => {
    const fetchFn = makeFetch([{ ok: false, status: 500 }]);
    const p = new GroqTranscribeProvider({ apiKey: "k", fetch: fetchFn });
    await expect(p.transcribe(fakeAudio())).rejects.toMatchObject({
      code: "TRANSCRIBE_FAILED",
    });
  });

  it("throws TRANSCRIBE_FAILED on network error", async () => {
    const badFetch: FetchFn = vi.fn().mockRejectedValue(new Error("network down"));
    const p = new GroqTranscribeProvider({ apiKey: "k", fetch: badFetch });
    await expect(p.transcribe(fakeAudio())).rejects.toMatchObject({
      code: "TRANSCRIBE_FAILED",
    });
  });

  it("uses whisper-large-v3-turbo by default", async () => {
    const fetchFn = makeFetch([okResponse]);
    const p = new GroqTranscribeProvider({ apiKey: "k", fetch: fetchFn });
    await p.transcribe(fakeAudio());
    const body = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as FormData;
    expect(body.get("model")).toBe("whisper-large-v3-turbo");
  });

  it("respects custom model in config", async () => {
    const fetchFn = makeFetch([okResponse]);
    const p = new GroqTranscribeProvider({
      apiKey: "k",
      model: "whisper-large-v3",
      fetch: fetchFn,
    });
    await p.transcribe(fakeAudio());
    const body = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as FormData;
    expect(body.get("model")).toBe("whisper-large-v3");
  });

  it("appends language to form when provided in opts", async () => {
    const fetchFn = makeFetch([okResponse]);
    const p = new GroqTranscribeProvider({ apiKey: "k", fetch: fetchFn });
    await p.transcribe(fakeAudio(), { language: "fr" });
    const body = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as FormData;
    expect(body.get("language")).toBe("fr");
  });

  it("latencyMs is a non-negative number", async () => {
    const fetchFn = makeFetch([okResponse]);
    const p = new GroqTranscribeProvider({ apiKey: "k", fetch: fetchFn });
    const result = await p.transcribe(fakeAudio());
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ElevenLabsSynthesizeProvider
// ─────────────────────────────────────────────────────────────────────────────

describe("ElevenLabsSynthesizeProvider", () => {
  const audioBytes = new Uint8Array([0xff, 0xfb, 0x10]);
  const okResponse = { ok: true, status: 200, arrayBuffer: audioBytes };

  it("has name 'elevenlabs'", () => {
    expect(new ElevenLabsSynthesizeProvider({ apiKey: "k" }).name).toBe("elevenlabs");
  });

  it("POSTs to ElevenLabs TTS endpoint", async () => {
    const fetchFn = makeFetch([okResponse]);
    const p = new ElevenLabsSynthesizeProvider({ apiKey: "k", fetch: fetchFn });
    await p.synthesize("Hello");
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain(
      "api.elevenlabs.io/v1/text-to-speech",
    );
  });

  it("sends xi-api-key header", async () => {
    const fetchFn = makeFetch([okResponse]);
    const p = new ElevenLabsSynthesizeProvider({ apiKey: "elkey", fetch: fetchFn });
    await p.synthesize("x");
    const headers = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.headers as Record<
      string,
      string
    >;
    expect(headers["xi-api-key"]).toBe("elkey");
  });

  it("returns AudioBuffer with mp3 format by default", async () => {
    const fetchFn = makeFetch([okResponse]);
    const p = new ElevenLabsSynthesizeProvider({ apiKey: "k", fetch: fetchFn });
    const result = await p.synthesize("Hello");
    expect(result.format).toBe("mp3");
    expect(result.data).toBeInstanceOf(Uint8Array);
  });

  it("respects opts.voice override in URL", async () => {
    const fetchFn = makeFetch([okResponse]);
    const p = new ElevenLabsSynthesizeProvider({ apiKey: "k", fetch: fetchFn });
    await p.synthesize("x", { voice: "custom-voice-id" });
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain("custom-voice-id");
  });

  it("throws PROVIDER_AUTH_FAILED on 401", async () => {
    const fetchFn = makeFetch([{ ok: false, status: 401 }]);
    const p = new ElevenLabsSynthesizeProvider({ apiKey: "bad", fetch: fetchFn });
    await expect(p.synthesize("test")).rejects.toMatchObject({
      code: "PROVIDER_AUTH_FAILED",
    });
  });

  it("throws SYNTHESIZE_FAILED on non-401 HTTP error", async () => {
    const fetchFn = makeFetch([{ ok: false, status: 500 }]);
    const p = new ElevenLabsSynthesizeProvider({ apiKey: "k", fetch: fetchFn });
    await expect(p.synthesize("test")).rejects.toMatchObject({
      code: "SYNTHESIZE_FAILED",
    });
  });

  it("throws SYNTHESIZE_FAILED on network error", async () => {
    const badFetch: FetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const p = new ElevenLabsSynthesizeProvider({ apiKey: "k", fetch: badFetch });
    await expect(p.synthesize("x")).rejects.toMatchObject({ code: "SYNTHESIZE_FAILED" });
  });

  it("includes speed in voice_settings when provided", async () => {
    const fetchFn = makeFetch([okResponse]);
    const p = new ElevenLabsSynthesizeProvider({ apiKey: "k", fetch: fetchFn });
    await p.synthesize("x", { speed: 1.5 });
    const body = JSON.parse(
      (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as string,
    );
    expect(body.voice_settings.speed).toBe(1.5);
  });

  it("returns sampleRate 24000", async () => {
    const fetchFn = makeFetch([okResponse]);
    const p = new ElevenLabsSynthesizeProvider({ apiKey: "k", fetch: fetchFn });
    const result = await p.synthesize("x");
    expect(result.sampleRate).toBe(24000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VoiceSession
// ─────────────────────────────────────────────────────────────────────────────

describe("VoiceSession — basic flow", () => {
  let transcribe: TranscribeProvider;
  let synthesize: SynthesizeProvider;
  let hooks: VoiceHooks;

  beforeEach(() => {
    transcribe = new NullTranscribeProvider("what is the weather");
    synthesize = new NullSynthesizeProvider();
    hooks = makeHooks();
  });

  it("returns transcript from provider", async () => {
    const session = new VoiceSession({ transcribe, handler: echoVoiceHandler });
    const result = await session.process(fakeAudio());
    expect(result.transcript).toBe("what is the weather");
  });

  it("returns handler response", async () => {
    const session = new VoiceSession({ transcribe, handler: echoVoiceHandler });
    const result = await session.process(fakeAudio());
    expect(result.response).toBe("Echo: what is the weather");
  });

  it("returns synthesized audio when synthesize is wired", async () => {
    const session = new VoiceSession({ transcribe, synthesize, handler: echoVoiceHandler });
    const result = await session.process(fakeAudio());
    expect(result.audio).toBeDefined();
    expect(result.audio?.format).toBe("mp3");
  });

  it("audio is undefined when no synthesize provider", async () => {
    const session = new VoiceSession({ transcribe, handler: echoVoiceHandler });
    const result = await session.process(fakeAudio());
    expect(result.audio).toBeUndefined();
  });

  it("audio is undefined when textOnly:true", async () => {
    const session = new VoiceSession({ transcribe, synthesize, handler: echoVoiceHandler });
    const result = await session.process(fakeAudio(), { textOnly: true });
    expect(result.audio).toBeUndefined();
    expect(result.synthesizeMs).toBeUndefined();
  });

  it("throws INVALID_AUDIO for empty buffer", async () => {
    const session = new VoiceSession({ transcribe, handler: echoVoiceHandler });
    await expect(
      session.process({ data: new Uint8Array(0), format: "wav", sampleRate: 16000 }),
    ).rejects.toMatchObject({ code: "INVALID_AUDIO" });
  });

  it("throws HANDLER_FAILED when handler throws", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    const session = new VoiceSession({ transcribe, handler });
    await expect(session.process(fakeAudio())).rejects.toMatchObject({
      code: "HANDLER_FAILED",
    });
  });

  it("HANDLER_FAILED context includes transcript", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    const session = new VoiceSession({ transcribe, handler });
    let caught: VoiceError | undefined;
    try {
      await session.process(fakeAudio());
    } catch (e) {
      caught = e as VoiceError;
    }
    expect(caught?.context).toMatchObject({ transcript: "what is the weather" });
  });

  it("throws TRANSCRIBE_FAILED when provider throws non-VoiceError", async () => {
    const badProvider: TranscribeProvider = {
      name: "bad",
      transcribe: vi.fn().mockRejectedValue(new Error("STT crash")),
    };
    const session = new VoiceSession({ transcribe: badProvider, handler: echoVoiceHandler });
    await expect(session.process(fakeAudio())).rejects.toMatchObject({
      code: "TRANSCRIBE_FAILED",
    });
  });

  it("re-throws VoiceError from transcribe provider as-is", async () => {
    const voiceErr = new VoiceError("PROVIDER_AUTH_FAILED", "bad key");
    const badProvider: TranscribeProvider = {
      name: "bad",
      transcribe: vi.fn().mockRejectedValue(voiceErr),
    };
    const session = new VoiceSession({ transcribe: badProvider, handler: echoVoiceHandler });
    await expect(session.process(fakeAudio())).rejects.toBe(voiceErr);
  });

  it("throws SYNTHESIZE_FAILED when synthesize provider throws non-VoiceError", async () => {
    const badSynth: SynthesizeProvider = {
      name: "bad",
      synthesize: vi.fn().mockRejectedValue(new Error("TTS crash")),
    };
    const session = new VoiceSession({
      transcribe,
      synthesize: badSynth,
      handler: echoVoiceHandler,
    });
    await expect(session.process(fakeAudio())).rejects.toMatchObject({
      code: "SYNTHESIZE_FAILED",
    });
  });

  it("re-throws VoiceError from synthesize provider as-is", async () => {
    const voiceErr = new VoiceError("PROVIDER_AUTH_FAILED", "bad key");
    const badSynth: SynthesizeProvider = {
      name: "bad",
      synthesize: vi.fn().mockRejectedValue(voiceErr),
    };
    const session = new VoiceSession({
      transcribe,
      synthesize: badSynth,
      handler: echoVoiceHandler,
    });
    await expect(session.process(fakeAudio())).rejects.toBe(voiceErr);
  });
});

describe("VoiceSession — timing and metrics", () => {
  it("latencyMs is a non-negative number", async () => {
    const session = new VoiceSession({
      transcribe: new NullTranscribeProvider("x"),
      handler: echoVoiceHandler,
    });
    const result = await session.process(fakeAudio());
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("transcribeMs is a non-negative number", async () => {
    const session = new VoiceSession({
      transcribe: new NullTranscribeProvider("x"),
      handler: echoVoiceHandler,
    });
    const result = await session.process(fakeAudio());
    expect(result.transcribeMs).toBeGreaterThanOrEqual(0);
  });

  it("handlerMs is a non-negative number", async () => {
    const session = new VoiceSession({
      transcribe: new NullTranscribeProvider("x"),
      handler: echoVoiceHandler,
    });
    const result = await session.process(fakeAudio());
    expect(result.handlerMs).toBeGreaterThanOrEqual(0);
  });

  it("synthesizeMs is defined when synthesis ran", async () => {
    const session = new VoiceSession({
      transcribe: new NullTranscribeProvider("x"),
      synthesize: new NullSynthesizeProvider(),
      handler: echoVoiceHandler,
    });
    const result = await session.process(fakeAudio());
    expect(result.synthesizeMs).toBeGreaterThanOrEqual(0);
  });

  it("synthesizeMs is undefined when synthesis skipped", async () => {
    const session = new VoiceSession({
      transcribe: new NullTranscribeProvider("x"),
      handler: echoVoiceHandler,
    });
    const result = await session.process(fakeAudio());
    expect(result.synthesizeMs).toBeUndefined();
  });
});

describe("VoiceSession — hooks", () => {
  it("emits task.before and task.after", async () => {
    const hooks = makeHooks();
    const session = new VoiceSession({
      transcribe: new NullTranscribeProvider("hi"),
      handler: echoVoiceHandler,
      hooks,
    });
    await session.process(fakeAudio());
    const events = (hooks.emit as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(events).toContain("task.before");
    expect(events).toContain("task.after");
  });

  it("task.before payload includes audioBytes and format", async () => {
    const hooks = makeHooks();
    const session = new VoiceSession({
      transcribe: new NullTranscribeProvider("hi"),
      handler: echoVoiceHandler,
      hooks,
    });
    await session.process(fakeAudio(200, "mp3"));
    expect((hooks.emit as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({
      audioBytes: 200,
      format: "mp3",
    });
  });

  it("task.after payload includes transcript and responseLength", async () => {
    const hooks = makeHooks();
    const session = new VoiceSession({
      transcribe: new NullTranscribeProvider("hello"),
      handler: echoVoiceHandler,
      hooks,
    });
    await session.process(fakeAudio());
    const afterPayload = (hooks.emit as ReturnType<typeof vi.fn>).mock.calls[1]![1];
    expect(afterPayload).toMatchObject({
      transcript: "hello",
      responseLength: "Echo: hello".length,
    });
  });

  it("uses custom session name in hook payloads", async () => {
    const hooks = makeHooks();
    const session = new VoiceSession({
      transcribe: new NullTranscribeProvider("x"),
      handler: echoVoiceHandler,
      hooks,
      name: "my-session",
    });
    await session.process(fakeAudio());
    expect((hooks.emit as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({
      session: "my-session",
    });
  });

  it("hook errors are non-fatal", async () => {
    const hooks: VoiceHooks = { emit: vi.fn().mockRejectedValue(new Error("hook err")) };
    const session = new VoiceSession({
      transcribe: new NullTranscribeProvider("x"),
      handler: echoVoiceHandler,
      hooks,
    });
    await expect(session.process(fakeAudio())).resolves.toBeDefined();
  });
});

describe("VoiceSession — opts passthrough", () => {
  it("passes language opt to transcribe provider", async () => {
    const transcribe: TranscribeProvider = {
      name: "mock",
      transcribe: vi.fn().mockResolvedValue({ transcript: "hola", latencyMs: 0, language: "es" }),
    };
    const session = new VoiceSession({ transcribe, handler: echoVoiceHandler });
    await session.process(fakeAudio(), { language: "es" });
    expect((transcribe.transcribe as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({
      language: "es",
    });
  });

  it("passes voice opt to synthesize provider", async () => {
    const synthesize: SynthesizeProvider = {
      name: "mock",
      synthesize: vi.fn().mockResolvedValue(fakeAudio()),
    };
    const session = new VoiceSession({
      transcribe: new NullTranscribeProvider("x"),
      synthesize,
      handler: echoVoiceHandler,
    });
    await session.process(fakeAudio(), { voice: "rachel" });
    expect((synthesize.synthesize as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({
      voice: "rachel",
    });
  });

  it("propagates language from transcribe result", async () => {
    const transcribe: TranscribeProvider = {
      name: "mock",
      transcribe: vi
        .fn()
        .mockResolvedValue({ transcript: "bonjour", latencyMs: 0, language: "fr" }),
    };
    const session = new VoiceSession({ transcribe, handler: echoVoiceHandler });
    const result = await session.process(fakeAudio());
    expect(result.language).toBe("fr");
  });

  it("merges config transcribeOpts with per-turn opts", async () => {
    const transcribe: TranscribeProvider = {
      name: "mock",
      transcribe: vi.fn().mockResolvedValue({ transcript: "ok", latencyMs: 0 }),
    };
    const session = new VoiceSession({
      transcribe,
      handler: echoVoiceHandler,
      transcribeOpts: { prompt: "nexus platform", temperature: 0 },
    });
    await session.process(fakeAudio(), { language: "en" });
    const callOpts = (transcribe.transcribe as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(callOpts).toMatchObject({ prompt: "nexus platform", temperature: 0, language: "en" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EnergyVadProvider
// ─────────────────────────────────────────────────────────────────────────────

/** PCM silence: all bytes at 128 (the zero-signal centre for 8-bit PCM) */
function silentPcm(byteCount: number, headerBytes = 44): Uint8Array {
  const buf = new Uint8Array(headerBytes + byteCount);
  buf.fill(128); // everything at centre = 0 energy
  return buf;
}

/** PCM signal: bytes alternate 0 and 255 — maximum energy */
function loudPcm(byteCount: number, headerBytes = 44): Uint8Array {
  const buf = new Uint8Array(headerBytes + byteCount);
  for (let i = headerBytes; i < buf.length; i++) {
    buf[i] = i % 2 === 0 ? 0 : 255;
  }
  return buf;
}

describe("EnergyVadProvider", () => {
  it("returns hasSpeech:false for silent audio (all 128)", async () => {
    const vad = new EnergyVadProvider({ headerBytes: 0 });
    const audio = createAudioBuffer(new Uint8Array(100).fill(128), "wav");
    const result = await vad.detect(audio);
    expect(result.hasSpeech).toBe(false);
    expect(result.energyLevel).toBe(0);
  });

  it("returns hasSpeech:true for loud audio (0/255 alternating)", async () => {
    const vad = new EnergyVadProvider({ headerBytes: 0 });
    const raw = new Uint8Array(100);
    for (let i = 0; i < 100; i++) raw[i] = i % 2 === 0 ? 0 : 255;
    const audio = createAudioBuffer(raw, "wav");
    const result = await vad.detect(audio);
    expect(result.hasSpeech).toBe(true);
    expect(result.energyLevel).toBeCloseTo(1, 1);
  });

  it("skips header bytes by default", async () => {
    // loud signal in header region only (bytes 0-43) — after skipping, only silence
    const buf = loudPcm(0, 44); // 44 bytes of loud, then nothing
    const vad = new EnergyVadProvider(); // headerBytes default 44
    const audio = createAudioBuffer(buf, "wav");
    const result = await vad.detect(audio);
    expect(result.hasSpeech).toBe(false);
    expect(result.energyLevel).toBe(0); // empty after header skip
  });

  it("respects custom threshold", async () => {
    // Audio with mild signal — passes low threshold, fails high threshold
    const vad_low = new EnergyVadProvider({ headerBytes: 0, threshold: 0.001 });
    const vad_high = new EnergyVadProvider({ headerBytes: 0, threshold: 0.99 });
    const raw = new Uint8Array(100).fill(140); // slight deviation from 128
    const audio = createAudioBuffer(raw, "wav");
    expect((await vad_low.detect(audio)).hasSpeech).toBe(true);
    expect((await vad_high.detect(audio)).hasSpeech).toBe(false);
  });

  it("returns energyLevel in [0, 1] range", async () => {
    const vad = new EnergyVadProvider({ headerBytes: 0 });
    const audio = createAudioBuffer(loudPcm(100, 0), "wav");
    const { energyLevel } = await vad.detect(audio);
    expect(energyLevel).toBeGreaterThanOrEqual(0);
    expect(energyLevel).toBeLessThanOrEqual(1);
  });

  it("handles empty buffer after header skip gracefully", async () => {
    const vad = new EnergyVadProvider({ headerBytes: 100 });
    const audio = createAudioBuffer(new Uint8Array(50), "wav");
    const result = await vad.detect(audio);
    expect(result.hasSpeech).toBe(false);
    expect(result.energyLevel).toBe(0);
  });

  it("name is 'energy-vad'", () => {
    expect(new EnergyVadProvider().name).toBe("energy-vad");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NullVadProvider / SilenceVadProvider
// ─────────────────────────────────────────────────────────────────────────────

describe("NullVadProvider", () => {
  it("always returns hasSpeech:true regardless of audio", async () => {
    const vad = new NullVadProvider();
    const audio = createAudioBuffer(new Uint8Array(10).fill(128), "wav");
    const result = await vad.detect(audio);
    expect(result.hasSpeech).toBe(true);
    expect(result.energyLevel).toBe(1);
  });

  it("name is 'null-vad'", () => {
    expect(new NullVadProvider().name).toBe("null-vad");
  });
});

describe("SilenceVadProvider", () => {
  it("always returns hasSpeech:false regardless of audio", async () => {
    const vad = new SilenceVadProvider();
    const audio = createAudioBuffer(loudPcm(100, 0), "wav");
    const result = await vad.detect(audio);
    expect(result.hasSpeech).toBe(false);
    expect(result.energyLevel).toBe(0);
  });

  it("name is 'silence-vad'", () => {
    expect(new SilenceVadProvider().name).toBe("silence-vad");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VoiceSession — VAD gate
// ─────────────────────────────────────────────────────────────────────────────

describe("VoiceSession — VAD gate", () => {
  const transcribeSpy = vi.fn().mockResolvedValue({ transcript: "hello", latencyMs: 10 });
  const handlerSpy = vi.fn().mockResolvedValue("world");
  const mockTranscribe: TranscribeProvider = { name: "mock", transcribe: transcribeSpy };

  beforeEach(() => {
    transcribeSpy.mockClear();
    handlerSpy.mockClear();
  });

  it("skips transcription and handler when VAD reports no speech", async () => {
    const session = new VoiceSession({
      transcribe: mockTranscribe,
      handler: handlerSpy,
      vad: new SilenceVadProvider(),
    });
    const result = await session.process(fakeAudio());
    expect(result.skipped).toBe(true);
    expect(result.transcript).toBe("");
    expect(result.response).toBe("");
    expect(transcribeSpy).not.toHaveBeenCalled();
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it("proceeds normally when VAD reports speech", async () => {
    const session = new VoiceSession({
      transcribe: mockTranscribe,
      handler: handlerSpy,
      vad: new NullVadProvider(),
    });
    const result = await session.process(fakeAudio());
    expect(result.skipped).toBe(false);
    expect(result.transcript).toBe("hello");
    expect(transcribeSpy).toHaveBeenCalledOnce();
    expect(handlerSpy).toHaveBeenCalledOnce();
  });

  it("skipped result has latencyMs >= 0", async () => {
    const session = new VoiceSession({
      transcribe: mockTranscribe,
      handler: handlerSpy,
      vad: new SilenceVadProvider(),
    });
    const result = await session.process(fakeAudio());
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.transcribeMs).toBe(0);
    expect(result.handlerMs).toBe(0);
  });

  it("skipped result includes vadEnergyLevel", async () => {
    const session = new VoiceSession({
      transcribe: mockTranscribe,
      handler: handlerSpy,
      vad: new SilenceVadProvider(),
    });
    const result = await session.process(fakeAudio());
    expect(result.vadEnergyLevel).toBe(0);
  });

  it("proceeds normally without a VAD provider configured", async () => {
    const session = new VoiceSession({
      transcribe: mockTranscribe,
      handler: handlerSpy,
      // no vad
    });
    const result = await session.process(fakeAudio());
    expect(result.skipped).toBe(false);
    expect(transcribeSpy).toHaveBeenCalledOnce();
  });

  it("uses a custom VadProvider that checks energy", async () => {
    const customVad: VadProvider = {
      name: "custom",
      detect: async (audio) => ({
        hasSpeech: audio.data.length > 50,
        energyLevel: audio.data.length > 50 ? 0.5 : 0,
      }),
    };
    const sessionSmall = new VoiceSession({
      transcribe: mockTranscribe,
      handler: handlerSpy,
      vad: customVad,
    });
    const sessionLarge = new VoiceSession({
      transcribe: mockTranscribe,
      handler: handlerSpy,
      vad: customVad,
    });

    const smallAudio = createAudioBuffer(new Uint8Array(10), "wav");
    const largeAudio = createAudioBuffer(new Uint8Array(100), "wav");

    expect((await sessionSmall.process(smallAudio)).skipped).toBe(true);
    expect((await sessionLarge.process(largeAudio)).skipped).toBe(false);
  });
});
