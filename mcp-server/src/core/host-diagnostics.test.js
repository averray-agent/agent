import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { collectHostDiagnostics } from "./host-diagnostics.js";

test("collectHostDiagnostics reports process, disk, and clean recommendations", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "averray-host-diagnostics-"));

  try {
    const diagnostics = collectHostDiagnostics({
      rootDir: dir,
      paths: [dir],
      now: new Date("2026-05-08T10:00:00.000Z")
    });

    assert.equal(diagnostics.schemaVersion, 1);
    assert.equal(diagnostics.generatedAt, "2026-05-08T10:00:00.000Z");
    assert.equal(diagnostics.mutates, false);
    assert.equal(diagnostics.process.pid, process.pid);
    assert.equal(diagnostics.filesystem.length, 1);
    assert.equal(diagnostics.filesystem[0].exists, true);
    assert.equal(diagnostics.filesystem[0].type, "directory");
    assert.equal(typeof diagnostics.filesystem[0].disk.freeBytes, "number");
    assert.equal(diagnostics.sqliteWal.count, 0);
    assert.ok(diagnostics.recommendations.some((entry) => entry.includes("read-only")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("collectHostDiagnostics detects SQLite WAL files without mutating them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "averray-host-diagnostics-"));
  const walPath = path.join(dir, "store.db-wal");
  fs.writeFileSync(walPath, Buffer.alloc(8));

  try {
    const diagnostics = collectHostDiagnostics({
      rootDir: dir,
      paths: [dir],
      walWarnBytes: 1,
      now: new Date("2026-05-08T10:00:00.000Z")
    });

    assert.equal(diagnostics.sqliteWal.count, 1);
    assert.equal(diagnostics.sqliteWal.largest.path, walPath);
    assert.equal(diagnostics.sqliteWal.largest.sizeBytes, 8);
    assert.ok(diagnostics.warnings.some((entry) => entry.code === "sqlite_wal_large"));
    assert.ok(fs.existsSync(walPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
