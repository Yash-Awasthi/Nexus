# Documentation

All project documents live here; the repository root keeps only `README.md` as the
entry point and the code. Every file in this folder is indexed below.

| Document                                                             | Purpose                                                                                          | Status                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| [`README.md`](README.md)                                             | This index.                                                                                      | Active                                          |
| [`mission.txt`](mission.txt)                                         | Acceptance mission: what "done" means for this repository.                                       | Active                                          |
| [`SRS_Agent_Board_v3.0.md`](SRS_Agent_Board_v3.0.md)                 | Authoritative requirements (FR-1..FR-7, ABP/1.0 protocol).                                       | Active                                          |
| [`ARCHITECTURE.md`](ARCHITECTURE.md)                                 | System architecture, file layout, credentials, snapshot format.                                  | Active                                          |
| [`PLAN.md`](PLAN.md)                                                 | Phase 6 delivery: real-agent harness, Mission Control inspector, evidence, external-only checks. | Complete                                        |
| [`claude_desktop_config.json`](claude_desktop_config.json)           | Ready-to-merge Claude Desktop MCP server entry.                                                  | Active                                          |
| [`SRS_Agent_Board_v2.0.md`](SRS_Agent_Board_v2.0.md)                 | Earlier requirements revision.                                                                   | Superseded by v3.0                              |
| [`SRS_Agent_Board_v1.0.md`](SRS_Agent_Board_v1.0.md)                 | Earlier requirements revision (numbered NFR-1..NFR-5).                                           | Superseded by v3.0; its NFRs are still measured |
| [SRS Agent Board (draft v0.1).md](<SRS Agent Board (draft v0.1).md>) | First draft.                                                                                     | Historical                                      |

`board/` and `sources/` are vendored reference repositories, not project documentation.

Link and reference integrity is checked by `bash scripts/check-docs.sh`.
