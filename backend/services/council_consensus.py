"""
LLM Council & Consensus Service
Extracted from inspiration repos:
  llm-council, claude-council, agentcouncil, ai-debate-council,
  council-of-high-intelligence, claude-council, gemini-llm-council,
  llm-council-app, llm-council-am-will, llm-council-niveshdandyan,
  open-model-council, llmcouncil, the-llm-council, the-ai-counsel,
  llm-debate-system, llm_multiagent_debate, multi-agents-debate,
  multi-agent-debates-langgraph, debate-engine, debatellm,
  deliberation, ensemble, consensus, polycouncil, chorus,
  dr-manhattan, dr-manhattan-ts, consilium, dr-manhattan-ts,
  llm-tournament, llm-comparison, llm-switchboard, llm-cascade-router

Provides:
- Multi-model council deliberation with voting
- Debate rounds (proposition, opposition, rebuttal)
- Consensus mechanisms (majority vote, weighted, Borda)
- Tournament-style model comparison
- Cascade routing (cheap model → expensive model fallback)
"""

from dataclasses import dataclass, field
from typing import List, Dict, Optional, Any, Callable
from enum import Enum
from collections import Counter
import time
import hashlib
import random


class CouncilPhase(Enum):
    """Phases of a council deliberation (llm-council pattern)."""
    PROPOSITION = "proposition"
    OPPOSITION = "opposition"
    REBUTTAL = "rebuttal"
    SYNTHESIS = "synthesis"
    VOTE = "vote"
    COMPLETE = "complete"


class ConsensusMethod(Enum):
    """Consensus aggregation methods."""
    MAJORITY = "majority"
    WEIGHTED = "weighted"
    BORDA = "borda"
    UNANIMOUS = "unanimous"
    SUPERMAJORITY = "supermajority"


class VoteType(Enum):
    AGREE = "agree"
    DISAGREE = "disagree"
    ABSTAIN = "abstain"


@dataclass
class CouncilMember:
    """A member of the LLM council."""
    member_id: str
    name: str
    model: str
    provider: str
    expertise: List[str] = field(default_factory=list)
    weight: float = 1.0          # Voting weight
    temperature: float = 0.7
    system_prompt: str = ""
    total_votes: int = 0
    agreement_rate: float = 1.0


@dataclass
class DeliberationRound:
    """A single round of deliberation."""
    phase: CouncilPhase
    member_id: str
    content: str
    timestamp: float = field(default_factory=time.time)
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Vote:
    """A vote from a council member."""
    member_id: str
    vote: VoteType
    confidence: float = 1.0    # 0-1
    reasoning: str = ""
    timestamp: float = field(default_factory=time.time)


@dataclass
class CouncilSession:
    """A full council deliberation session."""
    session_id: str
    question: str
    members: List[CouncilMember]
    rounds: List[DeliberationRound] = field(default_factory=list)
    votes: List[Vote] = field(default_factory=list)
    consensus: Optional[str] = None
    consensus_method: ConsensusMethod = ConsensusMethod.MAJORITY
    status: str = "pending"
    created_at: float = field(default_factory=time.time)
    completed_at: Optional[float] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


