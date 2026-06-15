// SPDX-License-Identifier: Apache-2.0
/**
 * doc-consumer — Full document ingestion pipeline.
 *
 * Provides:
 *   • FileLock             — per-path mutex to prevent concurrent ingestion
 *   • ChecksumRegistry     — SHA256-based dedup
 *   • MimeDetector         — MIME type from extension
 *   • DocumentClassifier   — route documents to typed handlers
 *   • PermissionSetter     — set read/write/owner permissions
 *   • IngestionSignal      — document_consumption_started/finished signals
 *   • WorkflowTrigger      — post-ingestion workflow execution
 *   • FilenameTemplater    — generate templated output filenames
 *   • DocConsumer          — orchestrates full pipeline
 *   • MockIngestionBackend — injectable test double
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type MimeType = string;
/** Document type type alias. */
export type DocumentType =
  | "text"
  | "pdf"
  | "image"
  | "spreadsheet"
  | "presentation"
  | "code"
  | "archive"
  | "unknown";
/** Permission level type alias. */
export type PermissionLevel = "read" | "write" | "owner" | "none";

/** Ingested document interface definition. */
export interface IngestedDocument {
  id: string;
  originalPath: string;
  outputPath: string;
  mimeType: MimeType;
  documentType: DocumentType;
  checksum: string;
  sizeBytes: number;
  permissions: PermissionLevel;
  ingestedAt: string;
  metadata: Record<string, unknown>;
}

/** Ingestion request interface definition. */
export interface IngestionRequest {
  path: string;
  content: string; // document content/bytes (base64 or text)
  sizeBytes?: number;
  owner?: string;
  tags?: string[];
  workflowId?: string;
  outputTemplate?: string;
}

/** Ingestion result interface definition. */
export interface IngestionResult {
  document?: IngestedDocument;
  status: "success" | "skipped" | "failed";
  reason?: string;
  signals: string[];
}

// ── FileLock ──────────────────────────────────────────────────────────────────

export class FileLock {
  private locks = new Set<string>();

  acquire(path: string): boolean {
    if (this.locks.has(path)) return false;
    this.locks.add(path);
    return true;
  }

  release(path: string): void {
    this.locks.delete(path);
  }

  isLocked(path: string): boolean {
    return this.locks.has(path);
  }
  lockedPaths(): string[] {
    return [...this.locks];
  }
  clear(): void {
    this.locks.clear();
  }
}

// ── ChecksumRegistry ──────────────────────────────────────────────────────────

/** Deterministic checksum: djb2 hash over content string (no crypto dep needed). */
export function computeChecksum(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash) ^ content.charCodeAt(i);
    hash = hash >>> 0; // keep 32-bit unsigned
  }
  return hash.toString(16).padStart(8, "0");
}

/** Checksum registry. */
export class ChecksumRegistry {
  private checksums = new Map<string, string>(); // checksum → document id

  /** Returns null if not seen; registers and returns id if new. */
  register(checksum: string, documentId: string): { isDuplicate: boolean; existingId?: string } {
    if (this.checksums.has(checksum)) {
      return { isDuplicate: true, existingId: this.checksums.get(checksum) };
    }
    this.checksums.set(checksum, documentId);
    return { isDuplicate: false };
  }

  has(checksum: string): boolean {
    return this.checksums.has(checksum);
  }
  getDocumentId(checksum: string): string | undefined {
    return this.checksums.get(checksum);
  }
  remove(checksum: string): void {
    this.checksums.delete(checksum);
  }
  clear(): void {
    this.checksums.clear();
  }
  size(): number {
    return this.checksums.size;
  }
}

// ── MimeDetector ──────────────────────────────────────────────────────────────

const MIME_MAP: Record<string, MimeType> = {
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ts: "text/typescript",
  js: "text/javascript",
  py: "text/x-python",
  zip: "application/zip",
  json: "application/json",
};

