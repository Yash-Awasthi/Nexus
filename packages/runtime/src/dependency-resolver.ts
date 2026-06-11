import type { ITaskDependencyResolver } from "./interfaces/execution.interface.js";
import type { Task } from "./task-router.js";

export class TaskDependencyResolver implements ITaskDependencyResolver {
  detectCycles(tasks: Task[]): boolean {
    const taskMap = new Map<string, Task>();
    for (const task of tasks) {
      taskMap.set(task.id, task);
    }

    const visited = new Set<string>();
    const visiting = new Set<string>();

    const dfs = (taskId: string): boolean => {
      visiting.add(taskId);
      const task = taskMap.get(taskId);
      if (task) {
        for (const depId of task.dependencies) {
          if (visiting.has(depId)) {
            return true;
          }
          if (!visited.has(depId)) {
            if (dfs(depId)) return true;
          }
        }
      }
      visiting.delete(taskId);
      visited.add(taskId);
      return false;
    };

    for (const task of tasks) {
      if (!visited.has(task.id)) {
        if (dfs(task.id)) return true;
      }
    }

    return false;
  }

  resolveOrder(tasks: Task[]): Task[] {
    if (this.detectCycles(tasks)) {
      throw new Error("Cyclic dependencies detected in task graph");
    }

    const taskMap = new Map<string, Task>();
    for (const task of tasks) {
      taskMap.set(task.id, task);
    }

    const visited = new Set<string>();
    const result: Task[] = [];

    const dfs = (taskId: string) => {
      const task = taskMap.get(taskId);
      if (task) {
        for (const depId of task.dependencies) {
          if (!visited.has(depId)) {
            dfs(depId);
          }
        }
      }
      if (!visited.has(taskId)) {
        visited.add(taskId);
        if (task) {
          result.push(task);
        }
      }
    };

    for (const task of tasks) {
      if (!visited.has(task.id)) {
        dfs(task.id);
      }
    }

    return result;
  }
}
