"""
Agent Orchestrator
Extracted from TradingAgents' multi-agent orchestration patterns

Features:
- Agent registration and management
- Task distribution and routing
- Consensus building
- Performance tracking
"""

from dataclasses import dataclass
from typing import List, Dict, Any, Optional, Callable
from enum import Enum
import time
import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor

logger = logging.getLogger(__name__)


class AgentStatus(Enum):
    IDLE = "idle"
    BUSY = "busy"
    ERROR = "error"
    OFFLINE = "offline"


@dataclass
class Agent:
    """Agent definition with capabilities"""
    id: str
    name: str
    role: str
    capabilities: List[str]
    status: AgentStatus
    performance_score: float  # 0-1
    tasks_completed: int
    average_response_time: float  # ms
    last_active: float


@dataclass
class Task:
    """Task definition for agent processing"""
    id: str
    type: str
    payload: Dict[str, Any]
    required_capabilities: List[str]
    priority: int  # 1-5
    created_at: float
    assigned_to: Optional[str] = None
    status: str = "pending"
    result: Optional[Dict[str, Any]] = None


@dataclass
class ConsensusResult:
    """Result from consensus building"""
    task_id: str
    participants: List[str]
    votes: Dict[str, Any]
    consensus: Any
    confidence: float
    timestamp: float


class AgentOrchestrator:
    """
    Orchestrates multiple agents for complex tasks
    Inspired by TradingAgents' approach to multi-agent collaboration
    """
    
    def __init__(self, max_workers: int = 4):
        self.agents: Dict[str, Agent] = {}
        self.tasks: Dict[str, Task] = {}
        self.task_queue: List[Task] = []
        self.executor = ThreadPoolExecutor(max_workers=max_workers)
        self.consensus_threshold = 0.6  # 60% agreement needed
        
    def register_agent(self, agent: Agent):
        """Register a new agent"""
        self.agents[agent.id] = agent
        logger.info(f"Registered agent: {agent.name} ({agent.role})")
    
    def unregister_agent(self, agent_id: str):
        """Unregister an agent"""
        if agent_id in self.agents:
            del self.agents[agent_id]
            logger.info(f"Unregistered agent: {agent_id}")
    
    def submit_task(self, task: Task) -> str:
        """Submit a task for processing"""
        self.tasks[task.id] = task
        self.task_queue.append(task)
        
        # Sort by priority (higher first)
        self.task_queue.sort(key=lambda t: t.priority, reverse=True)
        
        logger.info(f"Submitted task: {task.id} (priority: {task.priority})")
        return task.id
    
    def assign_task(self, task_id: str) -> Optional[str]:
        """Assign task to best available agent"""
        task = self.tasks.get(task_id)
        if not task:
            return None
        
        # Find agents with required capabilities
        capable_agents = [
            agent for agent in self.agents.values()
            if agent.status == AgentStatus.IDLE
            and all(cap in agent.capabilities for cap in task.required_capabilities)
        ]
        
        if not capable_agents:
            logger.warning(f"No capable agents for task {task_id}")
            return None
        
        # Select best agent based on performance score and response time
        best_agent = max(
            capable_agents,
            key=lambda a: a.performance_score * (1 / (a.average_response_time + 1))
        )
        
        # Assign task
        task.assigned_to = best_agent.id
        task.status = "assigned"
        best_agent.status = AgentStatus.BUSY
        
        logger.info(f"Assigned task {task_id} to agent {best_agent.name}")
        return best_agent.id
    
    def execute_task(self, task_id: str, handler: Callable[[Task], Any]) -> Any:
        """Execute a task with its assigned agent"""
        task = self.tasks.get(task_id)
        if not task or not task.assigned_to:
            raise ValueError(f"Task {task_id} not assigned")
        
        agent = self.agents.get(task.assigned_to)
        if not agent:
            raise ValueError(f"Agent {task.assigned_to} not found")
        
        start_time = time.time()
        
        try:
            # Execute task
            result = handler(task)
            
            # Update task
            task.status = "completed"
            task.result = result
            
            # Update agent stats
            execution_time = (time.time() - start_time) * 1000
            agent.tasks_completed += 1
            agent.average_response_time = (
                (agent.average_response_time * (agent.tasks_completed - 1) + execution_time)
                / agent.tasks_completed
            )
            agent.status = AgentStatus.IDLE
            agent.last_active = time.time()
            
            # Update performance score
            agent.performance_score = min(1.0, agent.performance_score + 0.01)
            
            logger.info(f"Task {task_id} completed in {execution_time:.0f}ms")
            return result
            
        except Exception as e:
            # Handle error
            task.status = "error"
            agent.status = AgentStatus.ERROR
            agent.performance_score = max(0.0, agent.performance_score - 0.1)
            
            logger.error(f"Task {task_id} failed: {e}")
            raise
    
    def build_consensus(
        self,
        task_id: str,
        participants: List[str],
        votes: Dict[str, Any]
    ) -> ConsensusResult:
        """Build consensus from multiple agents"""
        # Count votes
        vote_counts: Dict[Any, int] = {}
        for agent_id, vote in votes.items():
            if agent_id in participants:
                vote_counts[vote] = vote_counts.get(vote, 0) + 1
        
        # Find majority
        total_votes = len(votes)
        if total_votes == 0:
            consensus = None
            confidence = 0.0
        else:
            max_votes = max(vote_counts.values())
            consensus = max(vote_counts, key=vote_counts.get)
            confidence = max_votes / total_votes
        
        result = ConsensusResult(
            task_id=task_id,
            participants=participants,
            votes=votes,
            consensus=consensus,
            confidence=confidence,
            timestamp=time.time()
        )
        
        logger.info(f"Consensus for {task_id}: {consensus} (confidence: {confidence:.2f})")
        return result
    
    def get_agent_stats(self) -> Dict[str, Dict[str, Any]]:
        """Get statistics for all agents"""
        stats = {}
        
        for agent_id, agent in self.agents.items():
            stats[agent_id] = {
                'name': agent.name,
                'role': agent.role,
                'status': agent.status.value,
                'performance_score': agent.performance_score,
                'tasks_completed': agent.tasks_completed,
                'average_response_time': agent.average_response_time,
                'capabilities': agent.capabilities
            }
        
        return stats
    
    def get_task_stats(self) -> Dict[str, int]:
        """Get task statistics"""
        return {
            'total': len(self.tasks),
            'pending': sum(1 for t in self.tasks.values() if t.status == 'pending'),
            'assigned': sum(1 for t in self.tasks.values() if t.status == 'assigned'),
            'completed': sum(1 for t in self.tasks.values() if t.status == 'completed'),
            'error': sum(1 for t in self.tasks.values() if t.status == 'error')
        }
    
    def shutdown(self):
        """Graceful shutdown"""
        self.executor.shutdown(wait=True)
        logger.info("Shutdown complete")


def create_orchestrator_with_agents(agent_configs: List[Dict[str, Any]]) -> AgentOrchestrator:
    """
    Create an orchestrator with pre-configured agents
    
    Args:
        agent_configs: List of agent configuration dictionaries
    
    Returns:
        Configured AgentOrchestrator
    """
    orchestrator = AgentOrchestrator()
    
    for config in agent_configs:
        agent = Agent(
            id=config['id'],
            name=config['name'],
            role=config['role'],
            capabilities=config.get('capabilities', []),
            status=AgentStatus.IDLE,
            performance_score=0.5,
            tasks_completed=0,
            average_response_time=0.0,
            last_active=time.time()
        )
        orchestrator.register_agent(agent)
    
    return orchestrator