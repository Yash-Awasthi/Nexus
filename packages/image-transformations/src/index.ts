// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/image-transformations — image resize, crop, format convert, watermark.
 *
 * Uses `sharp` (optional peer dep) when available; falls back to a passthrough
 * stub that returns the original buffer unchanged so routes stay functional
 * without native binaries (CI / lightweight containers).
 *
 * Usage:
 * ```ts
 * import { ImageTransformer } from "@nexus/image-transformations";
 * const t = new ImageTransformer();
 * const result = await t.resize(inputBuffer, { width: 800, height: 600, fit: "cover" });
 * ```
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export type ImageFormat = "jpeg" | "png" | "webp" | "avif" | "gif" | "tiff";
export type FitMode    = "cover" | "contain" | "fill" | "inside" | "outside";

export interface ResizeOptions {
  width?:   number;
  height?:  number;
  fit?:     FitMode;
  /** Background colour for `contain` / `fill` — CSS hex or rgba string. Default: "#ffffff" */
  background?: string;
}

export interface CropOptions {
  left:   number;
  top:    number;
  width:  number;
  height: number;
}

export interface ConvertOptions {
  format:  ImageFormat;
  quality?: number; // 1–100; default 85
}

export interface WatermarkOptions {
  text:         string;
  /** CSS colour string. Default: "rgba(255,255,255,0.5)" */
  colour?:      string;
  /** Font size in px. Default: 36 */
  fontSize?:    number;
  /** Gravity: "northwest" | "north" | "northeast" | "southeast" | etc. Default: "southeast" */
  gravity?:     string;
}

export interface TransformResult {
  buffer:    Buffer;
  format:    ImageFormat;
  width:     number | null;
  height:    number | null;
  byteSize:  number;
  /** True when sharp was unavailable and input was returned unchanged */
  passthrough: boolean;
}

// ── Sharp availability check ───────────────────────────────────────────────────

let _sharpModule: typeof import("sharp") | null | undefined = undefined; // undefined = not yet checked

async function getSharp(): Promise<typeof import("sharp") | null> {
  if (_sharpModule !== undefined) return _sharpModule;
  try {
    _sharpModule = (await import("sharp")).default as unknown as typeof import("sharp");
    return _sharpModule;
  } catch {
    _sharpModule = null;
    return null;
  }
}

function passthrough(input: Buffer, format: ImageFormat = "jpeg"): TransformResult {
  return { buffer: input, format, width: null, height: null, byteSize: input.byteLength, passthrough: true };
}

// ── ImageTransformer ──────────────────────────────────────────────────────────

export class ImageTransformer {
  /**
   * Resize an image. Returns the original buffer unchanged if sharp is not
   * installed (passthrough: true in the result).
   */
  async resize(input: Buffer, opts: ResizeOptions, format?: ImageFormat): Promise<TransformResult> {
    const sharp = await getSharp();
    if (!sharp) return passthrough(input, format ?? "jpeg");

    let pipeline = sharp(input).resize({
      width:      opts.width,
      height:     opts.height,
      fit:        opts.fit ?? "cover",
      background: opts.background ?? "#ffffff",
    });
    if (format) pipeline = applyFormat(pipeline, format);

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return {
      buffer:    data,
      format:    info.format as ImageFormat ?? format ?? "jpeg",
      width:     info.width,
      height:    info.height,
      byteSize:  info.size,
      passthrough: false,
    };
  }

  /** Crop to an exact region. */
  async crop(input: Buffer, opts: CropOptions, format?: ImageFormat): Promise<TransformResult> {
    const sharp = await getSharp();
    if (!sharp) return passthrough(input, format);

    let pipeline = sharp(input).extract({
      left:   opts.left,
      top:    opts.top,
      width:  opts.width,
      height: opts.height,
    });
    if (format) pipeline = applyFormat(pipeline, format);

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return {
      buffer: data,
      format: info.format as ImageFormat ?? format ?? "jpeg",
      width:  info.width,
      height: info.height,
      byteSize: info.size,
      passthrough: false,
    };
  }

  /** Convert image format / quality. */
  async convert(input: Buffer, opts: ConvertOptions): Promise<TransformResult> {
    const sharp = await getSharp();
    if (!sharp) return passthrough(input, opts.format);

    const quality = opts.quality ?? 85;
    let pipeline  = sharp(input);
    pipeline = applyFormat(pipeline, opts.format, quality);

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return {
      buffer:    data,
      format:    opts.format,
      width:     info.width,
      height:    info.height,
      byteSize:  info.size,
      passthrough: false,
    };
  }

  /** Add a text watermark (SVG overlay). */
  async watermark(input: Buffer, opts: WatermarkOptions, format?: ImageFormat): Promise<TransformResult> {
    const sharp = await getSharp();
    if (!sharp) return passthrough(input, format);

    const fontSize = opts.fontSize ?? 36;
    const colour   = opts.colour   ?? "rgba(255,255,255,0.5)";
    const textLen  = opts.text.length;
    const svgWidth = fontSize * textLen * 0.6;

    const svgBuf = Buffer.from(
      `<svg width="${svgWidth}" height="${fontSize * 1.5}">` +
      `<text x="0" y="${fontSize}" font-size="${fontSize}" fill="${colour}" ` +
      `font-family="sans-serif">${opts.text}</text></svg>`,
    );

    let pipeline = sharp(input).composite([{
      input: svgBuf,
      gravity: (opts.gravity ?? "southeast") as "southeast",
    }]);
    if (format) pipeline = applyFormat(pipeline, format);

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return {
      buffer:    data,
      format:    info.format as ImageFormat ?? format ?? "jpeg",
      width:     info.width,
      height:    info.height,
      byteSize:  info.size,
      passthrough: false,
    };
  }

  /** Get image metadata without transforming. */
  async metadata(input: Buffer): Promise<{
    format: string | undefined;
    width: number | undefined;
    height: number | undefined;
    channels: number | undefined;
    size: number;
    hasAlpha: boolean | undefined;
  }> {
    const sharp = await getSharp();
    if (!sharp) {
      return { format: undefined, width: undefined, height: undefined,
               channels: undefined, size: input.byteLength, hasAlpha: undefined };
    }
    const meta = await sharp(input).metadata();
    return {
      format:   meta.format,
      width:    meta.width,
      height:   meta.height,
      channels: meta.channels,
      size:     meta.size ?? input.byteLength,
      hasAlpha: meta.hasAlpha,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyFormat(pipeline: any, format: ImageFormat, quality = 85): any {
  switch (format) {
    case "jpeg": return pipeline.jpeg({ quality });
    case "png":  return pipeline.png({ compressionLevel: Math.round((100 - quality) / 11) });
    case "webp": return pipeline.webp({ quality });
    case "avif": return pipeline.avif({ quality });
    case "gif":  return pipeline.gif();
    case "tiff": return pipeline.tiff({ quality });
    default:     return pipeline;
  }
}

/** One-shot helper: check whether sharp is available in this runtime. */
export async function isSharpAvailable(): Promise<boolean> {
  return (await getSharp()) !== null;
}

// ── TransformError ────────────────────────────────────────────────────────────

export class TransformError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "TransformError";
  }
}
