import { FilesystemSandbox, SandboxConstraint } from "../orchestration/filesystem-sandbox";
import { BrowserExecutionAdapter } from "../orchestration/browser-adapter";
import { ScrapingExecutionAdapter } from "../orchestration/scraping-adapter";
import { MCPRuntime } from "../orchestration/mcp-adapter";
import { MCPServerRegistry } from "../orchestration/mcp-registry";
import { FileEventStore, FileRuntimePersistence } from "../orchestration/persistence-manager";
import { ApprovalWorkflow } from "../orchestration/approval-workflow";
import { LocalEventBus } from "../orchestration/event-bus";
import { EnvironmentTelemetry } from "../orchestration/environment-telemetry";
import { isSafeUrl, isSafeSandboxPath } from "../orchestration/security-utils";
import * as fs from "fs";
import * as path from "path";

describe("GhostStack v1.1 Hardening & Security Verification", () => {
  const testDir = path.join(__dirname, "../temp-hardening-db");

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("1. Filesystem Sandbox Traversal & Boundary Safety", () => {
    it("should prevent sibling folder traversal bypass (e.g. sandbox-sibling vs sandbox)", () => {
      const sandboxRoot = path.join(testDir, "sandbox");
      const siblingRoot = path.join(testDir, "sandbox-sibling");

      const constraint = new SandboxConstraint(1024 * 1024, sandboxRoot);
      const sandbox = new FilesystemSandbox(sandboxRoot, constraint);

      // Verify basic prefix matching checks that would allow path-traversal without deep matching
      const traversalPath = path.resolve(siblingRoot);

      // Target sibling must fail
      expect(isSafeSandboxPath(sandboxRoot, traversalPath)).toBe(false);
      expect(isSafeSandboxPath(sandboxRoot, path.join(sandboxRoot, "nested-file.txt"))).toBe(true);

      // Attempting to write to sibling path should throw error
      expect(async () => {
        await sandbox.writeFile(traversalPath, "malicious script");
      }).rejects.toThrow();
    });

    it("should prevent relative path escapes (e.g. nested/../../file.txt)", () => {
      const sandboxRoot = path.join(testDir, "sandbox");
      const constraint = new SandboxConstraint(1024 * 1024, sandboxRoot);
      const sandbox = new FilesystemSandbox(sandboxRoot, constraint);

      const escapePath = path.join(sandboxRoot, "nested/../../escaped-file.txt");
      expect(isSafeSandboxPath(sandboxRoot, escapePath)).toBe(false);

      expect(async () => {
        await sandbox.writeFile(escapePath, "malicious script");
      }).rejects.toThrow();
    });
  });

  describe("2. Browser & Scraper URL Safety (SSRF & Redirection Hardening)", () => {
    it("should validate allowed protocols and reject non-http schemes", () => {
      expect(isSafeUrl("http://example.com")).toBe(true);
      expect(isSafeUrl("https://secure.site.org")).toBe(true);

      expect(isSafeUrl("file:///etc/passwd")).toBe(false);
      expect(isSafeUrl("ftp://files.host")).toBe(false);
      expect(isSafeUrl("gopher://server.net")).toBe(false);
      expect(isSafeUrl("javascript:alert(1)")).toBe(false);
      expect(isSafeUrl("FILE://host/path")).toBe(false); // Case insensitivity checks
    });

    it("should block loopbacks, metadata domains, and SSRF ranges", () => {
      // Loopbacks
      expect(isSafeUrl("http://localhost/admin")).toBe(false);
      expect(isSafeUrl("http://127.0.0.1/dashboard")).toBe(false);
      expect(isSafeUrl("http://[::1]/internal")).toBe(false);

      // Cloud Metadata Services (AWS, GCP, Azure standard targets)
      expect(isSafeUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
      expect(isSafeUrl("http://metadata.google.internal/computeMetadata")).toBe(false);
      expect(isSafeUrl("http://metadata/services")).toBe(false);
      expect(isSafeUrl("http://instance-data/hostname")).toBe(false);

      // Subnets and Private IP spaces
      expect(isSafeUrl("http://10.0.0.1/sensitive")).toBe(false);
      expect(isSafeUrl("http://192.168.1.1/router")).toBe(false);
    });

    it("should reject malicious execution in BrowserAdapter and ScrapingAdapter", async () => {
      const telemetry = new EnvironmentTelemetry();

      const browserAdapter = new BrowserExecutionAdapter(telemetry, true);
      const scraperAdapter = new ScrapingExecutionAdapter(telemetry, true);

      // Test unsafe URL execution
      const browserRes = await browserAdapter.executeBrowserTask({
        id: "task-test",
        url: "http://169.254.169.254/latest/meta-data",
        actions: [],
        timeoutMs: 1000
      });
      expect(browserRes.success).toBe(false);
      expect(browserRes.content).toBe("BLOCKED_BY_SAFETY_POLICY");

      const scraperRes = await scraperAdapter.executeScrapingTask({
        id: "task-test",
        url: "file:///etc/shadow",
        selectors: ["h1"]
      });
      expect(scraperRes.success).toBe(false);
      expect(scraperRes.data.error).toBe("BLOCKED_BY_SAFETY_POLICY");
    });
  });

  describe("3. MCP Tool Execution Safety (Blocklist Governance)", () => {
    it("should prevent invocation of dangerous/blocked tool namespaces", async () => {
      const registry = new MCPServerRegistry();
      const mcpRuntime = new MCPRuntime(registry);

      const task = {
        id: "mcp-test-task",
        correlationId: "correlation-test",
        serverName: "system-server",
        toolName: "shell_execute", // Blocked by default policy
        arguments: { command: "rm -rf /" },
        timeoutMs: 2000
      };

      const result = await mcpRuntime.executeTask(task);
      expect(result.success).toBe(false);
      expect(result.error).toContain("blocked by safety policy");
    });
  });

  describe("4. Atomic Persistence & Write Verification", () => {
    it("should save state atomically to prevent JSON write corruption", async () => {
      const stateFilePath = path.join(testDir, "persistent_state.json");
      const persistence = new FileRuntimePersistence(stateFilePath);

      await persistence.saveState("config", { cluster: "primary", node: 12 });

      // Verify correct write state
      const value = await persistence.getState<{ cluster: string }>("config");
      expect(value?.cluster).toBe("primary");

      // Verify no temporary file is left lingering
      const tempPath = `${stateFilePath}.tmp`;
      expect(fs.existsSync(tempPath)).toBe(false);
      expect(fs.existsSync(stateFilePath)).toBe(true);
    });
  });

  describe("5. Approval Cache Integrity & Replay Performance", () => {
    it("should read event logs only once and preserve consistent cache state", async () => {
      const eventLogPath = path.join(testDir, "cached_events.jsonl");
      const eventStore = new FileEventStore(eventLogPath);
      const eventBus = new LocalEventBus();

      const approvalWorkflow = new ApprovalWorkflow(eventStore, eventBus);

      // Create several approval items
      const req1 = await approvalWorkflow.createRequest("task-01");
      const req2 = await approvalWorkflow.createRequest("task-02");

      // Verify they are stored and retrievable via cache
      const list = await approvalWorkflow.listRecords();
      expect(list.length).toBe(2);

      // Spies or assertion checks: eventStore replayEvents count should match 1 on first list query
      const replaySpy = jest.spyOn(eventStore, "replayEvents");

      const record = await approvalWorkflow.getRecord(req1.approvalId);
      expect(record?.status).toBe("pending");

      // Multiple list and retrieve calls should NOT call eventStore.replayEvents again
      await approvalWorkflow.listRecords();
      await approvalWorkflow.getRecord(req2.approvalId);

      // Since it is cached, replayEvents was not triggered again
      expect(replaySpy).not.toHaveBeenCalled();

      replaySpy.mockRestore();
    });
  });
});
