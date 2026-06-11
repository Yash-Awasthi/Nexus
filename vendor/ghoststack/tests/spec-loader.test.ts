import * as path from "path";
import {
  loadWorkflowSpecFile,
  specToWorkflowDefinition,
  parseWorkflowSpec
} from "../orchestration/spec-loader";

describe("Workflow spec loader", () => {
  const demoSpecPath = path.join(__dirname, "../specs/demo-etl/workflow-spec.json");

  it("loads the demo ETL spec from disk", () => {
    const spec = loadWorkflowSpecFile(demoSpecPath);
    expect(spec.template_id).toBe("governed-etl-template");
    expect(spec.tasks).toHaveLength(3);
    expect(spec.tasks[0].type).toBe("scraping");
    expect(spec.tasks[1].action).toBe("filter_content");
  });

  it("converts a spec file into a workflow definition with typed tasks", () => {
    const spec = loadWorkflowSpecFile(demoSpecPath);
    const def = specToWorkflowDefinition(spec, "demo-etl");
    expect(def.id).toBe("demo-etl");
    expect(def.tasks[2].type).toBe("floci");
    expect(def.tasks[2].action).toBe("create_s3_bucket");
    expect(def.tasks[2].arguments?.bucketName).toBe("ghoststack-etl-archive");
  });

  it("rejects invalid JSON specs", () => {
    expect(() => parseWorkflowSpec("{not-json", "inline")).toThrow(/Invalid workflow spec JSON/);
  });
});
