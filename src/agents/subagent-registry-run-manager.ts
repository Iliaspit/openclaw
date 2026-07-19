import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  createQueuedTaskRun,
  createRunningTaskRun,
  failTaskRunByRunId,
  reassignTaskRunByRunId,
} from "../tasks/task-executor.js";
import { type DeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";
import { recordChildRouteHealthEvent } from "./child-route-health.js";
import { waitForAgentRun } from "./run-wait.js";
import type { ensureRuntimePluginsLoaded as ensureRuntimePluginsLoadedFn } from "./runtime-plugins.js";
import { type SubagentRunOutcome, withSubagentOutcomeTiming } from "./subagent-announce-output.js";
import {
  SUBAGENT_ENDED_OUTCOME_KILLED,
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import {
  emitSubagentEndedHookOnce,
  shouldUpdateRunOutcome,
} from "./subagent-registry-completion.js";
import {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  persistSubagentSessionTiming,
  resolveArchiveAfterMs,
  safeRemoveAttachmentsDir,
} from "./subagent-registry-helpers.js";
import { getLatestSubagentRunByChildSessionKey } from "./subagent-registry-read.js";
import type {
  SubagentRunRecord,
  SubagentSliceContinuation,
  SubagentSliceRole,
} from "./subagent-registry.types.js";
import {
  applySubagentResultReceiptToRun,
  persistSubagentResultReceiptForRunSync,
} from "./subagent-result-receipts.js";

const log = createSubsystemLogger("agents/subagent-registry");

type ProtectedRunScopeInput = {
  delegationAssignmentId?: string;
  delegationSliceId?: string;
  delegationEpoch?: number;
};

function normalizeProtectedRunScope(input: ProtectedRunScopeInput):
  | {
      delegationAssignmentId: string;
      delegationSliceId: string;
      delegationEpoch: number;
    }
  | undefined {
  const delegationAssignmentId = input.delegationAssignmentId?.trim() || undefined;
  const delegationSliceId = input.delegationSliceId?.trim() || undefined;
  const delegationEpoch =
    typeof input.delegationEpoch === "number" &&
    Number.isSafeInteger(input.delegationEpoch) &&
    input.delegationEpoch > 0
      ? input.delegationEpoch
      : undefined;
  const hasProtectedScope =
    input.delegationAssignmentId !== undefined ||
    input.delegationSliceId !== undefined ||
    input.delegationEpoch !== undefined;
  if (!hasProtectedScope) {
    return undefined;
  }
  if (!delegationAssignmentId || !delegationSliceId || delegationEpoch === undefined) {
    throw new Error(
      "Protected subagent run registration requires exact assignment, slice, and epoch.",
    );
  }
  return {
    delegationAssignmentId,
    delegationSliceId,
    delegationEpoch,
  };
}

function shouldDeleteAttachments(entry: SubagentRunRecord) {
  return entry.cleanup === "delete" || !entry.retainAttachmentsOnKeep;
}

export type RegisterSubagentRunParams = {
  runId: string;
  delegationAssignmentId?: string;
  delegationSliceId?: string;
  delegationEpoch?: number;
  childSessionKey: string;
  controllerSessionKey?: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  cleanup: "delete" | "keep";
  label?: string;
  sliceRole?: SubagentSliceRole;
  sliceContinuation?: SubagentSliceContinuation;
  model?: string;
  workspaceDir?: string;
  runTimeoutSeconds?: number;
  expectsCompletionMessage?: boolean;
  spawnMode?: "run" | "session";
  attachmentsDir?: string;
  attachmentsRootDir?: string;
  retainAttachmentsOnKeep?: boolean;
  /**
   * The provisional run id a `registerPendingSubagentTaskRun` call already
   * created a durable (queued) task row under, before the child gateway run
   * was started. When present, the durable row is promoted/reassigned to
   * `runId` instead of creating a fresh row, so the task store always has a
   * record covering the window between child-start and in-process
   * registration.
   */
  pendingTaskRunId?: string;
};

export type RegisterPendingSubagentTaskRunParams = {
  pendingRunId: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  childSessionKey: string;
  task: string;
  label?: string;
  expectsCompletionMessage?: boolean;
};

export function createSubagentRunManager(params: {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  endedHookInFlightRunIds: Set<string>;
  persist(): void;
  callGateway: typeof callGateway;
  loadConfig: typeof loadConfig;
  ensureRuntimePluginsLoaded:
    | typeof ensureRuntimePluginsLoadedFn
    | ((args: {
        config: OpenClawConfig;
        workspaceDir?: string;
        allowGatewaySubagentBinding?: boolean;
      }) => void | Promise<void>);
  ensureListener(): void;
  startSweeper(): void;
  stopSweeper(): void;
  resumeSubagentRun(runId: string): void;
  clearPendingLifecycleError(runId: string): void;
  resolveSubagentWaitTimeoutMs(cfg: OpenClawConfig, runTimeoutSeconds?: number): number;
  notifyContextEngineSubagentEnded(args: {
    childSessionKey: string;
    reason: "completed" | "deleted" | "released";
    workspaceDir?: string;
  }): Promise<void>;
  completeCleanupBookkeeping(args: {
    runId: string;
    entry: SubagentRunRecord;
    cleanup: "delete" | "keep";
    completedAt: number;
  }): void;
  completeSubagentRun(args: {
    runId: string;
    endedAt?: number;
    outcome: SubagentRunOutcome;
    reason: SubagentLifecycleEndedReason;
    sendFarewell?: boolean;
    accountId?: string;
    triggerCleanup: boolean;
    rawCompletionStopReason?: string;
  }): Promise<void>;
  recordSubagentSliceSpawn?(entry: SubagentRunRecord): void;
  recordSubagentSliceTerminalOutcome?(args: {
    entry: SubagentRunRecord;
    endedAt: number;
    evidenceGapKind?: "timeout" | "no_visible_final" | "error" | "killed";
  }): boolean;
}) {
  const waitForSubagentCompletion = async (
    runId: string,
    waitTimeoutMs: number,
    expectedEntry?: SubagentRunRecord,
  ) => {
    const terminalizeWaitError = async (err: unknown) => {
      const entry = params.runs.get(runId);
      if (!entry || (expectedEntry && entry !== expectedEntry)) {
        return;
      }
      if (!entry.endedAt) {
        entry.endedAt = Date.now();
      }
      const outcome = withSubagentOutcomeTiming(
        { status: "error", error: formatErrorMessage(err) },
        {
          startedAt: entry.startedAt,
          endedAt: entry.endedAt,
        },
      );
      if (shouldUpdateRunOutcome(entry.outcome, outcome)) {
        entry.outcome = outcome;
        params.persist();
      }
      await params
        .completeSubagentRun({
          runId,
          endedAt: entry.endedAt,
          outcome,
          reason: SUBAGENT_ENDED_REASON_ERROR,
          sendFarewell: true,
          accountId: entry.requesterOrigin?.accountId,
          triggerCleanup: true,
          rawCompletionStopReason: entry.rawCompletionStopReason,
        })
        .catch((completeError) => {
          log.warn("Failed to terminalize subagent wait error", {
            runId,
            childSessionKey: entry.childSessionKey,
            error: completeError,
          });
        });
    };

    let wait: Awaited<ReturnType<typeof waitForAgentRun>>;
    try {
      wait = await waitForAgentRun({
        runId,
        timeoutMs: Math.max(1, Math.floor(waitTimeoutMs)),
        callGateway: params.callGateway,
      });
    } catch (err) {
      await terminalizeWaitError(err);
      return;
    }

    const entry = params.runs.get(runId);
    if (!entry || (expectedEntry && entry !== expectedEntry)) {
      return;
    }
    if (wait.status === "pending") {
      return;
    }
    let mutated = false;
    if (typeof wait.startedAt === "number") {
      entry.startedAt = wait.startedAt;
      if (typeof entry.sessionStartedAt !== "number") {
        entry.sessionStartedAt = wait.startedAt;
      }
      mutated = true;
    }
    if (typeof wait.endedAt === "number") {
      entry.endedAt = wait.endedAt;
      mutated = true;
    }
    if (!entry.endedAt) {
      entry.endedAt = Date.now();
      mutated = true;
    }
    const waitError = typeof wait.error === "string" ? wait.error : undefined;
    const baseOutcome: SubagentRunOutcome =
      wait.status === "error"
        ? { status: "error", error: waitError }
        : wait.status === "timeout"
          ? { status: "timeout" }
          : { status: "ok" };
    const outcome = withSubagentOutcomeTiming(baseOutcome, {
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
    });
    if (shouldUpdateRunOutcome(entry.outcome, outcome)) {
      entry.outcome = outcome;
      mutated = true;
    }
    if (mutated) {
      params.persist();
    }
    await params
      .completeSubagentRun({
        runId,
        endedAt: entry.endedAt,
        outcome,
        reason:
          wait.status === "error" ? SUBAGENT_ENDED_REASON_ERROR : SUBAGENT_ENDED_REASON_COMPLETE,
        sendFarewell: true,
        accountId: entry.requesterOrigin?.accountId,
        triggerCleanup: true,
        rawCompletionStopReason: wait.rawCompletionStopReason,
      })
      .catch((completeError) => {
        log.warn("Failed to complete subagent run after wait", {
          runId,
          childSessionKey: entry.childSessionKey,
          error: completeError,
        });
      });
  };

  const markSubagentRunForSteerRestart = (runId: string) => {
    const key = runId.trim();
    if (!key) {
      return false;
    }
    const entry = params.runs.get(key);
    if (!entry) {
      return false;
    }
    if (entry.suppressAnnounceReason === "steer-restart") {
      return true;
    }
    entry.suppressAnnounceReason = "steer-restart";
    params.persist();
    return true;
  };

  const clearSubagentRunSteerRestart = (runId: string) => {
    const key = runId.trim();
    if (!key) {
      return false;
    }
    const entry = params.runs.get(key);
    if (!entry) {
      return false;
    }
    if (entry.suppressAnnounceReason !== "steer-restart") {
      return true;
    }
    entry.suppressAnnounceReason = undefined;
    params.persist();
    // If the interrupted run already finished while suppression was active, retry
    // cleanup now so completion output is not lost when restart dispatch fails.
    params.resumedRuns.delete(key);
    if (typeof entry.endedAt === "number" && !entry.cleanupCompletedAt) {
      params.resumeSubagentRun(key);
    }
    return true;
  };

  const recordKilledRouteHealth = async (entry: SubagentRunRecord, observedAt: number) => {
    const recorded = await recordChildRouteHealthEvent({
      code: "agent_lifecycle_abandoned",
      status: "active",
      source: "repair_control",
      childSessionKey: entry.childSessionKey,
      runId: entry.runId,
      requesterSessionKey: entry.requesterSessionKey,
      observedAt,
      reason: "Sub-agent run was killed before completion.",
    });
    if (!recorded.ok) {
      log.warn("Failed to record killed subagent route-health state", {
        runId: entry.runId,
        childSessionKey: entry.childSessionKey,
        error: recorded.error,
      });
    }
  };

  const replaceSubagentRunAfterSteer = (replaceParams: {
    previousRunId: string;
    nextRunId: string;
    delegationAssignmentId?: string;
    delegationSliceId?: string;
    delegationEpoch?: number;
    fallback?: SubagentRunRecord;
    task?: string;
    runTimeoutSeconds?: number;
    preserveFrozenResultFallback?: boolean;
  }) => {
    const previousRunId = replaceParams.previousRunId.trim();
    const nextRunId = replaceParams.nextRunId.trim();
    if (!previousRunId || !nextRunId) {
      return false;
    }

    const previous = params.runs.get(previousRunId);
    const source = previous ?? replaceParams.fallback;
    if (!source) {
      return false;
    }
    const replacementProtectedScope = normalizeProtectedRunScope(replaceParams);
    const latestForChild = getLatestSubagentRunByChildSessionKey(source.childSessionKey);
    if (latestForChild && latestForChild.runId !== previousRunId) {
      return false;
    }
    for (const candidate of params.runs.values()) {
      if (candidate.childSessionKey !== source.childSessionKey) {
        continue;
      }
      if (candidate.runId === previousRunId) {
        continue;
      }
      if (candidate.createdAt >= source.createdAt) {
        return false;
      }
    }

    const preserveFrozenResultFallback = replaceParams.preserveFrozenResultFallback === true;
    if (previousRunId !== nextRunId) {
      params.clearPendingLifecycleError(previousRunId);
      if (preserveFrozenResultFallback && previous) {
        if (previous.frozenResultText !== undefined) {
          applySubagentResultReceiptToRun(previous);
        }
        previous.cleanup = "keep";
        previous.wakeOnDescendantSettle = undefined;
        previous.suppressAnnounceReason = undefined;
      } else if (shouldDeleteAttachments(source)) {
        void safeRemoveAttachmentsDir(source);
      }
      if (!preserveFrozenResultFallback || !previous) {
        params.runs.delete(previousRunId);
      }
      params.resumedRuns.delete(previousRunId);
    }

    const now = Math.max(Date.now(), source.createdAt + 1);
    const cfg = params.loadConfig();
    const archiveAfterMs = resolveArchiveAfterMs(cfg);
    const spawnMode = source.spawnMode === "session" ? "session" : "run";
    const archiveAtMs =
      spawnMode === "session" || source.cleanup === "keep"
        ? undefined
        : archiveAfterMs
          ? now + archiveAfterMs
          : undefined;
    const runTimeoutSeconds = replaceParams.runTimeoutSeconds ?? source.runTimeoutSeconds ?? 0;
    const waitTimeoutMs = params.resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds);
    const task = replaceParams.task?.trim();
    const sessionStartedAt = getSubagentSessionStartedAt(source) ?? now;
    const accumulatedRuntimeMs =
      getSubagentSessionRuntimeMs(
        source,
        typeof source.endedAt === "number" ? source.endedAt : now,
      ) ?? 0;

    const next: SubagentRunRecord = {
      ...source,
      runId: nextRunId,
      ...replacementProtectedScope,
      task: task || source.task,
      createdAt: now,
      startedAt: now,
      sessionStartedAt,
      accumulatedRuntimeMs,
      endedAt: undefined,
      endedReason: undefined,
      endedHookEmittedAt: undefined,
      wakeOnDescendantSettle: undefined,
      outcome: undefined,
      frozenResultText: undefined,
      frozenResultCapturedAt: undefined,
      modelCompletion: undefined,
      rawCompletionStopReason: undefined,
      frozenResultRuntimeCapped: undefined,
      frozenResultOriginalBytes: undefined,
      resultReceiptId: undefined,
      resultReceiptSha256: undefined,
      resultReceiptBytes: undefined,
      resultReceiptCapturedAt: undefined,
      fallbackFrozenResultText: preserveFrozenResultFallback ? source.frozenResultText : undefined,
      fallbackFrozenResultCapturedAt: preserveFrozenResultFallback
        ? source.frozenResultCapturedAt
        : undefined,
      cleanupCompletedAt: undefined,
      cleanupHandled: false,
      completionAnnouncedAt: undefined,
      suppressAnnounceReason: undefined,
      announceRetryCount: undefined,
      lastAnnounceRetryAt: undefined,
      spawnMode,
      archiveAtMs,
      runTimeoutSeconds,
    };

    params.runs.set(nextRunId, next);
    params.recordSubagentSliceSpawn?.(next);
    try {
      reassignTaskRunByRunId({
        currentRunId: previousRunId,
        nextRunId,
        runtime: "subagent",
        sessionKey: next.childSessionKey,
        sourceId: nextRunId,
        label: next.label,
        task: next.task,
        restart: true,
        startedAt: now,
        lastEventAt: now,
        deliveryStatus: next.expectsCompletionMessage === false ? "not_applicable" : "pending",
      });
    } catch (error) {
      log.warn("Failed to reassign background task for steered subagent run", {
        previousRunId,
        nextRunId,
        childSessionKey: next.childSessionKey,
        error,
      });
    }
    params.ensureListener();
    params.persist();
    // Always start sweeper — session-mode runs (no archiveAtMs) also need TTL cleanup.
    params.startSweeper();
    void waitForSubagentCompletion(nextRunId, waitTimeoutMs, next);
    return true;
  };

  const registerSubagentRun = (registerParams: RegisterSubagentRunParams) => {
    const runId = registerParams.runId.trim();
    const childSessionKey = registerParams.childSessionKey.trim();
    const requesterSessionKey = registerParams.requesterSessionKey.trim();
    const controllerSessionKey = registerParams.controllerSessionKey?.trim() || requesterSessionKey;
    if (!runId || !childSessionKey || !requesterSessionKey) {
      return;
    }
    const now = Date.now();
    const cfg = params.loadConfig();
    const archiveAfterMs = resolveArchiveAfterMs(cfg);
    const spawnMode = registerParams.spawnMode === "session" ? "session" : "run";
    const archiveAtMs =
      spawnMode === "session" || registerParams.cleanup === "keep"
        ? undefined
        : archiveAfterMs
          ? now + archiveAfterMs
          : undefined;
    const runTimeoutSeconds = registerParams.runTimeoutSeconds ?? 0;
    const waitTimeoutMs = params.resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds);
    const requesterOrigin = normalizeDeliveryContext(registerParams.requesterOrigin);
    const requesterGeneration =
      getLatestSubagentRunByChildSessionKey(requesterSessionKey)?.runId ?? undefined;
    const protectedScope = normalizeProtectedRunScope(registerParams);
    const entry: SubagentRunRecord = {
      runId,
      ...protectedScope,
      childSessionKey,
      controllerSessionKey,
      requesterSessionKey,
      requesterGeneration,
      requesterOrigin,
      requesterDisplayKey: registerParams.requesterDisplayKey,
      task: registerParams.task,
      cleanup: registerParams.cleanup,
      expectsCompletionMessage: registerParams.expectsCompletionMessage,
      spawnMode,
      label: registerParams.label,
      sliceRole: registerParams.sliceRole,
      sliceContinuation: registerParams.sliceContinuation,
      model: registerParams.model,
      workspaceDir: registerParams.workspaceDir,
      runTimeoutSeconds,
      createdAt: now,
      startedAt: now,
      sessionStartedAt: now,
      accumulatedRuntimeMs: 0,
      archiveAtMs,
      cleanupHandled: false,
      completionAnnouncedAt: undefined,
      wakeOnDescendantSettle: undefined,
      attachmentsDir: registerParams.attachmentsDir,
      attachmentsRootDir: registerParams.attachmentsRootDir,
      retainAttachmentsOnKeep: registerParams.retainAttachmentsOnKeep,
    };
    const createFreshRunningTaskRun = () =>
      createRunningTaskRun({
        runtime: "subagent",
        sourceId: runId,
        ownerKey: requesterSessionKey,
        scopeKind: "session",
        requesterOrigin,
        childSessionKey,
        runId,
        label: registerParams.label,
        task: registerParams.task,
        deliveryStatus:
          registerParams.expectsCompletionMessage === false ? "not_applicable" : "pending",
        startedAt: now,
        lastEventAt: now,
      });
    try {
      const pendingTaskRunId = registerParams.pendingTaskRunId?.trim();
      if (pendingTaskRunId) {
        const reassigned = reassignTaskRunByRunId({
          currentRunId: pendingTaskRunId,
          nextRunId: runId,
          runtime: "subagent",
          sessionKey: childSessionKey,
          sourceId: runId,
          label: registerParams.label,
          task: registerParams.task,
          restart: true,
          startedAt: now,
          lastEventAt: now,
          deliveryStatus:
            registerParams.expectsCompletionMessage === false ? "not_applicable" : "pending",
        });
        // A pre-registered row should always exist; fall back to creating one
        // if it was somehow lost (e.g. evicted before this call ran).
        if (reassigned.length === 0) {
          createFreshRunningTaskRun();
        }
      } else {
        createFreshRunningTaskRun();
      }
    } catch (error) {
      log.warn("Failed to create background task for subagent run", {
        runId: registerParams.runId,
        error,
      });
      throw error;
    }
    params.runs.set(runId, entry);
    params.recordSubagentSliceSpawn?.(entry);
    params.ensureListener();
    params.persist();
    // Always start sweeper — session-mode runs (no archiveAtMs) also need TTL cleanup.
    params.startSweeper();
    // Wait for subagent completion via gateway RPC (cross-process).
    // The in-process lifecycle listener is a fallback for embedded runs.
    void waitForSubagentCompletion(runId, waitTimeoutMs, entry);
  };

  // Creates a durable (queued) task row before the child gateway run is
  // started, so a spawn attempt is never invisible to the task store even if
  // in-process registration (`registerSubagentRun`) never runs.
  const registerPendingSubagentTaskRun = (pendingParams: RegisterPendingSubagentTaskRunParams) => {
    const pendingRunId = pendingParams.pendingRunId.trim();
    const requesterSessionKey = pendingParams.requesterSessionKey.trim();
    const childSessionKey = pendingParams.childSessionKey.trim();
    if (!pendingRunId || !requesterSessionKey || !childSessionKey) {
      return;
    }
    createQueuedTaskRun({
      runtime: "subagent",
      sourceId: pendingRunId,
      runId: pendingRunId,
      ownerKey: requesterSessionKey,
      scopeKind: "session",
      requesterOrigin: normalizeDeliveryContext(pendingParams.requesterOrigin),
      childSessionKey,
      label: pendingParams.label,
      task: pendingParams.task,
      deliveryStatus:
        pendingParams.expectsCompletionMessage === false ? "not_applicable" : "pending",
    });
  };

  // Terminalizes a task row created by `registerPendingSubagentTaskRun` when
  // the child run never reached (or never completed) in-process registration.
  const failPendingSubagentTaskRun = (failParams: { pendingRunId: string; error?: string }) => {
    const pendingRunId = failParams.pendingRunId.trim();
    if (!pendingRunId) {
      return [];
    }
    return failTaskRunByRunId({
      runId: pendingRunId,
      runtime: "subagent",
      status: "failed",
      endedAt: Date.now(),
      error: failParams.error,
    });
  };

  const releaseSubagentRun = (runId: string) => {
    params.clearPendingLifecycleError(runId);
    const entry = params.runs.get(runId);
    if (entry) {
      if (shouldDeleteAttachments(entry)) {
        void safeRemoveAttachmentsDir(entry);
      }
      void params.notifyContextEngineSubagentEnded({
        childSessionKey: entry.childSessionKey,
        reason: "released",
        workspaceDir: entry.workspaceDir,
      });
    }
    const didDelete = params.runs.delete(runId);
    if (didDelete) {
      params.persist();
    }
    if (params.runs.size === 0) {
      params.stopSweeper();
    }
  };

  const markSubagentRunTerminated = (markParams: {
    runId?: string;
    childSessionKey?: string;
    reason?: string;
  }): number => {
    const runIds = new Set<string>();
    if (typeof markParams.runId === "string" && markParams.runId.trim()) {
      runIds.add(markParams.runId.trim());
    }
    if (typeof markParams.childSessionKey === "string" && markParams.childSessionKey.trim()) {
      for (const [runId, entry] of params.runs.entries()) {
        if (entry.childSessionKey === markParams.childSessionKey.trim()) {
          runIds.add(runId);
        }
      }
    }
    if (runIds.size === 0) {
      return 0;
    }

    const now = Date.now();
    const reason = markParams.reason?.trim() || "killed";
    let updated = 0;
    const entriesByChildSessionKey = new Map<string, SubagentRunRecord>();
    for (const runId of runIds) {
      params.clearPendingLifecycleError(runId);
      const entry = params.runs.get(runId);
      if (!entry) {
        continue;
      }
      if (typeof entry.endedAt === "number") {
        continue;
      }
      entry.endedAt = now;
      entry.outcome = withSubagentOutcomeTiming(
        { status: "error", error: reason },
        {
          startedAt: entry.startedAt,
          endedAt: now,
        },
      );
      entry.endedReason = SUBAGENT_ENDED_REASON_KILLED;
      if (entry.frozenResultText === undefined) {
        entry.frozenResultText = null;
        entry.frozenResultCapturedAt = now;
      }
      const persistedReceipt = persistSubagentResultReceiptForRunSync(entry);
      if (!persistedReceipt.ok && entry.cleanup === "delete") {
        entry.cleanup = "keep";
      }
      applySubagentResultReceiptToRun(entry);
      params.recordSubagentSliceTerminalOutcome?.({
        entry,
        endedAt: now,
        evidenceGapKind: "killed",
      });
      entry.cleanupHandled = true;
      entry.cleanupCompletedAt = now;
      entry.suppressAnnounceReason = "killed";
      if (!entriesByChildSessionKey.has(entry.childSessionKey)) {
        entriesByChildSessionKey.set(entry.childSessionKey, entry);
      }
      void recordKilledRouteHealth(entry, now);
      updated += 1;
    }
    if (updated > 0) {
      params.persist();
      for (const entry of entriesByChildSessionKey.values()) {
        const emitEndedHook = () =>
          emitSubagentEndedHookOnce({
            entry,
            reason: SUBAGENT_ENDED_REASON_KILLED,
            sendFarewell: true,
            accountId: entry.requesterOrigin?.accountId,
            outcome: SUBAGENT_ENDED_OUTCOME_KILLED,
            error: reason,
            inFlightRunIds: params.endedHookInFlightRunIds,
            persist: () => params.persist(),
          });
        void persistSubagentSessionTiming(entry).catch((err) => {
          log.warn("failed to persist killed subagent session timing", {
            err,
            runId: entry.runId,
            childSessionKey: entry.childSessionKey,
          });
        });
        if (shouldDeleteAttachments(entry)) {
          void safeRemoveAttachmentsDir(entry);
        }
        params.completeCleanupBookkeeping({
          runId: entry.runId,
          entry,
          cleanup: entry.cleanup,
          completedAt: now,
        });
        if (getGlobalHookRunner()) {
          void emitEndedHook().catch(() => {
            // Hook failures should not break termination flow.
          });
          continue;
        }
        const cfg = params.loadConfig();
        void Promise.resolve(
          params.ensureRuntimePluginsLoaded({
            config: cfg,
            workspaceDir: entry.workspaceDir,
            allowGatewaySubagentBinding: true,
          }),
        )
          .then(emitEndedHook)
          .catch(() => {
            // Hook failures should not break termination flow.
          });
      }
    }
    return updated;
  };

  return {
    clearSubagentRunSteerRestart,
    failPendingSubagentTaskRun,
    markSubagentRunForSteerRestart,
    markSubagentRunTerminated,
    registerPendingSubagentTaskRun,
    registerSubagentRun,
    releaseSubagentRun,
    replaceSubagentRunAfterSteer,
    waitForSubagentCompletion,
  };
}
