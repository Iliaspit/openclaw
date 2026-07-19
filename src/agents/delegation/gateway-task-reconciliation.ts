import type { DelegationGuardConfig } from "../../config/types.agents.js";
import {
  assertDurableTaskLookupReady,
  completeTaskRunByRunId,
  failTaskRunByRunId,
  findTaskRunByExactScope,
  releaseTaskRunCleanupHold,
} from "../../tasks/task-executor.js";
import {
  openDelegationLedger,
  type DelegationGatewayTaskReconciliationOutcome,
  type DelegationGatewayTerminalKind,
  type DelegationLedger,
} from "./ledger.js";

export function reconcileDelegationGatewayTaskAfterRestart(
  params: { runId: string; targetSessionKey: string; requiredTask: boolean },
  deps: {
    assertReady?: typeof assertDurableTaskLookupReady;
    findTask?: typeof findTaskRunByExactScope;
  } = {},
): DelegationGatewayTaskReconciliationOutcome {
  const assertReady = deps.assertReady ?? assertDurableTaskLookupReady;
  const findTask = deps.findTask ?? findTaskRunByExactScope;
  assertReady();
  const task = findTask({
    runId: params.runId,
    runtime: "cli",
    childSessionKey: params.targetSessionKey,
  });
  if (!task) {
    if (params.requiredTask) {
      throw new Error(
        "Gateway restart reconciliation could not find its required durable task record.",
      );
    }
    return "absent";
  }
  if (
    task.runtime !== "cli" ||
    task.runId !== params.runId ||
    task.childSessionKey !== params.targetSessionKey
  ) {
    throw new Error("Gateway restart reconciliation found a mismatched durable task record.");
  }
  if (task.status === "queued" || task.status === "running") {
    if (!params.requiredTask) {
      // Without protected run proof, the Gateway cannot have started agent
      // execution. Active task state is therefore an interrupted pre-start
      // claim, not uncertain completed work.
      return "interrupted";
    }
    // A prior process may have completed external side effects and crashed before
    // terminal task accounting. Treat active durable state as uncertain and block
    // recovery instead of relabeling it failed and risking duplicate execution.
    return "uncertain";
  }
  return task.status === "succeeded" ? "completed" : "interrupted";
}

export function reconcileDelegationInitialSpawnTaskAfterRestart(params: {
  runId: string;
  targetSessionKey: string;
}): DelegationGatewayTaskReconciliationOutcome {
  assertDurableTaskLookupReady();
  const task = findTaskRunByExactScope({
    runId: params.runId,
    runtime: "subagent",
    childSessionKey: params.targetSessionKey,
  });
  if (!task) {
    return "absent";
  }
  if (
    task.runtime !== "subagent" ||
    task.runId !== params.runId ||
    task.childSessionKey !== params.targetSessionKey
  ) {
    throw new Error("Initial guarded spawn reconciliation found a mismatched durable task record.");
  }
  if (task.status === "queued" || task.status === "running") {
    failTaskRunByRunId({
      runId: params.runId,
      runtime: "subagent",
      status: "failed",
      endedAt: Date.now(),
      error: "guarded initial spawn was interrupted before exact Gateway authority",
      terminalSummary: "guarded initial spawn reconciled as pre-execution failure",
    });
    return "interrupted";
  }
  return task.status === "succeeded" ? "completed" : "interrupted";
}

export function reconcileDelegationGatewayTerminalTaskAfterRestart(params: {
  runId: string;
  targetSessionKey: string;
  terminalKind: DelegationGatewayTerminalKind;
}): void {
  assertDurableTaskLookupReady();
  let task = findTaskRunByExactScope({
    runId: params.runId,
    runtime: "cli",
    childSessionKey: params.targetSessionKey,
  });
  if (!task) {
    return;
  }
  if (
    task.runtime !== "cli" ||
    task.runId !== params.runId ||
    task.childSessionKey !== params.targetSessionKey
  ) {
    throw new Error("Terminal Gateway reconciliation found a mismatched durable task record.");
  }
  if (task.status === "queued" || task.status === "running") {
    const endedAt = Date.now();
    const settled =
      params.terminalKind === "completed" || params.terminalKind === "validation_rejected"
        ? completeTaskRunByRunId({
            runId: params.runId,
            runtime: "cli",
            sessionKey: params.targetSessionKey,
            endedAt,
            terminalSummary: "guarded Gateway dispatch reconciled as completed",
            cleanupAfter: Number.MAX_SAFE_INTEGER,
          })
        : failTaskRunByRunId({
            runId: params.runId,
            runtime: "cli",
            sessionKey: params.targetSessionKey,
            status: params.terminalKind === "timeout" ? "timed_out" : "failed",
            endedAt,
            terminalSummary: "guarded Gateway dispatch reconciled as rejected",
            cleanupAfter: Number.MAX_SAFE_INTEGER,
          });
    task = settled[0] ?? task;
  }
  if (task.status !== "queued" && task.status !== "running") {
    releaseTaskRunCleanupHold(task.taskId);
  }
}

export function openConfiguredDelegationLedger(params: {
  guard: DelegationGuardConfig;
  policyDigest: string;
  stateDir?: string;
}): DelegationLedger {
  return openDelegationLedger({
    ...params,
    reconcileGatewayTask: reconcileDelegationGatewayTaskAfterRestart,
    reconcileTerminalGatewayTask: reconcileDelegationGatewayTerminalTaskAfterRestart,
    reconcileInitialSpawnTask: reconcileDelegationInitialSpawnTaskAfterRestart,
  });
}
