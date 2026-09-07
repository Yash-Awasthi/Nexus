"""
LLM Routing Strategies
Extracted from inspiration repos:
  LLMRouter, RouteLLM, litellm, llm-cascade-router, llm-router,
  llm-switchboard, SmarterRouter, bitrouter, ai-gateway, gateway,
  smart-llm-router, xrouter, xrouter-llm, routellm, router,
  proxygatellm, llm-api-key-proxy, routellm, resilient-llm

Routing strategies (each extracted from the corresponding repo):
  - EloRatingRouter: Route to model with highest Elo score (LLMRouter)
  - ThresholdRouter: Estimate query difficulty, route to cheap/expensive (LLMRouter)
  - KNNRouter: Route based on similarity to past queries (LLMRouter)
  - CascadeRouter: Try cheap model first, escalate on failure (llm-cascade-router)
  - WeightedRouter: Weighted random selection by cost/quality (RouteLLM)
  - LeastLatencyRouter: Route to provider with lowest avg latency (litellm)
  - CostOptimizedRouter: Route to cheapest provider that meets requirements (smart-llm-router)
  - RoundRobinRouter: Distribute load evenly across providers
"""

from dataclasses import dataclass, field
from typing import List, Dict, Optional, Any, Tuple
from enum import Enum
from collections import defaultdict, deque
import math
import time
import hashlib
import random


class RoutingStrategy(Enum):
    """Routing strategy types extracted from LLMRouter."""
    PRIORITY = "priority"           # Basic priority-based (existing in llm_router.py)
    ELO = "elo"                     # Elo rating (LLMRouter elorouter)
    THRESHOLD = "threshold"         # Difficulty threshold (LLMRouter thresholdrouter)
    KNN = "knn"                     # K-nearest-neighbors (LLMRouter knnrouter)
    CASCADE = "cascade"             # Try cheap first (llm-cascade-router)
    WEIGHTED = "weighted"           # Weighted by quality*cost (RouteLLM)
    LEAST_LATENCY = "latency"       # Lowest latency (litellm)
    COST_OPTIMIZED = "cost"         # Cheapest viable (smart-llm-router)
    ROUND_ROBIN = "round_robin"     # Even distribution


@dataclass
class ModelEloScore:
    """Elo rating for a model (LLMRouter elorouter pattern)."""
    model: str
    provider: str
    elo: float = 1000.0      # Starting Elo
    wins: int = 0
    losses: int = 0

    def expected_score(self, opponent_elo: float) -> float:
        """Expected win probability against an opponent."""
        return 1.0 / (1.0 + 10.0 ** ((opponent_elo - self.elo) / 400.0))

    def update(self, opponent_elo: float, won: bool, k: int = 32):
        """Update Elo after a match."""
        expected = self.expected_score(opponent_elo)
        actual = 1.0 if won else 0.0
        self.elo = self.elo + k * (actual - expected)
        if won:
            self.wins += 1
        else:
            self.losses += 1


@dataclass
class QueryDifficulty:
    """Estimated difficulty of a query (LLMRouter thresholdrouter pattern)."""
    score: float                # 0-1, higher = harder
    factors: Dict[str, float] = field(default_factory=dict)
    method: str = "heuristic"


