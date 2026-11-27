<!-- verified: 8065a84 2026-11-25 -->

# Support matrix

What this release is tested on, on what, and which model backends it talks to without a local patch. The block
below is **checked by CI**: `scripts/support-matrix.test.mjs` reads it and compares it to `package.json` `engines`,
the `build.yml` matrix, the Dockerfiles' base image, and the provider names the LLM driver registry exports. If they
disagree, the build fails — a support matrix that drifts from the build is a marketing page.

```json nexus-support-matrix
{
  "node": ["24", "26"],
  "os": ["ubuntu-latest", "macos-latest"],
  "docker": { "base": "node:26-alpine", "distro": "alpine" },
  "localRuntimes": ["node"],
  "modelBackends": [
    "anthropic",
    "groq",
    "deepseek",
    "mistral",
    "openrouter",
    "gemini",
    "ollama",
    "lmstudio",
    "llamacpp",
    "fireworks",
    "nvidia_nim",
    "cerebras",
    "kimi",
    "codestral",
    "xai",
    "together",
    "perplexity",
    "cohere",
    "zhipu",
    "moonshot",
    "openai",
    "azure_openai",
    "vertex",
    "bedrock"
  ]
}
```

## What that means

| Dimension          | Supported                           | Notes                                                                                                                                                                                                                  |
| ------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node**           | 24 (LTS) and 26                     | `engines` requires ≥24; both are built and tested on every push. Node 22 is not tested and not claimed.                                                                                                                |
| **OS**             | Linux (Ubuntu), macOS               | Both are in the CI matrix. **Windows is not in the matrix**: the desktop app is built for Windows, but the server is not tested there, and this table says so rather than implying parity.                             |
| **Container**      | `node:26-alpine`                    | Pinned by digest in every Dockerfile. `alpine` means musl, which is why native modules are built in the image rather than copied from a glibc host.                                                                    |
| **Model backends** | the list above                      | Provider ids as the driver registry spells them (`nvidia_nim`, `zeroone`), not as their marketing names. Local backends (`ollama`, `lmstudio`, `llamacpp`) need no key — that is the "no paid API required" invariant. |
| **Database**       | Postgres 16 + pgvector              | Embedded pglite runs the same migrations in tests; the service container in `test.yml` is `postgres:16`.                                                                                                               |
| **KV**             | Redis 7, or the in-process fallback | The fallback is tested; production semantics (TTL, durability across restarts) assume Redis.                                                                                                                           |

## Not supported, on purpose

- **Node < 24.** Two minors of cover is the promise; older runtimes are not tested and the `engines` field will
  refuse them at install.
- **Windows as a server host.** The CLI and desktop app run there; the API is tested on Linux and macOS only.
- **Provider ids not in the list.** Adding one is a driver plus a row in this file plus a test that it is a real
  provider — not a config value.
