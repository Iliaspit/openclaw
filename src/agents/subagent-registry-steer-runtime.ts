import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type ReplaceSubagentRunAfterSteerParams = {
  previousRunId: string;
  nextRunId: string;
  /** Runtime-owned guarded assignment for the replacement run. */
  delegationAssignmentId?: string;
  /** Runtime-owned guarded slice for the replacement run. */
  delegationSliceId?: string;
  /** Runtime-owned guarded epoch for the replacement run. */
  delegationEpoch?: number;
  fallback?: SubagentRunRecord;
  task?: string;
  runTimeoutSeconds?: number;
  preserveFrozenResultFallback?: boolean;
};

type ReplaceSubagentRunAfterSteerFn = (params: ReplaceSubagentRunAfterSteerParams) => boolean;

let replaceSubagentRunAfterSteerImpl: ReplaceSubagentRunAfterSteerFn | null = null;

export function configureSubagentRegistrySteerRuntime(params: {
  replaceSubagentRunAfterSteer: ReplaceSubagentRunAfterSteerFn;
}) {
  replaceSubagentRunAfterSteerImpl = params.replaceSubagentRunAfterSteer;
}

export function replaceSubagentRunAfterSteer(params: ReplaceSubagentRunAfterSteerParams) {
  return replaceSubagentRunAfterSteerImpl?.(params) ?? false;
}
