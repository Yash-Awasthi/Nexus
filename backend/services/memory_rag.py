"""
Memory & RAG Service
Extracted from inspiration repos:
  mem0, cognee, graphiti, graphrag, graphrag-rs, lightrag, nano-graphrag,
  knowledge_graph, knowledge-graph-retrieval-with-hierarchical-community-clustering,
  chroma, qdrant, milvus, weaviate, pgvector, pgvectorscale-rag-solution,
  vectorchord, hnswlib, falkordb, nexusrag, kglite, pg_knowledge_graph,
  leiden-communities-openmp-dynamic, ngraph.leiden, unified-kg-rag-on-aws,
  rag-anything, haystack, context, contexto, opencode-dynamic-context-pruning,
  llmlingua, how_to_fix_your_context, agentic-memory

Provides:
- Conversation memory (short-term + long-term, mem0 pattern)
- Graph-based memory (graphiti/lightrag pattern)
- Vector search abstraction (chroma/qdrant/pgvector)
- Community detection for knowledge graphs (leiden pattern)
- Context window management (llmlingua pattern)
"""

from dataclasses import dataclass, field
from typing import List, Dict, Optional, Any, Tuple
from enum import Enum
from datetime import datetime
from collections import defaultdict
import hashlib
import math
import json


class MemoryType(Enum):
    SHORT_TERM = "short_term"    # Current conversation context
    LONG_TERM = "long_term"      # Persisted across sessions
    ENTITY = "entity"            # Facts about entities
    EPISODIC = "episodic"         # Event-based memories
    SEMANTIC = "semantic"        # Concept relationships


@dataclass
class Memory:
    """A memory entry (mem0 pattern)."""
    id: str
    content: str
    memory_type: MemoryType
    entity_ids: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)
    embedding: Optional[List[float]] = None
    created_at: float = field(default_factory=datetime.now().timestamp)
    last_accessed: float = field(default_factory=datetime.now().timestamp)
    access_count: int = 0
    importance: float = 0.5     # 0-1, affects retention
    decay_rate: float = 0.01     # Memory decay per day


@dataclass
class GraphNode:
    """A node in the knowledge graph (graphiti pattern)."""
    id: str
    label: str
    properties: Dict[str, Any] = field(default_factory=dict)
    embedding: Optional[List[float]] = None


@dataclass
class GraphEdge:
    """An edge in the knowledge graph."""
    source_id: str
    target_id: str
    label: str
    properties: Dict[str, Any] = field(default_factory=dict)
    weight: float = 1.0


@dataclass
class SearchResult:
    """A vector search result."""
    memory: Memory
    score: float
    rank: int = 0


