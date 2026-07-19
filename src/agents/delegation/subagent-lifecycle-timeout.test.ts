import { beforeEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_ENDED_REASON_ERROR } from "../subagent-lifecycle-events.js";
import { createSubagentRegistryLifecycleController } from "../subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "../subagent-registry.types.js";

const ledgerMocks = vi.hoisted(() => ({
  appendRouteEvent: vi.fn(),
  acceptedReceiptForAssignment: vi.fn(),
  currentEpoch: vi.fn(() => 4),
  guardMode: "enforce" as "audit" | "enforce",
  guardResolutionFails: false,
  getAssignment: vi.fn(() => ({ assignmentId: "assignment-1", epoch: 4 })),
  hasReceiptForAssignment: vi.fn(() => false),
  promoteRecordedTerminalCompletion: vi.fn(),
  recordTerminalResultReceipt: vi.fn(),
  resolveAssignmentForChildSession: vi.fn(() => ({ assignmentId: "assignment-1", epoch: 4 })),
}));

const taskMocks = vi.hoisted(() => ({
  completeTaskRunByRunId: vi.fn(),
  failTaskRunByRunId: vi.fn(),
  setDetachedTaskDeliveryStatusByRunId: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({ loadConfig: () => ({}) }));

vi.mock("./ledger.js", () => ({
  openDelegationLedger: () => ledgerMocks,
}));

vi.mock("./policy.js", () => ({
  resolveDelegationGuardConfig: () => {
    if (ledgerMocks.guardResolutionFails) {
      throw new Error("guard mode unavailable");
    }
    return { mode: ledgerMocks.guardMode };
  },
  resolveDelegationPolicyDigest: () => "policy-digest",
}));

vi.mock("../../tasks/task-executor.js", () => ({
  completeTaskRunByRunId: taskMocks.completeTaskRunByRunId,
  failTaskRunByRunId: taskMocks.failTaskRunByRunId,
  setDetachedTaskDeliveryStatusByRunId: taskMocks.setDetachedTaskDeliveryStatusByRunId,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: { log: vi.fn() },
}));

vi.mock("../../sessions/session-lifecycle-events.js", () => ({
  emitSessionLifecycleEvent: vi.fn(),
}));

vi.mock("../../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
}));

vi.mock("../child-route-health.js", () => ({
  recordChildRouteHealthEvent: vi.fn(async () => ({ ok: true, eventId: "route-event" })),
}));

vi.mock("../subagent-registry-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../subagent-registry-helpers.js")>();
  return {
    ...actual,
    logAnnounceGiveUp: vi.fn(),
    persistSubagentSessionTiming: vi.fn(async () => {}),
    safeRemoveAttachmentsDir: vi.fn(async () => {}),
  };
});

vi.mock("../subagent-result-receipts.js", () => ({
  applySubagentResultReceiptToRun: () => false,
  persistSubagentResultReceiptForRunSync: () => ({ ok: true }),
}));

