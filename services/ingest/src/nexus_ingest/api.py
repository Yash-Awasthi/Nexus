# SPDX-License-Identifier: Apache-2.0
"""FastAPI application skeleton — implementation pending (M4)."""
from fastapi import FastAPI

app = FastAPI(title="nexus-ingest", version="0.0.0")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "version": "0.0.0"}
