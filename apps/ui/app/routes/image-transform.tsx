// SPDX-License-Identifier: Apache-2.0
/**
 * Image Transformations — img2img and img2video.
 *
 * Tab 1: img2img — transform an image with a text prompt (style transfer,
 *   inpainting, upscaling, etc.)
 * Tab 2: img2video — animate a still image into a short video clip.
 *
 * API:
 *   GET  /api/image-transformations/providers
 *   POST /api/image-transformations/img2img
 *   POST /api/image-transformations/img2video
 */
import { useState, useCallback, useRef } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { ImageIcon, Film, Upload, Loader2, Download, Wand2, RefreshCw, X } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Provider {
  id: string;
  name: string;
  supportsImg2Img?: boolean;
  supportsImg2Video?: boolean;
}

interface TransformResult {
  url?: string;
  base64?: string;
  width?: number;
  height?: number;
  provider?: string;
  durationMs?: number;
}

interface VideoResult {
  url?: string;
  durationSec?: number;
  provider?: string;
}

// ─── Image upload helper ──────────────────────────────────────────────────────

function useImageUpload() {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => setDataUrl(e.target?.result as string);
    reader.readAsDataURL(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) handleFile(file);
  };

  const clear = () => setDataUrl(null);

  const DropZone = () => (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
      onClick={() => ref.current?.click()}
      className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors hover:border-primary/50 ${dataUrl ? "border-primary/30" : "border-muted-foreground/25"}`}
    >
      <input
        ref={ref}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
      />
      {dataUrl ? (
        <div className="relative inline-block">
          <img src={dataUrl} alt="source" className="max-h-48 rounded-md mx-auto" />
          <button
            onClick={(e) => {
              e.stopPropagation();
              clear();
            }}
            className="absolute -top-2 -right-2 bg-background border rounded-full p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ) : (
        <>
          <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground opacity-50" />
          <p className="text-sm text-muted-foreground">Drop an image here or click to upload</p>
          <p className="text-xs text-muted-foreground mt-1">PNG, JPG, WebP</p>
        </>
      )}
    </div>
  );

  return { dataUrl, DropZone, clear };
}

// ─── Img2Img Tab ──────────────────────────────────────────────────────────────

function Img2ImgTab({ providers }: { providers: Provider[] }) {
  const { dataUrl, DropZone } = useImageUpload();
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [strength, setStrength] = useState(0.7);
  const [providerId, setProviderId] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TransformResult | null>(null);
  const [err, setErr] = useState("");

  const run = useCallback(async () => {
    if (!dataUrl || !prompt.trim()) return;
    setRunning(true);
    setErr("");
    setResult(null);
    try {
      const r = await fetch("/api/image-transformations/img2img", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: dataUrl.split(",")[1],
          prompt: prompt.trim(),
          negativePrompt: negativePrompt.trim() || undefined,
          strength,
          provider: providerId || undefined,
        }),
      });
      if (r.ok) setResult(await r.json());
      else {
        const d = await r.json().catch(() => ({}));
        setErr(d.error ?? "Transform failed");
      }
    } catch {
      setErr("Could not reach server");
    }
    setRunning(false);
  }, [dataUrl, prompt, negativePrompt, strength, providerId]);

  const imgSrc = result?.url ?? (result?.base64 ? `data:image/png;base64,${result.base64}` : null);

  return (
    <div className="space-y-4">
      <div className="grid md:grid-cols-2 gap-4">
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">Source Image</label>
            <DropZone />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Transform Prompt *</label>
            <Textarea
              rows={3}
              placeholder="A painting in the style of Van Gogh, oil on canvas…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="resize-none"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Negative Prompt</label>
            <Input
              placeholder="blurry, low quality…"
              value={negativePrompt}
              onChange={(e) => setNegativePrompt(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium flex items-center justify-between">
              <span>Transform Strength</span>
              <span className="font-normal text-muted-foreground">{strength.toFixed(2)}</span>
            </label>
            <input
              type="range"
              min={0.1}
              max={1.0}
              step={0.05}
              value={strength}
              onChange={(e) => setStrength(parseFloat(e.target.value))}
              className="w-full accent-primary"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Subtle</span>
              <span>Full transform</span>
            </div>
          </div>
          {providers.length > 0 && (
            <div className="space-y-1">
              <label className="text-sm font-medium">Provider</label>
              <select
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
              >
                <option value="">Auto-select</option>
                {providers
                  .filter((p) => p.supportsImg2Img !== false)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </div>
          )}
          {err && <p className="text-red-500 text-xs">{err}</p>}
          <Button onClick={run} disabled={running || !dataUrl || !prompt.trim()} className="w-full">
            {running ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Transforming…
              </>
            ) : (
              <>
                <Wand2 className="w-4 h-4 mr-2" />
                Transform Image
              </>
            )}
          </Button>
        </div>

        <div className="space-y-3">
          <label className="text-sm font-medium">Result</label>
          <div className="border rounded-lg min-h-[300px] flex items-center justify-center bg-muted/30">
            {running ? (
              <div className="text-center text-muted-foreground">
                <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />
                <p className="text-sm">Transforming…</p>
              </div>
            ) : imgSrc ? (
              <div className="w-full p-2 space-y-2">
                <img src={imgSrc} alt="transformed" className="w-full rounded-md" />
                <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
                  <span>
                    {result?.width && result?.height ? `${result.width}×${result.height}` : ""}
                  </span>
                  <div className="flex items-center gap-2">
                    {result?.provider && <Badge variant="outline">{result.provider}</Badge>}
                    {result?.durationMs && <span>{(result.durationMs / 1000).toFixed(1)}s</span>}
                  </div>
                </div>
                {imgSrc && (
                  <a href={imgSrc} download="transformed.png">
                    <Button variant="outline" size="sm" className="w-full">
                      <Download className="w-4 h-4 mr-2" />
                      Download
                    </Button>
                  </a>
                )}
              </div>
            ) : (
              <div className="text-center text-muted-foreground">
                <ImageIcon className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p className="text-sm">Result will appear here</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Img2Video Tab ────────────────────────────────────────────────────────────

function Img2VideoTab({ providers }: { providers: Provider[] }) {
  const { dataUrl, DropZone } = useImageUpload();
  const [motionPrompt, setMotionPrompt] = useState("");
  const [durationSec, setDurationSec] = useState(3);
  const [fps, setFps] = useState(24);
  const [providerId, setProviderId] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<VideoResult | null>(null);
  const [err, setErr] = useState("");

  const run = useCallback(async () => {
    if (!dataUrl) return;
    setRunning(true);
    setErr("");
    setResult(null);
    try {
      const r = await fetch("/api/image-transformations/img2video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: dataUrl.split(",")[1],
          motionPrompt: motionPrompt.trim() || undefined,
          durationSec,
          fps,
          provider: providerId || undefined,
        }),
      });
      if (r.ok) setResult(await r.json());
      else {
        const d = await r.json().catch(() => ({}));
        setErr(d.error ?? "Video generation failed");
      }
    } catch {
      setErr("Could not reach server");
    }
    setRunning(false);
  }, [dataUrl, motionPrompt, durationSec, fps, providerId]);

  return (
    <div className="space-y-4">
      <div className="grid md:grid-cols-2 gap-4">
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">Source Image</label>
            <DropZone />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">
              Motion Prompt <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <Textarea
              rows={2}
              placeholder="Camera slowly zooms in, leaves rustle in the breeze…"
              value={motionPrompt}
              onChange={(e) => setMotionPrompt(e.target.value)}
              className="resize-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Duration (s)</label>
              <Input
                type="number"
                min={1}
                max={15}
                value={durationSec}
                onChange={(e) => setDurationSec(parseInt(e.target.value) || 3)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">FPS</label>
              <Input
                type="number"
                min={8}
                max={60}
                value={fps}
                onChange={(e) => setFps(parseInt(e.target.value) || 24)}
              />
            </div>
          </div>
          {providers.length > 0 && (
            <div className="space-y-1">
              <label className="text-sm font-medium">Provider</label>
              <select
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
              >
                <option value="">Auto-select</option>
                {providers
                  .filter((p) => p.supportsImg2Video !== false)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </div>
          )}
          {err && <p className="text-red-500 text-xs">{err}</p>}
          <Button onClick={run} disabled={running || !dataUrl} className="w-full">
            {running ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Generating video…
              </>
            ) : (
              <>
                <Film className="w-4 h-4 mr-2" />
                Animate Image
              </>
            )}
          </Button>
          <p className="text-xs text-muted-foreground">
            Video generation typically takes 15–120 seconds depending on provider and duration.
          </p>
        </div>

        <div className="space-y-3">
          <label className="text-sm font-medium">Result</label>
          <div className="border rounded-lg min-h-[300px] flex items-center justify-center bg-muted/30">
            {running ? (
              <div className="text-center text-muted-foreground">
                <Film className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <Loader2 className="w-6 h-6 animate-spin mx-auto mb-1" />
                <p className="text-sm">Generating video…</p>
                <p className="text-xs mt-1">This may take a while</p>
              </div>
            ) : result?.url ? (
              <div className="w-full p-2 space-y-2">
                <video src={result.url} controls autoPlay loop className="w-full rounded-md" />
                <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
                  {result.durationSec && <span>{result.durationSec}s</span>}
                  {result.provider && <Badge variant="outline">{result.provider}</Badge>}
                </div>
                <a href={result.url} download="animated.mp4" target="_blank" rel="noreferrer">
                  <Button variant="outline" size="sm" className="w-full">
                    <Download className="w-4 h-4 mr-2" />
                    Download
                  </Button>
                </a>
              </div>
            ) : (
              <div className="text-center text-muted-foreground">
                <Film className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p className="text-sm">Animated video will appear here</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ImageTransform() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(true);

  useState(() => {
    fetch("/api/image-transformations/providers")
      .then((r) => (r.ok ? r.json() : { providers: [] }))
      .then((d) => setProviders(d.providers ?? d))
      .catch(() => {})
      .finally(() => setLoadingProviders(false));
  });

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Wand2 className="w-6 h-6 text-fuchsia-500" />
          Image Transformations
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Transform images with AI (img2img style transfer) or animate stills into videos
        </p>
      </div>

      {loadingProviders ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading providers…
        </div>
      ) : providers.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {providers.map((p) => (
            <Badge key={p.id} variant="outline">
              {p.name}
            </Badge>
          ))}
        </div>
      ) : null}

      <Tabs defaultValue="img2img">
        <TabsList>
          <TabsTrigger value="img2img">
            <ImageIcon className="w-4 h-4 mr-1" />
            Image to Image
          </TabsTrigger>
          <TabsTrigger value="img2video">
            <Film className="w-4 h-4 mr-1" />
            Image to Video
          </TabsTrigger>
        </TabsList>
        <TabsContent value="img2img" className="mt-4">
          <Img2ImgTab providers={providers} />
        </TabsContent>
        <TabsContent value="img2video" className="mt-4">
          <Img2VideoTab providers={providers} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
