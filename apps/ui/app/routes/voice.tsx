// SPDX-License-Identifier: Apache-2.0
/**
 * Voice — text-to-speech synthesis + provider status over the existing
 * `@nexus/voice`-backed API.
 *
 * API (all auth'd via authFetch):
 *   GET  /api/v1/voice/providers   — transcribe/synthesize provider availability
 *   GET  /api/v1/voice/voices      — available synth voices
 *   POST /api/v1/voice/synthesize  — { text, voice } → audio/mpeg bytes
 *
 * Real audio needs the operator's ELEVENLABS_API_KEY; without it the backend
 * returns a null-provider result and this page surfaces that state.
 */
import { AudioLines, Play, Loader2, AlertCircle, Volume2, Mic } from "lucide-react";
import { useState, useEffect, useCallback, useRef } from "react";

import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { authFetch } from "~/lib/api";

interface Voice {
  id: string;
  label: string;
  provider: string;
}

interface Providers {
  transcribe: { provider: string; model?: string; available: boolean };
  synthesize: { provider: string; available: boolean };
}

export default function VoicePage() {
  const [providers, setProviders] = useState<Providers | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voice, setVoice] = useState("alloy");
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [synthesizing, setSynthesizing] = useState(false);
  const [error, setError] = useState("");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [pRes, vRes] = await Promise.all([
        authFetch("/api/v1/voice/providers"),
        authFetch("/api/v1/voice/voices"),
      ]);
      if (pRes.status === 401 || vRes.status === 401)
        throw new Error("Please sign in to use voice.");
      if (pRes.ok) setProviders((await pRes.json()) as Providers);
      if (vRes.ok) {
        const data = (await vRes.json()) as { voices: Voice[] };
        setVoices(data.voices ?? []);
        if (data.voices?.[0]) setVoice(data.voices[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load voice config");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Revoke the previous object URL when it changes / on unmount to avoid leaks.
  useEffect(() => {
    audioUrlRef.current = audioUrl;
    return () => {
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, [audioUrl]);

  const synthesize = async () => {
    if (!text.trim()) return;
    setSynthesizing(true);
    setError("");
    setAudioUrl(null);
    try {
      const res = await authFetch("/api/v1/voice/synthesize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim(), voice }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(body.message ?? body.error ?? `Synthesis failed (${res.status})`);
      }
      const contentType = res.headers.get("Content-Type") ?? "";
      if (!contentType.includes("audio")) {
        throw new Error("No audio returned — is a synthesis provider configured?");
      }
      const blob = await res.blob();
      setAudioUrl(URL.createObjectURL(blob));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Synthesis failed");
    } finally {
      setSynthesizing(false);
    }
  };

  const synthAvailable = providers?.synthesize.available ?? false;

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <AudioLines className="size-5" /> Voice
        </h1>
        <p className="text-sm text-muted-foreground">
          Text-to-speech synthesis. Bring your own provider key via the backend `.env`.
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Card>
              <CardHeader className="py-4">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Volume2 className="size-4" /> Synthesis
                </CardTitle>
                <CardDescription>
                  {providers?.synthesize.provider ?? "unknown"}
                  {synthAvailable ? " · ready" : " · no key"}
                </CardDescription>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="py-4">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Mic className="size-4" /> Transcription
                </CardTitle>
                <CardDescription>
                  {providers?.transcribe.provider ?? "unknown"}
                  {providers?.transcribe.available ? " · ready" : " · no key"}
                </CardDescription>
              </CardHeader>
            </Card>
          </div>

          <Card>
            <CardContent className="space-y-4 pt-6">
              <div className="space-y-1.5">
                <Label htmlFor="voice-text">Text</Label>
                <Textarea
                  id="voice-text"
                  placeholder="Type something to speak…"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={4}
                />
              </div>
              <div className="flex items-end gap-3">
                <div className="flex-1 space-y-1.5">
                  <Label>Voice</Label>
                  <Select value={voice} onValueChange={setVoice}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {voices.map((v) => (
                        <SelectItem key={v.id} value={v.id}>
                          {v.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  onClick={synthesize}
                  disabled={synthesizing || !text.trim()}
                  className="gap-2"
                >
                  {synthesizing ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Play className="size-4" />
                  )}
                  Synthesize
                </Button>
              </div>
              {!synthAvailable && (
                <p className="text-xs text-muted-foreground">
                  No synthesis provider key configured — set `ELEVENLABS_API_KEY` in the backend
                  `.env` to hear real audio.
                </p>
              )}
              {audioUrl && (
                <audio controls src={audioUrl} className="w-full" autoPlay />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
