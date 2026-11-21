<!-- SPDX-License-Identifier: Apache-2.0 -->

# nexus-ingest

Python FastAPI service — scrapes financial signals, analyses them, and pushes `IngestedEvent[]` to `@nexus/api`.

**Status:** Skeleton — implementation pending (M4).

## Queue boundary

Two queues share one Redis, and each stays in the language that owns its work.

Celery (Python) runs the ingest service's own heavy jobs: `index_document` chunks and embeds
documents, `crawl_url` fetches and extracts a page, `run_inference` makes long LLM calls, and a
beat job purges expired memory entries every six hours. They use the `nexus-python-index`,
`nexus-python-crawl` and `nexus-python-inference` queues with Redis as both broker and result
backend.

BullMQ (Node, `apps/worker`) runs everything the TypeScript side owns: `ingest:event`,
`browser.task`, `council.deliberate`, `agent.run` and the Drive lifecycle jobs, on the
`nexus-high`, `nexus-medium` and `nexus-low` queues. Python never registers a BullMQ worker; when
it has a finished event it publishes an `ingest:event` job through `queue.py`, which writes the
BullMQ job hash and wait list directly so the Node worker can pick it up.

Rule of thumb: a task belongs to Celery if it needs Python libraries (scraping, embeddings,
provider SDKs) and to BullMQ if it touches the API's data or services. Neither side polls the
other's queue.
