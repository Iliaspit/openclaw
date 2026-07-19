import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
} from "./subagent-lifecycle-events.js";
import { createSubagentRegistryLifecycleController } from "./subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const taskExecutorMocks = vi.hoisted(() => ({
  completeTaskRunByRunId: vi.fn(),
  failTaskRunByRunId: vi.fn(),
  setDetachedTaskDeliveryStatusByRunId: vi.fn(),
}));

const helperMocks = vi.hoisted(() => ({
  persistSubagentSessionTiming: vi.fn(async () => {}),
  safeRemoveAttachmentsDir: vi.fn(async () => {}),
  logAnnounceGiveUp: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  log: vi.fn(),
}));

const lifecycleEventMocks = vi.hoisted(() => ({
  emitSessionLifecycleEvent: vi.fn(),
}));

const browserLifecycleCleanupMocks = vi.hoisted(() => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
}));

const routeHealthMocks = vi.hoisted(() => ({
  recordChildRouteHealthEvent: vi.fn(async () => ({ ok: true, eventId: "event-1" })),
}));

vi.mock("../tasks/task-executor.js", () => ({
  completeTaskRunByRunId: taskExecutorMocks.completeTaskRunByRunId,
  failTaskRunByRunId: taskExecutorMocks.failTaskRunByRunId,
  setDetachedTaskDeliveryStatusByRunId: taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId,
}));

vi.mock("../sessions/session-lifecycle-events.js", () => ({
  emitSessionLifecycleEvent: lifecycleEventMocks.emitSessionLifecycleEvent,
}));

vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd:
    browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
}));

vi.mock("./child-route-health.js", () => ({
  recordChildRouteHealthEvent: routeHealthMocks.recordChildRouteHealthEvent,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: runtimeMocks.log,
  },
}));

vi.mock("../utils/delivery-context.js", () => ({
  normalizeDeliveryContext: (origin: unknown) => origin ?? "agent",
}));

vi.mock("./subagent-announce.js", () => ({
  captureSubagentCompletionReply: vi.fn(async () => undefined),
  runSubagentAnnounceFlow: vi.fn(async () => false),
}));

vi.mock("./subagent-registry-cleanup.js", () => ({
  resolveCleanupCompletionReason: () => SUBAGENT_ENDED_REASON_COMPLETE,
  resolveDeferredCleanupDecision: () => ({ kind: "give-up", reason: "retry-limit" }),
}));

vi.mock("./subagent-registry-completion.js", () => ({
  runOutcomesEqual: (left: unknown, right: unknown) =>
    JSON.stringify(left) === JSON.stringify(right),
}));

vi.mock("./subagent-registry-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-registry-helpers.js")>();
  return {
    ...actual,
    logAnnounceGiveUp: helperMocks.logAnnounceGiveUp,
    persistSubagentSessionTiming: helperMocks.persistSubagentSessionTiming,
    safeRemoveAttachmentsDir: helperMocks.safeRemoveAttachmentsDir,
  };
});

function createRunEntry(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "finish the task",
    cleanup: "keep",
    createdAt: 1_000,
    startedAt: 2_000,
    ...overrides,
  };
}

function createLifecycleController({
  entry,
  runs = new Map([[entry.runId, entry]]),
  ...overrides
}: {
  entry: SubagentRunRecord;
  runs?: Map<string, SubagentRunRecord>;
} & Partial<Parameters<typeof createSubagentRegistryLifecycleController>[0]>) {
  return createSubagentRegistryLifecycleController({
    runs,
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
    captureSubagentCompletionReply: vi.fn(async () => "final completion reply"),
    runSubagentAnnounceFlow: vi.fn(async () => true),
    warn: vi.fn(),
    ...overrides,
  });
}

