"""
LLM Router Service
Inspired by litellm - multi-provider routing, load balancing, fallback chains

Pure functions for intelligent LLM request routing:
- Provider selection based on model/capability
- Load balancing across providers
- Fallback chain management
- Cost optimization
- Rate limit handling
"""

from dataclasses import dataclass
from typing import List, Optional, Dict, Any
import time
import random
from enum import Enum


class ProviderStatus(Enum):
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    DOWN = "down"
    RATE_LIMITED = "rate_limited"


@dataclass
class LLMProvider:
    """LLM provider configuration"""
    name: str
    api_key: str
    base_url: str
    models: List[str]
    rate_limit: int  # requests per minute
    cost_per_1k_tokens: float
    status: ProviderStatus
    last_health_check: float
    error_count: int
    success_count: int
    avg_latency: float  # ms


@dataclass
class LLMRequest:
    """LLM request with routing metadata"""
    id: str
    model: str
    messages: List[Dict[str, str]]
    max_tokens: int
    temperature: float
    user_id: str
    priority: int  # 1-5, 5 being highest
    metadata: Dict[str, Any]


@dataclass
class LLMResponse:
    """LLM response with provider metadata"""
    id: str
    content: str
    model: str
    provider: str
    tokens_used: int
    cost: float
    latency: float  # ms
    cached: bool
    metadata: Dict[str, Any]


@dataclass
class RoutingDecision:
    """Routing decision for a request"""
    provider: LLMProvider
    model: str
    reason: str
    fallback_chain: List[LLMProvider]
    estimated_cost: float
    estimated_latency: float


