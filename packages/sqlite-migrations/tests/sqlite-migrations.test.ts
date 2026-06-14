// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  InMemoryDbClient,
  MigrationRunner,
  SchemaRepair,
  type Migration,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const M1: Migration = {
  version: 1,
  name: "create_users",
  up: "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
};

const M2: Migration = {
  version: 2,
  name: "create_sessions",
  up: [
    "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)",
  ],
};

const M3: Migration = {
  version: 3,
  name: "add_email",
  up: "ALTER TABLE users ADD COLUMN email TEXT",
};

// ── InMemoryDbClient ──────────────────────────────────────────────────────────

describe("InMemoryDbClient", () => {
  it("exec CREATE TABLE records columns", () => {
    const db = new InMemoryDbClient();
    db.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    expect(db.tableColumns("users")).toContain("id");
    expect(db.tableColumns("users")).toContain("name");
  });

  it("exec ALTER TABLE ADD COLUMN adds to column list", () => {
    const db = new InMemoryDbClient();
    db.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)");
    db.exec("ALTER TABLE users ADD COLUMN email TEXT");
    expect(db.tableColumns("users")).toContain("email");
  });

  it("exec CREATE INDEX records index", () => {
    const db = new InMemoryDbClient();
    db.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id INTEGER)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)");
    expect(db.tableIndexes("sessions")).toContain("idx_sessions_user");
  });

  it("prepare INSERT then SELECT retrieves row", () => {
    const db = new InMemoryDbClient();
    db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, label TEXT)");
    db.prepare("INSERT INTO items (id, label) VALUES (?, ?)").run(1, "hello");
    const rows = db.prepare("SELECT * FROM items").all<{ id: number; label: string }>();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("hello");
  });

  it("SELECT with WHERE filters rows", () => {
    const db = new InMemoryDbClient();
    db.exec("CREATE TABLE IF NOT EXISTS things (id INTEGER PRIMARY KEY, kind TEXT)");
    db.prepare("INSERT INTO things (id, kind) VALUES (?, ?)").run(1, "a");
    db.prepare("INSERT INTO things (id, kind) VALUES (?, ?)").run(2, "b");
    const rows = db.prepare("SELECT * FROM things WHERE kind = ?").all({ kind: "a" });
    // Note: our WHERE uses params[0]
    const rowsByParam = db.prepare("SELECT * FROM things WHERE id = ?").all<{ id: number }>(1);
    expect(rowsByParam).toHaveLength(1);
    expect(rowsByParam[0]!.id).toBe(1);
  });

  it("INSERT OR IGNORE skips duplicate version", () => {
    const db = new InMemoryDbClient();
    db.exec("CREATE TABLE IF NOT EXISTS _schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)");
    db.prepare("INSERT OR IGNORE INTO _schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(1, "m1", "t1");
    db.prepare("INSERT OR IGNORE INTO _schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(1, "m1-dup", "t2");
    const rows = db.prepare("SELECT * FROM _schema_migrations ORDER BY version").all<{ version: number }>();
    expect(rows).toHaveLength(1);
  });

  it("transaction wraps and executes fn", () => {
    const db = new InMemoryDbClient();
    let ran = false;
    db.transaction(() => { ran = true; });
    expect(ran).toBe(true);
  });

  it("tableColumns returns empty for missing table", () => {
    const db = new InMemoryDbClient();
    expect(db.tableColumns("nonexistent")).toEqual([]);
  });

  it("tableIndexes returns empty for missing table", () => {
    const db = new InMemoryDbClient();
    expect(db.tableIndexes("nonexistent")).toEqual([]);
  });
});

// ── MigrationRunner ───────────────────────────────────────────────────────────

describe("MigrationRunner – init", () => {
  it("init creates _schema_migrations table", () => {
    const db = new InMemoryDbClient();
    const runner = new MigrationRunner(db);
    runner.init();
    expect(db.tableColumns("_schema_migrations")).toContain("version");
  });

  it("init is idempotent", () => {
    const db = new InMemoryDbClient();
    const runner = new MigrationRunner(db);
    runner.init();
    runner.init(); // second call should not throw
    expect(db.tableColumns("_schema_migrations").length).toBeGreaterThan(0);
  });
});

