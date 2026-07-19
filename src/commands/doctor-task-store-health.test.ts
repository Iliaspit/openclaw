import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";

const noteMock = vi.hoisted(() => vi.fn());
const checkTaskRegistrySqliteIntegrityMock = vi.hoisted(() => vi.fn());
const reindexTaskRegistrySqliteMock = vi.hoisted(() => vi.fn());

vi.mock("../terminal/note.js", () => ({
  note: noteMock,
}));

vi.mock("../tasks/task-registry.store.sqlite.js", () => ({
  checkTaskRegistrySqliteIntegrity: checkTaskRegistrySqliteIntegrityMock,
  reindexTaskRegistrySqlite: reindexTaskRegistrySqliteMock,
}));

import { noteTaskStoreHealth } from "./doctor-task-store-health.js";

function createPrompter(confirmResult: boolean) {
  return {
    confirmRuntimeRepair: vi.fn(async () => confirmResult),
  };
}

describe("noteTaskStoreHealth", () => {
  let stateDir: string;
  let envSnapshot: ReturnType<typeof captureEnv>;
  let sqlitePath: string;

  beforeEach(() => {
    noteMock.mockClear();
    checkTaskRegistrySqliteIntegrityMock.mockReset();
    reindexTaskRegistrySqliteMock.mockReset();
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    stateDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-task-store-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    sqlitePath = path.join(stateDir, "tasks", "runs.sqlite");
  });

  afterEach(() => {
    envSnapshot.restore();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("does nothing when the store reports ok", async () => {
    checkTaskRegistrySqliteIntegrityMock.mockReturnValue({ exists: true, ok: true, issues: [] });
    const prompter = createPrompter(true);

    await noteTaskStoreHealth(prompter);

    expect(noteMock).not.toHaveBeenCalled();
    expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
  });

  it("does nothing when no database file exists yet", async () => {
    checkTaskRegistrySqliteIntegrityMock.mockReturnValue({ exists: false, ok: true, issues: [] });
    const prompter = createPrompter(true);

    await noteTaskStoreHealth(prompter);

    expect(noteMock).not.toHaveBeenCalled();
  });

  it("warns but does not offer repair for structural corruption", async () => {
    checkTaskRegistrySqliteIntegrityMock.mockReturnValue({
      exists: true,
      ok: false,
      issues: ["database disk image is malformed"],
    });
    const prompter = createPrompter(true);

    await noteTaskStoreHealth(prompter);

    expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
    expect(reindexTaskRegistrySqliteMock).not.toHaveBeenCalled();
    expect(noteMock).toHaveBeenCalledTimes(1);
    const [message, title] = noteMock.mock.calls[0] as [string, string];
    expect(title).toBe("Task store");
    expect(message).toContain("structural");
    expect(message).toContain(".recover");
  });

  it("offers reindex for index-only corruption and reports success after verifying", async () => {
    checkTaskRegistrySqliteIntegrityMock
      .mockReturnValueOnce({
        exists: true,
        ok: false,
        issues: ["wrong # of entries in index idx_task_runs_owner_key"],
      })
      .mockReturnValueOnce({ exists: true, ok: true, issues: [] });
    const prompter = createPrompter(true);

    await noteTaskStoreHealth(prompter);

    expect(prompter.confirmRuntimeRepair).toHaveBeenCalledTimes(1);
    expect(reindexTaskRegistrySqliteMock).toHaveBeenCalledTimes(1);
    expect(noteMock).toHaveBeenCalledTimes(2);
    const [, secondCall] = noteMock.mock.calls;
    const [message] = secondCall as [string, string];
    expect(message).toContain("Reindexed");
    expect(message).toContain("restart the gateway");
    expect(message).toContain("pick up the repair automatically");
  });

  it("backs up sidecar files before reindexing when the user confirms", async () => {
    checkTaskRegistrySqliteIntegrityMock
      .mockReturnValueOnce({
        exists: true,
        ok: false,
        issues: ["wrong # of entries in index idx_task_runs_owner_key"],
      })
      .mockReturnValueOnce({ exists: true, ok: true, issues: [] });
    const prompter = createPrompter(true);
    mkdirSync(path.dirname(sqlitePath), { recursive: true });
    writeFileSync(sqlitePath, "sqlite-fixture");
    writeFileSync(`${sqlitePath}-wal`, "wal-fixture");

    await noteTaskStoreHealth(prompter);

    const [, secondCall] = noteMock.mock.calls;
    const [message] = secondCall as [string, string];
    expect(message).toContain("Backed up");
    expect(message).toContain("runs.sqlite.bak.");
    expect(message).toContain("runs.sqlite-wal.bak.");
  });

  it("does not reindex when the user declines repair", async () => {
    checkTaskRegistrySqliteIntegrityMock.mockReturnValue({
      exists: true,
      ok: false,
      issues: ["wrong # of entries in index idx_task_runs_owner_key"],
    });
    const prompter = createPrompter(false);

    await noteTaskStoreHealth(prompter);

    expect(prompter.confirmRuntimeRepair).toHaveBeenCalledTimes(1);
    expect(reindexTaskRegistrySqliteMock).not.toHaveBeenCalled();
    expect(noteMock).toHaveBeenCalledTimes(1);
  });

  it("reports still-broken integrity after reindex without claiming success", async () => {
    checkTaskRegistrySqliteIntegrityMock
      .mockReturnValueOnce({
        exists: true,
        ok: false,
        issues: ["wrong # of entries in index idx_task_runs_owner_key"],
      })
      .mockReturnValueOnce({
        exists: true,
        ok: false,
        issues: ["wrong # of entries in index idx_task_runs_owner_key"],
      });
    const prompter = createPrompter(true);

    await noteTaskStoreHealth(prompter);

    const [, secondCall] = noteMock.mock.calls;
    const [message] = secondCall as [string, string];
    expect(message).toContain("still reports issues");
    expect(message).toContain(".recover");
  });

  it("reports a check failure without throwing", async () => {
    checkTaskRegistrySqliteIntegrityMock.mockImplementation(() => {
      throw new Error("boom");
    });
    const prompter = createPrompter(true);

    await expect(noteTaskStoreHealth(prompter)).resolves.toBeUndefined();

    expect(noteMock).toHaveBeenCalledTimes(1);
    const [message] = noteMock.mock.calls[0] as [string, string];
    expect(message).toContain("Failed to check task registry integrity");
  });

  it("does not attempt to back up sidecar files that do not exist", async () => {
    expect(existsSync(sqlitePath)).toBe(false);
    checkTaskRegistrySqliteIntegrityMock
      .mockReturnValueOnce({
        exists: true,
        ok: false,
        issues: ["wrong # of entries in index idx_task_runs_owner_key"],
      })
      .mockReturnValueOnce({ exists: true, ok: true, issues: [] });
    const prompter = createPrompter(true);

    await noteTaskStoreHealth(prompter);

    const [, secondCall] = noteMock.mock.calls;
    const [message] = secondCall as [string, string];
    expect(message).not.toContain("Backed up");
  });
});