class LLMRouter:
    def __init__(self, providers: List[LLMProvider]):
        self.providers = providers
        self.provider_stats: Dict[str, Dict[str, Any]] = {}
        self._initialize_stats()
    
    def _initialize_stats(self):
        """Initialize provider statistics"""
        for provider in self.providers:
            self.provider_stats[provider.name] = {
                'requests': 0,
                'errors': 0,
                'total_latency': 0,
                'total_cost': 0,
                'last_used': 0,
                'cooldown_until': 0
            }
    
    def route_request(self, request: LLMRequest) -> RoutingDecision:
        """
        Route an LLM request to the best provider
        
        Args:
            request: LLM request with routing metadata
        
        Returns:
            RoutingDecision with selected provider and fallback chain
        """
        # Filter providers that support the requested model
        capable_providers = [
            p for p in self.providers 
            if request.model in p.models and p.status != ProviderStatus.DOWN
        ]
        
        if not capable_providers:
            raise ValueError(f"No providers available for model {request.model}")
        
        # Score providers
        scored_providers = []
        for provider in capable_providers:
            score = self._score_provider(provider, request)
            scored_providers.append((provider, score))
        
        # Sort by score (highest first)
        scored_providers.sort(key=lambda x: x[1], reverse=True)
        
        # Select primary provider
        primary_provider = scored_providers[0][0]
        
        # Build fallback chain (top 3 providers)
        fallback_chain = [p[0] for p in scored_providers[1:4]]
        
        # Calculate estimates
        estimated_cost = self._estimate_cost(primary_provider, request)
        estimated_latency = self._estimate_latency(primary_provider)
        
        return RoutingDecision(
            provider=primary_provider,
            model=request.model,
            reason=f"Selected based on score {scored_providers[0][1]:.2f}",
            fallback_chain=fallback_chain,
            estimated_cost=estimated_cost,
            estimated_latency=estimated_latency
        )
    
    def _score_provider(self, provider: LLMProvider, request: LLMRequest) -> float:
        """
        Score a provider for a specific request
        
        Args:
            provider: Provider to score
            request: LLM request
        
        Returns:
            Score between 0 and 1 (higher is better)
        """
        score = 0.0
        
        # Health score (0-0.3)
        if provider.status == ProviderStatus.HEALTHY:
            score += 0.3
        elif provider.status == ProviderStatus.DEGRADED:
            score += 0.15
        
        # Cost score (0-0.25)
        if provider.cost_per_1k_tokens > 0:
            cost_score = 1.0 / (1.0 + provider.cost_per_1k_tokens)
            score += cost_score * 0.25
        
        # Latency score (0-0.25)
        if provider.avg_latency > 0:
            latency_score = 1.0 / (1.0 + provider.avg_latency / 1000)
            score += latency_score * 0.25
        
        # Load score (0-0.2)
        stats = self.provider_stats.get(provider.name, {})
        recent_requests = stats.get('requests', 0)
        load_score = 1.0 / (1.0 + recent_requests / 100)
        score += load_score * 0.2
        
        # Priority bonus (0-0.15)
        if request.priority >= 4:
            score += 0.15
        elif request.priority >= 3:
            score += 0.1
        
        # Cooldown penalty
        cooldown_until = stats.get('cooldown_until', 0)
        if time.time() < cooldown_until:
            score *= 0.1
        
        return min(max(score, 0.0), 1.0)
    
    def _estimate_cost(self, provider: LLMProvider, request: LLMRequest) -> float:
        """
        Estimate cost for a request
        
        Args:
            provider: Selected provider
            request: LLM request
        
        Returns:
            Estimated cost in dollars
        """
        # Rough estimate: 1 token ≈ 4 characters
        estimated_tokens = len(str(request.messages)) / 4
        return (estimated_tokens / 1000) * provider.cost_per_1k_tokens
    
    def _estimate_latency(self, provider: LLMProvider) -> float:
        """
        Estimate latency for a request
        
        Args:
            provider: Selected provider
        
        Returns:
            Estimated latency in milliseconds
        """
        return provider.avg_latency
    
    def record_success(self, provider_name: str, latency: float, cost: float):
        """
        Record a successful request
        
        Args:
            provider_name: Provider name
            latency: Request latency in ms
            cost: Request cost in dollars
        """
        stats = self.provider_stats.get(provider_name, {})
        stats['requests'] = stats.get('requests', 0) + 1
        stats['total_latency'] = stats.get('total_latency', 0) + latency
        stats['total_cost'] = stats.get('total_cost', 0) + cost
        stats['last_used'] = time.time()
        
        # Update provider stats
        provider = next((p for p in self.providers if p.name == provider_name), None)
        if provider:
            provider.success_count += 1
            provider.avg_latency = (provider.avg_latency + latency) / 2
    
    def record_error(self, provider_name: str, error_type: str):
        """
        Record a failed request
        
        Args:
            provider_name: Provider name
            error_type: Type of error
        """
        stats = self.provider_stats.get(provider_name, {})
        stats['errors'] = stats.get('errors', 0) + 1
        
        # Update provider stats
        provider = next((p for p in self.providers if p.name == provider_name), None)
        if provider:
            provider.error_count += 1
            
            # Mark as down if too many errors
            if provider.error_count > 10:
                provider.status = ProviderStatus.DOWN
                stats['cooldown_until'] = time.time() + 300  # 5 minute cooldown
            
            # Mark as degraded if error rate is high
            elif provider.error_count > 5 and provider.success_count > 0:
                error_rate = provider.error_count / (provider.error_count + provider.success_count)
                if error_rate > 0.3:
                    provider.status = ProviderStatus.DEGRADED
    
    def health_check(self):
        """
        Perform health check on all providers
        
        This would typically ping provider endpoints
        """
        for provider in self.providers:
            try:
                # Simulate health check
                # In production, this would make a test API call
                provider.last_health_check = time.time()
                
                # Reset status if provider has recovered
                if provider.status == ProviderStatus.DOWN:
                    stats = self.provider_stats.get(provider.name, {})
                    if time.time() > stats.get('cooldown_until', 0):
                        provider.status = ProviderStatus.HEALTHY
                        provider.error_count = 0
                
            except Exception as e:
                print(f"Health check failed for {provider.name}: {e}")
                provider.status = ProviderStatus.DOWN
    
    def get_provider_stats(self) -> Dict[str, Dict[str, Any]]:
        """Get statistics for all providers"""
        return self.provider_stats.copy()
    
    def add_provider(self, provider: LLMProvider):
        """Add a new provider"""
        self.providers.append(provider)
        self._initialize_stats()
    
    def remove_provider(self, provider_name: str):
        """Remove a provider"""
        self.providers = [p for p in self.providers if p.name != provider_name]
        self.provider_stats.pop(provider_name, None)
    
    def update_provider_status(self, provider_name: str, status: ProviderStatus):
        """Update provider status"""
        provider = next((p for p in self.providers if p.name == provider_name), None)
        if provider:
            provider.status = status


# Example usage
def create_default_router() -> LLMRouter:
    """Create a router with default providers"""
    providers = [
        LLMProvider(
            name="openai",
            api_key="sk-...",
            base_url="https://api.openai.com/v1",
            models=["gpt-4", "gpt-3.5-turbo", "gpt-4-turbo"],
            rate_limit=100,
            cost_per_1k_tokens=0.03,
            status=ProviderStatus.HEALTHY,
            last_health_check=0,
            error_count=0,
            success_count=0,
            avg_latency=1000
        ),
        LLMProvider(
            name="anthropic",
            api_key="sk-ant-...",
            base_url="https://api.anthropic.com/v1",
            models=["claude-3-opus", "claude-3-sonnet", "claude-3-haiku"],
            rate_limit=50,
            cost_per_1k_tokens=0.015,
            status=ProviderStatus.HEALTHY,
            last_health_check=0,
            error_count=0,
            success_count=0,
            avg_latency=1200
        ),
        LLMProvider(
            name="google",
            api_key="AIza...",
            base_url="https://generativelanguage.googleapis.com/v1beta",
            models=["gemini-pro", "gemini-flash"],
            rate_limit=60,
            cost_per_1k_tokens=0.001,
            status=ProviderStatus.HEALTHY,
            last_health_check=0,
            error_count=0,
            success_count=0,
            avg_latency=800
        )
    ]
    
    return LLMRouter(providers)