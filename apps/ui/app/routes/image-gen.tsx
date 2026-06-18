/**
 * Image Generation — prompt-to-image via DALL-E / Stable Diffusion / FLUX
 *
 * POST /api/images/generate — { prompt, size, quality, style, provider }
 * GET  /api/images/providers — list available providers
 */

import { useState, useEffect, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Badge } from "~/components/ui/badge";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  ImageIcon, Send, Loader2, X, Download, Trash2, RefreshCw,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface GeneratedImage {
  id:             string;
  prompt:         string;
  revisedPrompt?: string;
  provider:       string;
  model:          string;
  url?:           string;
  base64?:        string;
  width:          number;
  height:         number;
  createdAt:      string;
}

interface Provider {
  id:    string;
  name:  string;
  models: string[];
}

// ── Sizing options ─────────────────────────────────────────────────────────────

const SIZES = [
  { value: "1024x1024", label: "1024 × 1024 (Square)" },
  { value: "1024x1792", label: "1024 × 1792 (Portrait)" },
  { value: "1792x1024", label: "1792 × 1024 (Landscape)" },
  { value: "512x512",   label: "512 × 512 (Small)" },
];

const QUALITIES = [
  { value: "standard", label: "Standard" },
  { value: "hd",       label: "HD" },
];

const STYLES = [
  { value: "vivid",   label: "Vivid" },
  { value: "natural", label: "Natural" },
];

// ── Image card ────────────────────────────────────────────────────────────────

