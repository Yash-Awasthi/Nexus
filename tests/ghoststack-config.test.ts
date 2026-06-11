import * as fs from "fs";
import * as path from "path";
import { loadGhostStackConfig } from "../runtime/ghoststack-config";

describe("ghoststack-config", () => {
  const tmp = path.join(__dirname, "../temp-config-repo");

  beforeEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    delete process.env.GHOSTSTACK_API_PORT;
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("loads defaults when no config file", () => {
    const cfg = loadGhostStackConfig(tmp);
    expect(cfg.apiPort).toBe(3000);
    expect(cfg.flociUrl).toContain("4566");
  });

  it("merges ghoststack.config.json", () => {
    fs.writeFileSync(
      path.join(tmp, "ghoststack.config.json"),
      JSON.stringify({ apiPort: 3999, features: { offlineMode: false } }),
      "utf8"
    );
    const cfg = loadGhostStackConfig(tmp);
    expect(cfg.apiPort).toBe(3999);
    expect(cfg.features.offlineMode).toBe(false);
  });
});
