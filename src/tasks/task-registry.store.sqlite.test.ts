import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveTaskRegistrySqlitePath } from "./task-registry.paths.js";
import {
  checkTaskRegistrySqliteIntegrity,
  closeTaskRegistrySqliteStore,
  reindexTaskRegistrySqlite,
  upsertTaskRegistryRecordToSqlite,
} from "./task-registry.store.sqlite.js";
import type { TaskRecord } from "./task-registry.types.js";

function createTaskRecordFixture(taskId: string): TaskRecord {
  return {
    taskId,
    runtime: "acp",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    task: "Fixture task",
    status: "running",
    deliveryStatus: "pending",
    notifyPolicy: "done_only",
    createdAt: 100,
  };
}

describe("task registry sqlite integrity", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-task-store-integrity-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(() => {
    closeTaskRegistrySqliteStore();
    delete process.env.OPENCLAW_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("reports exists:false when no database file has been created yet", () => {
    expect(checkTaskRegistrySqliteIntegrity()).toEqual({ exists: false, ok: true, issues: [] });
  });

  it("reports ok for a healthy database", () => {
    upsertTaskRegistryRecordToSqlite(createTaskRecordFixture("task-healthy"));
    closeTaskRegistrySqliteStore();

    expect(checkTaskRegistrySqliteIntegrity()).toEqual({ exists: true, ok: true, issues: [] });
  });

  it("reindex is a no-op on a healthy database and integrity stays ok", () => {
    upsertTaskRegistryRecordToSqlite(createTaskRecordFixture("task-reindex-noop"));
    closeTaskRegistrySqliteStore();

    expect(() => reindexTaskRegistrySqlite()).not.toThrow();
    expect(checkTaskRegistrySqliteIntegrity()).toEqual({ exists: true, ok: true, issues: [] });
  });

  it("detects on-disk corruption via integrity_check", () => {
    upsertTaskRegistryRecordToSqlite(createTaskRecordFixture("task-corrupt"));
    closeTaskRegistrySqliteStore();

    const sqlitePath = resolveTaskRegistrySqlitePath(process.env);
    // Smash a run of bytes past the file header to force a real integrity_check
    // failure without depending on a specific SQLite internal error message.
    const fd = openSync(sqlitePath, "r+");
    try {
      writeSync(fd, Buffer.alloc(256, 0xff), 0, 256, 4096);
    } finally {
      closeSync(fd);
    }

    const report = checkTaskRegistrySqliteIntegrity();
    expect(report.exists).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.issues.length).toBeGreaterThan(0);
  });
});
