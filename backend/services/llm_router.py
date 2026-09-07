"""
LLM Router Service — Inspired by LLM orchestration frameworks
Intelligent routing, load balancing, fallback chains, and cost optimization
"""

import time
import json
from typing import List, Dict, Optional, Tuple, Any
from dataclasses import dataclass, field
from enum import Enum
from collections import defaultdict
import hashlib


class ModelCapability(Enum):
    CHAT = "chat"
    COMPLETION = "completion"
    EMBEDDING = "embedding"
    VISION = "vision"
    CODE = "code"
    REASONING = "reasoning"


@dataclass
class LLMProvider:
    name: str
    models: List[str]
    cost_per_1k_input: float
    cost_per_1k_output: float
    rate_limit_rpm: int
    max_tokens: int
    capabilities: List[ModelCapability]
    priority: int = 0
    enabled: bool = True
    health_score: float = 1.0


@dataclass
class RoutingRequest:
    prompt: str
    required_capabilities: List[ModelCapability] = field(default_factory=list)
    max_cost: float = float('inf')
    max_latency_ms: float = float('inf')
    preferred_provider: Optional[str] = None
    fallback_allowed: bool = True
    cache_key: Optional[str] = None


@dataclass
class RoutingResponse:
    provider: str
    model: str
    latency_ms: float
    cost: float
    tokens_used: int
    cached: bool = False
    fallback_used: bool = False
    error: Optional[str] = None


@dataclass
class ProviderMetrics:
    total_requests: int = 0
    successful_requests: int = 0
    failed_requests: int = 0
    total_latency_ms: float = 0.0
    total_cost: float = 0.0
    avg_latency_ms: float = 0.0
    success_rate: float = 1.0
    last_error: Optional[str] = None
    last_error_time: Optional[float] = None