describe("MigrationRunner – run", () => {
  it("applies all pending migrations in order", () => {
    const db = new InMemoryDbClient();
    const runner = new MigrationRunner(db, [M1, M2, M3]);
    const report = runner.run();
    expect(report.appliedCount).toBe(3);
    expect(report.skippedCount).toBe(0);
    expect(report.failedCount).toBe(0);
    expect(db.tableColumns("users")).toContain("email");
    expect(db.tableIndexes("sessions")).toContain("idx_sessions_user");
  });

  it("skips already-applied migrations", () => {
    const db = new InMemoryDbClient();
    const runner = new MigrationRunner(db, [M1, M2]);
    runner.run(); // first run applies both
    const report2 = runner.run(); // second run should skip both
    expect(report2.appliedCount).toBe(0);
    expect(report2.skippedCount).toBe(2);
  });

  it("handles multi-statement migrations (array up)", () => {
    const db = new InMemoryDbClient();
    const runner = new MigrationRunner(db, [M2]);
    const report = runner.run();
    expect(report.appliedCount).toBe(1);
    expect(db.tableColumns("sessions")).toContain("id");
    expect(db.tableIndexes("sessions")).toContain("idx_sessions_user");
  });

  it("stops on first failed migration", () => {
    const db = new InMemoryDbClient();
    // M_BAD will throw because InMemoryDbClient transaction re-throws
    const M_BAD: Migration = {
      version: 2,
      name: "bad",
      up: "THIS IS NOT VALID SQL — WILL THROW",
    };
    // Make the db throw on bad SQL by overriding exec
    const throwingDb = new InMemoryDbClient();
    const origExec = throwingDb.exec.bind(throwingDb);
    throwingDb.exec = (sql: string) => {
      if (sql.startsWith("THIS IS NOT VALID")) throw new Error("syntax error");
      origExec(sql);
    };
    const runner = new MigrationRunner(throwingDb, [M1, M_BAD]);
    const report = runner.run();
    expect(report.failedCount).toBe(1);
    expect(report.results.find((r) => r.version === 2)?.status).toBe("failed");
  });

  it("run report counts match results array", () => {
    const db = new InMemoryDbClient();
    const runner = new MigrationRunner(db, [M1, M2, M3]);
    const report = runner.run();
    const total = report.appliedCount + report.skippedCount + report.failedCount;
    expect(total).toBe(report.results.length);
  });

  it("applies migrations sorted by version regardless of registration order", () => {
    const db = new InMemoryDbClient();
    const runner = new MigrationRunner(db, [M3, M1, M2]); // out of order
    const report = runner.run();
    const versions = report.results.map((r) => r.version);
    expect(versions).toEqual([1, 2, 3]);
  });
});

describe("MigrationRunner – runOne", () => {
  it("applies a specific migration", () => {
    const db = new InMemoryDbClient();
    const runner = new MigrationRunner(db, [M1, M2]);
    const result = runner.runOne(1);
    expect(result.status).toBe("applied");
    expect(result.version).toBe(1);
  });

  it("skips if already applied", () => {
    const db = new InMemoryDbClient();
    const runner = new MigrationRunner(db, [M1]);
    runner.runOne(1);
    const result = runner.runOne(1);
    expect(result.status).toBe("skipped");
  });

  it("returns failed for unknown version", () => {
    const db = new InMemoryDbClient();
    const runner = new MigrationRunner(db, [M1]);
    const result = runner.runOne(99);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("not found");
  });
});

describe("MigrationRunner – pending", () => {
  it("returns all migrations when none applied", () => {
    const db = new InMemoryDbClient();
    const runner = new MigrationRunner(db, [M1, M2]);
    expect(runner.pending()).toHaveLength(2);
  });

  it("returns only unapplied migrations", () => {
    const db = new InMemoryDbClient();
    const runner = new MigrationRunner(db, [M1, M2, M3]);
    runner.runOne(1);
    expect(runner.pending().map((m) => m.version)).toEqual([2, 3]);
  });

  it("returns empty when all applied", () => {
    const db = new InMemoryDbClient();
    const runner = new MigrationRunner(db, [M1]);
    runner.run();
    expect(runner.pending()).toHaveLength(0);
  });
});

