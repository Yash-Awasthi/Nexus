import { TaskDependencyResolver } from "../orchestration/dependency-resolver";
import { Task } from "../orchestration/task-router";

describe("Milestone 1: Dependency Resolver & Cycle Detection", () => {
  it("should successfully sort independent tasks in basic dependency order", () => {
    const resolver = new TaskDependencyResolver();

    const tasks: Task[] = [
      { id: "task-A", title: "A", description: "", priority: "medium", status: "pending", dependencies: ["task-B"] },
      { id: "task-B", title: "B", description: "", priority: "medium", status: "pending", dependencies: [] },
      { id: "task-C", title: "C", description: "", priority: "medium", status: "pending", dependencies: ["task-A"] }
    ];

    const sorted = resolver.resolveOrder(tasks);

    // B must be first, then A, then C
    expect(sorted.map((t) => t.id)).toEqual(["task-B", "task-A", "task-C"]);
  });

  it("should detect simple and transient circular dependencies", () => {
    const resolver = new TaskDependencyResolver();

    const circularTasks: Task[] = [
      { id: "task-A", title: "A", description: "", priority: "medium", status: "pending", dependencies: ["task-B"] },
      { id: "task-B", title: "B", description: "", priority: "medium", status: "pending", dependencies: ["task-A"] }
    ];

    expect(resolver.detectCycles(circularTasks)).toBe(true);

    const transitiveCircularTasks: Task[] = [
      { id: "task-A", title: "A", description: "", priority: "medium", status: "pending", dependencies: ["task-B"] },
      { id: "task-B", title: "B", description: "", priority: "medium", status: "pending", dependencies: ["task-C"] },
      { id: "task-C", title: "C", description: "", priority: "medium", status: "pending", dependencies: ["task-A"] }
    ];

    expect(resolver.detectCycles(transitiveCircularTasks)).toBe(true);
  });

  it("should throw error if attempting to resolve dependencies with a cycle", () => {
    const resolver = new TaskDependencyResolver();

    const circularTasks: Task[] = [
      { id: "task-A", title: "A", description: "", priority: "medium", status: "pending", dependencies: ["task-B"] },
      { id: "task-B", title: "B", description: "", priority: "medium", status: "pending", dependencies: ["task-A"] }
    ];

    expect(() => resolver.resolveOrder(circularTasks)).toThrow("Cyclic dependencies detected in task graph");
  });
});
