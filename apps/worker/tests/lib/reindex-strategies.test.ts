// SPDX-License-Identifier: Apache-2.0
// Offline strategy-selection tests (pass 73): loadReindexStrategies maps an
// injected env to the worker's search:reindex strategy chain. Construction
// only — no strategy is searched, so nothing here touches Chroma or Postgres;
// the real backends are asserted purely by the selected strategies' names and
// order (chroma + hybrid first, Postgres second, mock fallback when neither).
import { describe, expect, it } from "vitest";

import { loadReindexStrategies } from "../../src/lib/reindex-strategies.js";

describe("loadReindexStrategies (search:reindex env → strategies)", () => {
  it("falls back to the single mock strategy when no backend env is set", async () => {
    const strategies = await loadReindexStrategies({});
    expect(strategies.map((s) => s.name)).toEqual(["mock"]);
  });

  it("selects Chroma + hybrid when CHROMA_URL is set (chroma first)", async () => {
    const strategies = await loadReindexStrategies({ chromaUrl: "http://chroma:8000" });
    expect(strategies.map((s) => s.name)).toEqual(["chroma", "hybrid"]);
  });

  it("honors the Chroma collection override", async () => {
    const strategies = await loadReindexStrategies({
      chromaUrl: "http://chroma:8000",
      chromaCollection: "team-docs",
    });
    expect(strategies.map((s) => s.name)).toEqual(["chroma", "hybrid"]);
  });

  it("selects Postgres full-text when only DATABASE_URL is set", async () => {
    const strategies = await loadReindexStrategies({
      databaseUrl: "postgres://user:pass@db/nexus",
    });
    expect(strategies.map((s) => s.name)).toEqual(["sqlite"]); // PgFullTextStrategy's source slot
  });

  it("orders both backends chroma/hybrid before Postgres when both are set", async () => {
    const strategies = await loadReindexStrategies({
      chromaUrl: "http://chroma:8000",
      databaseUrl: "postgres://user:pass@db/nexus",
    });
    expect(strategies.map((s) => s.name)).toEqual(["chroma", "hybrid", "sqlite"]);
  });
});