function ImageCard({
  img, onDelete,
}: {
  img: GeneratedImage;
  onDelete: (id: string) => void;
}) {
  const src = img.url ?? (img.base64 ? `data:image/png;base64,${img.base64}` : null);

  const handleDownload = () => {
    if (!src) return;
    const a = document.createElement("a");
    a.href = src;
    a.download = `nexus-img-${img.id}.png`;
    a.click();
  };

  return (
    <div
      className="group relative rounded-xl overflow-hidden"
      style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
    >
      {src ? (
        <img
          src={src}
          alt={img.prompt}
          className="w-full object-cover"
          style={{ aspectRatio: `${img.width}/${img.height}` }}
        />
      ) : (
        <div
          className="w-full flex items-center justify-center text-muted-foreground"
          style={{ aspectRatio: "1/1" }}
        >
          <ImageIcon className="size-10 opacity-20" />
        </div>
      )}

      {/* Hover overlay */}
      <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-3 gap-1">
        <p className="text-white text-xs line-clamp-2">{img.prompt}</p>
        {img.revisedPrompt && img.revisedPrompt !== img.prompt && (
          <p className="text-white/60 text-[10px] line-clamp-1 italic">{img.revisedPrompt}</p>
        )}
        <div className="flex items-center gap-2 mt-1">
          <Badge variant="outline" className="text-[10px] text-white/70 border-white/20">
            {img.provider}
          </Badge>
          <Badge variant="outline" className="text-[10px] text-white/70 border-white/20">
            {img.width}×{img.height}
          </Badge>
          <div className="ml-auto flex gap-1.5">
            {src && (
              <button
                onClick={handleDownload}
                className="p-1 rounded text-white/70 hover:text-white transition-colors"
                title="Download"
              >
                <Download className="size-3.5" />
              </button>
            )}
            <button
              onClick={() => onDelete(img.id)}
              className="p-1 rounded text-white/70 hover:text-destructive transition-colors"
              title="Delete"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ImageGenPage() {
  const [prompt,   setPrompt]   = useState("");
  const [size,     setSize]     = useState("1024x1024");
  const [quality,  setQuality]  = useState("standard");
  const [style,    setStyle]    = useState("vivid");
  const [provider, setProvider] = useState("");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [images,   setImages]   = useState<GeneratedImage[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Load providers
  useEffect(() => {
    fetch("/api/images/providers")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.providers?.length) {
          setProviders(data.providers);
          setProvider(data.providers[0]?.id ?? "");
        }
      })
      .catch(() => {});
  }, []);

  // Load image history
  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const res = await fetch("/api/images?limit=20");
      if (res.ok) {
        const data = await res.json();
        setImages(data.images ?? []);
      }
    } catch { /* ignore */ }
    setLoadingHistory(false);
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const generate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || loading) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/images/generate", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          prompt:   prompt.trim(),
          size,
          quality,
          style,
          ...(provider && { provider }),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);

      // The API may return nested image object or flat
      const img: GeneratedImage = data.image ?? data;
      setImages((prev) => [img, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setLoading(false);
    }
  };

  const deleteImage = async (id: string) => {
    try {
      await fetch(`/api/images/${id}`, { method: "DELETE" });
      setImages((prev) => prev.filter((img) => img.id !== id));
    } catch { /* ignore */ }
  };

  return (
    <div className="flex h-screen overflow-hidden">

      {/* Left panel — controls */}
      <aside
        className="w-72 shrink-0 flex flex-col border-r border-border"
        style={{ background: "hsl(var(--card))" }}
      >
        <div className="border-b border-border px-4 py-4 flex items-center gap-2">
          <ImageIcon className="size-4 text-primary" />
          <h2 className="text-sm font-semibold">Image Generation</h2>
        </div>

        <form onSubmit={generate} className="flex flex-col gap-4 p-4 flex-1">
          {/* Prompt */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Prompt</label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="A cinematic shot of a neon-lit cyberpunk city at dusk, rain-soaked streets…"
              className="min-h-[100px] resize-none text-sm"
              disabled={loading}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  (e.target as HTMLTextAreaElement).form?.requestSubmit();
                }
              }}
            />
            <p className="text-[10px] text-muted-foreground text-right">{prompt.length}/4000</p>
          </div>

          {/* Size */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Size</label>
            <Select value={size} onValueChange={setSize} disabled={loading}>
              <SelectTrigger className="text-xs h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SIZES.map((s) => (
                  <SelectItem key={s.value} value={s.value} className="text-xs">{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Quality + Style row */}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Quality</label>
              <Select value={quality} onValueChange={setQuality} disabled={loading}>
                <SelectTrigger className="text-xs h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {QUALITIES.map((q) => (
                    <SelectItem key={q.value} value={q.value} className="text-xs">{q.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Style</label>
              <Select value={style} onValueChange={setStyle} disabled={loading}>
                <SelectTrigger className="text-xs h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STYLES.map((s) => (
                    <SelectItem key={s.value} value={s.value} className="text-xs">{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Provider */}
          {providers.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Provider</label>
              <Select value={provider} onValueChange={setProvider} disabled={loading}>
                <SelectTrigger className="text-xs h-8">
                  <SelectValue placeholder="Auto" />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={p.id} className="text-xs">{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Error */}
          {error && (
            <div
              className="text-xs text-destructive p-2 rounded-lg flex items-start gap-2"
              style={{ background: "hsl(var(--destructive)/0.1)" }}
            >
              <X className="size-3 shrink-0 mt-0.5" />
              {error}
            </div>
          )}

          {/* Generate button */}
          <Button
            type="submit"
            disabled={loading || !prompt.trim()}
            className="gap-2 mt-auto"
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            {loading ? "Generating…" : "Generate"}
          </Button>
        </form>
      </aside>

      {/* Right panel — gallery */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="border-b border-border px-6 py-3 shrink-0 flex items-center gap-3">
          <h1 className="text-sm font-semibold">Gallery</h1>
          <Badge variant="outline" className="text-xs">{images.length} images</Badge>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 ml-auto text-muted-foreground"
            onClick={loadHistory}
            disabled={loadingHistory}
            title="Refresh"
          >
            <RefreshCw className={`size-3.5 ${loadingHistory ? "animate-spin" : ""}`} />
          </Button>
        </div>

        <ScrollArea className="flex-1 p-6">
          {loading && images.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 gap-4">
              <Loader2 className="size-8 animate-spin text-primary/50" />
              <p className="text-sm text-muted-foreground">Generating your image…</p>
            </div>
          ) : images.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 gap-4 text-center">
              <ImageIcon className="size-14 text-muted-foreground/20" />
              <div>
                <p className="text-sm font-medium">No images yet</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Enter a prompt and click Generate to create your first image
                </p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {/* Loading placeholder */}
              {loading && (
                <div
                  className="rounded-xl flex items-center justify-center"
                  style={{
                    aspectRatio: "1/1",
                    background: "hsl(var(--muted)/0.5)",
                    border: "1px dashed hsl(var(--border))",
                  }}
                >
                  <Loader2 className="size-6 animate-spin text-primary/50" />
                </div>
              )}
              {images.map((img) => (
                <ImageCard key={img.id} img={img} onDelete={deleteImage} />
              ))}
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}
