import { realpathSync } from "node:fs";
import { isThinkingLevelSupported, type ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { DelegationAssignmentRecord } from "./contracts.js";
import { openConfiguredDelegationLedger } from "./gateway-task-reconciliation.js";
import {
  resolveDelegationGuardConfig,
  resolveDelegationGuardPrincipal,
  resolveDelegationPolicyDigest,
} from "./policy.js";

export function resolveGuardedDelegationExecution(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  provider: string;
  model: string;
  thinking: ThinkLevel;
  workspaceDir?: string;
}): DelegationAssignmentRecord | undefined {
  if (!params.config) {
    return undefined;
  }
  const guard = resolveDelegationGuardConfig(params.config);
  if (!guard) {
    return undefined;
  }
  const principal = params.agentId
    ? resolveDelegationGuardPrincipal(guard, params.agentId)
    : undefined;
  if (!params.sessionKey) {
    if (guard.mode === "enforce" && principal?.kind === "worker") {
      throw new Error("Guarded workers require a runtime-bound delegation assignment.");
    }
    return undefined;
  }
  const ledger = openConfiguredDelegationLedger({
    guard,
    policyDigest: resolveDelegationPolicyDigest(guard),
  });
  const assignment = ledger.resolveAssignmentForChildSession(params.sessionKey);
  if (!assignment) {
    if (guard.mode === "enforce" && principal?.kind === "worker") {
      throw new Error("Guarded workers cannot execute outside a runtime-bound assignment.");
    }
    return undefined;
  }
  if (
    params.agentId &&
    normalizeAgentId(assignment.workerAgentId) !== normalizeAgentId(params.agentId)
  ) {
    throw new Error("Guarded delegation assignment does not match the executing worker.");
  }
  const slice = ledger.getSliceScope(assignment.sliceId);
  if (!slice || slice.epoch !== ledger.currentEpoch() || !params.workspaceDir?.trim()) {
    throw new Error("Guarded delegation requires the assignment's protected workspace.");
  }
  let effectiveWorkspace: string;
  try {
    effectiveWorkspace = realpathSync(params.workspaceDir);
  } catch {
    throw new Error("Guarded delegation workspace cannot be resolved canonically.");
  }
  if (effectiveWorkspace !== slice.repositoryRoot) {
    throw new Error(
      "Guarded delegation execution workspace does not match the protected slice worktree.",
    );
  }
  if (params.thinking !== assignment.requiredThinking) {
    throw new Error(
      `Guarded delegation requires exact ${assignment.requiredThinking} thinking; session or directive overrides are not allowed.`,
    );
  }
  const effectiveModel = `${params.provider}/${params.model}`;
  if (effectiveModel !== assignment.requiredModel) {
    throw new Error(
      `Guarded delegation is bound to ${assignment.requiredModel}; model switches and fallbacks are not allowed.`,
    );
  }
  if (
    !isThinkingLevelSupported({
      provider: params.provider,
      model: params.model,
      level: assignment.requiredThinking,
    })
  ) {
    throw new Error(
      `Guarded delegation requires exact ${assignment.requiredThinking} thinking, which is not supported for ${params.provider}/${params.model}.`,
    );
  }
  return assignment;
}

export function rejectGuardedThinkingFallback(
  assignment: DelegationAssignmentRecord | undefined,
): void {
  if (!assignment) {
    return;
  }
  throw new Error(
    `Guarded delegation requires exact ${assignment.requiredThinking} thinking; runtime thinking fallback is disabled.`,
  );
}