class ConversationMemory:
    """
    Manages conversation memory with short-term and long-term storage.
    Extracted from mem0 and agentic-memory patterns.
    """

    def __init__(self, max_short_term: int = 50, max_tokens: int = 8000):
        self.short_term: List[Memory] = []
        self.long_term: List[Memory] = []
        self.max_short_term = max_short_term
        self.max_tokens = max_tokens
        self.entity_memories: Dict[str, List[Memory]] = defaultdict(list)

    def add(self, content: str, memory_type: MemoryType = MemoryType.SHORT_TERM,
            entity_ids: Optional[List[str]] = None, importance: float = 0.5,
            metadata: Optional[Dict] = None) -> Memory:
        """Add a memory entry."""
        mem_id = hashlib.sha256(f"{content}{datetime.now().timestamp()}".encode()).hexdigest()[:12]
        memory = Memory(
            id=mem_id,
            content=content,
            memory_type=memory_type,
            entity_ids=entity_ids or [],
            importance=importance,
            metadata=metadata or {},
        )
        if memory_type == MemoryType.SHORT_TERM:
            self.short_term.append(memory)
            self._evict_if_needed()
        else:
            self.long_term.append(memory)

        for eid in (entity_ids or []):
            self.entity_memories[eid].append(memory)

        return memory

    def _evict_if_needed(self):
        """Evict old short-term memories when over capacity.
        Uses importance-weighted recency scoring (mem0 pattern).
        """
        if len(self.short_term) <= self.max_short_term:
            return

        now = datetime.now().timestamp()
        # Score each memory: importance * recency_decay
        scored = []
        for mem in self.short_term:
            age_days = (now - mem.created_at) / 86400
            decay = math.exp(-mem.decay_rate * age_days)
            score = mem.importance * decay
            scored.append((mem, score))

        scored.sort(key=lambda x: x[1])

        # Evict lowest-scoring, promote to long-term if important
        to_evict = len(self.short_term) - self.max_short_term
        for i in range(to_evict):
            mem = scored[i][0]
            self.short_term.remove(mem)
            if mem.importance > 0.3:
                mem.memory_type = MemoryType.LONG_TERM
                self.long_term.append(mem)

    def search(self, query: str, limit: int = 10, memory_types: Optional[List[MemoryType]] = None) -> List[SearchResult]:
        """Search memories by keyword (fallback when no embeddings available)."""
        query_lower = query.lower()
        words = query_lower.split()
        results = []

        search_pool = self.short_term + self.long_term
        if memory_types:
            search_pool = [m for m in search_pool if m.memory_type in memory_types]

        for mem in search_pool:
            content_lower = mem.content.lower()
            score = sum(1 for w in words if w in content_lower) / max(len(words), 1)
            if score > 0:
                now = datetime.now().timestamp()
                recency = math.exp(-mem.decay_rate * ((now - mem.last_accessed) / 86400))
                final_score = score * recency * mem.importance
                results.append(SearchResult(memory=mem, score=final_score))
                mem.access_count += 1
                mem.last_accessed = now

        results.sort(key=lambda r: r.score, reverse=True)
        for i, r in enumerate(results[:limit]):
            r.rank = i + 1
        return results[:limit]

    def vector_search(
        self, query_embedding: List[float], limit: int = 10,
        memory_types: Optional[List[MemoryType]] = None,
    ) -> List[SearchResult]:
        """Search memories by cosine similarity on embeddings (chroma/qdrant pattern).

        If memories don't have embeddings, falls back to keyword search.
        """
        search_pool = self.short_term + self.long_term
        if memory_types:
            search_pool = [m for m in search_pool if m.memory_type in memory_types]

        # Filter to only memories with embeddings
        embedded = [m for m in search_pool if m.embedding is not None]
        if not embedded:
            # Fallback to keyword search
            return self.search(" ".join(str(x) for x in query_embedding[:10]), limit, memory_types)

        results = []
        for mem in embedded:
            score = self._cosine_similarity(query_embedding, mem.embedding)
            now = datetime.now().timestamp()
            recency = math.exp(-mem.decay_rate * ((now - mem.last_accessed) / 86400))
            final_score = score * recency * mem.importance
            results.append(SearchResult(memory=mem, score=final_score))
            mem.access_count += 1
            mem.last_accessed = now

        results.sort(key=lambda r: r.score, reverse=True)
        for i, r in enumerate(results[:limit]):
            r.rank = i + 1
        return results[:limit]

    @staticmethod
    def _cosine_similarity(a: List[float], b: List[float]) -> float:
        """Compute cosine similarity between two vectors."""
        if len(a) != len(b) or len(a) == 0:
            return 0.0
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = math.sqrt(sum(x * x for x in a))
        norm_b = math.sqrt(sum(y * y for y in b))
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return dot / (norm_a * norm_b)

    def get_context_window(self, max_tokens: Optional[int] = None) -> str:
        """Build a context window from recent memories (llmlingua pattern).
        Prioritizes recent and important memories within token budget.
        """
        budget = max_tokens or self.max_tokens
        # Sort by recency * importance
        all_mem = sorted(
            self.short_term,
            key=lambda m: m.last_accessed * m.importance,
            reverse=True
        )
        context_parts = []
        token_estimate = 0
        for mem in all_mem:
            mem_tokens = len(mem.content.split()) * 1.3
            if token_estimate + mem_tokens > budget:
                continue
            context_parts.append(mem.content)
            token_estimate += mem_tokens
        return "\n".join(context_parts)

    def get_entity_memories(self, entity_id: str) -> List[Memory]:
        """Get all memories about a specific entity."""
        return self.entity_memories.get(entity_id, [])


