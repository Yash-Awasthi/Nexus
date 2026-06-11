import * as fs from "fs";
import { ILogger } from "./interfaces/logger.interface.js";

// ─── Log level ordering ────────────────────────────────────────────────────────

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVEL_RANK: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

function resolveMinLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "INFO").toUpperCase();
  if (raw in LEVEL_RANK) return raw as LogLevel;
  return "INFO";
}

// ─── StructuredLogger ─────────────────────────────────────────────────────────

export class StructuredLogger implements ILogger {
  private readonly minLevel: LogLevel;
  private readonly jsonMode: boolean;
  private readonly fileSink: fs.WriteStream | null;

  constructor() {
    this.minLevel = resolveMinLevel();
    this.jsonMode = (process.env.LOG_FORMAT ?? "").toLowerCase() === "json";

    const logFile = process.env.LOG_FILE;
    if (logFile) {
      try {
        this.fileSink = fs.createWriteStream(logFile, { flags: "a", encoding: "utf8" });
      } catch {
        this.fileSink = null;
      }
    } else {
      this.fileSink = null;
    }
  }

  private _passes(level: LogLevel): boolean {
    return LEVEL_RANK[level] >= LEVEL_RANK[this.minLevel];
  }

  private _format(level: LogLevel, message: string, extra?: any): string {
    const ts = new Date().toISOString();
    if (this.jsonMode) {
      return JSON.stringify({ ts, level, message, ...(extra !== undefined ? { context: extra } : {}) });
    }
    const ctx = extra !== undefined ? " " + JSON.stringify(extra) : "";
    return `${ts} [${level}] ${message}${ctx}`;
  }

  private _emit(level: LogLevel, line: string): void {
    switch (level) {
      case "DEBUG": console.debug(line); break;
      case "INFO":  console.log(line);   break;
      case "WARN":  console.warn(line);  break;
      case "ERROR": console.error(line); break;
    }
    if (this.fileSink) {
      this.fileSink.write(line + "\n");
    }
  }

  info(message: string, context?: any): void {
    if (!this._passes("INFO")) return;
    this._emit("INFO", this._format("INFO", message, context));
  }

  warn(message: string, context?: any): void {
    if (!this._passes("WARN")) return;
    this._emit("WARN", this._format("WARN", message, context));
  }

  error(message: string, error?: any, context?: any): void {
    if (!this._passes("ERROR")) return;
    const extra = error !== undefined || context !== undefined
      ? { ...(error !== undefined ? { error: error instanceof Error ? error.message : error } : {}), ...(context ?? {}) }
      : undefined;
    this._emit("ERROR", this._format("ERROR", message, extra));
  }

  debug(message: string, context?: any): void {
    if (!this._passes("DEBUG")) return;
    this._emit("DEBUG", this._format("DEBUG", message, context));
  }

  /** Flush and close the optional file sink. Safe to call multiple times. */
  close(): void {
    if (this.fileSink) {
      this.fileSink.end();
    }
  }
}

// ─── NullLogger ───────────────────────────────────────────────────────────────
// Swallows all log output — useful in tests and sandboxed agent contexts
// where console noise would pollute output or assertions.

export class NullLogger implements ILogger {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  info(_message: string, _context?: any): void { /* no-op */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  warn(_message: string, _context?: any): void { /* no-op */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  error(_message: string, _error?: any, _context?: any): void { /* no-op */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  debug(_message: string, _context?: any): void { /* no-op */ }
}