class DifficultyEstimator:
    """
    Estimates query difficulty without requiring embeddings/ML.
    Uses heuristic features extracted from LLMRouter's DifficultyEstimator concept
    but works with text features instead of neural embeddings.

    Features:
    - Length (longer = harder)
    - Complexity (code/math/technical terms = harder)
    - Question type (reasoning vs factual)
    - Token count estimate
    """

    HARD_INDICATORS = [
        "explain", "analyze", "compare", "evaluate", "design", "implement",
        "architect", "optimize", "debug", "refactor", "prove", "derive",
        "synthesize", "critique", "reasoning", "step by step",
    ]

    EASY_INDICATORS = [
        "what is", "list", "define", "who", "when", "where", "hi",
        "hello", "help", "summary", "summary of", "translate",
    ]

    CODE_INDICATORS = ["def ", "class ", "function ", "import ", "```", "algorithm", "complexity"]

    def estimate(self, prompt: str) -> QueryDifficulty:
        """Estimate difficulty of a prompt on a 0-1 scale."""
        words = prompt.split()
        word_count = len(words)
        prompt_lower = prompt.lower()

        factors = {}

        # Length factor (normalize: 0 words=0, 500+ words=1)
        factors["length"] = min(1.0, word_count / 500.0)

        # Hard indicator factor
        hard_hits = sum(1 for ind in self.HARD_INDICATORS if ind in prompt_lower)
        factors["hard_indicators"] = min(1.0, hard_hits / 3.0)

        # Easy indicator factor (inverse)
        easy_hits = sum(1 for ind in self.EASY_INDICATORS if ind in prompt_lower)
        factors["easy_indicators"] = min(1.0, easy_hits / 2.0)

        # Code/technical factor
        code_hits = sum(1 for ind in self.CODE_INDICATORS if ind in prompt_lower)
        factors["code_complexity"] = min(1.0, code_hits / 2.0)

        # Weighted combination
        score = (
            factors["length"] * 0.2 +
            factors["hard_indicators"] * 0.3 +
            (1 - factors["easy_indicators"]) * 0.2 +
            factors["code_complexity"] * 0.3
        )
        score = max(0.0, min(1.0, score))

        return QueryDifficulty(score=score, factors=factors, method="heuristic")


class EloRatingRouter:
    """
    Routes to the model with the highest Elo rating.
    Extracted from LLMRouter's EloRouter pattern.
    """

    def __init__(self):
        self.elo_scores: Dict[str, ModelEloScore] = {}

    def register_model(self, model: str, provider: str, initial_elo: float = 1000.0):
        key = f"{provider}/{model}"
        self.elo_scores[key] = ModelEloScore(model=model, provider=provider, elo=initial_elo)

    def route(self, available_keys: List[str]) -> Optional[Tuple[str, str]]:
        """Route to the model with highest Elo among available."""
        candidates = [self.elo_scores[k] for k in available_keys if k in self.elo_scores]
        if not candidates:
            return None
        best = max(candidates, key=lambda e: e.elo)
        return (best.provider, best.model)

    def record_result(self, provider: str, model: str, opponent_elo: float, won: bool, k: int = 32):
        """Record a match result and update Elo."""
        key = f"{provider}/{model}"
        if key in self.elo_scores:
            self.elo_scores[key].update(opponent_elo, won, k)

    def get_rankings(self) -> List[Dict]:
        """Get all models ranked by Elo."""
        ranked = sorted(self.elo_scores.values(), key=lambda e: -e.elo)
        return [
            {"provider": e.provider, "model": e.model, "elo": round(e.elo, 1),
             "wins": e.wins, "losses": e.losses}
            for e in ranked
        ]


class ThresholdRouter:
    """
    Routes based on query difficulty threshold.
    Extracted from LLMRouter's ThresholdRouter pattern.
    Routes easy queries to a small/cheap model, hard queries to a large/expensive model.
    """

    def __init__(self, threshold: float = 0.5, small_model: str = "",
                 large_model: str = "", small_provider: str = "",
                 large_provider: str = ""):
        self.threshold = threshold
        self.small_model = small_model
        self.large_model = large_model
        self.small_provider = small_provider
        self.large_provider = large_provider
        self.estimator = DifficultyEstimator()

    def route(self, prompt: str) -> Dict[str, Any]:
        """Route a prompt based on estimated difficulty."""
        difficulty = self.estimator.estimate(prompt)

        if difficulty.score < self.threshold:
            return {
                "provider": self.small_provider,
                "model": self.small_model,
                "difficulty": difficulty.score,
                "threshold": self.threshold,
                "method": "threshold",
                "routed_to": "small",
            }
        else:
            return {
                "provider": self.large_provider,
                "model": self.large_model,
                "difficulty": difficulty.score,
                "threshold": self.threshold,
                "method": "threshold",
                "routed_to": "large",
            }

    def set_threshold(self, threshold: float):
        """Adjust the difficulty threshold."""
        self.threshold = max(0.0, min(1.0, threshold))


