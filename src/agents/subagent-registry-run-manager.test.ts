import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createRunningTaskRun } from "../tasks/task-executor.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type RunManagerParams = Parameters<typeof createSubagentRunManager>[0];

const waitMocks = vi.hoisted(() => ({
  waitForAgentRun: vi.fn(),
}));

const createRunningTaskRunMock = vi.mocked(createRunningTaskRun);

vi.mock("./run-wait.js", () => ({
  waitForAgentRun: waitMocks.waitForAgentRun,
}));

vi.mock("../tasks/task-executor.js", () => ({
  createRunningTaskRun: vi.fn(),
  reassignTaskRunByRunId: vi.fn(),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

function createRunEntry(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:planner-helper:subagent:child",
    requesterSessionKey: "agent:planner:main",
    requesterDisplayKey: "planner",
    task: "audit typed dispatch",
    cleanup: "keep",
    createdAt: 1_000,
    startedAt: 2_000,
    ...overrides,
  };
}

function createManager(params: {
  entry: SubagentRunRecord;
  persist?: () => void;
  completeSubagentRun?: RunManagerParams["completeSubagentRun"];
}) {
  const runs = new Map([[params.entry.runId, params.entry]]);
  return createSubagentRunManager({
    runs,
    resumedRuns: new Set(),
    endedHookInFlightRunIds: new Set(),
    persist: params.persist ?? vi.fn(),
    callGateway: vi.fn() as never,
    loadConfig: () => ({}) as OpenClawConfig,
    ensureRuntimePluginsLoaded: vi.fn(),
    ensureListener: vi.fn(),
    startSweeper: vi.fn(),
    stopSweeper: vi.fn(),
    resumeSubagentRun: vi.fn(),
    clearPendingLifecycleError: vi.fn(),
    resolveSubagentWaitTimeoutMs: vi.fn(() => 100),
    notifyContextEngineSubagentEnded: vi.fn(async () => {}),
    completeCleanupBookkeeping: vi.fn(),
    completeSubagentRun: params.completeSubagentRun ?? vi.fn(async () => {}),
  });
}

describe("subagent registry run manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects registration when background task creation fails", () => {
    const runs = new Map<string, SubagentRunRecord>();
    const persist = vi.fn();
    const ensureListener = vi.fn();
    const startSweeper = vi.fn();
    const recordSubagentSliceSpawn = vi.fn();
    const manager = createSubagentRunManager({
      runs,
      resumedRuns: new Set(),
      endedHookInFlightRunIds: new Set(),
      persist,
      callGateway: vi.fn() as never,
      loadConfig: () => ({}) as OpenClawConfig,
      ensureRuntimePluginsLoaded: vi.fn(),
      ensureListener,
      startSweeper,
      stopSweeper: vi.fn(),
      resumeSubagentRun: vi.fn(),
      clearPendingLifecycleError: vi.fn(),
      resolveSubagentWaitTimeoutMs: vi.fn(() => 100),
      notifyContextEngineSubagentEnded: vi.fn(async () => {}),
      completeCleanupBookkeeping: vi.fn(),
      completeSubagentRun: vi.fn(async () => {}),
      recordSubagentSliceSpawn,
    });
    createRunningTaskRunMock.mockImplementationOnce(() => {
      throw new Error("task store boom");
    });

    expect(() =>
      manager.registerSubagentRun({
        runId: "run-register-failure",
        childSessionKey: "agent:planner-helper:subagent:register-failure",
        requesterSessionKey: "agent:planner:main",
        requesterDisplayKey: "planner",
        task: "audit typed dispatch",
        cleanup: "keep",
      }),
    ).toThrow("task store boom");

    expect(runs.size).toBe(0);
    expect(recordSubagentSliceSpawn).not.toHaveBeenCalled();
    expect(ensureListener).not.toHaveBeenCalled();
    expect(startSweeper).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("rejects partial protected scope before registering a run", () => {
    const runs = new Map<string, SubagentRunRecord>();
    const recordSubagentSliceSpawn = vi.fn();
    const manager = createSubagentRunManager({
      runs,
      resumedRuns: new Set(),
      endedHookInFlightRunIds: new Set(),
      persist: vi.fn(),
      callGateway: vi.fn() as never,
      loadConfig: () => ({}) as OpenClawConfig,
      ensureRuntimePluginsLoaded: vi.fn(),
      ensureListener: vi.fn(),
      startSweeper: vi.fn(),
      stopSweeper: vi.fn(),
      resumeSubagentRun: vi.fn(),
      clearPendingLifecycleError: vi.fn(),
      resolveSubagentWaitTimeoutMs: vi.fn(() => 100),
      notifyContextEngineSubagentEnded: vi.fn(async () => {}),
      completeCleanupBookkeeping: vi.fn(),
      completeSubagentRun: vi.fn(async () => {}),
      recordSubagentSliceSpawn,
    });

    expect(() =>
      manager.registerSubagentRun({
        runId: "run-partial-protected",
        delegationAssignmentId: "assignment_partial",
        childSessionKey: "agent:planner-helper:subagent:partial",
        requesterSessionKey: "agent:planner:main",
        requesterDisplayKey: "planner",
        task: "audit typed dispatch",
        cleanup: "keep",
      }),
    ).toThrow("requires exact assignment, slice, and epoch");

    expect(runs.size).toBe(0);
    expect(createRunningTaskRunMock).not.toHaveBeenCalled();
    expect(recordSubagentSliceSpawn).not.toHaveBeenCalled();
  });

  it("registers and replaces protected scope only as one exact unit", () => {
    const runs = new Map<string, SubagentRunRecord>();
    const recordSubagentSliceSpawn = vi.fn();
    const manager = createSubagentRunManager({
      runs,
      resumedRuns: new Set(),
      endedHookInFlightRunIds: new Set(),
      persist: vi.fn(),
      callGateway: vi.fn() as never,
      loadConfig: () => ({}) as OpenClawConfig,
      ensureRuntimePluginsLoaded: vi.fn(),
      ensureListener: vi.fn(),
      startSweeper: vi.fn(),
      stopSweeper: vi.fn(),
      resumeSubagentRun: vi.fn(),
      clearPendingLifecycleError: vi.fn(),
      resolveSubagentWaitTimeoutMs: vi.fn(() => 100),
      notifyContextEngineSubagentEnded: vi.fn(async () => {}),
      completeCleanupBookkeeping: vi.fn(),
      completeSubagentRun: vi.fn(async () => {}),
      recordSubagentSliceSpawn,
    });
    waitMocks.waitForAgentRun.mockResolvedValue({ status: "pending" });

    manager.registerSubagentRun({
      runId: "run-protected",
      delegationAssignmentId: "assignment_original",
      delegationSliceId: "slice_original",
      delegationEpoch: 11,
      childSessionKey: "agent:planner-helper:subagent:protected",
      requesterSessionKey: "agent:planner:main",
      requesterDisplayKey: "planner",
      task: "audit typed dispatch",
      cleanup: "keep",
    });
    expect(runs.get("run-protected")).toMatchObject({
      delegationAssignmentId: "assignment_original",
      delegationSliceId: "slice_original",
      delegationEpoch: 11,
    });
    Object.assign(runs.get("run-protected") as SubagentRunRecord, {
      frozenResultText: "old truncated result",
      modelCompletion: "truncated",
      rawCompletionStopReason: "length",
      frozenResultRuntimeCapped: true,
      frozenResultOriginalBytes: 200_000,
    });

    expect(() =>
      manager.replaceSubagentRunAfterSteer({
        previousRunId: "run-protected",
        nextRunId: "run-partial-replacement",
        delegationAssignmentId: "assignment_partial_replacement",
      }),
    ).toThrow("requires exact assignment, slice, and epoch");
    expect(runs.has("run-protected")).toBe(true);
    expect(runs.has("run-partial-replacement")).toBe(false);

    expect(
      manager.replaceSubagentRunAfterSteer({
        previousRunId: "run-protected",
        nextRunId: "run-protected-replacement",
        delegationAssignmentId: "assignment_replacement",
        delegationSliceId: "slice_replacement",
        delegationEpoch: 12,
      }),
    ).toBe(true);
    expect(runs.get("run-protected-replacement")).toMatchObject({
      delegationAssignmentId: "assignment_replacement",
      delegationSliceId: "slice_replacement",
      delegationEpoch: 12,
      frozenResultText: undefined,
      modelCompletion: undefined,
      rawCompletionStopReason: undefined,
      frozenResultRuntimeCapped: undefined,
      frozenResultOriginalBytes: undefined,
    });
  });

  it("terminalizes unexpected wait errors as failed child runs", async () => {
    const entry = createRunEntry();
    const persist = vi.fn();
    const completeSubagentRun = vi.fn(async () => {});
    const manager = createManager({ entry, persist, completeSubagentRun });
    waitMocks.waitForAgentRun.mockRejectedValueOnce(
      new Error("gateway closed (1012): service restart"),
    );

    await manager.waitForSubagentCompletion(entry.runId, 10_000, entry);

    expect(entry.endedAt).toBeTypeOf("number");
    expect(entry.outcome).toMatchObject({
      status: "error",
      error: "gateway closed (1012): service restart",
    });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(completeSubagentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        endedAt: entry.endedAt,
        outcome: expect.objectContaining({
          status: "error",
          error: "gateway closed (1012): service restart",
        }),
        reason: SUBAGENT_ENDED_REASON_ERROR,
        sendFarewell: true,
        triggerCleanup: true,
      }),
    );
  });

  it("threads agent.wait stop reasons into terminal result capture", async () => {
    const entry = createRunEntry({ runId: "run-wait-stop" });
    const completeSubagentRun = vi.fn(async () => {});
    const manager = createManager({ entry, completeSubagentRun });
    waitMocks.waitForAgentRun.mockResolvedValueOnce({
      status: "ok",
      endedAt: 4_000,
      rawCompletionStopReason: "max_tokens",
    });

    await manager.waitForSubagentCompletion(entry.runId, 10_000, entry);

    expect(completeSubagentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        rawCompletionStopReason: "max_tokens",
      }),
    );
  });
});
