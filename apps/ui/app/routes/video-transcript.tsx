// SPDX-License-Identifier: Apache-2.0
/**
 * Video Transcript — extract transcripts from video URLs or uploads.
 *
 * Supports YouTube, Loom, Vimeo, MP4 uploads, and other sources.
 * Returns full transcript with timestamps, speaker diarization,
 * and chapter markers.
 *
 * API:
 *   GET  /api/video/transcript/sources
 *   POST /api/video/transcript
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Video, Loader2, Download, Play, Upload, Clock, User, Copy, Check } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Source {
  id: string;
  name: string;
  supported: boolean;
  urlPattern?: string;
}

interface TranscriptSegment {
  startSec: number;
  endSec?: number;
  text: string;
  speaker?: string;
  confidence?: number;
}

interface TranscriptResult {
  title?: string;
  duration?: number;
  language?: string;
  segments: TranscriptSegment[];
  fullText: string;
  chapters?: { startSec: number; title: string }[];
  sourceUrl?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function VideoTranscript() {
  const [sources, setSources] = useState<Source[]>([]);
  const [url, setUrl] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [result, setResult] = useState<TranscriptResult | null>(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<"segments" | "text" | "chapters">("segments");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/video/transcript/sources")
      .then((r) => (r.ok ? r.json() : { sources: [] }))
      .then((d) => setSources(d.sources ?? d))
      .catch(() => {});
  }, []);

  const transcribe = useCallback(
    async (sourceUrl?: string, base64?: string) => {
      const target = sourceUrl ?? url.trim();
      if (!target && !base64) return;
      setTranscribing(true);
      setErr("");
      setResult(null);
      const r = await fetch("/api/video/transcript", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(base64 ? { base64 } : { url: target }),
      }).catch(() => null);
      if (r?.ok) setResult(await r.json());
      else setErr("Transcription failed");
      setTranscribing(false);
    },
    [url],
  );

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const base64 = (e.target?.result as string).split(",")[1];
      transcribe(undefined, base64);
    };
    reader.readAsDataURL(file);
  };

  const copyText = () => {
    if (!result?.fullText) return;
    navigator.clipboard.writeText(result.fullText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const downloadSRT = () => {
    if (!result) return;
    const srt = result.segments
      .map((seg, i) => {
        const start = formatTime(seg.startSec).replace(":", ",");
        const end = seg.endSec
          ? formatTime(seg.endSec).replace(":", ",")
          : formatTime(seg.startSec + 5).replace(":", ",");
        return `${i + 1}\n00:${start},000 --> 00:${end},000\n${seg.speaker ? `[${seg.speaker}] ` : ""}${seg.text}\n`;
      })
      .join("\n");
    const blob = new Blob([srt], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "transcript.srt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Video className="w-6 h-6 text-purple-500" />
          Video Transcript
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Extract full transcripts from video URLs or file uploads
        </p>
      </div>

      {/* Supported sources */}
      {sources.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {sources
            .filter((s) => s.supported)
            .map((s) => (
              <Badge key={s.id} variant="outline" className="text-xs">
                {s.name}
              </Badge>
            ))}
        </div>
      )}

      {/* Input */}
      <Card>
        <CardContent className="pt-4 space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder="https://youtube.com/watch?v=… or any video URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && transcribe()}
              className="flex-1"
            />
            <Button onClick={() => transcribe()} disabled={transcribing || !url.trim()}>
              {transcribing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Play className="w-4 h-4" />
              )}
            </Button>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1 border-t" />
            <span className="text-xs text-muted-foreground">or</span>
            <div className="flex-1 border-t" />
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="video/*,audio/*"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
          <Button
            variant="outline"
            className="w-full"
            onClick={() => fileRef.current?.click()}
            disabled={transcribing}
          >
            <Upload className="w-4 h-4 mr-2" />
            Upload video/audio file
          </Button>
          {err && <p className="text-red-500 text-xs">{err}</p>}
          {transcribing && (
            <div className="flex items-center gap-2 text-muted-foreground text-sm py-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Transcribing… This may take a minute
            </div>
          )}
        </CardContent>
      </Card>

      {/* Result */}
      {result && (
        <div className="space-y-4">
          {/* Metadata */}
          <div className="flex flex-wrap items-center gap-2">
            {result.title && <h2 className="text-lg font-semibold flex-1">{result.title}</h2>}
            <div className="flex items-center gap-2">
              {result.duration && (
                <Badge variant="outline" className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {formatTime(result.duration)}
                </Badge>
              )}
              {result.language && <Badge variant="outline">{result.language.toUpperCase()}</Badge>}
              <Button size="sm" variant="outline" onClick={copyText}>
                {copied ? (
                  <>
                    <Check className="w-3 h-3 mr-1" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3 mr-1" />
                    Copy text
                  </>
                )}
              </Button>
              <Button size="sm" variant="outline" onClick={downloadSRT}>
                <Download className="w-3 h-3 mr-1" />
                SRT
              </Button>
            </div>
          </div>

          {/* View mode */}
          <div className="flex gap-2">
            {(["segments", "text", "chapters"] as const).map((m) =>
              result.chapters || m !== "chapters" ? (
                <Button
                  key={m}
                  size="sm"
                  variant={viewMode === m ? "default" : "outline"}
                  onClick={() => setViewMode(m)}
                  className="capitalize"
                >
                  {m}
                </Button>
              ) : null,
            )}
          </div>

          {/* Segments */}
          {viewMode === "segments" && (
            <div className="space-y-1 max-h-[500px] overflow-y-auto">
              {result.segments.map((seg, i) => (
                <div
                  key={i}
                  className="flex items-start gap-3 py-1.5 px-2 rounded hover:bg-muted/30 group"
                >
                  <span className="text-xs text-muted-foreground font-mono w-12 shrink-0 pt-0.5">
                    {formatTime(seg.startSec)}
                  </span>
                  {seg.speaker && (
                    <span className="text-xs font-medium text-primary shrink-0 w-20 truncate pt-0.5 flex items-center gap-0.5">
                      <User className="w-3 h-3" />
                      {seg.speaker}
                    </span>
                  )}
                  <p className="text-sm flex-1">{seg.text}</p>
                </div>
              ))}
            </div>
          )}

          {/* Full text */}
          {viewMode === "text" && (
            <Card>
              <CardContent className="pt-4">
                <p className="text-sm whitespace-pre-wrap max-h-[500px] overflow-y-auto">
                  {result.fullText}
                </p>
              </CardContent>
            </Card>
          )}

          {/* Chapters */}
          {viewMode === "chapters" && result.chapters && (
            <div className="space-y-1">
              {result.chapters.map((ch, i) => (
                <div key={i} className="flex items-center gap-3 py-2 border-b last:border-0">
                  <span className="text-xs text-muted-foreground font-mono w-12">
                    {formatTime(ch.startSec)}
                  </span>
                  <span className="text-sm font-medium">{ch.title}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