class KNNRouter:
    """
    Routes based on similarity to past queries (K-nearest-neighbors).
    Extracted from LLMRouter's KNNRouter pattern.
    Stores past (query, model, success) tuples and routes new queries
    to the model that performed best on similar past queries.
    """

    def __init__(self, k: int = 5):
        self.k = k
        self.history: List[Dict[str, Any]] = []

    def record(self, prompt: str, provider: str, model: str, success: bool, latency_ms: float = 0):
        """Record a past routing result."""
        self.history.append({
            "prompt": prompt,
            "prompt_lower": prompt.lower(),
            "words": set(prompt.lower().split()),
            "provider": provider,
            "model": model,
            "success": success,
            "latency_ms": latency_ms,
            "timestamp": time.time(),
        })

    def _similarity(self, query_words: set, past_words: set) -> float:
        """Jaccard similarity between word sets."""
        if not query_words or not past_words:
            return 0.0
        intersection = len(query_words & past_words)
        union = len(query_words | past_words)
        return intersection / union if union > 0 else 0.0

    def route(self, prompt: str) -> Optional[Dict[str, Any]]:
        """Route based on K-nearest past queries."""
        if not self.history:
            return None

        query_words = set(prompt.lower().split())

        # Compute similarity to all past queries
        scored = []
        for entry in self.history:
            sim = self._similarity(query_words, entry["words"])
            scored.append((sim, entry))

        # Get top K
        scored.sort(key=lambda x: -x[0])
        top_k = scored[:self.k]

        if not top_k or top_k[0][0] == 0:
            return None

        # Vote: weight by similarity * success
        model_scores: Dict[str, float] = defaultdict(float)
        for sim, entry in top_k:
            key = f"{entry['provider']}/{entry['model']}"
            weight = sim * (1.0 if entry["success"] else 0.0)
            model_scores[key] += weight

        if not model_scores:
            return None

        best_key = max(model_scores, key=model_scores.get)
        provider, model = best_key.split("/", 1)

        return {
            "provider": provider,
            "model": model,
            "method": "knn",
            "k": self.k,
            "neighbors_used": len(top_k),
            "confidence": model_scores[best_key] / sum(model_scores.values()) if sum(model_scores.values()) > 0 else 0,
        }


class CascadeRouter:
    """
    Try cheap model first, escalate to expensive model on failure.
    Extracted from llm-cascade-router pattern.
    """

    def __init__(self):
        self.tiers: List[Dict[str, Any]] = []
        self._rr_idx: int = 0

    def add_tier(self, provider: str, model: str, cost_per_1k: float,
                 max_tokens: int, is_fallback: bool = False):
        """Add a tier (cheapest first)."""
        self.tiers.append({
            "provider": provider,
            "model": model,
            "cost_per_1k": cost_per_1k,
            "max_tokens": max_tokens,
            "is_fallback": is_fallback,
            "calls": 0,
            "successes": 0,
            "escalations": 0,
        })
        self.tiers.sort(key=lambda t: t["cost_per_1k"])

    def route(self, prompt: str, estimated_tokens: int = 1000) -> Dict[str, Any]:
        """Route to the first (cheapest) tier that can handle the request."""
        for tier in self.tiers:
            if tier["max_tokens"] >= estimated_tokens:
                tier["calls"] += 1
                return {
                    "provider": tier["provider"],
                    "model": tier["model"],
                    "tier": self.tiers.index(tier),
                    "method": "cascade",
                    "cost_estimate": (estimated_tokens / 1000) * tier["cost_per_1k"],
                }
        # Fallback to last tier
        if self.tiers:
            last = self.tiers[-1]
            last["calls"] += 1
            return {"provider": last["provider"], "model": last["model"],
                    "tier": len(self.tiers) - 1, "method": "cascade",
                    "cost_estimate": (estimated_tokens / 1000) * last["cost_per_1k"]}
        return {"error": "No tiers configured"}

    def escalate(self, from_tier: int) -> Optional[Dict[str, Any]]:
        """Escalate to the next tier after a failure."""
        if from_tier + 1 < len(self.tiers):
            next_tier = self.tiers[from_tier + 1]
            next_tier["escalations"] += 1
            return {
                "provider": next_tier["provider"],
                "model": next_tier["model"],
                "tier": from_tier + 1,
                "method": "cascade_escalation",
            }
        return None

    def record_result(self, tier: int, success: bool):
        if 0 <= tier < len(self.tiers):
            if success:
                self.tiers[tier]["successes"] += 1

    def get_stats(self) -> List[Dict]:
        return [
            {
                "provider": t["provider"], "model": t["model"],
                "calls": t["calls"], "successes": t["successes"],
                "escalations": t["escalations"],
                "success_rate": t["successes"] / t["calls"] if t["calls"] > 0 else 0,
            }
            for t in self.tiers
        ]


