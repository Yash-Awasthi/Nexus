# SPDX-License-Identifier: Apache-2.0
"""
GhostStack local inference bridge.

Runs large language models (up to 70B+) on consumer GPUs via layer-by-layer
sharded inference. No quantization required — achieves 70B inference on 4GB VRAM.
Exposed as a local FastAPI server on port 7703.

Endpoints:
  POST /generate     — text generation (single prompt)
  POST /chat         — chat-style generation (messages array)
  GET  /models       — list downloaded/available models
  GET  /health       — liveness probe (includes GPU availability)
"""

from __future__ import annotations

import argparse
import traceback
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

# ── Conditional imports ───────────────────────────────────────────────────────
try:
    from airllm import AutoModel
    _LOCAL_INFERENCE_AVAILABLE = True
except ImportError:
    _LOCAL_INFERENCE_AVAILABLE = False

try:
    import torch
    _TORCH_AVAILABLE = True
    _CUDA_AVAILABLE = torch.cuda.is_available()
    _MPS_AVAILABLE = getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()
except ImportError:
    _TORCH_AVAILABLE = False
    _CUDA_AVAILABLE = False
    _MPS_AVAILABLE = False

app = FastAPI(title="local-inference-bridge", version="1.0.0")

# Global model cache — load once, reuse
_loaded_models: dict[str, Any] = {}


# ── Request/response models ───────────────────────────────────────────────────

class GenerateRequest(BaseModel):
    model: str = Field(description="HuggingFace model ID or local path")
    prompt: str
    max_new_tokens: int = Field(default=200, ge=1, le=2048)
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    top_p: float = Field(default=0.9, ge=0.0, le=1.0)
    compression: str | None = Field(default=None, description="'4bit' or '8bit' for quantized inference")

class ChatMessage(BaseModel):
    role: str  # "system" | "user" | "assistant"
    content: str

class ChatRequest(BaseModel):
    model: str
    messages: list[ChatMessage]
    max_new_tokens: int = Field(default=300, ge=1, le=2048)
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    compression: str | None = None

class GenerateResponse(BaseModel):
    success: bool
    text: str = ""
    model: str = ""
    tokens_generated: int = 0
    error: str = ""


# ── Helpers ────────────────────────────────────────────────────────────────────

def _get_device() -> str:
    if _CUDA_AVAILABLE:
        return "cuda:0"
    if _MPS_AVAILABLE:
        return "mps"
    return "cpu"

def _load_model(model_id: str, compression: str | None = None) -> Any:
    cache_key = f"{model_id}:{compression}"
    if cache_key in _loaded_models:
        return _loaded_models[cache_key]

    if not _LOCAL_INFERENCE_AVAILABLE:
        raise RuntimeError("Local inference engine not installed. Run: pip install airllm")

    device = _get_device()
    model = AutoModel.from_pretrained(
        model_id,
        device=device,
        compression=compression,
    )
    _loaded_models[cache_key] = model
    return model

def _messages_to_prompt(messages: list[ChatMessage]) -> str:
    """Format chat messages as a simple prompt string for models without chat template."""
    parts = []
    for msg in messages:
        if msg.role == "system":
            parts.append(f"System: {msg.content}")
        elif msg.role == "user":
            parts.append(f"User: {msg.content}")
        elif msg.role == "assistant":
            parts.append(f"Assistant: {msg.content}")
    parts.append("Assistant:")
    return "\n".join(parts)


# ── Routes ─────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "local_inference_available": _LOCAL_INFERENCE_AVAILABLE,
        "torch_available": _TORCH_AVAILABLE,
        "cuda_available": _CUDA_AVAILABLE,
        "mps_available": _MPS_AVAILABLE,
        "device": _get_device(),
        "loaded_models": list(_loaded_models.keys()),
    }


@app.get("/models")
async def list_models():
    return {"loaded": list(_loaded_models.keys())}


@app.post("/generate", response_model=GenerateResponse)
async def generate(req: GenerateRequest):
    if not _LOCAL_INFERENCE_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="Local inference engine not installed. Run: pip install airllm"
        )
    try:
        model = _load_model(req.model, req.compression)

        input_text = req.prompt
        input_tokens = model.tokenizer(
            input_text,
            return_tensors="pt",
            truncation=True,
            max_length=model.max_seq_len
        )

        generation_output = model.generate(
            input_tokens["input_ids"].cuda() if _CUDA_AVAILABLE else input_tokens["input_ids"],
            max_new_tokens=req.max_new_tokens,
            use_cache=True,
            return_dict_in_generate=True,
        )

        generated_ids = generation_output.sequences[0][input_tokens["input_ids"].shape[1]:]
        output_text = model.tokenizer.decode(generated_ids, skip_special_tokens=True)

        return GenerateResponse(
            success=True,
            text=output_text,
            model=req.model,
            tokens_generated=len(generated_ids),
        )
    except Exception:
        return GenerateResponse(success=False, model=req.model, error=traceback.format_exc())


@app.post("/chat", response_model=GenerateResponse)
async def chat(req: ChatRequest):
    if not _LOCAL_INFERENCE_AVAILABLE:
        raise HTTPException(status_code=503, detail="Local inference engine not installed")
    try:
        model = _load_model(req.model, req.compression)

        # Try chat template first, fall back to manual formatting
        try:
            if hasattr(model.tokenizer, "apply_chat_template"):
                messages_dicts = [{"role": m.role, "content": m.content} for m in req.messages]
                input_text = model.tokenizer.apply_chat_template(
                    messages_dicts,
                    tokenize=False,
                    add_generation_prompt=True
                )
            else:
                input_text = _messages_to_prompt(req.messages)
        except Exception:
            input_text = _messages_to_prompt(req.messages)

        input_tokens = model.tokenizer(
            input_text,
            return_tensors="pt",
            truncation=True,
            max_length=model.max_seq_len
        )

        generation_output = model.generate(
            input_tokens["input_ids"].cuda() if _CUDA_AVAILABLE else input_tokens["input_ids"],
            max_new_tokens=req.max_new_tokens,
            use_cache=True,
            return_dict_in_generate=True,
        )

        generated_ids = generation_output.sequences[0][input_tokens["input_ids"].shape[1]:]
        output_text = model.tokenizer.decode(generated_ids, skip_special_tokens=True)

        return GenerateResponse(
            success=True,
            text=output_text,
            model=req.model,
            tokens_generated=len(generated_ids),
        )
    except Exception:
        return GenerateResponse(success=False, model=req.model, error=traceback.format_exc())


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=7703)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