class KnowledgeGraph:
    """
    Graph-based memory with community detection.
    Extracted from graphiti, graphrag, lightrag, leiden patterns.
    """

    def __init__(self):
        self.nodes: Dict[str, GraphNode] = {}
        self.edges: List[GraphEdge] = []
        self.adjacency: Dict[str, List[str]] = defaultdict(list)
        self.communities: Dict[str, str] = {}    # node_id -> community_id

    def add_node(self, node: GraphNode):
        self.nodes[node.id] = node
        if node.id not in self.adjacency:
            self.adjacency[node.id] = []

    def add_edge(self, edge: GraphEdge):
        self.edges.append(edge)
        self.adjacency[edge.source_id].append(edge.target_id)
        self.adjacency[edge.target_id].append(edge.source_id)

    def get_neighbors(self, node_id: str, depth: int = 1) -> List[str]:
        """Get neighbors within a certain depth (graphrag pattern)."""
        visited = set()
        current = {node_id}
        for _ in range(depth):
            next_level = set()
            for nid in current:
                for neighbor in self.adjacency.get(nid, []):
                    if neighbor not in visited:
                        next_level.add(neighbor)
            visited.update(current)
            current = next_level
        return list(visited - {node_id})

    def detect_communities(self, resolution: float = 1.0) -> Dict[str, str]:
        """
        Simple community detection using label propagation.
        Extracted from leiden-communities and ngraph.leiden patterns.
        """
        node_ids = list(self.nodes.keys())
        if not node_ids:
            return {}

        # Initialize: each node is its own community
        labels = {nid: nid for nid in node_ids}

        # Iterate label propagation
        for _ in range(10):  # max iterations
            changed = False
            random_order = list(node_ids)
            for nid in random_order:
                neighbor_labels = [labels[n] for n in self.adjacency.get(nid, []) if n in labels]
                if not neighbor_labels:
                    continue
                # Pick most common neighbor label
                counts = defaultdict(int)
                for lbl in neighbor_labels:
                    counts[lbl] += 1
                new_label = max(counts, key=counts.get)
                if new_label != labels[nid]:
                    labels[nid] = new_label
                    changed = True
            if not changed:
                break

        self.communities = labels
        return labels

    def get_community_summary(self, community_id: str) -> Dict[str, Any]:
        """Get a summary of a community (graphrag hierarchical clustering pattern)."""
        members = [nid for nid, cid in self.communities.items() if cid == community_id]
        member_nodes = [self.nodes[nid] for nid in members if nid in self.nodes]
        internal_edges = [
            e for e in self.edges
            if e.source_id in members and e.target_id in members
        ]
        return {
            "community_id": community_id,
            "member_count": len(members),
            "members": [{"id": n.id, "label": n.label} for n in member_nodes],
            "internal_edges": len(internal_edges),
            "labels": [n.label for n in member_nodes],
        }

    def search_graph(self, query: str, limit: int = 10) -> List[Dict]:
        """Search the knowledge graph (lightrag pattern)."""
        query_lower = query.lower()
        query_words = set(query_lower.split())
        results = []
        for node in self.nodes.values():
            label_match = sum(1 for w in query_words if w in node.label.lower())
            prop_match = sum(1 for w in query_words
                              for v in node.properties.values()
                              if w in str(v).lower())
            score = label_match + prop_match
            if score > 0:
                # Boost score based on degree
                degree = len(self.adjacency.get(node.id, []))
                results.append({
                    "node": {"id": node.id, "label": node.label},
                    "score": score * (1 + degree * 0.1),
                    "degree": degree,
                })
        results.sort(key=lambda r: r["score"], reverse=True)
        return results[:limit]
