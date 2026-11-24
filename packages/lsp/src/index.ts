// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/lsp — LSP framing, stdio transport and lifecycle.
 *
 * File map:
 * - src/config.ts     — `NEXUS_LSP_*` parsing and documented defaults (Appendix A.1).
 * - src/framing.ts    — LSP `Content-Length` encode and incremental decode.
 * - src/transport.ts  — spawn without a shell, JSON-RPC ids, pending map, stderr ring.
 * - src/client.ts     — initialize/initialized handshake, requests, graceful shutdown.
 * - src/languages.ts  — extension → language and per-language command lookup.
 * - src/documents.ts  — didOpen/didChange/didClose, LRU cap, diagnostics and symbol caches.
 * - src/containment.ts — root resolution and realpath file containment.
 * - src/manager.ts    — pool, idle/LRU/RSS/crash policy, manager API for the tools.
 * - src/testing/fake-server.mjs — fixture server; tests never need a real language server.
 * - src/index.ts      — exports only (this comment).
 *
 * The agent tools live in agent-core; the spawn authorize callback is supplied
 * by the API. This package imports no API, exec-policy or tool module.
 */

export {
  DEFAULT_LSP_CONFIG,
  parseLspConfig,
  splitCommand,
  type LspCommand,
  type LspConfig,
  type LspLogLevel,
} from "./config.ts";
export {
  FrameDecoder,
  LspFrameError,
  MAX_BODY_BYTES,
  MAX_HEADER_BYTES,
  encodeFrame,
  type LspFrameErrorCode,
} from "./framing.ts";
export {
  LspTransport,
  LspTransportError,
  type LspNotificationHandler,
  type LspTransportErrorCode,
  type LspTransportOptions,
} from "./transport.ts";
export {
  CHILD_ENV_NAMES,
  LspClient,
  createLspClient,
  minimalChildEnv,
  type LspClientOptions,
  type ServerCapabilities,
  type ServerInfo,
} from "./client.ts";
export {
  LANGUAGE_EXTENSIONS,
  commandForLanguage,
  languageForPath,
  type LspLanguage,
} from "./languages.ts";
export {
  DocumentSync,
  type DocumentSyncOptions,
  type PublishDiagnosticsParams,
  type WaitedDiagnostics,
} from "./documents.ts";
export {
  containFile,
  isWithin,
  resolveWorkspaceRoot,
  splitRootList,
  type ContainedFile,
  type ContainmentCode,
  type ContainmentRefusal,
  type ContainmentResult,
  type RootAvailable,
  type RootResolution,
  type RootResolverInput,
  type RootSource,
  type RootUnavailable,
} from "./containment.ts";
export {
  LspManagerImpl,
  MAX_DIAGNOSTICS,
  MAX_HOVER_BYTES,
  MAX_LOCATIONS,
  MAX_REFERENCES,
  MAX_SYMBOL_CHILDREN,
  createLspManager,
  type LspAuthorization,
  type LspAuthorize,
  type LspAuthorizeResult,
  type LspCodeAction,
  type LspCodeActionsInput,
  type LspCodeActionsResult,
  type LspDiagnostic,
  type LspDiagnosticsResult,
  type LspEdit,
  type LspEditResult,
  type LspFailure,
  type LspFileInput,
  type LspLocation,
  type LspLocationsResult,
  type LspManager,
  type LspManagerErrorCode,
  type LspManagerOptions,
  type LspManagerStatus,
  type LspPosition,
  type LspPositionInput,
  type LspRenameInput,
  type LspScheduler,
  type LspServerHealth,
  type LspServerStatus,
  type LspSpawnAction,
  type LspSymbol,
  type LspSymbolsResult,
  type LspWorkspaceSymbolsResult,
} from "./manager.ts";
