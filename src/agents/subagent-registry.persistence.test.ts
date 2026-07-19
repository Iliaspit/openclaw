import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./subagent-registry.mocks.shared.js";
import {
  clearSessionStoreCacheForTest,
  drainSessionStoreLockQueuesForTest,
} from "../config/sessions/store.js";
import { callGateway } from "../gateway/call.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { captureEnv, withEnv } from "../test-utils/env.js";
import { persistSubagentSessionTiming } from "./subagent-registry-helpers.js";
import {
  __testing,
  addSubagentRunForTests,
  clearSubagentRunSteerRestart,
  getLatestSubagentRunByChildSessionKey,
  getSubagentRunByChildSessionKey,
  initSubagentRegistry,
  listSubagentRunsForRequester,
  registerSubagentRun,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";
import {
  createSubagentRegistryTestDeps,
  readSubagentSessionStore,
  removeSubagentSessionEntry,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import {
  loadSubagentRegistryFromDisk,
  resolveSubagentRegistryPath,
  saveSubagentRegistryToDisk,
} from "./subagent-registry.store.js";
import type { SubagentRunRecord, SubagentSliceBudgetRecord } from "./subagent-registry.types.js";

const { announceSpy } = vi.hoisted(() => ({
  announceSpy: vi.fn(async () => true),
}));
vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: announceSpy,
}));

vi.mock("./subagent-orphan-recovery.js", () => ({
  scheduleOrphanRecovery: vi.fn(),
}));

