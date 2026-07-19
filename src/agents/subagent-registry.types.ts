import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { SubagentRunOutcome } from "./subagent-announce-output.js";
import type { SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

export type SubagentSliceFullE2EGateGreen = boolean | "unknown";
export type SubagentSliceRole = "implementation" | "testing" | "review" | "qa" | "full_gate";
export type SubagentSliceContinuation = "default" | "same";
export type SubagentSliceBoundary = "original" | "post_full_gate_followup";

export type SubagentSliceBudgetTerminalEvidenceGapKind =
  | "timeout"
  | "no_visible_final"
  | "error"
  | "killed";

export type SubagentSliceBudgetRecord = {
  sliceKey: string;
  requesterSessionKey: string;
  requesterGeneration?: string;
  delegationAssignmentId?: string;
  delegationSliceId?: string;
  delegationEpoch?: number;
  targetAgentId?: string;
  label?: string;
  sliceRole?: SubagentSliceRole;
  sliceBoundary?: SubagentSliceBoundary;
  parentSliceKey?: string;
  taskSha256: string;
  discriminatorKind?: "label" | "task_sha256";
  firstObservedAt: number;
  lastObservedAt: number;
  childSpawnCount: number;
  childTimeoutCount: number;
  childTimeoutRunIds: string[];
  childTimeoutSessionKeys: string[];
  terminalEvidenceGapCount: number;
  terminalEvidenceGapRunIds: string[];
  lastTerminalEvidenceGapKind?: SubagentSliceBudgetTerminalEvidenceGapKind;
  childRouteHealthUnavailableCount: number;
  childRouteHealthUnavailableChildSessionKeys: string[];
  fullE2EGateGreen: SubagentSliceFullE2EGateGreen;
  fullE2EGateSignal: "unavailable" | "observed";
};

export type SubagentRunRecord = {
  runId: string;
  /** Protected-ledger assignment bound to this guarded run. */
  delegationAssignmentId?: string;
  /** Protected-ledger slice bound to this guarded run. */
  delegationSliceId?: string;
  /** Protected-ledger epoch bound to this guarded run. */
  delegationEpoch?: number;
  childSessionKey: string;
  controllerSessionKey?: string;
  requesterSessionKey: string;
  requesterGeneration?: string;
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
  spawnMode?: SpawnSubagentMode;
  createdAt: number;
  startedAt?: number;
  sessionStartedAt?: number;
  accumulatedRuntimeMs?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  archiveAtMs?: number;
  cleanupCompletedAt?: number;
  cleanupHandled?: boolean;
  sliceBudgetKey?: string;
  sliceTaskSha256?: string;
  sliceBudgetDiscriminator?: "label" | "task_sha256";
  suppressAnnounceReason?: "steer-restart" | "killed" | "fresh-reroute";
  expectsCompletionMessage?: boolean;
  announceRetryCount?: number;
  lastAnnounceRetryAt?: number;
  endedReason?: SubagentLifecycleEndedReason;
  wakeOnDescendantSettle?: boolean;
  frozenResultText?: string | null;
  frozenResultCapturedAt?: number;
  resultReceiptId?: string;
  resultReceiptSha256?: string;
  resultReceiptBytes?: number;
  resultReceiptCapturedAt?: number;
  fallbackFrozenResultText?: string | null;
  fallbackFrozenResultCapturedAt?: number;
  endedHookEmittedAt?: number;
  completionAnnouncedAt?: number;
  attachmentsDir?: string;
  attachmentsRootDir?: string;
  retainAttachmentsOnKeep?: boolean;
};