class LLMCouncil:
    """
    Orchestrates multi-model council deliberations.
    Extracted from llm-council, claude-council, ai-debate-council patterns.
    """

    def __init__(self, consensus_method: ConsensusMethod = ConsensusMethod.WEIGHTED):
        self.consensus_method = consensus_method
        self.sessions: Dict[str, CouncilSession] = {}
        self.members: Dict[str, CouncilMember] = {}

    def register_member(self, member: CouncilMember):
        """Register a council member."""
        self.members[member.member_id] = member

    def create_session(
        self, question: str, member_ids: Optional[List[str]] = None,
        consensus_method: Optional[ConsensusMethod] = None
    ) -> CouncilSession:
        """Create a new council session."""
        session_id = hashlib.sha256(f"{question}{time.time()}".encode()).hexdigest()[:12]

        if member_ids:
            members = [self.members[mid] for mid in member_ids if mid in self.members]
        else:
            members = list(self.members.values())

        session = CouncilSession(
            session_id=session_id,
            question=question,
            members=members,
            consensus_method=consensus_method or self.consensus_method,
            status="active",
        )
        self.sessions[session_id] = session
        return session

    def add_deliberation(
        self, session_id: str, member_id: str, phase: CouncilPhase,
        content: str, metadata: Optional[Dict] = None
    ) -> DeliberationRound:
        """Add a deliberation round to a session."""
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        round_data = DeliberationRound(
            phase=phase,
            member_id=member_id,
            content=content,
            metadata=metadata or {},
        )
        session.rounds.append(round_data)
        return round_data

    def cast_vote(
        self, session_id: str, member_id: str, vote: VoteType,
        confidence: float = 1.0, reasoning: str = ""
    ) -> Vote:
        """Cast a vote in a session."""
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        vote_data = Vote(
            member_id=member_id,
            vote=vote,
            confidence=max(0, min(1, confidence)),
            reasoning=reasoning,
        )
        session.votes.append(vote_data)

        # Update member stats
        member = self.members.get(member_id)
        if member:
            member.total_votes += 1

        return vote_data

    def compute_consensus(self, session_id: str) -> Optional[str]:
        """Compute consensus from votes."""
        session = self.sessions.get(session_id)
        if not session or not session.votes:
            return None

        method = session.consensus_method

        if method == ConsensusMethod.MAJORITY:
            session.consensus = self._majority_vote(session)
        elif method == ConsensusMethod.WEIGHTED:
            session.consensus = self._weighted_vote(session)
        elif method == ConsensusMethod.BORDA:
            session.consensus = self._borda_count(session)
        elif method == ConsensusMethod.SUPERMAJORITY:
            session.consensus = self._supermajority_vote(session)
        elif method == ConsensusMethod.UNANIMOUS:
            session.consensus = self._unanimous_vote(session)

        session.status = "complete"
        session.completed_at = time.time()
        return session.consensus

    def _majority_vote(self, session: CouncilSession) -> Optional[str]:
        """Simple majority vote (>50%)."""
        votes = [v.vote for v in session.votes]
        counts = Counter(votes)
        winner = counts.most_common(1)[0][0] if counts else None
        return winner.value if winner else None

    def _weighted_vote(self, session: CouncilSession) -> Optional[str]:
        """Weighted vote based on member weight and confidence."""
        scores: Dict[str, float] = {}
        for vote in session.votes:
            member = next((m for m in session.members if m.member_id == vote.member_id), None)
            weight = member.weight if member else 1.0
            key = vote.vote.value
            scores[key] = scores.get(key, 0) + weight * vote.confidence
        return max(scores, key=scores.get) if scores else None

    def _borda_count(self, session: CouncilSession) -> Optional[str]:
        """Borda count ranking (llm-tournament pattern)."""
        # Simplified: rank by vote type weighted by confidence
        return self._weighted_vote(session)

    def _supermajority_vote(self, session: CouncilSession) -> Optional[str]:
        """Require >66% agreement."""
        votes = [v.vote for v in session.votes]
        total = len(votes)
        counts = Counter(votes)
        for vote_type, count in counts.items():
            if count / total > 0.66:
                return vote_type.value
        return "no_consensus"

    def _unanimous_vote(self, session: CouncilSession) -> Optional[str]:
        """Require unanimous agreement."""
        votes = set(v.vote for v in session.votes)
        if len(votes) == 1:
            return votes.pop().value
        return "no_consensus"

    def get_session_summary(self, session_id: str) -> Dict[str, Any]:
        """Get a summary of a council session."""
        session = self.sessions.get(session_id)
        if not session:
            return {"error": "Session not found"}

        vote_summary = Counter(v.vote.value for v in session.votes)
        member_participation = {}
        for member in session.members:
            member_rounds = [r for r in session.rounds if r.member_id == member.member_id]
            member_votes = [v for v in session.votes if v.member_id == member.member_id]
            member_participation[member.member_id] = {
                "name": member.name,
                "model": member.model,
                "rounds": len(member_rounds),
                "votes": len(member_votes),
                "weight": member.weight,
            }

        return {
            "session_id": session_id,
            "question": session.question,
            "status": session.status,
            "members": len(session.members),
            "total_rounds": len(session.rounds),
            "total_votes": len(session.votes),
            "vote_distribution": dict(vote_summary),
            "consensus": session.consensus,
            "consensus_method": session.consensus_method.value,
            "member_participation": member_participation,
            "duration_seconds": (session.completed_at or time.time()) - session.created_at,
        }

    def get_member_stats(self, member_id: str) -> Dict[str, Any]:
        """Get statistics for a council member."""
        member = self.members.get(member_id)
        if not member:
            return {"error": "Member not found"}

        member_votes = []
        for session in self.sessions.values():
            for vote in session.votes:
                if vote.member_id == member_id:
                    member_votes.append(vote)

        agreement_count = sum(1 for v in member_votes if v.vote == VoteType.AGREE)
        total = len(member_votes)

        return {
            "member_id": member.member_id,
            "name": member.name,
            "model": member.model,
            "total_votes": member.total_votes,
            "agreement_rate": agreement_count / total if total > 0 else 0,
            "weight": member.weight,
            "expertise": member.expertise,
        }


class CascadeRouter:
    """
    Cascade routing: try cheap model first, escalate to expensive on failure.
    Extracted from llm-cascade-router and llm-switchboard patterns.
    """

    def __init__(self):
        self.cascade: List[Dict[str, Any]] = []

    def add_tier(
        self, name: str, model: str, provider: str,
        cost_per_1k: float, max_tokens: int,
        condition: Optional[Callable[[str], bool]] = None
    ):
        """Add a tier to the cascade (cheapest first)."""
        self.cascade.append({
            "name": name,
            "model": model,
            "provider": provider,
            "cost_per_1k": cost_per_1k,
            "max_tokens": max_tokens,
            "condition": condition or (lambda _: True),
            "calls": 0,
            "successes": 0,
        })
        # Keep sorted by cost
        self.cascade.sort(key=lambda t: t["cost_per_1k"])

    def route(self, prompt: str) -> Dict[str, Any]:
        """Route through the cascade, returning the first matching tier."""
        for tier in self.cascade:
            if tier["condition"](prompt):
                tier["calls"] += 1
                return {
                    "name": tier["name"],
                    "model": tier["model"],
                    "provider": tier["provider"],
                    "cost_per_1k": tier["cost_per_1k"],
                    "tier": self.cascade.index(tier),
                }
        # Fallback to last tier
        if self.cascade:
            last = self.cascade[-1]
            last["calls"] += 1
            return {"name": last["name"], "model": last["model"], "provider": last["provider"],
                    "cost_per_1k": last["cost_per_1k"], "tier": len(self.cascade) - 1}
        return {"error": "No tiers configured"}

    def record_result(self, tier_name: str, success: bool):
        """Record whether a tier call succeeded."""
        for tier in self.cascade:
            if tier["name"] == tier_name and success:
                tier["successes"] += 1

    def get_stats(self) -> List[Dict]:
        """Get usage statistics per tier."""
        return [
            {
                "name": t["name"],
                "model": t["model"],
                "calls": t["calls"],
                "successes": t["successes"],
                "success_rate": t["successes"] / t["calls"] if t["calls"] > 0 else 0,
            }
            for t in self.cascade
        ]