describe("MigrationRunner – appliedMigrations", () => {
  it("tracks applied migration names and versions", () => {
    const db = new InMemoryDbClient();
    const runner = new MigrationRunner(db, [M1, M2]);
    runner.run();
    const applied = runner.appliedMigrations();
    expect(applied).toHaveLength(2);
    expect(applied[0]!.version).toBe(1);
    expect(applied[0]!.name).toBe("create_users");
    expect(typeof applied[0]!.appliedAt).toBe("string");
  });
});

// ── SchemaRepair ──────────────────────────────────────────────────────────────

describe("SchemaRepair", () => {
  it("addColumnIfMissing adds column and returns true", () => {
    const db = new InMemoryDbClient();
    db.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)");
    const repair = new SchemaRepair(db);
    const added = repair.addColumnIfMissing("users", "email", "TEXT");
    expect(added).toBe(true);
    expect(db.tableColumns("users")).toContain("email");
  });

  it("addColumnIfMissing skips existing column and returns false", () => {
    const db = new InMemoryDbClient();
    db.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)");
    const repair = new SchemaRepair(db);
    const added = repair.addColumnIfMissing("users", "name", "TEXT");
    expect(added).toBe(false);
  });

  it("rebuildIndex drops and recreates index", () => {
    const db = new InMemoryDbClient();
    db.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id INTEGER)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_user ON sessions (user_id)");
    const repair = new SchemaRepair(db);
    const sql = repair.rebuildIndex("idx_user", "sessions", "user_id");
    expect(sql).toContain("CREATE");
    expect(db.tableIndexes("sessions")).toContain("idx_user");
  });

  it("ensureIndex creates missing index and returns true", () => {
    const db = new InMemoryDbClient();
    db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, kind TEXT)");
    const repair = new SchemaRepair(db);
    const created = repair.ensureIndex("idx_kind", "items", "kind");
    expect(created).toBe(true);
    expect(db.tableIndexes("items")).toContain("idx_kind");
  });

  it("ensureIndex skips existing index and returns false", () => {
    const db = new InMemoryDbClient();
    db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, kind TEXT)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_kind ON items (kind)");
    const repair = new SchemaRepair(db);
    const created = repair.ensureIndex("idx_kind", "items", "kind");
    expect(created).toBe(false);
  });

  it("rebuildIndex creates UNIQUE index when unique=true", () => {
    const db = new InMemoryDbClient();
    db.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT)");
    const repair = new SchemaRepair(db);
    const sql = repair.rebuildIndex("idx_email_unique", "users", "email", true);
    expect(sql).toContain("UNIQUE");
  });

  it("repairAll runs multiple actions and returns log", () => {
    const db = new InMemoryDbClient();
    db.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)");
    const repair = new SchemaRepair(db);
    const log = repair.repairAll([
      { type: "addColumn", table: "users", column: "email", definition: "TEXT" },
      { type: "addColumn", table: "users", column: "name", definition: "TEXT" }, // already exists
      { type: "ensureIndex", indexName: "idx_email", table: "users", columns: "email" },
    ]);
    expect(log).toHaveLength(3);
    expect(log[0]).toContain("added");
    expect(log[1]).toContain("already exists");
    expect(log[2]).toContain("created");
  });

  it("repairAll rebuildIndex entry returns sql in log", () => {
    const db = new InMemoryDbClient();
    db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER, kind TEXT)");
    const repair = new SchemaRepair(db);
    const log = repair.repairAll([
      { type: "rebuildIndex", indexName: "idx_kind", table: "items", columns: "kind" },
    ]);
    expect(log[0]).toContain("rebuilt");
    expect(log[0]).toContain("idx_kind");
  });
});
