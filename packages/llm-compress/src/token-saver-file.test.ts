// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { compressOutputForCommand } from "./token-saver.js";

function tsSource(n: number): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++)
    lines.push(`export function fn_${i}(x: number): number { return x + ${i}; }`);
  return lines.join("\n");
}

function paddedLockJson(): string {
  // lockfileVersion-3-style fixture inflated past 100 lines
  const packages: Record<string, Record<string, string>> = {
    "": { name: "demo", version: "1.0.0" },
    "node_modules/left-pad": {
      version: "1.3.0",
      resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      integrity: "sha512-abcdef1234567890abcdef",
    },
    "node_modules/lodash": {
      version: "4.17.21",
      resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
      integrity: "sha512-0123456789abcdef0123456789abc",
    },
    "node_modules/rimraf": {
      version: "3.0.2",
      resolved: "https://registry.npmjs.org/rimraf/-/rimraf-3.0.2.tgz",
      integrity: "sha512-99887766554433221100",
    },
    "node_modules/semver": {
      version: "7.6.0",
      resolved: "https://registry.npmjs.org/semver/-/semver-7.6.0.tgz",
      integrity: "sha512-abcdefabcdefabcdefabcdefabcdef",
    },
  };
  const lines: string[] = [];
  for (let i = 0; i < 22; i++) {
    packages[`node_modules/pkg_${i}`] = {
      version: `0.1.${i}`,
      resolved: `https://registry.npmjs.org/pkg_${i}/-/${i}.tgz`,
      integrity: `sha512-integrity${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}`,
    };
  }
  const body = JSON.stringify({ name: "demo", lockfileVersion: 3, packages }, null, 2).split("\n");
  return [...body, ""].join("\n");
}

describe("fileContentProcessor — never-compress classes", () => {
  it("passes source code through untouched (model patches it)", () => {
    const out = tsSource(130);
    const r = compressOutputForCommand("cat src/server.ts", out);
    expect(r.processor).toBe("file_content");
    expect(r.wasCompressed).toBe(false);
    expect(r.output).toBe(out);
  });

  it("passes sensitive config through untouched", () => {
    const out = Array.from({ length: 120 }, (_, i) => `setting_${i}=value_${i}`).join("\n");
    const r = compressOutputForCommand("cat config/app.conf", out);
    expect(r.processor).toBe("file_content");
    expect(r.wasCompressed).toBe(false);
    expect(r.output).toBe(out);
  });

  it("does not treat a long single-line .py as minified (protected source)", () => {
    const out = `def one_liner(): return "${"x".repeat(6000)}"`;
    const r = compressOutputForCommand("cat util.py", out);
    expect(r.processor).toBe("file_content");
    expect(r.wasCompressed).toBe(false);
    expect(r.output).toBe(out);
  });
});

describe("fileContentProcessor — minified", () => {
  it("summarizes name-detected minified web assets", () => {
    const out = `(()=>{"use strict";${"console.log(1);".repeat(900)}})();`;
    const r = compressOutputForCommand("cat dist/app.min.js", out);
    expect(r.processor).toBe("file_content");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("[minified file: app.min.js,");
    expect(r.output).toContain("chars,");
    expect(r.output).toMatch(/^\s*Preview: /m);
  });

  it("content-heuristic minified detection applies to web assets, not protected source", () => {
    const oneLineHtml = `<!doctype html><html><body>${"<div>cell</div>".repeat(800)}</body></html>`;
    const r = compressOutputForCommand("cat index.html", oneLineHtml);
    expect(r.processor).toBe("file_content");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("[minified file: index.html,");
  });
});

describe("fileContentProcessor — .env variants", () => {
  it("redacts secrets in .env.production while keeping harmless keys", () => {
    const out = [
      "# production",
      "PORT=8080",
      "DATABASE_URL=postgres://user:supersecret@db:5432/app",
      "API_KEY=your-api-key-here",
      "GITHUB_TOKEN=ghp_fake1234567890",
      "LOG_LEVEL=info",
      "",
    ].join("\n");
    const r = compressOutputForCommand("cat .env.production", out);
    expect(r.processor).toBe("file_content");
    expect(r.output).toContain("DATABASE_URL=***");
    expect(r.output).toContain("API_KEY=***");
    expect(r.output).toContain("GITHUB_TOKEN=***");
    expect(r.output).toContain("PORT=8080");
    expect(r.output).toContain("LOG_LEVEL=info");
    expect(r.output).toContain("3 sensitive values redacted");
  });

  it("leaves exact .env untouched (pass-through class)", () => {
    const out = ["PORT=8080", "DATABASE_URL=postgres://u:p@db/app", ""].join("\n");
    const r = compressOutputForCommand("cat .env", out);
    expect(r.processor).toBe("file_content");
    expect(r.output).toBe(out);
  });
});

