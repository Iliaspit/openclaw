import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../browser-lifecycle-cleanup.js";
import { loadConfig } from "../config/config.js";
import { formatErrorMessage, readErrorName } from "../infra/errors.js";
import { defaultRuntime } from "../runtime.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import {
  completeTaskRunByRunId,
  failTaskRunByRunId,
  setDetachedTaskDeliveryStatusByRunId,
} from "../tasks/task-executor.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import type { ChildRouteHealthCode } from "./child-route-health-contract.js";
import {
  recordChildRouteHealthEvent,
  type ChildRouteHealthEventStatus,
} from "./child-route-health.js";
import { openConfiguredDelegationLedger } from "./delegation/gateway-task-reconciliation.js";
import {
  resolveDelegationGuardConfig,
  resolveDelegationPolicyDigest,
} from "./delegation/policy.js";
import { withSubagentOutcomeTiming } from "./subagent-announce-output.js";
import {
  captureSubagentCompletionReply,
  runSubagentAnnounceFlow,
  type SubagentRunOutcome,
} from "./subagent-announce.js";
import {
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import {
  resolveCleanupCompletionReason,
  resolveDeferredCleanupDecision,
} from "./subagent-registry-cleanup.js";
import { runOutcomesEqual } from "./subagent-registry-completion.js";
import {
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
  ANNOUNCE_EXPIRY_MS,
  classifySubagentModelCompletion,
  finalizeFrozenResultText,
  logAnnounceGiveUp,
  MAX_ANNOUNCE_RETRY_COUNT,
  MIN_ANNOUNCE_RETRY_DELAY_MS,
  persistSubagentSessionTiming,
  resolveAnnounceRetryDelayMs,
  safeRemoveAttachmentsDir,
} from "./subagent-registry-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  applySubagentResultReceiptToRun,
  persistSubagentResultReceiptForRunSync,
} from "./subagent-result-receipts.js";

const NO_VISIBLE_CHILD_COMPLETION_ERROR =
  "child run completed without a visible final assistant reply";
const GUARDED_COMPLETION_EVIDENCE_ERROR =
  "guarded child run completed without an accepted protected report and terminal receipt";