class LLMRouter:
    """Intelligent LLM routing with load balancing and fallback."""

    def __init__(self):
        self.providers: Dict[str, LLMProvider] = {}
        self.metrics: Dict[str, ProviderMetrics] = defaultdict(ProviderMetrics)
        self.request_cache: Dict[str, Any] = {}
        self.rate_limiters: Dict[str, List[float]] = defaultdict(list)
        self.cost_budget: float = float('inf')
        self.total_cost: float = 0.0

    def register_provider(self, provider: LLMProvider):
        self.providers[provider.name] = provider
        if provider.name not in self.metrics:
            self.metrics[provider.name] = ProviderMetrics()

    def route_request(self, request: RoutingRequest) -> RoutingResponse:
        if request.cache_key:
            cached = self._check_cache(request.cache_key)
            if cached:
                return RoutingResponse(
                    provider=cached['provider'],
                    model=cached['model'],
                    latency_ms=0,
                    cost=0,
                    tokens_used=cached['tokens'],
                    cached=True
                )
        candidates = self._find_candidates(request)
        if not candidates:
            return RoutingResponse(
                provider="none",
                model="none",
                latency_ms=0,
                cost=0,
                tokens_used=0,
                error="No suitable provider found"
            )
        for provider in candidates:
            if not self._check_rate_limit(provider.name):
                continue
            if not self._check_health(provider.name):
                continue
            estimated_cost = self._estimate_cost(provider, request)
            if estimated_cost > request.max_cost:
                continue
            model = self._select_model(provider, request)
            if not model:
                continue
            self._record_request(provider.name)
            return RoutingResponse(
                provider=provider.name,
                model=model,
                latency_ms=0,
                cost=estimated_cost,
                tokens_used=0,
                fallback_used=provider.name != (request.preferred_provider or "")
            )
        return RoutingResponse(
            provider="none",
            model="none",
            latency_ms=0,
            cost=0,
            tokens_used=0,
            error="All providers exhausted"
        )

    def _find_candidates(self, request: RoutingRequest) -> List[LLMProvider]:
        candidates = []
        for provider in self.providers.values():
            if not provider.enabled:
                continue
            if request.preferred_provider and provider.name == request.preferred_provider:
                candidates.insert(0, provider)
                continue
            if request.required_capabilities:
                if all(cap in provider.capabilities for cap in request.required_capabilities):
                    candidates.append(provider)
            else:
                candidates.append(provider)
        candidates.sort(key=lambda p: (-p.priority, -p.health_score))
        return candidates

    def _check_rate_limit(self, provider_name: str) -> bool:
        provider = self.providers.get(provider_name)
        if not provider:
            return False
        now = time.time()
        self.rate_limiters[provider_name] = [
            t for t in self.rate_limiters[provider_name] if now - t < 60
        ]
        return len(self.rate_limiters[provider_name]) < provider.rate_limit_rpm

    def _check_health(self, provider_name: str) -> bool:
        metrics = self.metrics[provider_name]
        if metrics.total_requests > 10 and metrics.success_rate < 0.5:
            return False
        if metrics.last_error_time and time.time() - metrics.last_error_time < 60:
            return False
        return True

    def _estimate_cost(self, provider: LLMProvider, request: RoutingRequest) -> float:
        estimated_tokens = len(request.prompt.split()) * 1.3
        input_cost = (estimated_tokens / 1000) * provider.cost_per_1k_input
        output_cost = (estimated_tokens * 0.5 / 1000) * provider.cost_per_1k_output
        return input_cost + output_cost

    def _select_model(self, provider: LLMProvider, request: RoutingRequest) -> Optional[str]:
        if not provider.models:
            return None
        for model in provider.models:
            if 'gpt-4' in model and ModelCapability.REASONING in request.required_capabilities:
                return model
        return provider.models[0] if provider.models else None

    def _check_cache(self, cache_key: str) -> Optional[Dict]:
        return self.request_cache.get(cache_key)

    def _record_request(self, provider_name: str):
        self.rate_limiters[provider_name].append(time.time())
        self.metrics[provider_name].total_requests += 1

    def record_success(self, provider_name: str, latency_ms: float, cost: float, tokens: int):
        metrics = self.metrics[provider_name]
        metrics.successful_requests += 1
        metrics.total_latency_ms += latency_ms
        metrics.total_cost += cost
        metrics.avg_latency_ms = metrics.total_latency_ms / metrics.successful_requests
        metrics.success_rate = metrics.successful_requests / metrics.total_requests
        self.total_cost += cost

    def record_failure(self, provider_name: str, error: str):
        metrics = self.metrics[provider_name]
        metrics.failed_requests += 1
        metrics.last_error = error
        metrics.last_error_time = time.time()
        if metrics.total_requests > 0:
            metrics.success_rate = metrics.successful_requests / metrics.total_requests

    def get_provider_rankings(self) -> List[Dict]:
        rankings = []
        for name, provider in self.providers.items():
            metrics = self.metrics[name]
            rankings.append({
                "name": name,
                "health_score": provider.health_score,
                "success_rate": metrics.success_rate,
                "avg_latency_ms": metrics.avg_latency_ms,
                "total_requests": metrics.total_requests,
                "total_cost": metrics.total_cost,
                "enabled": provider.enabled,
                "score": provider.health_score * metrics.success_rate
            })
        rankings.sort(key=lambda x: -x['score'])
        return rankings

    def get_cost_report(self) -> Dict:
        by_provider = {}
        for name, metrics in self.metrics.items():
            by_provider[name] = {
                "total_cost": metrics.total_cost,
                "avg_cost_per_request": metrics.total_cost / max(metrics.total_requests, 1),
                "request_count": metrics.total_requests
            }
        return {
            "total_cost": self.total_cost,
            "by_provider": by_provider,
            "budget_remaining": self.cost_budget - self.total_cost
        }

    def get_metrics(self) -> Dict:
        return {
            "providers": {
                name: {
                    "total_requests": m.total_requests,
                    "success_rate": m.success_rate,
                    "avg_latency_ms": m.avg_latency_ms,
                    "total_cost": m.total_cost,
                    "last_error": m.last_error
                }
                for name, m in self.metrics.items()
            },
            "total_cost": self.total_cost
        }

    # ---- Retry with exponential backoff (extracted from litellm) ----

    def retry_with_backoff(
        self,
        request: RoutingRequest,
        max_retries: int = 3,
        base_delay: float = 1.0,
        max_delay: float = 30.0,
        jitter: bool = True,
    ) -> RoutingResponse:
        """Route a request with retry-on-failure and exponential backoff.

        Extracted from litellm's retry/fallback pattern:
        - Try the preferred provider first
        - On failure, wait (exponential backoff + jitter) and retry
        - After max_retries, fall back to next available provider
        - Records each failure for health score updates
        """
        import random as _rng
        last_error = None
        for attempt in range(max_retries + 1):
            response = self.route_request(request)
            if not response.error:
                return response
            last_error = response.error
            # Record the failure
            if response.provider != "none":
                self.record_failure(response.provider, last_error)
            # Don't sleep on the last attempt
            if attempt < max_retries:
                delay = min(base_delay * (2 ** attempt), max_delay)
                if jitter:
                    delay = delay * (0.5 + _rng.random() * 0.5)
                time.sleep(delay)
            # On final retry, try fallback providers
            if attempt == max_retries and request.fallback_allowed:
                fallback_request = RoutingRequest(
                    prompt=request.prompt,
                    required_capabilities=request.required_capabilities,
                    max_cost=request.max_cost,
                    max_latency_ms=request.max_latency_ms,
                    preferred_provider=None,  # Clear preference to allow any provider
                    fallback_allowed=False,
                    cache_key=request.cache_key,
                )
                fallback_response = self.route_request(fallback_request)
                if not fallback_response.error:
                    fallback_response.fallback_used = True
                    return fallback_response
        return RoutingResponse(
            provider="none",
            model="none",
            latency_ms=0,
            cost=0,
            tokens_used=0,
            error=f"All retries exhausted: {last_error}",
        )