describe("guarded subagent lifecycle timeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ledgerMocks.guardMode = "enforce";
    ledgerMocks.guardResolutionFails = false;
    ledgerMocks.hasReceiptForAssignment.mockReturnValue(false);
  });

  function createEntry(): SubagentRunRecord {
    return {
      runId: "run-1",
      childSessionKey: "agent:helper:subagent:child-1",
      requesterSessionKey: "agent:planner:main",
      requesterDisplayKey: "planner",
      task: "inspect the finite scope",
      cleanup: "keep",
      createdAt: 1_000,
      startedAt: 2_000,
      delegationAssignmentId: "assignment-1",
    };
  }

  function createController(
    entry: SubagentRunRecord,
    overrides?: {
      recordSubagentSliceTerminalOutcome?: ReturnType<typeof vi.fn>;
      warn?: ReturnType<typeof vi.fn>;
    },
  ) {
    return createSubagentRegistryLifecycleController({
      runs: new Map([[entry.runId, entry]]),
      resumedRuns: new Set(),
      subagentAnnounceTimeoutMs: 1_000,
      persist: vi.fn(),
      clearPendingLifecycleError: vi.fn(),
      countPendingDescendantRuns: () => 0,
      suppressAnnounceForSteerRestart: () => false,
      shouldEmitEndedHookForRun: () => false,
      emitSubagentEndedHookForRun: vi.fn(async () => {}),
      notifyContextEngineSubagentEnded: vi.fn(async () => {}),
      resumeSubagentRun: vi.fn(),
      captureSubagentCompletionReply: vi.fn(async () => "visible completion"),
      runSubagentAnnounceFlow: vi.fn(async () => false),
      recordSubagentSliceTerminalOutcome: overrides?.recordSubagentSliceTerminalOutcome,
      warn: overrides?.warn ?? vi.fn(),
    });
  }

  it("persists an actual child run deadline as a terminal route timeout", async () => {
    const entry = createEntry();
    const controller = createController(entry);

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "timeout" },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      triggerCleanup: false,
    });

    expect(ledgerMocks.appendRouteEvent).toHaveBeenCalledOnce();
    expect(ledgerMocks.appendRouteEvent).toHaveBeenCalledWith({
      assignmentId: "assignment-1",
      kind: "timeout",
      createdAt: 4_000,
      payload: { runId: "run-1", deadlineKind: "run" },
    });
  });

  it("settles a run deadline after report submission as fail-closed validation rejection", async () => {
    ledgerMocks.hasReceiptForAssignment.mockReturnValue(true);
    const entry = createEntry();
    const controller = createController(entry);

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "timeout" },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      triggerCleanup: false,
    });

    expect(ledgerMocks.appendRouteEvent).toHaveBeenCalledOnce();
    expect(ledgerMocks.appendRouteEvent).toHaveBeenCalledWith({
      assignmentId: "assignment-1",
      kind: "validation_rejected",
      createdAt: 4_000,
      payload: {
        runId: "run-1",
        deadlineKind: "run",
        code: "run-timeout-after-report",
      },
    });
    expect(entry.outcome?.status).toBe("timeout");
  });

  it.each(["enforce", "audit"] as const)(
    "records a visible evidence gap when %s timeout persistence fails",
    async (mode) => {
      ledgerMocks.guardMode = mode;
      ledgerMocks.appendRouteEvent.mockImplementationOnce(() => {
        throw new Error("ledger unavailable");
      });
      const entry = createEntry();
      const recordEvidenceGap = vi.fn(() => true);
      const warn = vi.fn();
      const controller = createController(entry, {
        recordSubagentSliceTerminalOutcome: recordEvidenceGap,
        warn,
      });

      await controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "timeout" },
        reason: SUBAGENT_ENDED_REASON_ERROR,
        triggerCleanup: false,
      });

      expect(warn).toHaveBeenCalledWith(
        "failed to persist guarded run deadline",
        expect.objectContaining({ mode }),
      );
      expect(recordEvidenceGap).toHaveBeenCalledWith(
        expect.objectContaining({ evidenceGapKind: "timeout" }),
      );
      expect(entry.outcome?.status).toBe(mode === "enforce" ? "error" : "timeout");
    },
  );

  it("defaults fail-closed when timeout guard-mode resolution fails", async () => {
    ledgerMocks.guardResolutionFails = true;
    const entry = createEntry();
    const recordEvidenceGap = vi.fn(() => true);
    const controller = createController(entry, {
      recordSubagentSliceTerminalOutcome: recordEvidenceGap,
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "timeout" },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      triggerCleanup: false,
    });

    expect(entry.outcome?.status).toBe("error");
    expect(recordEvidenceGap).toHaveBeenCalledWith(
      expect.objectContaining({ evidenceGapKind: "timeout" }),
    );
  });

  it.each([
    ["missing-accepted-report", true],
    ["missing-terminal-receipt", false],
  ] as const)("rejects successful completion with %s", async (code, hasTerminalFields) => {
    const entry = createEntry();
    if (hasTerminalFields) {
      Object.assign(entry, {
        frozenResultText: "visible completion",
        resultReceiptId: "result-1",
        resultReceiptSha256: "a".repeat(64),
        resultReceiptBytes: 18,
        resultReceiptCapturedAt: 3_000,
      });
    }
    ledgerMocks.acceptedReceiptForAssignment.mockReturnValue(undefined);
    const controller = createController(entry);

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      triggerCleanup: false,
    });

    expect(ledgerMocks.appendRouteEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        assignmentId: "assignment-1",
        kind: "validation_rejected",
        payload: expect.objectContaining({ code }),
      }),
    );
    expect(entry.outcome?.status).toBe("error");
  });
});
