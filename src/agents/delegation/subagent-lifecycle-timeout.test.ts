import { beforeEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_ENDED_REASON_ERROR } from "../subagent-lifecycle-events.js";
import { createSubagentRegistryLifecycleController } from "../subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "../subagent-registry.types.js";

const ledgerMocks = vi.hoisted(() => ({
  appendRouteEvent: vi.fn(),
  currentEpoch: vi.fn(() => 4),
  getAssignment: vi.fn(() => ({ assignmentId: "assignment-1", epoch: 4 })),
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
  resolveDelegationGuardConfig: () => ({ mode: "enforce" }),
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

vi.mock("../subagent-registry-helpers.js", () => ({
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS: 30 * 60_000,
  ANNOUNCE_EXPIRY_MS: 5 * 60_000,
  MAX_ANNOUNCE_RETRY_COUNT: 3,
  MIN_ANNOUNCE_RETRY_DELAY_MS: 1_000,
  capFrozenResultText: (text: string) => text.trim(),
  logAnnounceGiveUp: vi.fn(),
  persistSubagentSessionTiming: vi.fn(async () => {}),
  resolveAnnounceRetryDelayMs: () => 1_000,
  safeRemoveAttachmentsDir: vi.fn(async () => {}),
}));

vi.mock("../subagent-result-receipts.js", () => ({
  applySubagentResultReceiptToRun: () => false,
  persistSubagentResultReceiptForRunSync: () => ({ ok: true }),
}));

describe("guarded subagent lifecycle timeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists an actual child run deadline as a terminal route timeout", async () => {
    const entry: SubagentRunRecord = {
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
    const controller = createSubagentRegistryLifecycleController({
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
      captureSubagentCompletionReply: vi.fn(async () => undefined),
      runSubagentAnnounceFlow: vi.fn(async () => false),
      warn: vi.fn(),
    });

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
});
