<!-- SPDX-License-Identifier: Apache-2.0 -->

# Proposal: LSP-backed code intelligence

**Status:** proposed, not scheduled. This is not migration work and is deliberately not part of
`plan.md`.

## Why

Agents currently read code and search it with grep. They cannot ask where a symbol is defined, who
references it, or what the type checker thinks of an edit before running tests. A Language Server
Protocol client would give missions and the code agent that feedback in every supported language,
and would let a review step report real diagnostics instead of guessing.

## Shape

- A `@nexus/lsp` package with a stdio JSON-RPC client, one server process per language per
  workspace, an idle timeout, and caps on process count and memory.
- Agent tools in `@nexus/agent-core`: definition, references, hover, diagnostics, and document
  symbols. These are read-only, so they belong in `AUTO_ALLOWED_TOOLS`; a rename or code action
  would be `requires_permission`.
- Workspace root comes from the tool context. Paths outside it are rejected, matching the
  filesystem tools' boundary.
- Each tool call gets the existing `tool.call` span, so LSP latency and failures show up in traces.

## Non-goals

- Editor integration, or implementing a language server.
- Installing or managing servers automatically on the host.
- Replacing `grep` and file reads; LSP complements them.

## Open questions

- Which servers ship first: `typescript-language-server`, `pyright`, `gopls`, `rust-analyzer`?
- One server per session, or a shared pool keyed by workspace and language?
- How to refresh diagnostics after an edit without a full workspace re-index?