describe("subagent registry lifecycle hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd.mockClear();
    routeHealthMocks.recordChildRouteHealthEvent.mockResolvedValue({
      ok: true,
      eventId: "event-1",
    });
  });

  it("records a route-health success marker for completed child runs", async () => {
    const entry = createRunEntry();
    const controller = createLifecycleController({ entry });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    expect(routeHealthMocks.recordChildRouteHealthEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "agent_lifecycle_error",
        status: "success",
        source: "subagent_terminal",
        childSessionKey: entry.childSessionKey,
        runId: entry.runId,
        requesterSessionKey: entry.requesterSessionKey,
        observedAt: 4_000,
      }),
    );
  });

  it("does not clear route-health blockers when a fresh-reroute old generation completes late", async () => {
    const entry = createRunEntry({
      suppressAnnounceReason: "fresh-reroute",
    });
    const controller = createLifecycleController({ entry });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    expect(routeHealthMocks.recordChildRouteHealthEvent).not.toHaveBeenCalled();
  });

  it("suppresses announce cleanup when a fresh-reroute old generation completes late", async () => {
    const entry = createRunEntry({
      suppressAnnounceReason: "fresh-reroute",
    });
    const runSubagentAnnounceFlow = vi.fn(async () => true);
    const emitSubagentEndedHookForRun = vi.fn(async () => {});
    const controller = createLifecycleController({
      entry,
      suppressAnnounceForSteerRestart: (candidate) =>
        candidate?.suppressAnnounceReason === "steer-restart" ||
        candidate?.suppressAnnounceReason === "fresh-reroute",
      shouldEmitEndedHookForRun: () => true,
      emitSubagentEndedHookForRun,
      runSubagentAnnounceFlow,
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    });

    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(emitSubagentEndedHookForRun).not.toHaveBeenCalled();
    expect(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    ).not.toHaveBeenCalled();
    expect(lifecycleEventMocks.emitSessionLifecycleEvent).not.toHaveBeenCalled();
  });

  it("records a route-health lifecycle blocker for failed child runs", async () => {
    const entry = createRunEntry();
    const controller = createLifecycleController({ entry });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "error", error: "model failed" },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      triggerCleanup: false,
    });

    expect(routeHealthMocks.recordChildRouteHealthEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "agent_lifecycle_error",
        status: "active",
        source: "subagent_terminal",
        childSessionKey: entry.childSessionKey,
        runId: entry.runId,
        requesterSessionKey: entry.requesterSessionKey,
        observedAt: 4_000,
      }),
    );
  });

  it("downgrades successful completion-message children with no visible final reply", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: true,
    });
    const captureSubagentCompletionReply = vi.fn(async () => undefined);
    const recordSubagentSliceTerminalOutcome = vi.fn(() => true);
    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply,
      recordSubagentSliceTerminalOutcome,
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    expect(captureSubagentCompletionReply).toHaveBeenCalledWith(entry.childSessionKey, {
      waitForReply: true,
      outcome: { status: "ok" },
      requireAssistantReply: true,
    });
    expect(entry.frozenResultText).toBeNull();
    expect(entry.outcome).toMatchObject({
      status: "error",
      error: expect.stringContaining("visible final assistant reply"),
    });
    expect(entry.endedReason).toBe(SUBAGENT_ENDED_REASON_ERROR);
    expect(entry.resultReceiptId).toBeUndefined();
    expect(recordSubagentSliceTerminalOutcome).toHaveBeenCalledWith({
      entry,
      endedAt: 4_000,
      evidenceGapKind: "no_visible_final",
    });
    expect(taskExecutorMocks.failTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        status: "failed",
        endedAt: 4_000,
      }),
    );
    expect(taskExecutorMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
    expect(routeHealthMocks.recordChildRouteHealthEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "agent_lifecycle_error",
        status: "active",
        source: "subagent_terminal",
        childSessionKey: entry.childSessionKey,
        runId: entry.runId,
        requesterSessionKey: entry.requesterSessionKey,
        observedAt: 4_000,
      }),
    );
  });

  it("keeps successful completion-message children when a visible final reply exists", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: true,
    });
    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply: vi.fn(async () => "final completion reply"),
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    expect(entry.outcome).toEqual({ status: "ok" });
    expect(entry.frozenResultText).toBe("final completion reply");
    expect(entry.resultReceiptId).toMatch(/^scr_/);
    expect(entry.resultReceiptBytes).toBe(Buffer.byteLength("final completion reply", "utf8"));
    expect(taskExecutorMocks.completeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        endedAt: 4_000,
      }),
    );
    expect(taskExecutorMocks.failTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("persists terminal child timing when route-health recording throws", async () => {
    const persist = vi.fn();
    const warn = vi.fn();
    const entry = createRunEntry();
    routeHealthMocks.recordChildRouteHealthEvent.mockRejectedValueOnce(
      new Error("route store boom"),
    );
    const controller = createLifecycleController({ entry, persist, warn });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "error", error: "gateway closed (1012): service restart" },
        reason: SUBAGENT_ENDED_REASON_ERROR,
        triggerCleanup: false,
      }),
    ).resolves.toBeUndefined();

    expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledTimes(1);
    expect(taskExecutorMocks.failTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        status: "failed",
        endedAt: 4_000,
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      "failed to record subagent route-health terminal state",
      expect.objectContaining({
        error: { name: "Error", message: "route store boom" },
        outcomeStatus: "error",
      }),
    );
  });

  it("does not reject completion when task finalization throws", async () => {
    const persist = vi.fn();
    const warn = vi.fn();
    const entry = createRunEntry();
    const runs = new Map([[entry.runId, entry]]);
    taskExecutorMocks.completeTaskRunByRunId.mockImplementation(() => {
      throw new Error("task store boom");
    });

    const controller = createLifecycleController({ entry, runs, persist, warn });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: false,
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "failed to finalize subagent background task state",
      expect.objectContaining({
        error: { name: "Error", message: "task store boom" },
        runId: "***",
        childSessionKey: "agent:main:…",
        outcomeStatus: "ok",
      }),
    );
    expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledTimes(1);
    expect(lifecycleEventMocks.emitSessionLifecycleEvent).toHaveBeenCalledWith({
      sessionKey: "agent:main:subagent:child",
      reason: "subagent-status",
      parentSessionKey: "agent:main:main",
      label: undefined,
    });
  });

  it("does not reject cleanup give-up when task delivery status update throws", async () => {
    const persist = vi.fn();
    const warn = vi.fn();
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: false,
      retainAttachmentsOnKeep: true,
    });
    taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mockImplementation(() => {
      throw new Error("delivery state boom");
    });

    const controller = createLifecycleController({
      entry,
      persist,
      captureSubagentCompletionReply: vi.fn(async () => undefined),
      warn,
    });

    await expect(
      controller.finalizeResumedAnnounceGiveUp({
        runId: entry.runId,
        entry,
        reason: "retry-limit",
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "failed to update subagent background task delivery state",
      expect.objectContaining({
        error: { name: "Error", message: "delivery state boom" },
        runId: "***",
        childSessionKey: "agent:main:…",
        deliveryStatus: "failed",
      }),
    );
    expect(entry.cleanupCompletedAt).toBeTypeOf("number");
    expect(persist).toHaveBeenCalled();
  });

  it("cleans up tracked browser sessions before subagent cleanup flow", async () => {
    const persist = vi.fn();
    const entry = createRunEntry({
      expectsCompletionMessage: false,
    });
    const runSubagentAnnounceFlow = vi.fn(async () => true);

    const controller = createLifecycleController({ entry, persist, runSubagentAnnounceFlow });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    expect(browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd).toHaveBeenCalledWith(
      {
        sessionKeys: [entry.childSessionKey],
        onWarn: expect.any(Function),
      },
    );
    expect(runSubagentAnnounceFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionKey: entry.childSessionKey,
      }),
    );
  });

  it("does not wait for a completion reply when the run does not expect one", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: false,
    });
    const captureSubagentCompletionReply = vi.fn(async () => undefined);

    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply,
      runSubagentAnnounceFlow: vi.fn(async () => false),
    });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: false,
      }),
    ).resolves.toBeUndefined();

    expect(captureSubagentCompletionReply).toHaveBeenCalledWith(entry.childSessionKey, {
      waitForReply: false,
      outcome: { status: "ok" },
    });
  });

  it("does not re-run announce flow after completion was already delivered", async () => {
    const entry = createRunEntry({
      completionAnnouncedAt: 3_500,
      endedAt: 4_000,
    });
    const persist = vi.fn();
    const runSubagentAnnounceFlow = vi.fn(async () => true);
    const notifyContextEngineSubagentEnded = vi.fn(async () => {});

    const controller = createLifecycleController({
      entry,
      persist,
      notifyContextEngineSubagentEnded,
      runSubagentAnnounceFlow,
    });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(typeof entry.cleanupCompletedAt).toBe("number");
    expect(entry.cleanupCompletedAt).toBeGreaterThan(0);
    expect(notifyContextEngineSubagentEnded).toHaveBeenCalledWith({
      childSessionKey: entry.childSessionKey,
      reason: "completed",
      workspaceDir: entry.workspaceDir,
    });
    expect(persist).toHaveBeenCalled();
  });

  it("emits ended hook while retrying cleanup after completion was already delivered", async () => {
    const entry = createRunEntry({
      completionAnnouncedAt: 3_500,
      endedAt: 4_000,
      expectsCompletionMessage: true,
    });
    const emitSubagentEndedHookForRun = vi.fn(async () => {});

    const controller = createLifecycleController({
      entry,
      shouldEmitEndedHookForRun: () => true,
      emitSubagentEndedHookForRun,
    });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    expect(emitSubagentEndedHookForRun).toHaveBeenCalledTimes(1);
    expect(emitSubagentEndedHookForRun).toHaveBeenCalledWith({
      entry,
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      sendFarewell: true,
    });
  });

  it("produces valid cleanupCompletedAt on give-up path when completionAnnouncedAt is undefined", async () => {
    const persist = vi.fn();
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: false,
      retainAttachmentsOnKeep: true,
    });

    const controller = createLifecycleController({
      entry,
      persist,
      captureSubagentCompletionReply: vi.fn(async () => undefined),
    });

    expect(entry.completionAnnouncedAt).toBeUndefined();

    await controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "retry-limit",
    });

    expect(entry.cleanupCompletedAt).toBeTypeOf("number");
    expect(Number.isNaN(entry.cleanupCompletedAt)).toBe(false);
  });

  it("continues cleanup when delivery-status persistence throws after announce delivery", async () => {
    const persist = vi.fn();
    const warn = vi.fn();
    const emitSubagentEndedHookForRun = vi.fn(async () => {});
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: false,
      retainAttachmentsOnKeep: false,
    });
    taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mockImplementation(() => {
      throw new Error("delivery status boom");
    });

    const controller = createLifecycleController({
      entry,
      persist,
      shouldEmitEndedHookForRun: () => true,
      emitSubagentEndedHookForRun,
      warn,
    });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "failed to update subagent background task delivery state",
      expect.objectContaining({
        error: { name: "Error", message: "delivery status boom" },
        deliveryStatus: "delivered",
      }),
    );
    expect(emitSubagentEndedHookForRun).toHaveBeenCalledTimes(1);
    expect(helperMocks.safeRemoveAttachmentsDir).toHaveBeenCalledTimes(1);
    expect(entry.cleanupCompletedAt).toBeTypeOf("number");
    expect(persist).toHaveBeenCalled();
  });

  it("skips browser cleanup when steer restart suppresses cleanup flow", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: false,
    });
    const runSubagentAnnounceFlow = vi.fn(async () => true);

    const controller = createLifecycleController({
      entry,
      suppressAnnounceForSteerRestart: () => true,
      runSubagentAnnounceFlow,
    });

    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    expect(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    ).not.toHaveBeenCalled();
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it("freezes truncation metadata before the first receipt and deduplicates its notice", async () => {
    const entry = createRunEntry({ runId: "run-truncated" });
    const controller = createLifecycleController({ entry });
    const completion = {
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" as const },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
      rawCompletionStopReason: "length",
    };

    await controller.completeSubagentRun(completion);
    await controller.completeSubagentRun(completion);

    expect(entry).toMatchObject({
      modelCompletion: "truncated",
      rawCompletionStopReason: "length",
      frozenResultRuntimeCapped: false,
      frozenResultOriginalBytes: Buffer.byteLength("final completion reply", "utf8"),
    });
    expect(entry.resultReceiptId).toMatch(/^scr_/);
    expect(entry.frozenResultText).toContain("[incomplete handoff:");
    expect(entry.frozenResultText?.match(/\[incomplete handoff:/g)).toHaveLength(1);
  });

  it("re-finalizes late refreshed output with the refreshed stop reason", async () => {
    const entry = createRunEntry({
      runId: "run-late-refresh",
      endedAt: 4_000,
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
      frozenResultText: "early output",
      frozenResultCapturedAt: 3_000,
    });
    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply: vi.fn(async () => "late incomplete output"),
    });

    await controller.refreshFrozenResultFromSession(entry.childSessionKey, "max_tokens");

    expect(entry.modelCompletion).toBe("truncated");
    expect(entry.rawCompletionStopReason).toBe("max_tokens");
    expect(entry.frozenResultText).toContain("late incomplete output");
    expect(entry.frozenResultText).toContain("[incomplete handoff:");
  });

  it("does not downgrade known truncation when a later refresh reports stop", async () => {
    const entry = createRunEntry({
      runId: "run-truncation-first",
      endedAt: 4_000,
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
      frozenResultText: "early incomplete output",
      frozenResultCapturedAt: 3_000,
      modelCompletion: "truncated",
      rawCompletionStopReason: "max_tokens",
    });
    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply: vi.fn(async () => "late incomplete output"),
    });

    await controller.refreshFrozenResultFromSession(entry.childSessionKey, "stop");

    expect(entry.modelCompletion).toBe("truncated");
    expect(entry.rawCompletionStopReason).toBe("max_tokens");
    expect(entry.frozenResultText).toContain("stopReason=max_tokens");
  });

  it("refuses to fan one late session result across ambiguous ended generations", async () => {
    const first = createRunEntry({
      runId: "run-ambiguous-first",
      endedAt: 4_000,
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
      frozenResultText: "first output",
      frozenResultCapturedAt: 3_000,
    });
    const second = createRunEntry({
      runId: "run-ambiguous-second",
      childSessionKey: first.childSessionKey,
      endedAt: 5_000,
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
      frozenResultText: "second output",
      frozenResultCapturedAt: 4_500,
    });
    const captureSubagentCompletionReply = vi.fn(async () => "unbound late output");
    const controller = createLifecycleController({
      entry: first,
      runs: new Map([
        [first.runId, first],
        [second.runId, second],
      ]),
      captureSubagentCompletionReply,
    });

    await expect(
      controller.refreshFrozenResultFromSession(first.childSessionKey, "max_tokens"),
    ).resolves.toBe(false);

    expect(captureSubagentCompletionReply).not.toHaveBeenCalled();
    expect(first).toMatchObject({ frozenResultText: "first output" });
    expect(second).toMatchObject({ frozenResultText: "second output" });
    expect(first.rawCompletionStopReason).toBeUndefined();
    expect(second.rawCompletionStopReason).toBeUndefined();
  });
});