describe("fileContentProcessor — lock files", () => {
  it("extracts top-level dependency names + versions from package-lock.json", () => {
    const out = paddedLockJson();
    expect(out.split("\n").filter((l) => l.trim()).length).toBeGreaterThan(100);
    const r = compressOutputForCommand("cat package-lock.json", out);
    expect(r.processor).toBe("file_content");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toMatch(/^package-lock\.json \(\d+ dependencies, \d+ lines\):$/m);
    expect(r.output).toContain("  left-pad@1.3.0");
    expect(r.output).toContain("  lodash@4.17.21");
    expect(r.output).toContain("  semver@7.6.0");
    expect(r.output).not.toContain("resolved");
    expect(r.output).not.toContain("integrity");
  });

  it("extracts [[package]] name@version from Cargo.lock", () => {
    const blocks: string[] = [];
    for (let i = 0; i < 16; i++) {
      blocks.push(
        "[[package]]",
        `name = "crate_${i}"`,
        `version = "0.${i}.1"`,
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        'checksum = "abc123"',
        "dependencies = [",
        ` "dep_${i}",`,
        "]",
        "",
      );
    }
    const out = blocks.join("\n");
    expect(out.split("\n").length).toBeGreaterThan(100);
    const r = compressOutputForCommand("cat Cargo.lock", out);
    expect(r.processor).toBe("file_content");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toMatch(/^Cargo\.lock \(\d+ packages, \d+ lines\):$/m);
    expect(r.output).toContain("  crate_0@0.0.1");
    expect(r.output).toContain("  crate_15@0.15.1");
    expect(r.output).not.toContain("checksum");
  });

  it("extracts module@version pairs from go.sum", () => {
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) {
      lines.push(
        `github.com/org/mod_${i} v1.${i}.0 h1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
      );
      lines.push(
        `github.com/org/mod_${i} v1.${i}.0/go.mod h1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
      );
    }
    const out = lines.join("\n");
    expect(out.split("\n").length).toBeGreaterThan(100);
    const r = compressOutputForCommand("head -n 500 go.sum", out);
    expect(r.processor).toBe("file_content");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toMatch(/^go\.sum \(\d+ modules, \d+ lines\):$/m);
    expect(r.output).toContain("  github.com/org/mod_0@v1.0.0");
    // capped at 50 entries like the other lock compressors
    expect(r.output).toContain("  github.com/org/mod_49@v1.49.0");
    expect(r.output).toContain("... (10 more)");
    expect(r.output).not.toContain("mod_59");
    expect(r.output).not.toContain("h1:");
  });
});

