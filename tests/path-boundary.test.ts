import * as path from "path";
import * as fs from "fs";
import { assertPathDescendsFrom } from "../orchestration/path-boundary";

describe("path-boundary", () => {
  const tmp = path.join(__dirname, "../temp-path-boundary");

  beforeEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("allows a descendant directory inside ancestor", () => {
    const root = path.join(tmp, "repo");
    const data = path.join(root, "data-runtime");
    fs.mkdirSync(data, { recursive: true });
    const resolved = assertPathDescendsFrom(root, data);
    expect(resolved).toContain("data-runtime");
  });

  it("rejects escape via ..", () => {
    const root = path.join(tmp, "repo");
    fs.mkdirSync(root, { recursive: true });
    const evil = path.join(root, "..", "outside");
    fs.mkdirSync(evil, { recursive: true });
    expect(() => assertPathDescendsFrom(root, evil)).toThrow(/boundary violation/i);
  });
});
