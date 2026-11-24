// SPDX-License-Identifier: Apache-2.0
/**
 * Open-document bookkeeping: full-text `didOpen` at version 1, full-text
 * `didChange` at version + 1 (never incremental), `didClose` on eviction.
 * Also holds the per-URI+version diagnostics and symbol caches.
 */

export interface PublishDiagnosticsParams {
  uri: string;
  version?: number | null;
  diagnostics: unknown[];
}

export interface DocumentSyncOptions {
  maxDocuments: number;
  diagnosticsWaitMs: number;
  notify: (method: string, params: unknown) => void;
  now?: () => number;
}

export interface WaitedDiagnostics {
  diagnostics: unknown[];
  stale: boolean;
}

interface OpenDocument {
  uri: string;
  languageId: string;
  version: number;
  text: string;
  lastUsed: number;
}

interface DiagnosticsRecord {
  version: number;
  diagnostics: unknown[];
}

interface Waiter {
  uri: string;
  version: number;
  resolve: (result: WaitedDiagnostics) => void;
  timer: NodeJS.Timeout;
}

export class DocumentSync {
  private readonly options: DocumentSyncOptions;
  private readonly documents = new Map<string, OpenDocument>();
  private readonly diagnostics = new Map<string, DiagnosticsRecord>();
  private readonly symbols = new Map<string, { version: number; symbols: unknown[] }>();
  private readonly waiters = new Set<Waiter>();

  constructor(options: DocumentSyncOptions) {
    this.options = options;
  }

  get openCount(): number {
    return this.documents.size;
  }

  version(uri: string): number | undefined {
    return this.documents.get(uri)?.version;
  }

  text(uri: string): string | undefined {
    return this.documents.get(uri)?.text;
  }

  isOpen(uri: string): boolean {
    return this.documents.has(uri);
  }

  touch(uri: string): void {
    const document = this.documents.get(uri);
    if (document) document.lastUsed = this.now();
  }

  /** didOpen with full text and version 1. Returns the version. */
  open(input: { uri: string; languageId: string; text: string }): number {
    const version = 1;
    this.documents.set(input.uri, {
      uri: input.uri,
      languageId: input.languageId,
      version,
      text: input.text,
      lastUsed: this.now(),
    });
    this.options.notify("textDocument/didOpen", {
      textDocument: {
        uri: input.uri,
        languageId: input.languageId,
        version,
        text: input.text,
      },
    });
    this.evictIfNeeded();
    return version;
  }

  /** didChange with the full text and version + 1. Returns the new version. */
  change(uri: string, text: string): number {
    const document = this.documents.get(uri);
    if (!document) return this.open({ uri, languageId: "plaintext", text });
    document.version += 1;
    document.text = text;
    document.lastUsed = this.now();
    // Keep the last diagnostics: a stale read returns them after a timeout.
    this.symbols.delete(uri);
    this.options.notify("textDocument/didChange", {
      textDocument: { uri, version: document.version },
      contentChanges: [{ text }],
    });
    return document.version;
  }

  close(uri: string): void {
    if (!this.documents.delete(uri)) return;
    this.diagnostics.delete(uri);
    this.symbols.delete(uri);
    this.options.notify("textDocument/didClose", { textDocument: { uri } });
  }

  /** Server died: forget everything without sending notifications. */
  reset(): void {
    for (const waiter of [...this.waiters]) this.finish(waiter, { diagnostics: [], stale: true });
    this.documents.clear();
    this.diagnostics.clear();
    this.symbols.clear();
  }

  /** Feed a `textDocument/publishDiagnostics` notification. */
  publish(params: PublishDiagnosticsParams): void {
    const version =
      typeof params.version === "number" ? params.version : (this.version(params.uri) ?? 0);
    const existing = this.diagnostics.get(params.uri);
    if (!existing || version >= existing.version) {
      this.diagnostics.set(params.uri, { version, diagnostics: params.diagnostics });
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.uri !== params.uri) continue;
      if (version < waiter.version) continue;
      this.finish(waiter, { diagnostics: params.diagnostics, stale: false });
    }
  }

  /**
   * Resolve as soon as diagnostics for `uri` at `version` (or newer) arrive.
   * On timeout return the last known set with `stale: true`.
   */
  waitForDiagnostics(
    uri: string,
    version: number,
    timeoutMs = this.options.diagnosticsWaitMs,
  ): Promise<WaitedDiagnostics> {
    const known = this.diagnostics.get(uri);
    if (known && known.version >= version) {
      return Promise.resolve({ diagnostics: known.diagnostics, stale: false });
    }
    return new Promise<WaitedDiagnostics>((resolve) => {
      const waiter: Waiter = {
        uri,
        version,
        resolve,
        timer: undefined as unknown as NodeJS.Timeout,
      };
      waiter.timer = setTimeout(
        () => {
          this.finish(waiter, { diagnostics: known?.diagnostics ?? [], stale: true });
        },
        Math.max(0, timeoutMs),
      );
      this.waiters.add(waiter);
    });
  }

  getSymbols(uri: string, version: number): unknown[] | undefined {
    const cached = this.symbols.get(uri);
    return cached && cached.version === version ? cached.symbols : undefined;
  }

  setSymbols(uri: string, version: number, symbols: unknown[]): void {
    this.symbols.set(uri, { version, symbols });
  }

  private finish(waiter: Waiter, result: WaitedDiagnostics): void {
    if (!this.waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.resolve(result);
  }

  private evictIfNeeded(): void {
    while (this.documents.size > this.options.maxDocuments) {
      let oldest: OpenDocument | undefined;
      for (const document of this.documents.values()) {
        if (!oldest || document.lastUsed < oldest.lastUsed) oldest = document;
      }
      if (!oldest) return;
      this.close(oldest.uri);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
