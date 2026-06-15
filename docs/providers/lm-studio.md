# LM Studio Provider — Setup Guide

LM Studio lets you run open-weight models (Llama, Mistral, Phi, Gemma, …) locally
with a built-in OpenAI-compatible API server.  Nexus routes to it via `LMStudioDriver`
when `LM_STUDIO_BASE_URL` is set.

---

## 1 — Install LM Studio

Download from <https://lmstudio.ai> (macOS / Windows / Linux).

---

## 2 — Start the local server

1. Open LM Studio → **Local Server** tab (⌘L / Ctrl+L).
2. Select a model (e.g. `lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF`).
3. Click **Start Server**.  Default endpoint: `http://localhost:1234`.

LM Studio exposes a subset of the OpenAI Chat Completions API at:

```
POST http://localhost:1234/v1/chat/completions
GET  http://localhost:1234/v1/models
```

---

## 3 — Wire into Nexus API

Add to your `.env` (or `k8s/api-secret.yaml`):

```env
# LM Studio local server
LM_STUDIO_BASE_URL=http://localhost:1234
```

No API key is required — LM Studio accepts requests without authentication.

Once the env var is set, `LMStudioDriver` is automatically registered in the
`DriverRegistry` inside `gateway.ts` and the `nexus/local` alias points at it.

---

## 4 — Model aliases

| Nexus alias      | Resolved backend                       |
|------------------|----------------------------------------|
| `nexus/local`    | `ollama/llama3.2`  *(default)*        |
| Custom alias     | Set `x-nexus-provider: lmstudio` and  |
|                  | pass any model name loaded in LM Studio |

To override the provider per-request:

```http
POST /api/v1/gateway/messages
x-nexus-provider: lmstudio
Content-Type: application/json

{
  "model": "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF",
  "messages": [{ "role": "user", "content": "Hello!" }],
  "max_tokens": 512
}
```

---

## 5 — Docker Compose (optional)

If you want to run LM Studio's CLI backend (`lms`) alongside the Nexus stack:

```yaml
# docker-compose.lm-studio.yml  (append to main docker-compose.yml services)
services:
  lm-studio:
    image: ghcr.io/lmstudio-ai/lmstudio-cli:latest   # unofficial — check releases
    ports:
      - "1234:1234"
    volumes:
      - lm_studio_models:/root/.cache/lm-studio
    environment:
      - LMS_MODEL=lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF

volumes:
  lm_studio_models:
```

Then set `LM_STUDIO_BASE_URL=http://lm-studio:1234` in `apps/api/.env`.

---

## 6 — Recommended models

| Use case               | Model                                              | VRAM  |
|------------------------|----------------------------------------------------|-------|
| Fast / low-latency     | `Phi-3.5-mini-instruct-GGUF` (Q4_K_M)             | ~3 GB |
| Balanced               | `Meta-Llama-3.1-8B-Instruct-GGUF` (Q4_K_M)        | ~5 GB |
| Code generation        | `Qwen2.5-Coder-7B-Instruct-GGUF` (Q4_K_M)         | ~5 GB |
| High quality           | `Meta-Llama-3.1-70B-Instruct-GGUF` (Q4_K_M)       | ~40 GB|

---

## 7 — Verifying connectivity

```bash
# Health check — should return {"status":"ok"}
curl http://localhost:3000/health

# LM Studio via gateway (with NEXUS_API_KEY=dev)
curl -X POST http://localhost:3000/api/v1/gateway/messages \
  -H "Authorization: Bearer dev" \
  -H "Content-Type: application/json" \
  -H "x-nexus-provider: lmstudio" \
  -d '{"model":"lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF","messages":[{"role":"user","content":"ping"}],"max_tokens":16}'
```

---

## 8 — Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Provider "lmstudio" is not configured` | Set `LM_STUDIO_BASE_URL` env var and restart the API |
| `ECONNREFUSED 127.0.0.1:1234` | Start the LM Studio server (step 2) |
| Slow first token | Model is being loaded into VRAM — normal on first request |
| Out-of-memory / SIGKILL | Reduce context window in LM Studio settings or use smaller model |
| `model not found` error | Verify the exact model filename matches what LM Studio reports at `GET /v1/models` |