describe("fileContentProcessor — structured data", () => {
  it("compresses deep JSON preserving top keys and summarizing depth", () => {
    const nested: Record<string, unknown> = { version: 1, app: "demo" };
    const deep: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) deep[`svc_${i}`] = { image: `img:${i}`, replicas: i, nested };
    const body = JSON.stringify(
      { metadata: { created: "2024-01-01", nested }, services: deep },
      null,
      2,
    );
    const out = [...body.split("\n"), ""].join("\n");
    expect(out.split("\n").length).toBeGreaterThan(100);
    const r = compressOutputForCommand("cat compose.json", out);
    expect(r.processor).toBe("file_content");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain('"metadata"');
    expect(r.output).toContain('"created": "2024-01-01"');
    // depth-2 objects collapse to a key-count summary (max_depth=2)
    expect(r.output).toContain('"nested": "{... 2 keys}"');
    expect(r.output).toMatch(/\(\d+ total lines\)$/m);
    expect(r.output).not.toContain('"app": "demo"');
    expect(r.output).not.toContain("replicas");
  });

  it("keeps yaml top-level keys and second level, notes nested lines", () => {
    const lines: string[] = ["version: 2", "services:"];
    for (let i = 0; i < 40; i++) {
      lines.push(`  web_${i}:`);
      lines.push(`    image: nginx:${i}`);
      lines.push(`    ports:`);
      lines.push(`      - "${8080 + i}:80"`);
    }
    const out = lines.join("\n");
    expect(out.split("\n").length).toBeGreaterThan(100);
    const r = compressOutputForCommand("cat docker-compose.yml", out);
    expect(r.processor).toBe("file_content");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("version: 2");
    expect(r.output).toContain("services:");
    expect(r.output).toContain("nested lines omitted");
    expect(r.output).toMatch(/\(\d+ total lines\)$/m);
    expect(r.output).not.toContain("8080:80");
  });

  it("truncates over-long csv to header + head/tail rows", () => {
    const rows = ["name,id,score,region,active"];
    for (let i = 0; i < 120; i++)
      rows.push(`user_${i},${i},${i % 5},region_${i % 4},${i % 2 === 0}`);
    const out = rows.join("\n");
    const r = compressOutputForCommand("cat users.csv", out);
    expect(r.processor).toBe("file_content");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("name,id,score,region,active");
    expect(r.output).toContain("user_0,");
    expect(r.output).toContain("user_1,");
    expect(r.output).toContain("user_2,");
    expect(r.output).toContain("... (115 rows omitted)");
    expect(r.output).toContain("(120 data rows, 5 columns)");
    expect(r.output).not.toContain("user_60,");
  });
});

describe("fileContentProcessor — logs, docs, heuristics", () => {
  it("keeps head/tail plus error lines with context in a .log file", () => {
    const lines: string[] = [];
    for (let i = 0; i < 40; i++)
      lines.push(`2024-05-01T10:00:0${i % 10}Z INFO  worker-${i} processed item ${i}`);
    lines.push("2024-05-01T10:00:59Z ERROR worker-crash division by zero");
    lines.push("2024-05-01T10:01:00Z WARN  worker-crash restarting");
    for (let i = 0; i < 60; i++)
      lines.push(`2024-05-01T10:01:${String(i % 60).padStart(2, "0")}Z INFO  worker-${i} done`);
    const out = lines.join("\n");
    const r = compressOutputForCommand("tail -n 200 app.log", out);
    expect(r.processor).toBe("file_content");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("ERROR worker-crash");
    expect(r.output).toContain("WARN  worker-crash");
    expect(r.output).toContain("total lines");
  });

  it("truncates long markdown to head/tail with a truncation marker", () => {
    const lines: string[] = [];
    for (let i = 0; i < 120; i++) lines.push(`## Section ${i}`);
    const out = lines.join("\n");
    const r = compressOutputForCommand("cat README.md", out);
    expect(r.processor).toBe("file_content");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("## Section 0");
    expect(r.output).toContain("## Section 119");
    expect(r.output).toContain("lines truncated");
  });

  it("heuristic log detection applies to extensionless files", () => {
    const lines: string[] = [];
    for (let i = 0; i < 60; i++)
      lines.push(`2024-05-01 12:34:${String(i % 60).padStart(2, "0")} [INFO] service ${i} up`);
    for (let i = 0; i < 60; i++)
      lines.push(`2024-05-01 12:35:${String(i % 60).padStart(2, "0")} [DEBUG] heartbeat ${i}`);
    const out = lines.join("\n");
    const r = compressOutputForCommand("cat output", out);
    expect(r.processor).toBe("file_content");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("[INFO] service 0");
    expect(r.output).toContain("lines truncated");
    expect(r.output).not.toContain("service 30");
  });

  it("heuristic json detection applies to extensionless files starting with {", () => {
    const deep: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++)
      deep[`k_${i}`] = { a: i, b: `v_${i}`, c: { d: i, e: i + 1, f: [1, 2, 3, 4, 5] } };
    const out = JSON.stringify({ root: deep }, null, 2);
    expect(out.split("\n").length).toBeGreaterThan(100);
    const r = compressOutputForCommand("less payload", out);
    expect(r.processor).toBe("file_content");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("root");
    expect(r.output).toMatch(/\(\d+ total lines\)$/m);
  });
});