export function createSubagentRegistryLifecycleController(params: {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  subagentAnnounceTimeoutMs: number;
  persist(): void;
  clearPendingLifecycleError(runId: string): void;
  countPendingDescendantRuns(rootSessionKey: string): number;
  suppressAnnounceForSteerRestart(entry?: SubagentRunRecord): boolean;
  shouldEmitEndedHookForRun(args: {
    entry: SubagentRunRecord;
    reason: SubagentLifecycleEndedReason;
  }): boolean;
  emitSubagentEndedHookForRun(args: {
    entry: SubagentRunRecord;
    reason?: SubagentLifecycleEndedReason;
    sendFarewell?: boolean;
    accountId?: string;
  }): Promise<void>;
  notifyContextEngineSubagentEnded(args: {
    childSessionKey: string;
    reason: "completed" | "deleted";
    workspaceDir?: string;
  }): Promise<void>;
  resumeSubagentRun(runId: string): void;
  captureSubagentCompletionReply: typeof captureSubagentCompletionReply;
  cleanupBrowserSessionsForLifecycleEnd?: typeof cleanupBrowserSessionsForLifecycleEnd;
  runSubagentAnnounceFlow: typeof runSubagentAnnounceFlow;
  recordSubagentSliceTerminalOutcome?(args: {
    entry: SubagentRunRecord;
    endedAt: number;
    evidenceGapKind?: "timeout" | "no_visible_final" | "error" | "killed";
  }): boolean;
  warn(message: string, meta?: Record<string, unknown>): void;
}) {
  const scheduledResumeTimers = new Set<ReturnType<typeof setTimeout>>();

  const scheduleResumeSubagentRun = (runId: string, entry: SubagentRunRecord, delayMs: number) => {
    const timer = setTimeout(() => {
      scheduledResumeTimers.delete(timer);
      if (params.runs.get(runId) !== entry) {
        return;
      }
      params.resumeSubagentRun(runId);
    }, delayMs);
    timer.unref?.();
    scheduledResumeTimers.add(timer);
  };

  const clearScheduledResumeTimers = () => {
    for (const timer of scheduledResumeTimers) {
      clearTimeout(timer);
    }
    scheduledResumeTimers.clear();
  };

  const maskRunId = (runId: string): string => {
    const trimmed = runId.trim();
    if (!trimmed) {
      return "unknown";
    }
    if (trimmed.length <= 8) {
      return "***";
    }
    return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
  };

  const maskSessionKey = (sessionKey: string): string => {
    const trimmed = sessionKey.trim();
    if (!trimmed) {
      return "unknown";
    }
    const prefix = trimmed.split(":").slice(0, 2).join(":") || "session";
    return `${prefix}:…`;
  };

  const buildSafeLifecycleErrorMeta = (err: unknown): Record<string, string> => {
    const message = formatErrorMessage(err);
    const name = readErrorName(err);
    return name ? { name, message } : { message };
  };

  const resolveTerminalRouteHealthEvent = (args: {
    outcome: SubagentRunOutcome;
    reason: SubagentLifecycleEndedReason;
  }): { code: ChildRouteHealthCode; status: ChildRouteHealthEventStatus; reason: string } => {
    if (args.outcome.status === "ok") {
      return {
        code: "agent_lifecycle_error",
        status: "success",
        reason: "Sub-agent run completed successfully.",
      };
    }
    if (args.outcome.status === "timeout" || args.reason === SUBAGENT_ENDED_REASON_KILLED) {
      return {
        code: "agent_lifecycle_abandoned",
        status: "active",
        reason: "Sub-agent run ended without a usable completion.",
      };
    }
    return {
      code: "agent_lifecycle_error",
      status: "active",
      reason: "Sub-agent run ended with an error.",
    };
  };

  const recordTerminalRouteHealth = async (args: {
    entry: SubagentRunRecord;
    outcome: SubagentRunOutcome;
    reason: SubagentLifecycleEndedReason;
    endedAt: number;
  }) => {
    if (args.entry.suppressAnnounceReason === "fresh-reroute" && args.outcome.status === "ok") {
      return;
    }
    const event = resolveTerminalRouteHealthEvent({
      outcome: args.outcome,
      reason: args.reason,
    });
    let recorded: Awaited<ReturnType<typeof recordChildRouteHealthEvent>>;
    try {
      recorded = await recordChildRouteHealthEvent({
        code: event.code,
        status: event.status,
        source: "subagent_terminal",
        childSessionKey: args.entry.childSessionKey,
        runId: args.entry.runId,
        requesterSessionKey: args.entry.requesterSessionKey,
        observedAt: args.endedAt,
        reason: event.reason,
      });
    } catch (err) {
      params.warn("failed to record subagent route-health terminal state", {
        error: buildSafeLifecycleErrorMeta(err),
        runId: maskRunId(args.entry.runId),
        childSessionKey: maskSessionKey(args.entry.childSessionKey),
        outcomeStatus: args.outcome.status,
      });
      return;
    }
    if (!recorded.ok) {
      params.warn("failed to record subagent route-health terminal state", {
        error: recorded.error,
        runId: maskRunId(args.entry.runId),
        childSessionKey: maskSessionKey(args.entry.childSessionKey),
        outcomeStatus: args.outcome.status,
      });
    }
  };

  const safeSetSubagentTaskDeliveryStatus = (args: {
    runId: string;
    childSessionKey: string;
    deliveryStatus: "delivered" | "failed";
  }) => {
    try {
      setDetachedTaskDeliveryStatusByRunId({
        runId: args.runId,
        runtime: "subagent",
        sessionKey: args.childSessionKey,
        deliveryStatus: args.deliveryStatus,
      });
    } catch (err) {
      params.warn("failed to update subagent background task delivery state", {
        error: buildSafeLifecycleErrorMeta(err),
        runId: maskRunId(args.runId),
        childSessionKey: maskSessionKey(args.childSessionKey),
        deliveryStatus: args.deliveryStatus,
      });
    }
  };

  const safeFinalizeSubagentTaskRun = (args: {
    entry: SubagentRunRecord;
    outcome: SubagentRunOutcome;
  }) => {
    const endedAt = args.entry.endedAt ?? Date.now();
    const lastEventAt = endedAt;
    try {
      if (args.outcome.status === "ok") {
        completeTaskRunByRunId({
          runId: args.entry.runId,
          runtime: "subagent",
          sessionKey: args.entry.childSessionKey,
          endedAt,
          lastEventAt,
          progressSummary: args.entry.frozenResultText ?? undefined,
          terminalSummary: null,
        });
        return;
      }
      failTaskRunByRunId({
        runId: args.entry.runId,
        runtime: "subagent",
        sessionKey: args.entry.childSessionKey,
        status: args.outcome.status === "timeout" ? "timed_out" : "failed",
        endedAt,
        lastEventAt,
        error: args.outcome.status === "error" ? args.outcome.error : undefined,
        progressSummary: args.entry.frozenResultText ?? undefined,
        terminalSummary: null,
      });
    } catch (err) {
      params.warn("failed to finalize subagent background task state", {
        error: buildSafeLifecycleErrorMeta(err),
        runId: maskRunId(args.entry.runId),
        childSessionKey: maskSessionKey(args.entry.childSessionKey),
        outcomeStatus: args.outcome.status,
      });
    }
  };

  const validateGuardedCompletion = (args: {
    entry: SubagentRunRecord;
    outcome: SubagentRunOutcome;
    reason: SubagentLifecycleEndedReason;
    endedAt: number;
  }): {
    outcome: SubagentRunOutcome;
    reason: SubagentLifecycleEndedReason;
    mutated: boolean;
    evidenceGap: boolean;
  } => {
    const assignmentId = args.entry.delegationAssignmentId?.trim();
    if (!assignmentId) {
      return { outcome: args.outcome, reason: args.reason, mutated: false, evidenceGap: false };
    }

    if (args.outcome.status === "timeout") {
      let auditOnly = false;
      try {
        const guard = resolveDelegationGuardConfig(loadConfig());
        if (!guard) {
          throw new Error("delegation guard is unavailable");
        }
        auditOnly = guard.mode === "audit";
        const ledger = openConfiguredDelegationLedger({
          guard,
          policyDigest: resolveDelegationPolicyDigest(guard),
        });
        const assignment = ledger.getAssignment(assignmentId);
        const boundAssignment = ledger.resolveAssignmentForChildSession(args.entry.childSessionKey);
        if (
          !assignment ||
          assignment.epoch !== ledger.currentEpoch() ||
          boundAssignment?.assignmentId !== assignmentId
        ) {
          throw new Error("delegation assignment does not match the timed-out child run");
        }
        const reportSubmitted = ledger.hasReceiptForAssignment(assignmentId);
        ledger.appendRouteEvent({
          assignmentId,
          kind: reportSubmitted ? "validation_rejected" : "timeout",
          createdAt: args.endedAt,
          payload: reportSubmitted
            ? {
                runId: args.entry.runId,
                deadlineKind: "run",
                code: "run-timeout-after-report",
              }
            : { runId: args.entry.runId, deadlineKind: "run" },
        });
      } catch (err) {
        params.warn("failed to persist guarded run deadline", {
          error: buildSafeLifecycleErrorMeta(err),
          runId: maskRunId(args.entry.runId),
          childSessionKey: maskSessionKey(args.entry.childSessionKey),
          mode: auditOnly ? "audit" : "enforce",
        });
        if (auditOnly) {
          return { outcome: args.outcome, reason: args.reason, mutated: false, evidenceGap: true };
        }
        const outcome = withSubagentOutcomeTiming(
          { status: "error", error: GUARDED_COMPLETION_EVIDENCE_ERROR },
          { startedAt: args.entry.startedAt, endedAt: args.endedAt },
        );
        args.entry.outcome = outcome;
        args.entry.endedReason = SUBAGENT_ENDED_REASON_ERROR;
        return {
          outcome,
          reason: SUBAGENT_ENDED_REASON_ERROR,
          mutated: true,
          evidenceGap: true,
        };
      }
      return { outcome: args.outcome, reason: args.reason, mutated: false, evidenceGap: false };
    }
    if (args.outcome.status !== "ok") {
      return { outcome: args.outcome, reason: args.reason, mutated: false, evidenceGap: false };
    }

    let auditOnly = false;
    let auditRecorded = false;
    let protectedLedger: ReturnType<typeof openConfiguredDelegationLedger> | undefined;
    let violationCode:
      | "guard-unavailable"
      | "assignment-mismatch"
      | "missing-accepted-report"
      | "missing-terminal-receipt"
      | "protected-ledger-error" = "protected-ledger-error";
    try {
      const guard = resolveDelegationGuardConfig(loadConfig());
      if (!guard) {
        violationCode = "guard-unavailable";
        throw new Error("delegation guard is unavailable");
      }
      auditOnly = guard.mode === "audit";
      const ledger = openConfiguredDelegationLedger({
        guard,
        policyDigest: resolveDelegationPolicyDigest(guard),
      });
      protectedLedger = ledger;
      const assignment = ledger.getAssignment(assignmentId);
      const boundAssignment = ledger.resolveAssignmentForChildSession(args.entry.childSessionKey);
      if (
        !assignment ||
        assignment.epoch !== ledger.currentEpoch() ||
        boundAssignment?.assignmentId !== assignmentId
      ) {
        violationCode = "assignment-mismatch";
      } else {
        const accepted = ledger.acceptedReceiptForAssignment(assignmentId);
        if (
          !args.entry.resultReceiptId ||
          !args.entry.resultReceiptSha256 ||
          typeof args.entry.resultReceiptBytes !== "number" ||
          typeof args.entry.resultReceiptCapturedAt !== "number"
        ) {
          violationCode = "missing-terminal-receipt";
        } else {
          ledger.recordTerminalResultReceipt({
            assignmentId,
            runId: args.entry.runId,
            createdAt: args.endedAt,
            resultReceipt: {
              receiptId: args.entry.resultReceiptId,
              sha256: args.entry.resultReceiptSha256,
              bytes: args.entry.resultReceiptBytes,
              capturedAt: args.entry.resultReceiptCapturedAt,
              resultText:
                typeof args.entry.frozenResultText === "string" ? args.entry.frozenResultText : "",
            },
          });
          if (!accepted) {
            violationCode = "missing-accepted-report";
          } else {
            const terminalReceiptId = ledger.promoteRecordedTerminalCompletion({
              assignmentId,
              runId: args.entry.runId,
              createdAt: args.endedAt,
            });
            if (!terminalReceiptId) {
              violationCode = "missing-terminal-receipt";
            } else {
              return {
                outcome: args.outcome,
                reason: args.reason,
                mutated: false,
                evidenceGap: false,
              };
            }
          }
        }
      }
      ledger.appendRouteEvent({
        assignmentId,
        kind: "validation_rejected",
        createdAt: args.endedAt,
        payload: { runId: args.entry.runId, code: violationCode },
      });
      auditRecorded = true;
    } catch (err) {
      params.warn("failed to validate guarded subagent completion", {
        error: buildSafeLifecycleErrorMeta(err),
        runId: maskRunId(args.entry.runId),
        childSessionKey: maskSessionKey(args.entry.childSessionKey),
        code: violationCode,
      });
      if (protectedLedger?.getAssignment(assignmentId)) {
        try {
          protectedLedger.appendRouteEvent({
            assignmentId,
            kind: "validation_rejected",
            createdAt: args.endedAt,
            payload: { runId: args.entry.runId, code: violationCode },
          });
          auditRecorded = true;
        } catch (auditError) {
          params.warn("failed to persist guarded completion rejection", {
            error: buildSafeLifecycleErrorMeta(auditError),
            runId: maskRunId(args.entry.runId),
            childSessionKey: maskSessionKey(args.entry.childSessionKey),
            code: violationCode,
          });
        }
      }
    }

    if (auditOnly && auditRecorded) {
      return { outcome: args.outcome, reason: args.reason, mutated: false, evidenceGap: true };
    }
    const outcome = withSubagentOutcomeTiming(
      { status: "error", error: GUARDED_COMPLETION_EVIDENCE_ERROR },
      { startedAt: args.entry.startedAt, endedAt: args.endedAt },
    );
    args.entry.outcome = outcome;
    args.entry.endedReason = SUBAGENT_ENDED_REASON_ERROR;
    return {
      outcome,
      reason: SUBAGENT_ENDED_REASON_ERROR,
      mutated: true,
      evidenceGap: true,
    };
  };

  const hasVisibleFrozenResult = (entry: SubagentRunRecord): boolean =>
    typeof entry.frozenResultText === "string" && Boolean(entry.frozenResultText.trim());

  const requiresVisibleCompletion = (entry: SubagentRunRecord): boolean =>
    entry.expectsCompletionMessage === true && entry.outcome?.status === "ok";

  const updateModelCompletion = (
    entry: SubagentRunRecord,
    rawCompletionStopReason?: string,
  ): boolean => {
    const incomingStopReason = rawCompletionStopReason?.trim() || undefined;
    const currentStopReason = entry.rawCompletionStopReason?.trim() || undefined;
    const completionRank = (completion: SubagentRunRecord["modelCompletion"]): number =>
      completion === "truncated" ? 2 : completion === "complete" ? 1 : 0;
    const incomingCompletion = classifySubagentModelCompletion(incomingStopReason);
    const currentCompletion = classifySubagentModelCompletion(currentStopReason);
    const nextStopReason =
      incomingStopReason &&
      (!currentStopReason || completionRank(incomingCompletion) > completionRank(currentCompletion))
        ? incomingStopReason
        : currentStopReason;
    const nextCompletion = classifySubagentModelCompletion(nextStopReason);
    let changed = false;
    if (entry.rawCompletionStopReason !== nextStopReason) {
      entry.rawCompletionStopReason = nextStopReason;
      changed = true;
    }
    if (entry.modelCompletion !== nextCompletion) {
      entry.modelCompletion = nextCompletion;
      changed = true;
    }
    return changed;
  };

  const finalizeRunResult = (args: {
    entry: SubagentRunRecord;
    resultText: string;
    preserveExistingCapMetadata?: boolean;
  }): boolean => {
    const finalized = finalizeFrozenResultText({
      resultText: args.resultText,
      rawCompletionStopReason: args.entry.rawCompletionStopReason,
      ...(args.preserveExistingCapMetadata
        ? {
            priorRuntimeCapped: args.entry.frozenResultRuntimeCapped,
            originalBytes: args.entry.frozenResultOriginalBytes,
          }
        : {}),
    });
    let changed = false;
    if (args.entry.frozenResultText !== finalized.resultText) {
      args.entry.frozenResultText = finalized.resultText;
      changed = true;
    }
    if (args.entry.modelCompletion !== finalized.modelCompletion) {
      args.entry.modelCompletion = finalized.modelCompletion;
      changed = true;
    }
    if (args.entry.rawCompletionStopReason !== finalized.rawCompletionStopReason) {
      args.entry.rawCompletionStopReason = finalized.rawCompletionStopReason;
      changed = true;
    }
    if (args.entry.frozenResultRuntimeCapped !== finalized.runtimeCapped) {
      args.entry.frozenResultRuntimeCapped = finalized.runtimeCapped;
      changed = true;
    }
    if (args.entry.frozenResultOriginalBytes !== finalized.originalBytes) {
      args.entry.frozenResultOriginalBytes = finalized.originalBytes;
      changed = true;
    }
    return changed;
  };

  const clearSubagentResultReceipt = (entry: SubagentRunRecord): boolean => {
    let changed = false;
    const clear = (key: keyof SubagentRunRecord) => {
      if (entry[key] === undefined) {
        return;
      }
      delete entry[key];
      changed = true;
    };
    clear("resultReceiptId");
    clear("resultReceiptSha256");
    clear("resultReceiptBytes");
    clear("resultReceiptCapturedAt");
    return changed;
  };

  const freezeRunResultAtCompletion = async (
    entry: SubagentRunRecord,
  ): Promise<{ mutated: boolean; hasVisibleResult: boolean }> => {
    const requireAssistantReply = requiresVisibleCompletion(entry);
    if (entry.frozenResultText !== undefined) {
      let mutated = false;
      if (typeof entry.frozenResultText === "string") {
        mutated = finalizeRunResult({
          entry,
          resultText: entry.frozenResultText,
          preserveExistingCapMetadata: true,
        });
      }
      if (requireAssistantReply && !hasVisibleFrozenResult(entry)) {
        return { mutated, hasVisibleResult: false };
      }
      const persisted = persistSubagentResultReceiptForRunSync(entry);
      if (!persisted.ok) {
        params.warn("failed to persist subagent result receipt", {
          error: persisted.error,
          runId: maskRunId(entry.runId),
          childSessionKey: maskSessionKey(entry.childSessionKey),
        });
        if (entry.cleanup === "delete") {
          entry.cleanup = "keep";
          mutated = true;
        }
      }
      return { mutated, hasVisibleResult: hasVisibleFrozenResult(entry) };
    }
    try {
      const captured = await params.captureSubagentCompletionReply(entry.childSessionKey, {
        waitForReply: entry.expectsCompletionMessage === true,
        outcome: entry.outcome,
        ...(requireAssistantReply ? { requireAssistantReply: true } : {}),
      });
      const trimmed = captured?.trim();
      if (trimmed) {
        finalizeRunResult({ entry, resultText: trimmed });
      } else {
        entry.frozenResultText = null;
        entry.frozenResultRuntimeCapped = false;
        entry.frozenResultOriginalBytes = 0;
      }
    } catch {
      entry.frozenResultText = null;
      entry.frozenResultRuntimeCapped = false;
      entry.frozenResultOriginalBytes = 0;
    }
    entry.frozenResultCapturedAt = Date.now();
    if (requireAssistantReply && !hasVisibleFrozenResult(entry)) {
      return { mutated: true, hasVisibleResult: false };
    }
    const persisted = persistSubagentResultReceiptForRunSync(entry);
    if (!persisted.ok) {
      params.warn("failed to persist subagent result receipt", {
        error: persisted.error,
        runId: maskRunId(entry.runId),
        childSessionKey: maskSessionKey(entry.childSessionKey),
      });
      if (entry.cleanup === "delete") {
        entry.cleanup = "keep";
      }
    }
    return { mutated: true, hasVisibleResult: hasVisibleFrozenResult(entry) };
  };

  const listPendingCompletionRunsForSession = (sessionKey: string): SubagentRunRecord[] => {
    const key = sessionKey.trim();
    if (!key) {
      return [];
    }
    const out: SubagentRunRecord[] = [];
    for (const entry of params.runs.values()) {
      if (entry.childSessionKey !== key) {
        continue;
      }
      if (entry.expectsCompletionMessage !== true) {
        continue;
      }
      if (typeof entry.endedAt !== "number") {
        continue;
      }
      if (typeof entry.cleanupCompletedAt === "number") {
        continue;
      }
      out.push(entry);
    }
    return out;
  };

  const refreshFrozenResultFromSession = async (
    sessionKey: string,
    rawCompletionStopReason?: string,
  ): Promise<boolean> => {
    const candidates = listPendingCompletionRunsForSession(sessionKey);
    // A session can retain multiple ended generations. Without an exact run
    // binding, applying one late reply/stop reason to more than one generation
    // would fabricate evidence, so refresh only an unambiguous candidate.
    if (candidates.length !== 1) {
      return false;
    }

    let captured: string | undefined;
    try {
      captured = await params.captureSubagentCompletionReply(sessionKey);
    } catch {
      return false;
    }
    const trimmed = captured?.trim();
    if (!trimmed || isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) {
      return false;
    }

    const capturedAt = Date.now();
    const entry = candidates[0];
    let changed = updateModelCompletion(entry, rawCompletionStopReason);
    if (finalizeRunResult({ entry, resultText: trimmed })) {
      entry.frozenResultCapturedAt = capturedAt;
      changed = true;
    }
    const persisted = persistSubagentResultReceiptForRunSync(entry);
    if (!persisted.ok) {
      params.warn("failed to persist refreshed subagent result receipt", {
        error: persisted.error,
        runId: maskRunId(entry.runId),
        childSessionKey: maskSessionKey(entry.childSessionKey),
      });
      if (entry.cleanup === "delete") {
        entry.cleanup = "keep";
        changed = true;
      }
    }
    if (applySubagentResultReceiptToRun(entry)) {
      changed = true;
    }
    if (changed) {
      params.persist();
    }
    return changed;
  };

  const emitCompletionEndedHookIfNeeded = async (
    entry: SubagentRunRecord,
    reason: SubagentLifecycleEndedReason,
  ) => {
    if (
      entry.expectsCompletionMessage === true &&
      params.shouldEmitEndedHookForRun({
        entry,
        reason,
      })
    ) {
      await params.emitSubagentEndedHookForRun({
        entry,
        reason,
        sendFarewell: true,
      });
    }
  };

  const finalizeResumedAnnounceGiveUp = async (giveUpParams: {
    runId: string;
    entry: SubagentRunRecord;
    reason: "retry-limit" | "expiry";
  }) => {
    safeSetSubagentTaskDeliveryStatus({
      runId: giveUpParams.runId,
      childSessionKey: giveUpParams.entry.childSessionKey,
      deliveryStatus: "failed",
    });
    giveUpParams.entry.wakeOnDescendantSettle = undefined;
    giveUpParams.entry.fallbackFrozenResultText = undefined;
    giveUpParams.entry.fallbackFrozenResultCapturedAt = undefined;
    const shouldDeleteAttachments =
      giveUpParams.entry.cleanup === "delete" || !giveUpParams.entry.retainAttachmentsOnKeep;
    if (shouldDeleteAttachments) {
      await safeRemoveAttachmentsDir(giveUpParams.entry);
    }
    const completionReason = resolveCleanupCompletionReason(giveUpParams.entry);
    logAnnounceGiveUp(giveUpParams.entry, giveUpParams.reason);
    // Retry-limit / expiry give-up should not leave cleanup stuck behind the
    // best-effort ended hook. Mark the run cleaned first, then fire the hook.
    completeCleanupBookkeeping({
      runId: giveUpParams.runId,
      entry: giveUpParams.entry,
      cleanup: giveUpParams.entry.cleanup,
      completedAt: Date.now(),
    });
    await emitCompletionEndedHookIfNeeded(giveUpParams.entry, completionReason);
  };

  const beginSubagentCleanup = (runId: string) => {
    const entry = params.runs.get(runId);
    if (!entry) {
      return false;
    }
    if (entry.cleanupCompletedAt || entry.cleanupHandled) {
      return false;
    }
    entry.cleanupHandled = true;
    params.persist();
    return true;
  };

  const retryDeferredCompletedAnnounces = (excludeRunId?: string) => {
    const now = Date.now();
    for (const [runId, entry] of params.runs.entries()) {
      if (excludeRunId && runId === excludeRunId) {
        continue;
      }
      if (typeof entry.endedAt !== "number") {
        continue;
      }
      if (entry.cleanupCompletedAt || entry.cleanupHandled) {
        continue;
      }
      if (params.suppressAnnounceForSteerRestart(entry)) {
        continue;
      }
      const endedAgo = now - (entry.endedAt ?? now);
      if (entry.expectsCompletionMessage !== true && endedAgo > ANNOUNCE_EXPIRY_MS) {
        if (!beginSubagentCleanup(runId)) {
          continue;
        }
        void finalizeResumedAnnounceGiveUp({
          runId,
          entry,
          reason: "expiry",
        }).catch((error) => {
          defaultRuntime.log(
            `[warn] Subagent expiry finalize failed during deferred retry for run ${runId}: ${String(error)}`,
          );
          const current = params.runs.get(runId);
          if (!current || current.cleanupCompletedAt) {
            return;
          }
          current.cleanupHandled = false;
          params.persist();
        });
        continue;
      }
      params.resumedRuns.delete(runId);
      params.resumeSubagentRun(runId);
    }
  };

  const completeCleanupBookkeeping = (cleanupParams: {
    runId: string;
    entry: SubagentRunRecord;
    cleanup: "delete" | "keep";
    completedAt: number;
  }) => {
    if (cleanupParams.cleanup === "delete") {
      params.clearPendingLifecycleError(cleanupParams.runId);
      void params.notifyContextEngineSubagentEnded({
        childSessionKey: cleanupParams.entry.childSessionKey,
        reason: "deleted",
        workspaceDir: cleanupParams.entry.workspaceDir,
      });
      params.runs.delete(cleanupParams.runId);
      params.persist();
      retryDeferredCompletedAnnounces(cleanupParams.runId);
      return;
    }
    void params.notifyContextEngineSubagentEnded({
      childSessionKey: cleanupParams.entry.childSessionKey,
      reason: "completed",
      workspaceDir: cleanupParams.entry.workspaceDir,
    });
    cleanupParams.entry.cleanupCompletedAt = cleanupParams.completedAt;
    params.persist();
    retryDeferredCompletedAnnounces(cleanupParams.runId);
  };

  const finalizeSubagentCleanup = async (
    runId: string,
    cleanup: "delete" | "keep",
    didAnnounce: boolean,
    options?: {
      skipAnnounce?: boolean;
    },
  ) => {
    const entry = params.runs.get(runId);
    if (!entry) {
      return;
    }
    if (didAnnounce) {
      if (!options?.skipAnnounce) {
        entry.completionAnnouncedAt = Date.now();
        params.persist();
      }
      safeSetSubagentTaskDeliveryStatus({
        runId,
        childSessionKey: entry.childSessionKey,
        deliveryStatus: "delivered",
      });
      entry.wakeOnDescendantSettle = undefined;
      entry.fallbackFrozenResultText = undefined;
      entry.fallbackFrozenResultCapturedAt = undefined;
      const completionReason = resolveCleanupCompletionReason(entry);
      await emitCompletionEndedHookIfNeeded(entry, completionReason);
      const shouldDeleteAttachments = cleanup === "delete" || !entry.retainAttachmentsOnKeep;
      if (shouldDeleteAttachments) {
        await safeRemoveAttachmentsDir(entry);
      }
      if (cleanup === "delete") {
        entry.frozenResultText = undefined;
        entry.frozenResultCapturedAt = undefined;
      }
      completeCleanupBookkeeping({
        runId,
        entry,
        cleanup,
        completedAt: Date.now(),
      });
      return;
    }

    const now = Date.now();
    const deferredDecision = resolveDeferredCleanupDecision({
      entry,
      now,
      activeDescendantRuns: Math.max(0, params.countPendingDescendantRuns(entry.childSessionKey)),
      announceExpiryMs: ANNOUNCE_EXPIRY_MS,
      announceCompletionHardExpiryMs: ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
      maxAnnounceRetryCount: MAX_ANNOUNCE_RETRY_COUNT,
      deferDescendantDelayMs: MIN_ANNOUNCE_RETRY_DELAY_MS,
      resolveAnnounceRetryDelayMs,
    });

    if (deferredDecision.kind === "defer-descendants") {
      entry.lastAnnounceRetryAt = now;
      entry.wakeOnDescendantSettle = true;
      entry.cleanupHandled = false;
      params.resumedRuns.delete(runId);
      params.persist();
      scheduleResumeSubagentRun(runId, entry, deferredDecision.delayMs);
      return;
    }

    if (deferredDecision.retryCount != null) {
      entry.announceRetryCount = deferredDecision.retryCount;
      entry.lastAnnounceRetryAt = now;
    }

    if (deferredDecision.kind === "give-up") {
      safeSetSubagentTaskDeliveryStatus({
        runId,
        childSessionKey: entry.childSessionKey,
        deliveryStatus: "failed",
      });
      entry.wakeOnDescendantSettle = undefined;
      entry.fallbackFrozenResultText = undefined;
      entry.fallbackFrozenResultCapturedAt = undefined;
      const shouldDeleteAttachments = cleanup === "delete" || !entry.retainAttachmentsOnKeep;
      if (shouldDeleteAttachments) {
        await safeRemoveAttachmentsDir(entry);
      }
      const completionReason = resolveCleanupCompletionReason(entry);
      logAnnounceGiveUp(entry, deferredDecision.reason);
      // Giving up on announce delivery is terminal for cleanup even if the
      // best-effort hook is still resolving.
      completeCleanupBookkeeping({
        runId,
        entry,
        cleanup,
        completedAt: now,
      });
      await emitCompletionEndedHookIfNeeded(entry, completionReason);
      return;
    }

    entry.cleanupHandled = false;
    params.resumedRuns.delete(runId);
    params.persist();
    if (deferredDecision.resumeDelayMs == null) {
      return;
    }
    scheduleResumeSubagentRun(runId, entry, deferredDecision.resumeDelayMs);
  };

  const startSubagentAnnounceCleanupFlow = (runId: string, entry: SubagentRunRecord): boolean => {
    if (typeof entry.completionAnnouncedAt === "number") {
      if (!beginSubagentCleanup(runId)) {
        return false;
      }
      void finalizeSubagentCleanup(runId, entry.cleanup, true, {
        skipAnnounce: true,
      }).catch((err) => {
        defaultRuntime.log(`[warn] subagent cleanup finalize failed (${runId}): ${String(err)}`);
        const current = params.runs.get(runId);
        if (!current || current.cleanupCompletedAt) {
          return;
        }
        current.cleanupHandled = false;
        params.persist();
      });
      return true;
    }
    if (!beginSubagentCleanup(runId)) {
      return false;
    }
    const requesterOrigin = normalizeDeliveryContext(entry.requesterOrigin);
    const finalizeAnnounceCleanup = (didAnnounce: boolean) => {
      void finalizeSubagentCleanup(runId, entry.cleanup, didAnnounce).catch((err) => {
        defaultRuntime.log(`[warn] subagent cleanup finalize failed (${runId}): ${String(err)}`);
        const current = params.runs.get(runId);
        if (!current || current.cleanupCompletedAt) {
          return;
        }
        current.cleanupHandled = false;
        params.persist();
      });
    };

    void params
      .runSubagentAnnounceFlow({
        childSessionKey: entry.childSessionKey,
        childRunId: entry.runId,
        requesterSessionKey: entry.requesterSessionKey,
        requesterGeneration: entry.requesterGeneration,
        requesterOrigin,
        requesterDisplayKey: entry.requesterDisplayKey,
        task: entry.task,
        timeoutMs: params.subagentAnnounceTimeoutMs,
        cleanup: entry.cleanup,
        roundOneReply: entry.frozenResultText ?? undefined,
        fallbackReply: entry.fallbackFrozenResultText ?? undefined,
        waitForCompletion: false,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        label: entry.label,
        outcome: entry.outcome,
        spawnMode: entry.spawnMode,
        expectsCompletionMessage: entry.expectsCompletionMessage,
        wakeOnDescendantSettle: entry.wakeOnDescendantSettle === true,
      })
      .then((didAnnounce) => {
        finalizeAnnounceCleanup(didAnnounce);
      })
      .catch((error) => {
        defaultRuntime.log(
          `[warn] Subagent announce flow failed during cleanup for run ${runId}: ${String(error)}`,
        );
        finalizeAnnounceCleanup(false);
      });
    return true;
  };

  const completeSubagentRun = async (completeParams: {
    runId: string;
    endedAt?: number;
    outcome: SubagentRunOutcome;
    reason: SubagentLifecycleEndedReason;
    sendFarewell?: boolean;
    accountId?: string;
    triggerCleanup: boolean;
    rawCompletionStopReason?: string;
  }) => {
    params.clearPendingLifecycleError(completeParams.runId);
    const entry = params.runs.get(completeParams.runId);
    if (!entry) {
      return;
    }

    const completionMetadataMutated = updateModelCompletion(
      entry,
      completeParams.rawCompletionStopReason,
    );

    if (
      entry.suppressAnnounceReason === "killed" &&
      entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
      (entry.cleanupHandled || typeof entry.cleanupCompletedAt === "number")
    ) {
      let killedMutated = completionMetadataMutated;
      if (entry.frozenResultText === undefined) {
        entry.frozenResultText = null;
        entry.frozenResultCapturedAt = entry.endedAt ?? Date.now();
        entry.frozenResultRuntimeCapped = false;
        entry.frozenResultOriginalBytes = 0;
        killedMutated = true;
      }
      const persisted = persistSubagentResultReceiptForRunSync(entry);
      if (!persisted.ok) {
        params.warn("failed to persist killed subagent result receipt", {
          error: persisted.error,
          runId: maskRunId(entry.runId),
          childSessionKey: maskSessionKey(entry.childSessionKey),
        });
        if (entry.cleanup === "delete") {
          entry.cleanup = "keep";
          killedMutated = true;
        }
      }
      if (applySubagentResultReceiptToRun(entry)) {
        killedMutated = true;
      }
      if (killedMutated) {
        params.persist();
      }
      return;
    }

    let mutated = completionMetadataMutated;
    const endedAt =
      typeof completeParams.endedAt === "number" ? completeParams.endedAt : Date.now();
    if (entry.endedAt !== endedAt) {
      entry.endedAt = endedAt;
      mutated = true;
    }
    if (!runOutcomesEqual(entry.outcome, completeParams.outcome)) {
      entry.outcome = completeParams.outcome;
      mutated = true;
    }
    if (entry.endedReason !== completeParams.reason) {
      entry.endedReason = completeParams.reason;
      mutated = true;
    }

    let terminalEvidenceGapKind: "timeout" | "no_visible_final" | "error" | "killed" | undefined =
      completeParams.outcome.status === "timeout"
        ? "timeout"
        : completeParams.outcome.status === "error"
          ? "error"
          : undefined;
    const frozen = await freezeRunResultAtCompletion(entry);
    if (frozen.mutated) {
      mutated = true;
    }
    if (requiresVisibleCompletion(entry) && !frozen.hasVisibleResult) {
      terminalEvidenceGapKind = "no_visible_final";
      const noVisibleOutcome = withSubagentOutcomeTiming(
        { status: "error", error: NO_VISIBLE_CHILD_COMPLETION_ERROR },
        {
          startedAt: entry.startedAt,
          endedAt,
        },
      );
      if (!runOutcomesEqual(entry.outcome, noVisibleOutcome)) {
        entry.outcome = noVisibleOutcome;
        mutated = true;
      }
      if (entry.endedReason !== SUBAGENT_ENDED_REASON_ERROR) {
        entry.endedReason = SUBAGENT_ENDED_REASON_ERROR;
        mutated = true;
      }
      if (clearSubagentResultReceipt(entry)) {
        mutated = true;
      }
    }

    let terminalOutcome = entry.outcome ?? completeParams.outcome;
    let terminalReason = entry.endedReason ?? completeParams.reason;
    const guardedCompletion = validateGuardedCompletion({
      entry,
      outcome: terminalOutcome,
      reason: terminalReason,
      endedAt,
    });
    terminalOutcome = guardedCompletion.outcome;
    terminalReason = guardedCompletion.reason;
    if (guardedCompletion.mutated) {
      mutated = true;
    }
    if (guardedCompletion.evidenceGap && !terminalEvidenceGapKind) {
      terminalEvidenceGapKind = "error";
    }
    if (terminalReason === SUBAGENT_ENDED_REASON_KILLED) {
      terminalEvidenceGapKind = "killed";
    } else if (!terminalEvidenceGapKind && terminalOutcome.status === "error") {
      terminalEvidenceGapKind = "error";
    }

    try {
      await persistSubagentSessionTiming(entry);
    } catch (err) {
      params.warn("failed to persist subagent session timing", {
        err,
        runId: entry.runId,
        childSessionKey: entry.childSessionKey,
      });
    }

    await recordTerminalRouteHealth({
      entry,
      outcome: terminalOutcome,
      reason: terminalReason,
      endedAt,
    });

    if (
      params.recordSubagentSliceTerminalOutcome?.({
        entry,
        endedAt,
        evidenceGapKind: terminalEvidenceGapKind,
      })
    ) {
      mutated = true;
    }

    if (mutated) {
      params.persist();
    }
    safeFinalizeSubagentTaskRun({
      entry,
      outcome: terminalOutcome,
    });

    const suppressedForSteerRestart = params.suppressAnnounceForSteerRestart(entry);
    if (mutated && !suppressedForSteerRestart) {
      emitSessionLifecycleEvent({
        sessionKey: entry.childSessionKey,
        reason: "subagent-status",
        parentSessionKey: entry.requesterSessionKey,
        label: entry.label,
      });
    }
    const shouldEmitEndedHook =
      !suppressedForSteerRestart &&
      params.shouldEmitEndedHookForRun({
        entry,
        reason: terminalReason,
      });
    const shouldDeferEndedHook =
      shouldEmitEndedHook &&
      completeParams.triggerCleanup &&
      entry.expectsCompletionMessage === true &&
      !suppressedForSteerRestart;
    if (!shouldDeferEndedHook && shouldEmitEndedHook) {
      await params.emitSubagentEndedHookForRun({
        entry,
        reason: terminalReason,
        sendFarewell: completeParams.sendFarewell,
        accountId: completeParams.accountId,
      });
    }

    if (!completeParams.triggerCleanup || suppressedForSteerRestart) {
      return;
    }

    await (params.cleanupBrowserSessionsForLifecycleEnd ?? cleanupBrowserSessionsForLifecycleEnd)({
      sessionKeys: [entry.childSessionKey],
      onWarn: (msg) => params.warn(msg, { runId: entry.runId }),
    });

    startSubagentAnnounceCleanupFlow(completeParams.runId, entry);
  };

  return {
    clearScheduledResumeTimers,
    completeCleanupBookkeeping,
    completeSubagentRun,
    finalizeResumedAnnounceGiveUp,
    refreshFrozenResultFromSession,
    startSubagentAnnounceCleanupFlow,
  };
}