describe("subagent registry persistence", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tempStateDir: string | null = null;

  const resolveAgentIdFromSessionKey = (sessionKey: string) => {
    const match = sessionKey.match(/^agent:([^:]+):/i);
    return (match?.[1] ?? "main").trim().toLowerCase() || "main";
  };

  const writeChildSessionEntry = async (params: {
    sessionKey: string;
    sessionId?: string;
    updatedAt?: number;
  }) => {
    if (!tempStateDir) {
      throw new Error("tempStateDir not initialized");
    }
    const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
    return await writeSubagentSessionEntry({
      stateDir: tempStateDir,
      agentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      updatedAt: params.updatedAt,
      defaultSessionId: `sess-${agentId}-${Date.now()}`,
    });
  };

  const removeChildSessionEntry = async (sessionKey: string) => {
    if (!tempStateDir) {
      throw new Error("tempStateDir not initialized");
    }
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    return await removeSubagentSessionEntry({
      stateDir: tempStateDir,
      agentId,
      sessionKey,
    });
  };

  const seedChildSessionsForPersistedRuns = async (persisted: Record<string, unknown>) => {
    const runs = (persisted.runs ?? {}) as Record<
      string,
      {
        runId?: string;
        childSessionKey?: string;
      }
    >;
    for (const [runId, run] of Object.entries(runs)) {
      const childSessionKey = run?.childSessionKey?.trim();
      if (!childSessionKey) {
        continue;
      }
      await writeChildSessionEntry({
        sessionKey: childSessionKey,
        sessionId: `sess-${run.runId ?? runId}`,
      });
    }
  };

  const writePersistedRegistry = async (
    persisted: Record<string, unknown>,
    opts?: { seedChildSessions?: boolean },
  ) => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    const registryPath = path.join(tempStateDir, "subagents", "runs.json");
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, `${JSON.stringify(persisted)}\n`, "utf8");
    if (opts?.seedChildSessions !== false) {
      await seedChildSessionsForPersistedRuns(persisted);
    }
    return registryPath;
  };

  const readPersistedRun = async <T>(
    registryPath: string,
    runId: string,
  ): Promise<T | undefined> => {
    const parsed = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      runs?: Record<string, unknown>;
    };
    return parsed.runs?.[runId] as T | undefined;
  };

  const createPersistedEndedRun = (params: {
    runId: string;
    childSessionKey: string;
    task: string;
    cleanup: "keep" | "delete";
  }) => {
    const now = Date.now();
    return {
      version: 2,
      runs: {
        [params.runId]: {
          runId: params.runId,
          childSessionKey: params.childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: params.task,
          cleanup: params.cleanup,
          createdAt: now - 2,
          startedAt: now - 1,
          endedAt: now,
        },
      },
    };
  };

  const flushQueuedRegistryWork = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const waitForRegistryWork = async (predicate: () => boolean | Promise<boolean>) => {
    await vi.waitFor(async () => expect(await predicate()).toBe(true), {
      interval: 1,
      timeout: 1_000,
    });
  };

  const restartRegistry = () => {
    resetSubagentRegistryForTests({ persist: false });
    initSubagentRegistry();
  };

  const restartRegistryAndFlush = async () => {
    restartRegistry();
    await flushQueuedRegistryWork();
  };

  const fastPersistSubagentRunsToDisk = (runs: Map<string, SubagentRunRecord>) => {
    const registryPath = tempStateDir
      ? path.join(tempStateDir, "subagents", "runs.json")
      : resolveSubagentRegistryPath();
    fsSync.mkdirSync(path.dirname(registryPath), { recursive: true });
    fsSync.writeFileSync(
      registryPath,
      `${JSON.stringify({ version: 2, runs: Object.fromEntries(runs) })}\n`,
      "utf8",
    );
  };

  beforeEach(() => {
    __testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      persistSubagentRunsToDisk: fastPersistSubagentRunsToDisk,
      runSubagentAnnounceFlow: announceSpy,
    });
    vi.mocked(callGateway).mockReset();
    vi.mocked(callGateway).mockResolvedValue({
      status: "ok",
      startedAt: 111,
      endedAt: 222,
    });
    vi.mocked(onAgentEvent).mockReset();
    vi.mocked(onAgentEvent).mockReturnValue(() => undefined);
  });

  afterEach(async () => {
    announceSpy.mockClear();
    __testing.setDepsForTest();
    resetSubagentRegistryForTests({ persist: false });
    await drainSessionStoreLockQueuesForTest();
    clearSessionStoreCacheForTest();
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      tempStateDir = null;
    }
    envSnapshot.restore();
  });

  it("persists completed subagent timing into the child session entry", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;

    const now = Date.now();
    const startedAt = now;
    const endedAt = now + 500;

    const storePath = await writeChildSessionEntry({
      sessionKey: "agent:main:subagent:timing",
      sessionId: "sess-timing",
      updatedAt: startedAt - 1,
    });
    await persistSubagentSessionTiming({
      runId: "run-session-timing",
      childSessionKey: "agent:main:subagent:timing",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persist timing",
      cleanup: "keep",
      createdAt: startedAt,
      startedAt,
      sessionStartedAt: startedAt,
      accumulatedRuntimeMs: 0,
      endedAt,
      outcome: { status: "ok" },
    } as never);

    const store = await readSubagentSessionStore(storePath);
    const persisted = store["agent:main:subagent:timing"];
    expect(persisted?.endedAt).toBe(endedAt);
    expect(persisted?.runtimeMs).toBe(500);
    expect(persisted?.status).toBe("done");
    expect(persisted?.startedAt).toBeGreaterThanOrEqual(startedAt);
    expect(persisted?.startedAt).toBeLessThanOrEqual(endedAt);
  });

  it("skips cleanup when cleanupCompletedAt was persisted", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;

    const registryPath = path.join(tempStateDir, "subagents", "runs.json");
    const persisted = {
      version: 2,
      runs: {
        "run-2": {
          runId: "run-2",
          childSessionKey: "agent:main:subagent:two",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "do the other thing",
          cleanup: "keep",
          createdAt: 1,
          startedAt: 1,
          endedAt: 2,
          cleanupHandled: true,
          cleanupCompletedAt: 3,
        },
      },
    };
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, `${JSON.stringify(persisted)}\n`, "utf8");
    await writeChildSessionEntry({
      sessionKey: "agent:main:subagent:two",
      sessionId: "sess-two",
    });

    restartRegistry();
    await flushQueuedRegistryWork();

    // announce should NOT be called since cleanup was already completed
    const calls = (announceSpy.mock.calls as unknown as Array<[unknown]>).map((call) => call[0]);
    const match = calls.find(
      (params) =>
        (params as { childSessionKey?: string }).childSessionKey === "agent:main:subagent:two",
    );
    expect(match).toBeFalsy();
  });

  it("retries cleanup when cleanupHandled was persisted without cleanupCompletedAt", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    const now = Date.now();

    const registryPath = path.join(tempStateDir, "subagents", "runs.json");
    const persisted = {
      version: 2,
      runs: {
        "run-interrupted-cleanup": {
          runId: "run-interrupted-cleanup",
          childSessionKey: "agent:main:subagent:interrupted-cleanup",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "retry interrupted cleanup",
          cleanup: "keep",
          createdAt: now - 2_000,
          startedAt: now - 1_000,
          endedAt: now - 500,
          cleanupHandled: true,
        },
      },
    };
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, `${JSON.stringify(persisted)}\n`, "utf8");
    await writeChildSessionEntry({
      sessionKey: "agent:main:subagent:interrupted-cleanup",
      sessionId: "sess-interrupted-cleanup",
    });

    await restartRegistryAndFlush();

    await vi.waitFor(async () => {
      expect(announceSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          childSessionKey: "agent:main:subagent:interrupted-cleanup",
        }),
      );
      const after = await readPersistedRun<{ cleanupCompletedAt?: number }>(
        registryPath,
        "run-interrupted-cleanup",
      );
      expect(after?.cleanupCompletedAt).toBeDefined();
    });
  });

  it("retries interrupted cleanup even when retry bookkeeping was already exhausted", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    const now = Date.now();

    const registryPath = path.join(tempStateDir, "subagents", "runs.json");
    const persisted = {
      version: 2,
      runs: {
        "run-exhausted-interrupted-cleanup": {
          runId: "run-exhausted-interrupted-cleanup",
          childSessionKey: "agent:main:subagent:exhausted-interrupted-cleanup",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "retry exhausted interrupted cleanup",
          cleanup: "keep",
          createdAt: now - 10 * 60_000,
          startedAt: now - 9 * 60_000,
          endedAt: now - 8 * 60_000,
          cleanupHandled: true,
          announceRetryCount: 3,
          lastAnnounceRetryAt: now - 7 * 60_000,
        },
      },
    };
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, `${JSON.stringify(persisted)}\n`, "utf8");
    await writeChildSessionEntry({
      sessionKey: "agent:main:subagent:exhausted-interrupted-cleanup",
      sessionId: "sess-exhausted-interrupted-cleanup",
    });

    await restartRegistryAndFlush();

    await vi.waitFor(async () => {
      expect(announceSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          childSessionKey: "agent:main:subagent:exhausted-interrupted-cleanup",
        }),
      );
      const after = await readPersistedRun<{
        cleanupCompletedAt?: number;
        announceRetryCount?: number;
      }>(registryPath, "run-exhausted-interrupted-cleanup");
      expect(after?.cleanupCompletedAt).toBeDefined();
      expect(after?.announceRetryCount).toBeUndefined();
    });
  });

  it("maps legacy announce fields into cleanup state", async () => {
    const persisted = {
      version: 1,
      runs: {
        "run-legacy": {
          runId: "run-legacy",
          childSessionKey: "agent:main:subagent:legacy",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "legacy announce",
          cleanup: "keep",
          createdAt: 1,
          startedAt: 1,
          endedAt: 2,
          announceCompletedAt: 9,
          announceHandled: true,
          requesterChannel: "whatsapp",
          requesterAccountId: "legacy-account",
        },
      },
    };
    const registryPath = await writePersistedRegistry(persisted);

    const runs = loadSubagentRegistryFromDisk();
    const entry = runs.get("run-legacy");
    expect(entry?.cleanupHandled).toBe(true);
    expect(entry?.cleanupCompletedAt).toBe(9);
    expect(entry?.requesterOrigin?.channel).toBe("whatsapp");
    expect(entry?.requesterOrigin?.accountId).toBe("legacy-account");

    const after = JSON.parse(await fs.readFile(registryPath, "utf8")) as { version?: number };
    expect(after.version).toBe(2);
  });

  it("restores raw stop reason and model completion metadata", async () => {
    await writePersistedRegistry({
      version: 2,
      runs: {
        "run-truncated-restart": {
          runId: "run-truncated-restart",
          childSessionKey: "agent:main:subagent:truncated-restart",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "resume truncated evidence",
          cleanup: "keep",
          createdAt: 1,
          endedAt: 2,
          frozenResultText: "incomplete handoff",
          rawCompletionStopReason: "max_tokens",
          modelCompletion: "truncated",
          frozenResultRuntimeCapped: false,
          frozenResultOriginalBytes: 18,
        },
      },
    });

    expect(loadSubagentRegistryFromDisk().get("run-truncated-restart")).toMatchObject({
      rawCompletionStopReason: "max_tokens",
      modelCompletion: "truncated",
      frozenResultRuntimeCapped: false,
      frozenResultOriginalBytes: 18,
    });
  });

  it("normalizes persisted and newly registered session keys to canonical trimmed values", async () => {
    const persisted = {
      version: 2,
      runs: {
        "run-spaced": {
          runId: "run-spaced",
          childSessionKey: " agent:main:subagent:spaced-child ",
          controllerSessionKey: " agent:main:subagent:controller ",
          requesterSessionKey: " agent:main:main ",
          requesterDisplayKey: "main",
          task: "spaced persisted keys",
          cleanup: "keep",
          createdAt: 1,
          startedAt: 1,
        },
      },
    };
    await writePersistedRegistry(persisted, { seedChildSessions: false });

    const restored = loadSubagentRegistryFromDisk();
    const restoredEntry = restored.get("run-spaced");
    expect(restoredEntry).toMatchObject({
      childSessionKey: "agent:main:subagent:spaced-child",
      controllerSessionKey: "agent:main:subagent:controller",
      requesterSessionKey: "agent:main:main",
    });

    resetSubagentRegistryForTests({ persist: false });
    addSubagentRunForTests(restoredEntry as never);
    expect(listSubagentRunsForRequester("agent:main:main")).toEqual([
      expect.objectContaining({
        runId: "run-spaced",
      }),
    ]);
    expect(getSubagentRunByChildSessionKey("agent:main:subagent:spaced-child")).toMatchObject({
      runId: "run-spaced",
    });

    resetSubagentRegistryForTests({ persist: false });
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;

    vi.mocked(callGateway).mockImplementationOnce(async () => await new Promise(() => {}));

    registerSubagentRun({
      runId: " run-live ",
      childSessionKey: " agent:main:subagent:live-child ",
      controllerSessionKey: " agent:main:subagent:live-controller ",
      requesterSessionKey: " agent:main:main ",
      requesterDisplayKey: "main",
      task: "live spaced keys",
      cleanup: "keep",
    });

    expect(listSubagentRunsForRequester("agent:main:main")).toEqual([
      expect.objectContaining({
        runId: "run-live",
        childSessionKey: "agent:main:subagent:live-child",
        controllerSessionKey: "agent:main:subagent:live-controller",
        requesterSessionKey: "agent:main:main",
      }),
    ]);
    expect(getSubagentRunByChildSessionKey("agent:main:subagent:live-child")).toMatchObject({
      runId: "run-live",
    });
  });

  it("retries cleanup announce after a failed announce", async () => {
    const persisted = createPersistedEndedRun({
      runId: "run-3",
      childSessionKey: "agent:main:subagent:three",
      task: "retry announce",
      cleanup: "keep",
    });
    const registryPath = await writePersistedRegistry(persisted);

    announceSpy.mockResolvedValueOnce(false);
    restartRegistry();
    await waitForRegistryWork(async () => {
      const afterFirst = await readPersistedRun<{
        cleanupHandled?: boolean;
        cleanupCompletedAt?: number;
      }>(registryPath, "run-3");
      return (
        announceSpy.mock.calls.length === 1 &&
        afterFirst?.cleanupHandled === false &&
        afterFirst.cleanupCompletedAt === undefined
      );
    });

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const afterFirst = await readPersistedRun<{
      cleanupHandled?: boolean;
      cleanupCompletedAt?: number;
    }>(registryPath, "run-3");
    expect(afterFirst?.cleanupHandled).toBe(false);
    expect(afterFirst?.cleanupCompletedAt).toBeUndefined();

    announceSpy.mockResolvedValueOnce(true);
    restartRegistry();
    await waitForRegistryWork(async () => {
      const afterSecond = await readPersistedRun<{
        cleanupCompletedAt?: number;
      }>(registryPath, "run-3");
      return announceSpy.mock.calls.length === 2 && afterSecond?.cleanupCompletedAt != null;
    });

    expect(announceSpy).toHaveBeenCalledTimes(2);
    const afterSecond = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      runs: Record<string, { cleanupCompletedAt?: number }>;
    };
    expect(afterSecond.runs["run-3"].cleanupCompletedAt).toBeDefined();
  });

  it("retries cleanup announce after announce flow rejects", async () => {
    const persisted = createPersistedEndedRun({
      runId: "run-reject",
      childSessionKey: "agent:main:subagent:reject",
      task: "reject announce",
      cleanup: "keep",
    });
    const registryPath = await writePersistedRegistry(persisted);

    announceSpy.mockRejectedValueOnce(new Error("announce boom"));
    restartRegistry();
    await waitForRegistryWork(async () => {
      const afterFirst = await readPersistedRun<{
        cleanupHandled?: boolean;
        cleanupCompletedAt?: number;
      }>(registryPath, "run-reject");
      return (
        announceSpy.mock.calls.length === 1 &&
        afterFirst?.cleanupHandled === false &&
        afterFirst.cleanupCompletedAt === undefined
      );
    });

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const afterFirst = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      runs: Record<string, { cleanupHandled?: boolean; cleanupCompletedAt?: number }>;
    };
    expect(afterFirst.runs["run-reject"].cleanupHandled).toBe(false);
    expect(afterFirst.runs["run-reject"].cleanupCompletedAt).toBeUndefined();

    announceSpy.mockResolvedValueOnce(true);
    restartRegistry();
    await waitForRegistryWork(async () => {
      const afterSecond = await readPersistedRun<{
        cleanupCompletedAt?: number;
      }>(registryPath, "run-reject");
      return announceSpy.mock.calls.length === 2 && afterSecond?.cleanupCompletedAt != null;
    });

    expect(announceSpy).toHaveBeenCalledTimes(2);
    const afterSecond = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      runs: Record<string, { cleanupCompletedAt?: number }>;
    };
    expect(afterSecond.runs["run-reject"].cleanupCompletedAt).toBeDefined();
  });

  it("keeps delete-mode runs retryable when announce is deferred", async () => {
    const persisted = createPersistedEndedRun({
      runId: "run-4",
      childSessionKey: "agent:main:subagent:four",
      task: "deferred announce",
      cleanup: "delete",
    });
    const registryPath = await writePersistedRegistry(persisted);

    announceSpy.mockResolvedValueOnce(false);
    restartRegistry();
    await waitForRegistryWork(async () => {
      const afterFirst = await readPersistedRun<{ cleanupHandled?: boolean }>(
        registryPath,
        "run-4",
      );
      return announceSpy.mock.calls.length === 1 && afterFirst?.cleanupHandled === false;
    });

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const afterFirst = await readPersistedRun<{ cleanupHandled?: boolean }>(registryPath, "run-4");
    expect(afterFirst?.cleanupHandled).toBe(false);

    announceSpy.mockResolvedValueOnce(true);
    restartRegistry();
    await waitForRegistryWork(async () => {
      const afterSecond = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
        runs?: Record<string, unknown>;
      };
      return announceSpy.mock.calls.length === 2 && afterSecond.runs?.["run-4"] === undefined;
    });

    expect(announceSpy).toHaveBeenCalledTimes(2);
    const afterSecond = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      runs?: Record<string, unknown>;
    };
    expect(afterSecond.runs?.["run-4"]).toBeUndefined();
  });

  it("reconciles orphaned restored runs by pruning them from registry", async () => {
    const persisted = createPersistedEndedRun({
      runId: "run-orphan-restore",
      childSessionKey: "agent:main:subagent:ghost-restore",
      task: "orphan restore",
      cleanup: "keep",
    });
    const registryPath = await writePersistedRegistry(persisted, {
      seedChildSessions: false,
    });

    restartRegistry();
    await waitForRegistryWork(async () => {
      const after = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
        runs?: Record<string, unknown>;
      };
      return after.runs?.["run-orphan-restore"] === undefined;
    });

    expect(announceSpy).not.toHaveBeenCalled();
    const after = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      runs?: Record<string, unknown>;
    };
    expect(after.runs?.["run-orphan-restore"]).toBeUndefined();
    expect(listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
  });

  it("removes attachments when pruning orphaned restored runs", async () => {
    const persisted = createPersistedEndedRun({
      runId: "run-orphan-attachments",
      childSessionKey: "agent:main:subagent:ghost-attachments",
      task: "orphan attachments",
      cleanup: "delete",
    });
    const registryPath = await writePersistedRegistry(persisted, {
      seedChildSessions: false,
    });
    if (!tempStateDir) {
      throw new Error("tempStateDir not initialized");
    }
    const attachmentsRootDir = path.join(tempStateDir, "attachments");
    const attachmentsDir = path.join(attachmentsRootDir, "ghost");
    await fs.mkdir(attachmentsDir, { recursive: true });
    await fs.writeFile(path.join(attachmentsDir, "artifact.txt"), "artifact", "utf8");
    const parsed = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      runs?: Record<string, Record<string, unknown>>;
    };
    if (!parsed.runs?.["run-orphan-attachments"]) {
      throw new Error("expected orphaned run in persisted registry");
    }
    parsed.runs["run-orphan-attachments"] = {
      ...parsed.runs["run-orphan-attachments"],
      attachmentsRootDir,
      attachmentsDir,
    };
    await fs.writeFile(registryPath, `${JSON.stringify(parsed)}\n`, "utf8");

    restartRegistry();
    await waitForRegistryWork(async () => {
      try {
        await fs.access(attachmentsDir);
        return false;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "ENOENT";
      }
    });

    await expect(fs.access(attachmentsDir)).rejects.toMatchObject({ code: "ENOENT" });
    const after = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      runs?: Record<string, unknown>;
    };
    expect(after.runs?.["run-orphan-attachments"]).toBeUndefined();
  });

  it("prefers active runs and can resolve them from persisted registry snapshots", async () => {
    const childSessionKey = "agent:main:subagent:disk-active";
    await writePersistedRegistry(
      {
        version: 2,
        runs: {
          "run-complete": {
            runId: "run-complete",
            childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "completed first",
            cleanup: "keep",
            createdAt: 200,
            startedAt: 210,
            endedAt: 220,
            outcome: { status: "ok" },
          },
          "run-active": {
            runId: "run-active",
            childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "still running",
            cleanup: "keep",
            createdAt: 100,
            startedAt: 110,
          },
        },
      },
      { seedChildSessions: false },
    );

    resetSubagentRegistryForTests({ persist: false });

    const resolved = withEnv({ VITEST: undefined, NODE_ENV: "development" }, () =>
      getSubagentRunByChildSessionKey(childSessionKey),
    );

    expect(resolved).toMatchObject({
      runId: "run-active",
      childSessionKey,
    });
    expect(resolved?.endedAt).toBeUndefined();
  });

  it("can resolve the newest child-session row even when an older stale row is still active", async () => {
    const childSessionKey = "agent:main:subagent:disk-latest";
    await writePersistedRegistry(
      {
        version: 2,
        runs: {
          "run-current-ended": {
            runId: "run-current-ended",
            childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "completed latest",
            cleanup: "keep",
            createdAt: 200,
            startedAt: 210,
            endedAt: 220,
            outcome: { status: "ok" },
          },
          "run-stale-active": {
            runId: "run-stale-active",
            childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "stale active",
            cleanup: "keep",
            createdAt: 100,
            startedAt: 110,
          },
        },
      },
      { seedChildSessions: false },
    );

    resetSubagentRegistryForTests({ persist: false });

    const resolved = withEnv({ VITEST: undefined, NODE_ENV: "development" }, () =>
      getLatestSubagentRunByChildSessionKey(childSessionKey),
    );

    expect(resolved).toMatchObject({
      runId: "run-current-ended",
      childSessionKey,
    });
    expect(resolved?.endedAt).toBe(220);
  });

  it("resume guard prunes orphan runs before announce retry", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    const runId = "run-orphan-resume-guard";
    const childSessionKey = "agent:main:subagent:ghost-resume";
    const now = Date.now();

    await writeChildSessionEntry({
      sessionKey: childSessionKey,
      sessionId: "sess-resume-guard",
      updatedAt: now,
    });
    addSubagentRunForTests({
      runId,
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "resume orphan guard",
      cleanup: "keep",
      createdAt: now - 50,
      startedAt: now - 25,
      endedAt: now,
      suppressAnnounceReason: "steer-restart",
      cleanupHandled: false,
    });
    await removeChildSessionEntry(childSessionKey);

    const changed = clearSubagentRunSteerRestart(runId);
    expect(changed).toBe(true);
    await flushQueuedRegistryWork();

    expect(announceSpy).not.toHaveBeenCalled();
    expect(listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
    const persisted = loadSubagentRegistryFromDisk();
    expect(persisted.has(runId)).toBe(false);
  });

  it("persists slice budgets across registry reloads", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    const budget: SubagentSliceBudgetRecord = {
      sliceKey: "subagent-slice:persistent-budget",
      requesterSessionKey: "agent:planner-2:main",
      delegationAssignmentId: "assignment_persistent",
      delegationSliceId: "slice_persistent",
      delegationEpoch: 11,
      targetAgentId: "implementer",
      label: "contract-v2-recovery",
      sliceRole: "review",
      sliceBoundary: "post_full_gate_followup",
      parentSliceKey: "subagent-slice:original-budget",
      taskSha256: "a".repeat(64),
      discriminatorKind: "label",
      firstObservedAt: 1_000,
      lastObservedAt: 2_000,
      childSpawnCount: 2,
      childTimeoutCount: 2,
      childTimeoutRunIds: ["run-timeout-1", "run-timeout-2"],
      childTimeoutSessionKeys: [
        "agent:implementer:subagent:timeout-1",
        "agent:implementer:subagent:timeout-2",
      ],
      terminalEvidenceGapCount: 2,
      terminalEvidenceGapRunIds: ["run-timeout-1", "run-timeout-2"],
      lastTerminalEvidenceGapKind: "timeout",
      childRouteHealthUnavailableCount: 0,
      childRouteHealthUnavailableChildSessionKeys: [],
      fullE2EGateGreen: "unknown",
      fullE2EGateSignal: "unavailable",
    };

    saveSubagentRegistryToDisk(new Map(), new Map([[budget.sliceKey, budget]]));

    const loaded = loadSubagentRegistryFromDisk();
    expect(loaded.size).toBe(0);
    expect(loaded.sliceBudgets?.get(budget.sliceKey)).toMatchObject({
      sliceKey: budget.sliceKey,
      delegationAssignmentId: "assignment_persistent",
      delegationSliceId: "slice_persistent",
      delegationEpoch: 11,
      childSpawnCount: 2,
      childTimeoutCount: 2,
      childTimeoutRunIds: ["run-timeout-1", "run-timeout-2"],
      sliceRole: "review",
      sliceBoundary: "post_full_gate_followup",
      parentSliceKey: "subagent-slice:original-budget",
      fullE2EGateGreen: "unknown",
      fullE2EGateSignal: "unavailable",
    });
  });

  it("uses isolated temp state when OPENCLAW_STATE_DIR is unset in tests", async () => {
    delete process.env.OPENCLAW_STATE_DIR;
    const registryPath = resolveSubagentRegistryPath();
    expect(registryPath).toContain(path.join(os.tmpdir(), "openclaw-test-state"));
  });
});