class WeightedRouter:
    """
    Weighted random selection based on quality/cost ratio.
    Extracted from RouteLLM pattern.
    """

    def __init__(self):
        self.weights: Dict[str, float] = {}

    def set_weight(self, key: str, quality: float, cost: float):
        """Set weight as quality / cost (higher = better)."""
        self.weights[key] = quality / max(cost, 0.0001)

    def route(self, available_keys: List[str]) -> Optional[str]:
        """Weighted random selection."""
        candidates = {k: self.weights.get(k, 0.5) for k in available_keys}
        total = sum(candidates.values())
        if total == 0:
            return random.choice(available_keys) if available_keys else None
        r = random.uniform(0, total)
        cumulative = 0
        for key, weight in candidates.items():
            cumulative += weight
            if r <= cumulative:
                return key
        return available_keys[-1] if available_keys else None


class LeastLatencyRouter:
    """
    Route to the provider with the lowest average latency.
    Extracted from litellm pattern.
    """

    def __init__(self):
        self.latency_history: Dict[str, deque] = defaultdict(lambda: deque(maxlen=100))

    def record_latency(self, key: str, latency_ms: float):
        self.latency_history[key].append(latency_ms)

    def route(self, available_keys: List[str]) -> Optional[str]:
        scored = []
        for key in available_keys:
            history = self.latency_history.get(key, deque())
            if history:
                avg = sum(history) / len(history)
            else:
                avg = 1000.0  # Default for unknown
            scored.append((key, avg))
        if not scored:
            return None
        scored.sort(key=lambda x: x[1])
        return scored[0][0]


class RoundRobinRouter:
    """
    Distribute load evenly across all providers.
    """

    def __init__(self):
        self._idx: int = 0

    def route(self, available_keys: List[str]) -> Optional[str]:
        if not available_keys:
            return None
        key = available_keys[self._idx % len(available_keys)]
        self._idx += 1
        return key


class RoutingStrategyFactory:
    """Factory to create routing strategies by name."""

    @staticmethod
    def create(strategy: RoutingStrategy, **kwargs) -> Any:
        if strategy == RoutingStrategy.ELO:
            return EloRatingRouter()
        elif strategy == RoutingStrategy.THRESHOLD:
            return ThresholdRouter(**kwargs)
        elif strategy == RoutingStrategy.KNN:
            return KNNRouter(**kwargs)
        elif strategy == RoutingStrategy.CASCADE:
            return CascadeRouter()
        elif strategy == RoutingStrategy.WEIGHTED:
            return WeightedRouter()
        elif strategy == RoutingStrategy.LEAST_LATENCY:
            return LeastLatencyRouter()
        elif strategy == RoutingStrategy.ROUND_ROBIN:
            return RoundRobinRouter()
        else:
            raise ValueError(f"Unknown strategy: {strategy}")
