// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";

import { api } from "../lib/api.js";

interface GeneratedImage {
  id: string;
  url: string;
  prompt: string;
  model: string;
  size: string;
  createdAt: string;
}

const MODELS = [
  { id: "dall-e-3", label: "DALL·E 3" },
  { id: "dall-e-2", label: "DALL·E 2" },
  { id: "stable-diffusion-xl", label: "Stable Diffusion XL" },
  { id: "flux-1-dev", label: "FLUX.1 Dev" },
];

const SIZES = ["1024x1024", "1792x1024", "1024x1792", "512x512"];

const s = {
  header: { marginBottom: 24 },
  title: { fontSize: 24, fontWeight: 700, margin: 0 } as React.CSSProperties,
  layout: { display: "grid", gridTemplateColumns: "320px 1fr", gap: 20 },
  panel: {
    background: "#161b27",
    border: "1px solid #1e2535",
    borderRadius: 10,
    padding: "20px 24px",
  } as React.CSSProperties,
  label: {
    fontSize: 12,
    color: "#64748b",
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
    marginBottom: 6,
    display: "block",
  },
  textarea: {
    width: "100%",
    background: "#0d1117",
    border: "1px solid #1e2535",
    borderRadius: 8,
    color: "#e2e8f0",
    fontSize: 14,
    padding: "10px 12px",
    resize: "vertical" as const,
    minHeight: 120,
    outline: "none",
    fontFamily: "inherit",
    boxSizing: "border-box" as const,
  } as React.CSSProperties,
  select: {
    width: "100%",
    background: "#0d1117",
    border: "1px solid #1e2535",
    borderRadius: 8,
    color: "#e2e8f0",
    fontSize: 13,
    padding: "8px 10px",
    marginBottom: 12,
  } as React.CSSProperties,
  genBtn: (loading: boolean): React.CSSProperties => ({
    width: "100%",
    background: loading ? "#4c1d95" : "#7c3aed",
    border: "none",
    borderRadius: 8,
    color: "#fff",
    fontSize: 14,
    fontWeight: 600,
    padding: "11px",
    cursor: loading ? "not-allowed" : "pointer",
    marginTop: 8,
    opacity: loading ? 0.7 : 1,
  }),
  imageGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
    gap: 12,
  },
  imageCard: {
    background: "#161b27",
    border: "1px solid #1e2535",
    borderRadius: 10,
    overflow: "hidden",
  } as React.CSSProperties,
  image: {
    width: "100%",
    display: "block",
    aspectRatio: "1/1",
    objectFit: "cover" as const,
    background: "#0d1117",
  },
  imageCaption: { padding: "10px 12px", fontSize: 12, color: "#64748b", lineHeight: 1.4 },
  placeholder: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    aspectRatio: "1/1",
    color: "#334155",
    fontSize: 13,
  },
};

export default function ImageGen() {
  const [prompt, setPrompt] = useState("");
  const [negPrompt, setNegPrompt] = useState("");
  const [model, setModel] = useState("dall-e-3");
  const [size, setSize] = useState("1024x1024");
  const [loading, setLoading] = useState(false);
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    if (!prompt.trim()) return;
    setLoading(true);
    setError(null);
    api
      .post<{ images: GeneratedImage[] }>("/image-gen/generate", {
        prompt,
        negativePrompt: negPrompt,
        model,
        size,
      })
      .then((r) => setImages((prev) => [...r.images, ...prev]))
      .catch(() => {
        setImages((prev) => [
          {
            id: `img${Date.now()}`,
            url: "",
            prompt,
            model,
            size,
            createdAt: new Date().toISOString(),
          },
          ...prev,
        ]);
      })
      .finally(() => setLoading(false));
  };

  return (
    <div>
      <div style={s.header}>
        <h1 style={s.title}>Image Generation</h1>
        <p style={{ color: "#64748b", margin: "4px 0 0" }}>Generate images from text prompts</p>
      </div>

      <div style={s.layout}>
        <div style={s.panel}>
          <label style={s.label}>Prompt</label>
          <textarea
            style={s.textarea}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="A photorealistic portrait of a futuristic AI researcher at NIT Raipur…"
          />

          <label style={{ ...s.label, marginTop: 12 }}>Negative prompt</label>
          <textarea
            style={{ ...s.textarea, minHeight: 60 }}
            value={negPrompt}
            onChange={(e) => setNegPrompt(e.target.value)}
            placeholder="blurry, watermark, low quality…"
          />

          <label style={{ ...s.label, marginTop: 12 }}>Model</label>
          <select style={s.select} value={model} onChange={(e) => setModel(e.target.value)}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>

          <label style={s.label}>Size</label>
          <select style={s.select} value={size} onChange={(e) => setSize(e.target.value)}>
            {SIZES.map((sz) => (
              <option key={sz} value={sz}>
                {sz}
              </option>
            ))}
          </select>

          <button style={s.genBtn(loading)} onClick={generate} disabled={loading || !prompt.trim()}>
            {loading ? "Generating…" : "Generate"}
          </button>

          {error && <p style={{ color: "#fca5a5", fontSize: 12, marginTop: 8 }}>{error}</p>}
        </div>

        <div>
          {images.length === 0 ? (
            <div
              style={{
                ...s.panel,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                minHeight: 300,
              }}
            >
              <p style={{ color: "#475569", fontSize: 14, textAlign: "center" }}>
                Generated images will appear here.
              </p>
            </div>
          ) : (
            <div style={s.imageGrid}>
              {images.map((img) => (
                <div key={img.id} style={s.imageCard}>
                  {img.url ? (
                    <img src={img.url} alt={img.prompt} style={s.image} />
                  ) : (
                    <div style={{ ...(s.image as React.CSSProperties), ...s.placeholder }}>
                      <span>Image placeholder</span>
                    </div>
                  )}
                  <div style={s.imageCaption}>
                    <div style={{ color: "#e2e8f0", marginBottom: 4, fontSize: 13 }}>
                      {img.prompt.slice(0, 80)}
                      {img.prompt.length > 80 ? "…" : ""}
                    </div>
                    <div>
                      {img.model} · {img.size}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
