#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""
local_inference_bridge.py — GhostStack local LLM inference bridge (port 7703).

Runs large language models locally via AirLLM, which streams model layers
from disk — enabling 70B+ parameter models on consumer hardware with as
little as 4 GB VRAM by never holding all weights in memory simultaneously.

The bridge is model-agnostic: pass the model name per-request; models are
loaded on first use and their AirLLM instances are cached for the lifetime
of the process (thread-safe).

Endpoints
---------
GET  /health    — liveness probe; reports GPU availability and loaded models
POST /generate  — prompt → generated text
POST /chat      — messages array (OpenAI-compatible format) → assistant reply

Dependencies
------------
    pip install fastapi uvicorn airllm torch

Optional (4-bit / 8-bit quantisation on top of AirLLM layer-streaming):
    pip install bitsandbytes

Environment
-----------
    AIRLLM_LAYER_CACHE   Disk path for layer-shard cache
                         (default: ~/.cache/airllm)
    HF_HOME              HuggingFace model download root
                         (inherited by AirLLM from the transformers ecosystem)

If airllm / torch are absent the server still starts; all inference
requests return {"success": false, "error": "airllm not available …"}.
"""
from __future__ import annotations

import argparse
import logging
import os
import threading
from typing import Any

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logger = logging.getLogger("local_inference_bridge")
logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(name)s  %(message)s")


def _sanitize_log(val: Any) -> str:
    """Strip newlines/control chars from user-supplied values before logging."""
    return str(val).replace("\n", "\\n").replace("\r", "\\r").replace("\0", "")[:500]


# ---------------------------------------------------------------------------
# Optional deps
# ---------------------------------------------------------------------------

try:
    import torch  # type: ignore[import]
    from airllm import AutoModel  # type: ignore[import]

    AIRLLM_AVAILABLE = True
    HAS_GPU = torch.cuda.is_available()
    logger.info("AirLLM loaded — GPU available: %s", HAS_GPU)
except ImportError:
    AIRLLM_AVAILABLE = False
    HAS_GPU = False
    logger.warning(
        "airllm / torch not installed — inference requests will return errors. "
        "Run: pip install airllm torch"
    )

# ---------------------------------------------------------------------------
# Model cache — keyed by (model_name, compression)
# ---------------------------------------------------------------------------

_model_cache: dict[str, Any] = {}
_cache_lock = threading.Lock()

# AirLLM streams layer shards from this directory to keep RAM/VRAM bounded.
_LAYER_CACHE_DIR: str = os.environ.get(
    "AIRLLM_LAYER_CACHE", os.path.expanduser("~/.cache/airllm")
)

# Conservative upper bound so single-request context never blows up VRAM.
_MAX_CONTEXT_TOKENS: int = 512


def _get_model(model_name: str, compression: str | None) -> Any:
    """
    Return a cached AirLLM AutoModel, loading from HuggingFace on first call.

    AirLLM splits the model into per-layer shards that are streamed from disk
    during inference — the GPU only holds one layer at a time.  Compression
    ('4bit' or '8bit') reduces shard size further via bitsandbytes.
    """
    cache_key = f"{model_name}:{compression}"
    with _cache_lock:
        if cache_key not in _model_cache:
            os.makedirs(_LAYER_CACHE_DIR, exist_ok=True)

            kwargs: dict[str, Any] = {"pretrained_model_name_or_path": model_name}
            if compression in ("4bit", "8bit"):
                kwargs["compression"] = compression
                logger.info(
                    "Loading %s with %s quantisation (VRAM-efficient) …",
                    _sanitize_log(model_name),
                    compression,
                )
            else:
                logger.info("Loading %s (no extra quantisation) …", _sanitize_log(model_name))

            model = AutoModel.from_pretrained(**kwargs)
            _model_cache[cache_key] = model
            logger.info("Model %s ready", _sanitize_log(model_name))

        return _model_cache[cache_key]


def _device(tensor: Any) -> Any:
    """Move a tensor to GPU if available, otherwise keep on CPU."""
    if HAS_GPU:
        return tensor.cuda()
    return tensor


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class GenerateRequest(BaseModel):
    model: str = "meta-llama/Llama-3.2-3B-Instruct"
    prompt: str = ""
    max_new_tokens: int = 200
    compression: str | None = None  # "4bit" | "8bit" | null


class ChatMessage(BaseModel):
    role: str       # system | user | assistant
    content: str


class ChatRequest(BaseModel):
    model: str = "meta-llama/Llama-3.2-3B-Instruct"
    messages: list[ChatMessage] = []
    max_new_tokens: int = 200
    compression: str | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _decode_output(generation_output: Any, tokenizer: Any) -> tuple[str, int]:
    """
    Decode AirLLM generation output to (text, token_count).

    AirLLM exposes only the new tokens via `sequences_output`; fall back to
    the full `sequences` attribute for compatibility with future API changes.
    """
    seqs = getattr(generation_output, "sequences_output", None)
    if seqs is None:
        seqs = generation_output.sequences
    token_ids = seqs[0]
    text: str = tokenizer.decode(token_ids, skip_special_tokens=True)
    return text, int(len(token_ids))


def _apply_chat_template(messages: list[dict[str, str]], tokenizer: Any) -> str:
    """
    Build a prompt string from an OpenAI-style messages list.

    Uses the tokenizer's built-in `apply_chat_template` when available
    (Llama-3, Mistral-Instruct, etc.); falls back to a minimal role-tag
    format that works with most open-weight instruction models.
    """
    if hasattr(tokenizer, "apply_chat_template") and getattr(
        tokenizer, "chat_template", None
    ):
        return tokenizer.apply_chat_template(  # type: ignore[no-any-return]
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )
    # Naive fallback
    parts: list[str] = []
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        parts.append(f"<|{role}|>\n{content}")
    parts.append("<|assistant|>")
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------


def create_app() -> FastAPI:
    app = FastAPI(
        title="GhostStack Local Inference Bridge",
        description="AirLLM-backed local LLM inference (layer-streaming, VRAM-efficient)",
        version="2.0.0",
    )

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "backend": "airllm",
            "airllm_available": AIRLLM_AVAILABLE,
            "gpu": HAS_GPU,
            "loaded_models": list(_model_cache.keys()),
            "layer_cache_dir": _LAYER_CACHE_DIR,
        }

    @app.post("/generate")
    async def generate(req: GenerateRequest) -> JSONResponse:
        if not AIRLLM_AVAILABLE:
            return JSONResponse({
                "success": False,
                "text": "",
                "model": req.model,
                "tokens_generated": 0,
                "error": "airllm not available — run: pip install airllm torch",
            })
        try:
            model = _get_model(req.model, req.compression)
            tokenizer = model.tokenizer

            input_tokens = tokenizer(
                [req.prompt],
                return_tensors="pt",
                return_attention_mask=False,
                truncation=True,
                max_length=_MAX_CONTEXT_TOKENS,
                padding=False,
            )
            generation_output = model.generate(
                _device(input_tokens["input_ids"]),
                max_new_tokens=req.max_new_tokens,
                use_cache=True,
                return_dict_in_generate=True,
            )
            text, n_tokens = _decode_output(generation_output, tokenizer)
            return JSONResponse({
                "success": True,
                "text": text,
                "model": req.model,
                "tokens_generated": n_tokens,
                "error": "",
            })
        except Exception as exc:
            logger.error("generate error: %s", exc)
            return JSONResponse({
                "success": False,
                "text": "",
                "model": req.model,
                "tokens_generated": 0,
                "error": "Inference failed — check server logs",
            })

    @app.post("/chat")
    async def chat(req: ChatRequest) -> JSONResponse:
        if not AIRLLM_AVAILABLE:
            return JSONResponse({
                "success": False,
                "text": "",
                "model": req.model,
                "tokens_generated": 0,
                "error": "airllm not available — run: pip install airllm torch",
            })
        try:
            model = _get_model(req.model, req.compression)
            tokenizer = model.tokenizer

            msgs = [{"role": m.role, "content": m.content} for m in req.messages]
            prompt = _apply_chat_template(msgs, tokenizer)

            input_tokens = tokenizer(
                [prompt],
                return_tensors="pt",
                return_attention_mask=False,
                truncation=True,
                max_length=_MAX_CONTEXT_TOKENS,
                padding=False,
            )
            generation_output = model.generate(
                _device(input_tokens["input_ids"]),
                max_new_tokens=req.max_new_tokens,
                use_cache=True,
                return_dict_in_generate=True,
            )
            text, n_tokens = _decode_output(generation_output, tokenizer)
            return JSONResponse({
                "success": True,
                "text": text,
                "model": req.model,
                "tokens_generated": n_tokens,
                "error": "",
            })
        except Exception as exc:
            logger.error("chat error: %s", exc)
            return JSONResponse({
                "success": False,
                "text": "",
                "model": req.model,
                "tokens_generated": 0,
                "error": "Inference failed — check server logs",
            })

    return app


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    import uvicorn  # type: ignore[import]

    parser = argparse.ArgumentParser(
        description="GhostStack local inference bridge (AirLLM backend)"
    )
    parser.add_argument(
        "--port", type=int, default=7703, help="Listen port (default: 7703)"
    )
    parser.add_argument(
        "--host", default="127.0.0.1", help="Listen host (default: 127.0.0.1)"
    )
    args = parser.parse_args()

    logger.info(
        "Starting AirLLM inference bridge on %s:%d  [layer-cache: %s]",
        args.host,
        args.port,
        _LAYER_CACHE_DIR,
    )
    uvicorn.run(create_app(), host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