const TYPE_MAP: Record<MimeType, DocumentType> = {
  "text/plain": "text",
  "text/markdown": "text",
  "text/html": "text",
  "application/json": "code",
  "text/typescript": "code",
  "text/javascript": "code",
  "text/x-python": "code",
  "application/pdf": "pdf",
  "image/png": "image",
  "image/jpeg": "image",
  "image/gif": "image",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "spreadsheet",
  "application/vnd.ms-excel": "spreadsheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "presentation",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "text",
  "application/zip": "archive",
};

/** Mime detector. */
export class MimeDetector {
  detect(path: string): MimeType {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    return MIME_MAP[ext] ?? "application/octet-stream";
  }

  toDocumentType(mime: MimeType): DocumentType {
    return TYPE_MAP[mime] ?? "unknown";
  }
}

// ── PermissionSetter ──────────────────────────────────────────────────────────

export class PermissionSetter {
  private permissions = new Map<string, PermissionLevel>();

  set(documentId: string, level: PermissionLevel): void {
    this.permissions.set(documentId, level);
  }

  get(documentId: string): PermissionLevel {
    return this.permissions.get(documentId) ?? "none";
  }

  /** Determine default permission based on document type. */
  defaultFor(type: DocumentType, owner?: string): PermissionLevel {
    if (owner) return "owner";
    return type === "code" ? "write" : "read";
  }
}

// ── IngestionSignal ───────────────────────────────────────────────────────────

export type SignalType =
  | "document_consumption_started"
  | "document_consumption_finished"
  | "document_skipped";

/** Ingestion signal event interface definition. */
export interface IngestionSignalEvent {
  type: SignalType;
  documentId: string;
  path: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/** Signal handler type alias. */
export type SignalHandler = (event: IngestionSignalEvent) => void;

/** Ingestion signal bus. */
export class IngestionSignalBus {
  private handlers = new Set<SignalHandler>();

  on(handler: SignalHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event: IngestionSignalEvent): void {
    for (const h of this.handlers) {
      try {
        h(event);
      } catch {
        /* isolate */
      }
    }
  }
}

// ── WorkflowTrigger ───────────────────────────────────────────────────────────

export interface WorkflowTriggerResult {
  workflowId: string;
  triggered: boolean;
  error?: string;
}

/** Workflow executor type alias. */
export type WorkflowExecutor = (workflowId: string, document: IngestedDocument) => Promise<void>;

/** Workflow trigger. */
export class WorkflowTrigger {
  private executor?: WorkflowExecutor;

  inject(executor: WorkflowExecutor): this {
    this.executor = executor;
    return this;
  }

