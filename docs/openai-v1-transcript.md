<!-- verified: c6e5d6c 2026-11-24 -->

# The OpenAI surface, as a client sees it

Recorded from a live server by
`apps/api/tests/routes/openai-v1-transcript.test.ts` over real HTTP with a bearer token.
Ids and `created`/`created_at`/`expires_at` readings are normalised; everything else is verbatim.
Regenerate with
`OPENAI_TRANSCRIPT=1 pnpm --filter @nexus/api exec vitest run tests/routes/openai-v1-transcript.test.ts`.

The OpenAI SDK is not a dependency of this repository, so these are plain HTTP calls with the
same request bodies and headers a client sends; the fields asserted are the ones the
specification documents for each object.

Two behaviours of this deployment show up below and are intentional: a repeated identical
request replays from the response cache with `usage` zeroed (a hit costs nothing upstream),
and a rejection is answered with OpenAI's `error` object rather than Nexus's own shape.

## GET /v1/models

Response: 200 (application/json; charset=utf-8)

```
{"object":"list","data":[{"id":"nexus/auto","object":"model","created": <unix-seconds>,"owned_by":"nexus"},{"id":"nexus/free","object":"model","created": <unix-seconds>,"owned_by":"nexus"},{"id":"freebie/calm:free","object":"model","created": <unix-seconds>,"owned_by":"freebie"},{"id":"harbor/tiny","object":"model","created": <unix-seconds>,"owned_by":"harbor"},{"id":"ollama/qwen2.5:7b","object":"model","created": <unix-seconds>,"owned_by":"ollama"}]}
```

## POST /v1/chat/completions

Request:

```json
{
  "model": "harbor/tiny",
  "messages": [
    {
      "role": "user",
      "content": "hello"
    }
  ]
}
```

Response: 200 (application/json; charset=utf-8)

```
{"id":"chatcmpl-<uuid>","object":"chat.completion","created": <unix-seconds>,"model":"harbor/tiny","choices":[{"index":0,"message":{"role":"assistant","content":"Hello from upstream"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}
```

## POST /v1/chat/completions

Request:

```json
{
  "model": "harbor/tiny",
  "stream": true,
  "messages": [
    {
      "role": "user",
      "content": "stream this back"
    }
  ]
}
```

Response: 200 (text/event-stream)

```
data: {"id":"chatcmpl-<uuid>","object":"chat.completion.chunk","created": <unix-seconds>,"model":"harbor/tiny","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-<uuid>","object":"chat.completion.chunk","created": <unix-seconds>,"model":"harbor/tiny","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}

data: {"id":"chatcmpl-<uuid>","object":"chat.completion.chunk","created": <unix-seconds>,"model":"harbor/tiny","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}

data: {"id":"chatcmpl-<uuid>","object":"chat.completion.chunk","created": <unix-seconds>,"model":"harbor/tiny","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]


```

## POST /v1/completions

Request:

```json
{
  "model": "harbor/tiny",
  "prompt": "finish this sentence"
}
```

Response: 200 (application/json; charset=utf-8)

```
{"id":"cmpl-<uuid>","object":"text_completion","created": <unix-seconds>,"model":"harbor/tiny","choices":[{"index":0,"text":"Hello from upstream","finish_reason":"stop","logprobs":null}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}
```

## POST /v1/embeddings

Request:

```json
{
  "model": "harbor/tiny",
  "input": "embed this"
}
```

Response: 200 (application/json; charset=utf-8)

```
{"object":"list","data":[{"object":"embedding","index":0,"embedding":[0.1,0.2]}],"model":"harbor/tiny","usage":{"prompt_tokens":2,"total_tokens":2}}
```

## POST /v1/files

Request:

```json
<multipart body>
```

Response: 200 (application/json; charset=utf-8)

```
{"id":"file-9e7a5819828642e2a7b63d01644a720f","bytes":18,"created_at": <unix-seconds>,"filename":"input.jsonl","purpose":"batch","object":"file","status":"processed"}
```

## GET /v1/files

Response: 200 (application/json; charset=utf-8)

```
{"object":"list","data":[{"id":"file-9e7a5819828642e2a7b63d01644a720f","bytes":18,"created_at": <unix-seconds>,"filename":"input.jsonl","purpose":"batch","object":"file","status":"processed"}]}
```

## GET /v1/files/file-9e7a5819828642e2a7b63d01644a720f/content

Response: 200 (application/octet-stream)

```
{"custom_id":"1"}

```

## DELETE /v1/files/file-9e7a5819828642e2a7b63d01644a720f

Response: 200 (application/json; charset=utf-8)

```
{"id":"file-9e7a5819828642e2a7b63d01644a720f","object":"file","deleted":true}
```

## POST /v1/chat/completions

Request:

```json
{
  "model": "harbor/tiny",
  "messages": [
    {
      "role": "user",
      "content": "repeat me"
    }
  ]
}
```

Response: 200 (application/json; charset=utf-8)

```
{"id":"chatcmpl-<uuid>","object":"chat.completion","created": <unix-seconds>,"model":"harbor/tiny","choices":[{"index":0,"message":{"role":"assistant","content":"Hello from upstream"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}
```

## POST /v1/chat/completions

Request:

```json
{
  "model": "harbor/tiny",
  "messages": [
    {
      "role": "user",
      "content": "repeat me"
    }
  ]
}
```

Response: 200 (application/json; charset=utf-8)

```
{"id":"chatcmpl-<uuid>","object":"chat.completion","created": <unix-seconds>,"model":"harbor/tiny","choices":[{"index":0,"message":{"role":"assistant","content":"Hello from upstream"},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}
```

## POST /v1/chat/completions

Request:

```json
{
  "model": "harbor/tiny"
}
```

Response: 400 (application/json; charset=utf-8)

```
{"error":{"message":"model and messages are required","type":"invalid_request_error","code":null}}
```
