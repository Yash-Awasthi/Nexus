import * as path from "path";
import { FederationSupervisor } from "../runtime/federation-supervisor";
import { loadGhostStackConfig } from "../runtime/ghoststack-config";

describe("FederationSupervisor", () => {
  const repoRoot = path.resolve(__dirname, "..");

  it("reports aggregated status structure", async () => {
    const config = loadGhostStackConfig(repoRoot);
    const supervisor = new FederationSupervisor(repoRoot, config);
    const status = await supervisor.status();
    expect(status.services.length).toBeGreaterThanOrEqual(3);
    expect(status.services.map((s) => s.name)).toContain("floci");
    expect(status.services.map((s) => s.name)).toContain("orchestrator");
  });
});