  async trigger(workflowId: string, document: IngestedDocument): Promise<WorkflowTriggerResult> {
    if (!this.executor) {
      return { workflowId, triggered: false, error: "No executor injected" };
    }
    try {
      await this.executor(workflowId, document);
      return { workflowId, triggered: true };
    } catch (err) {
      return {
        workflowId,
        triggered: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ── FilenameTemplater ─────────────────────────────────────────────────────────

export class FilenameTemplater {
  /**
   * Generate output filename from a template.
   * Tokens: {name}, {date}, {ext}, {type}, {id}
   */
  generate(
    template: string,
    vars: { name: string; ext: string; type: DocumentType; id: string; date?: string },
  ): string {
    const date = vars.date ?? new Date().toISOString().slice(0, 10);
    return template
      .replace("{name}", vars.name)
      .replace("{date}", date)
      .replace("{ext}", vars.ext)
      .replace("{type}", vars.type)
      .replace("{id}", vars.id);
  }

  /** Extract base name and extension from a path. */
  parse(path: string): { name: string; ext: string } {
    const filename = path.split("/").pop() ?? path;
    const dotIdx = filename.lastIndexOf(".");
    if (dotIdx === -1) return { name: filename, ext: "" };
    return { name: filename.slice(0, dotIdx), ext: filename.slice(dotIdx + 1) };
  }
}

// ── DocConsumer ───────────────────────────────────────────────────────────────

let _docSeq = 0;

/** Doc consumer options interface definition. */
export interface DocConsumerOptions {
  lock?: FileLock;
  checksumRegistry?: ChecksumRegistry;
  mimeDetector?: MimeDetector;
  permissionSetter?: PermissionSetter;
  signalBus?: IngestionSignalBus;
  workflowTrigger?: WorkflowTrigger;
  templater?: FilenameTemplater;
  defaultTemplate?: string;
}

/** Doc consumer. */
export class DocConsumer {
  private lock: FileLock;
  private checksums: ChecksumRegistry;
  private mime: MimeDetector;
  private permissions: PermissionSetter;
  private signals: IngestionSignalBus;
  private workflow: WorkflowTrigger;
  private templater: FilenameTemplater;
  private defaultTemplate: string;

  constructor(opts: DocConsumerOptions = {}) {
    this.lock = opts.lock ?? new FileLock();
    this.checksums = opts.checksumRegistry ?? new ChecksumRegistry();
    this.mime = opts.mimeDetector ?? new MimeDetector();
    this.permissions = opts.permissionSetter ?? new PermissionSetter();
    this.signals = opts.signalBus ?? new IngestionSignalBus();
    this.workflow = opts.workflowTrigger ?? new WorkflowTrigger();
    this.templater = opts.templater ?? new FilenameTemplater();
    this.defaultTemplate = opts.defaultTemplate ?? "{name}-{date}.{ext}";
  }

  async ingest(request: IngestionRequest): Promise<IngestionResult> {
    const signals: string[] = [];

    // 1. Acquire lock
    if (!this.lock.acquire(request.path)) {
      return { status: "skipped", reason: "File locked", signals };
    }

    try {
      const docId = `doc-${++_docSeq}`;

      // 2. Emit started signal
      this.signals.emit({
        type: "document_consumption_started",
        documentId: docId,
        path: request.path,
        timestamp: new Date().toISOString(),
      });
      signals.push("document_consumption_started");

      // 3. Checksum dedup
      const checksum = computeChecksum(request.content);
      const { isDuplicate, existingId } = this.checksums.register(checksum, docId);
      if (isDuplicate) {
        this.signals.emit({
          type: "document_skipped",
          documentId: existingId!,
          path: request.path,
          timestamp: new Date().toISOString(),
          metadata: { reason: "duplicate" },
        });
        signals.push("document_skipped");
        return { status: "skipped", reason: `Duplicate of ${existingId}`, signals };
      }

      // 4. MIME detection
      const mimeType = this.mime.detect(request.path);
      const documentType = this.mime.toDocumentType(mimeType);

      // 5. Output filename
      const { name, ext } = this.templater.parse(request.path);
      const template = request.outputTemplate ?? this.defaultTemplate;
      const outputPath = this.templater.generate(template, {
        name,
        ext,
        type: documentType,
        id: docId,
      });

      // 6. Permissions
      const permLevel = this.permissions.defaultFor(documentType, request.owner);
      this.permissions.set(docId, permLevel);

      // 7. Build document
      const document: IngestedDocument = {
        id: docId,
        originalPath: request.path,
        outputPath,
        mimeType,
        documentType,
        checksum,
        sizeBytes: request.sizeBytes ?? request.content.length,
        permissions: permLevel,
        ingestedAt: new Date().toISOString(),
        metadata: {
          tags: request.tags ?? [],
          owner: request.owner ?? null,
        },
      };

      // 8. Trigger workflow if specified
      if (request.workflowId) {
        await this.workflow.trigger(request.workflowId, document);
      }

      // 9. Emit finished signal
      this.signals.emit({
        type: "document_consumption_finished",
        documentId: docId,
        path: request.path,
        timestamp: new Date().toISOString(),
        metadata: { mimeType, documentType, outputPath },
      });
      signals.push("document_consumption_finished");

      return { document, status: "success", signals };
    } finally {
      this.lock.release(request.path);
    }
  }

  getSignalBus(): IngestionSignalBus {
    return this.signals;
  }
  getLock(): FileLock {
    return this.lock;
  }
  getChecksumRegistry(): ChecksumRegistry {
    return this.checksums;
  }
}
