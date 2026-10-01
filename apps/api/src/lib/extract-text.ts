// SPDX-License-Identifier: Apache-2.0
/**
 * Plain text of an uploaded file, for the knowledge base and the document pipeline. PDF, DOCX
 * and OCR libraries load only when a file of that kind arrives.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

const IMAGE_TYPES = new Set(["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"]);

export function isImageType(type: string): boolean {
  return type === "image" || IMAGE_TYPES.has(type);
}

/** Text in an image. The English model downloads once on first use, so this needs the network. */
export async function ocrImage(bytes: Buffer): Promise<string> {
  const { createWorker } = await import("tesseract.js");
  // Left alone, the model is cached in the working directory.
  const cachePath = join(process.env.NEXUS_DESKTOP_DATA_DIR ?? tmpdir(), "tesseract");
  const worker = await createWorker("eng", undefined, { cachePath });
  try {
    return (await worker.recognize(bytes)).data.text.trim();
  } finally {
    await worker.terminate();
  }
}

export async function extractText(type: string, bytes: Buffer): Promise<string> {
  if (type === "pdf") {
    const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await pdfText(pdf, { mergePages: true });
    return text;
  }
  if (type === "docx") {
    const mammoth = await import("mammoth");
    return (await mammoth.extractRawText({ buffer: bytes })).value;
  }
  if (isImageType(type)) return ocrImage(bytes);
  const raw = bytes.toString("utf8");
  if (type === "html") {
    return raw
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
  }
  return raw;
}
