# SPDX-License-Identifier: Apache-2.0
"""
Agent Orchestrator — Multi-agent coordination and task delegation
Inspired by CrewAI, LangGraph, and AutoGen patterns
"""

import time
import json
from typing import List, Dict, Optional, Any, Callable
from dataclasses import dataclass, field
from enum import Enum
from collections import defaultdict
import hashlib


class AgentRole(Enum):
    PLANNER = "planner"
    EXECUTOR = "executor"
    REVIEWER = "reviewer"
    COORDINATOR = "coordinator"
    SPECIALIST = "specialist"


class TaskStatus(Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    BLOCKED = "blocked"


@dataclass
class Agent:
    agent_id: str
    name: str
    role: AgentRole
    capabilities: List[str]
    max_concurrent_tasks: int = 1
    current_tasks: int = 0
    success_rate: float = 1.0
    avg_response_time: float = 0.0
    total_tasks: int = 0
    enabled: bool = True

    @property
    def available(self) -> bool:
        return self.enabled and self.current_tasks < self.max_concurrent_tasks

    @property
    def load(self) -> float:
        if self.max_concurrent_tasks == 0:
            return 1.0
        return self.current_tasks / self.max_concurrent_tasks


@dataclass
class Task:
    task_id: str
    description: str
    required_capabilities: List[str]
    status: TaskStatus = TaskStatus.PENDING
    assigned_agent: Optional[str] = None
    priority: int = 0
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    result: Optional[Any] = None
    error: Optional[str] = None
    dependencies: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Workflow:
    workflow_id: str
    name: str
    tasks: List[Task]
    status: str = "pending"
    created_at: float = field(default_factory=time.time)
    completed_at: Optional[float] = None


class AgentOrchestrator:
    """Orchestrates multiple agents for complex task completion."""

    def __init__(self):
        self.agents: Dict[str, Agent] = {}
        self.tasks: Dict[str, Task] = {}
        self.workflows: Dict[str, Workflow] = {}
        self.task_history: List[Dict] = []
        self.event_handlers: Dict[str, List[Callable]] = defaultdict(list)

    def register_agent(self, agent: Agent):
        self.agents[agent.agent_id] = agent

    def unregister_agent(self, agent_id: str):
        if agent_id in self.agents:
            del self.agents[agent_id]

    def submit_task(self, task: Task) -> str:
        self.tasks[task.task_id] = task
        self._notify("task_submitted", {"task_id": task.task_id})
        return task.task_id

    def assign_task(self, task_id: str, agent_id: Optional[str] = None) -> bool:
        task = self.tasks.get(task_id)
        if not task or task.status != TaskStatus.PENDING:
            return False
        if agent_id:
            agent = self.agents.get(agent_id)
            if not agent or not agent.available:
                return False
            if not self._agent_has_capabilities(agent, task.required_capabilities):
                return False
        else:
            agent = self._find_best_agent(task)
            if not agent:
                return False
            agent_id = agent.agent_id
        task.assigned_agent = agent_id
        task.status = TaskStatus.IN_PROGRESS
        task.started_at = time.time()
        self.agents[agent_id].current_tasks += 1
        self._notify("task_assigned", {"task_id": task_id, "agent_id": agent_id})
        return True

    def complete_task(self, task_id: str, result: Any) -> bool:
        task = self.tasks.get(task_id)
        if not task or task.status != TaskStatus.IN_PROGRESS:
            return False
        task.status = TaskStatus.COMPLETED
        task.result = result
        task.completed_at = time.time()
        if task.assigned_agent and task.assigned_agent in self.agents:
            agent = self.agents[task.assigned_agent]
            agent.current_tasks = max(0, agent.current_tasks - 1)
            agent.total_tasks += 1
            duration = task.completed_at - (task.started_at or task.created_at)
            agent.avg_response_time = (
                (agent.avg_response_time * (agent.total_tasks - 1) + duration) /
                agent.total_tasks
            )
        self._notify("task_completed", {"task_id": task_id})
        self._check_dependents(task_id)
        return True

    def fail_task(self, task_id: str, error: str) -> bool:
        task = self.tasks.get(task_id)
        if not task or task.status != TaskStatus.IN_PROGRESS:
            return False
        task.status = TaskStatus.FAILED
        task.error = error
        task.completed_at = time.time()
        if task.assigned_agent and task.assigned_agent in self.agents:
            agent = self.agents[task.assigned_agent]
            agent.current_tasks = max(0, agent.current_tasks - 1)
        self._notify("task_failed", {"task_id": task_id, "error": error})
        return True

    def get_pending_tasks(self) -> List[Task]:
        return [t for t in self.tasks.values() if t.status == TaskStatus.PENDING]

    def get_available_agents(self) -> List[Agent]:
        return [a for a in self.agents.values() if a.available]

    def get_workflow_status(self, workflow_id: str) -> Optional[Dict]:
        workflow = self.workflows.get(workflow_id)
        if not workflow:
            return None
        tasks_status = defaultdict(int)
        for task in workflow.tasks:
            tasks_status[task.status.value] += 1
        return {
            "workflow_id": workflow_id,
            "name": workflow.name,
            "status": workflow.status,
            "tasks": dict(tasks_status),
            "total_tasks": len(workflow.tasks),
            "progress": tasks_status.get("completed", 0) / max(len(workflow.tasks), 1)
        }

    def create_workflow(self, name: str, tasks: List[Task]) -> Workflow:
        workflow_id = f"wf_{hashlib.md5(f"{name}{time.time()}".encode()).hexdigest()[:8]}"
        workflow = Workflow(
            workflow_id=workflow_id,
            name=name,
            tasks=tasks
        )
        self.workflows[workflow_id] = workflow
        for task in tasks:
            self.tasks[task.task_id] = task
        return workflow

    def process_queue(self):
        pending = self.get_pending_tasks()
        available = self.get_available_agents()
        for task in sorted(pending, key=lambda t: -t.priority):
            if not available:
                break
            if task.dependencies:
                deps_met = all(
                    self.tasks.get(dep, Task()).status == TaskStatus.COMPLETED
                    for dep in task.dependencies
                )
                if not deps_met:
                    continue
            for agent in available:
                if self._agent_has_capabilities(agent, task.required_capabilities):
                    self.assign_task(task.task_id, agent.agent_id)
                    available.remove(agent)
                    break

    def _find_best_agent(self, task: Task) -> Optional[Agent]:
        candidates = [
            a for a in self.agents.values()
            if a.available and self._agent_has_capabilities(a, task.required_capabilities)
        ]
        if not candidates:
            return None
        candidates.sort(key=lambda a: (-a.success_rate, a.load))
        return candidates[0]

    def _agent_has_capabilities(self, agent: Agent, required: List[str]) -> bool:
        return all(cap in agent.capabilities for cap in required)

    def _check_dependents(self, completed_task_id: str):
        for task in self.tasks.values():
            if task.status == TaskStatus.PENDING and completed_task_id in task.dependencies:
                deps_met = all(
                    self.tasks.get(dep, Task()).status == TaskStatus.COMPLETED
                    for dep in task.dependencies
                )
                if deps_met:
                    self._notify("task_unblocked", {"task_id": task.task_id})

    def _notify(self, event: str, data: Dict):
        for handler in self.event_handlers.get(event, []):
            handler(data)

    def on(self, event: str, handler: Callable):
        self.event_handlers[event].append(handler)

    def get_metrics(self) -> Dict:
        tasks_by_status = defaultdict(int)
        for task in self.tasks.values():
            tasks_by_status[task.status.value] += 1
        agent_metrics = {}
        for agent in self.agents.values():
            agent_metrics[agent.agent_id] = {
                "name": agent.name,
                "role": agent.role.value,
                "total_tasks": agent.total_tasks,
                "current_tasks": agent.current_tasks,
                "success_rate": agent.success_rate,
                "avg_response_time": agent.avg_response_time,
                "load": agent.load
            }
        return {
            "total_tasks": len(self.tasks),
            "tasks_by_status": dict(tasks_by_status),
            "total_agents": len(self.agents),
            "available_agents": len(self.get_available_agents()),
            "agent_metrics": agent_metrics,
            "total_workflows": len(self.workflows)
        }
