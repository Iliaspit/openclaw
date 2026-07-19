import crypto from "node:crypto";
import { clearSessionQueues } from "../auto-reply/reply/queue.js";
import {
  resolveSubagentLabel,
  resolveSubagentTargetFromRuns,
  sortSubagentRuns,
  type SubagentTargetResolution,
} from "../auto-reply/reply/subagents-utils.js";
import type { SessionEntry } from "../config/sessions.js";
import { updateSessionStore } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { logVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { guardChildRouteForDelivery } from "./child-route-guard.js";
import { resolveChildRouteProviderContextFromSession } from "./child-route-provider-context.js";
import { openConfiguredDelegationLedger } from "./delegation/gateway-task-reconciliation.js";
import {
  resolveDelegationGuardConfig,
  resolveDelegationGuardPrincipal,
  resolveDelegationPolicyDigest,
} from "./delegation/policy.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import { abortEmbeddedPiRun } from "./pi-embedded-runner/runs.js";
import {
  readLatestAssistantReplySnapshot,
  waitForAgentRunAndReadUpdatedAssistantReply,
} from "./run-wait.js";
import { resolveStoredSubagentCapabilities } from "./subagent-capabilities.js";
import {
  buildLatestSubagentRunIndex,
  buildSubagentList,
  createPendingDescendantCounter,
  isActiveSubagentRun,
  resolveSessionEntryForKey,
  type BuiltSubagentList,
  type SessionEntryResolution,
  type SubagentListItem,
} from "./subagent-list.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  getLatestSubagentRunByChildSessionKey,
  listSubagentRunsForController,
} from "./subagent-registry-read.js";
import { getSubagentRunsSnapshotForRead } from "./subagent-registry-state.js";
import {
  clearSubagentRunSteerRestart,
  markSubagentRunTerminated,
  markSubagentRunForSteerRestart,
  replaceSubagentRunAfterSteer,
} from "./subagent-registry.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./tools/sessions-helpers.js";

export const DEFAULT_RECENT_MINUTES = 30;
export const MAX_RECENT_MINUTES = 24 * 60;
export const MAX_STEER_MESSAGE_CHARS = 4_000;
export const STEER_RATE_LIMIT_MS = 2_000;
export const STEER_ABORT_SETTLE_TIMEOUT_MS = 5_000;
const SUBAGENT_REPLY_HISTORY_LIMIT = 50;
const COMPACT_REASON_MAX_CHARS = 240;

const steerRateLimit = new Map<string, number>();

type GatewayCaller = typeof callGateway;

type CompactGatewayResponse = {
  ok?: unknown;
  key?: unknown;
  compacted?: unknown;
  reason?: unknown;
  checkpointId?: unknown;
  routeHealthRepairStatus?: unknown;
  result?: unknown;
};

export type CompactSubagentTarget =
  | {
      kind: "self";
      sessionKey: string;
    }
  | {
      kind: "child";
      entry: SubagentRunRecord;
    };

export type CompactControlledSubagentSessionResult = {
  status: "ok" | "error" | "forbidden";
  sessionKey: string;
  key?: string;
  compacted?: boolean;
  reason?: string;
  checkpointId?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  routeHealthRepairStatus?: string;
  text: string;
};

const defaultSubagentControlDeps = {
  callGateway,
};

let subagentControlDeps: {
  callGateway: GatewayCaller;
} = defaultSubagentControlDeps;

export type ResolvedSubagentController = {
  controllerSessionKey: string;
  callerSessionKey: string;
  callerIsSubagent: boolean;
  controlScope: "children" | "none";
};
export type { BuiltSubagentList, SessionEntryResolution, SubagentListItem };
export {
  buildSubagentList,
  createPendingDescendantCounter,
  isActiveSubagentRun,
  resolveSessionEntryForKey,
};

export function resolveSubagentController(params: {
  cfg: OpenClawConfig;
  agentSessionKey?: string;
}): ResolvedSubagentController {
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const callerRaw = params.agentSessionKey?.trim() || alias;
  const callerSessionKey = resolveInternalSessionKey({
    key: callerRaw,
    alias,
    mainKey,
  });
  if (!isSubagentSessionKey(callerSessionKey)) {
    return {
      controllerSessionKey: callerSessionKey,
      callerSessionKey,
      callerIsSubagent: false,
      controlScope: "children",
    };
  }
  const capabilities = resolveStoredSubagentCapabilities(callerSessionKey, {
    cfg: params.cfg,
  });
  return {
    controllerSessionKey: callerSessionKey,
    callerSessionKey,
    callerIsSubagent: true,
    controlScope: capabilities.controlScope,
  };
}

export function listControlledSubagentRuns(controllerSessionKey: string): SubagentRunRecord[] {
  const key = controllerSessionKey.trim();
  if (!key) {
    return [];
  }

  const snapshot = getSubagentRunsSnapshotForRead(subagentRuns);
  const latestByChildSessionKey = buildLatestSubagentRunIndex(snapshot).latestByChildSessionKey;
  const filtered = Array.from(latestByChildSessionKey.values()).filter((entry) => {
    const latestControllerSessionKey =
      entry.controllerSessionKey?.trim() || entry.requesterSessionKey?.trim();
    return latestControllerSessionKey === key;
  });
  return sortSubagentRuns(filtered);
}

function ensureControllerOwnsRun(params: {
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
}) {
  const owner = params.entry.controllerSessionKey?.trim() || params.entry.requesterSessionKey;
  if (owner === params.controller.controllerSessionKey) {
    return undefined;
  }
  return "Subagents can only control runs spawned from their own session.";
}

function normalizeCompactString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > COMPACT_REASON_MAX_CHARS
    ? `${trimmed.slice(0, COMPACT_REASON_MAX_CHARS - 3)}...`
    : trimmed;
}

function normalizeCompactTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.floor(value));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function summarizeCompactionGatewayResponse(params: {
  response: CompactGatewayResponse | undefined;
  fallbackKey: string;
}) {
  const response = params.response ?? {};
  const result = asRecord(response.result);
  const routeHealthRepairStatus =
    normalizeCompactString(response.routeHealthRepairStatus) ??
    normalizeCompactString(result?.routeHealthRepairStatus);
  return {
    status: response.ok === false ? ("error" as const) : ("ok" as const),
    key: normalizeCompactString(response.key) ?? params.fallbackKey,
    compacted: response.compacted === true,
    reason: normalizeCompactString(response.reason),
    checkpointId:
      normalizeCompactString(response.checkpointId) ?? normalizeCompactString(result?.checkpointId),
    tokensBefore: normalizeCompactTokenCount(result?.tokensBefore),
    tokensAfter: normalizeCompactTokenCount(result?.tokensAfter),
    ...(routeHealthRepairStatus ? { routeHealthRepairStatus } : {}),
  };
}

function formatCompactResultText(params: {
  sessionKey: string;
  compacted: boolean;
  reason?: string;
}) {
  if (params.compacted) {
    return `compacted ${params.sessionKey}.`;
  }
  return params.reason
    ? `did not compact ${params.sessionKey}: ${params.reason}.`
    : `did not compact ${params.sessionKey}.`;
}

async function killSubagentRun(params: {
  cfg: OpenClawConfig;
  entry: SubagentRunRecord;
  cache: Map<string, Record<string, SessionEntry>>;
}): Promise<{ killed: boolean; sessionId?: string }> {
  if (params.entry.endedAt) {
    return { killed: false };
  }
  const childSessionKey = params.entry.childSessionKey;
  const resolved = resolveSessionEntryForKey({
    cfg: params.cfg,
    key: childSessionKey,
    cache: params.cache,
  });
  const sessionId = resolved.entry?.sessionId;
  const aborted = sessionId ? abortEmbeddedPiRun(sessionId) : false;
  const cleared = clearSessionQueues([childSessionKey, sessionId]);
  if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
    logVerbose(
      `subagents control kill: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
    );
  }
  if (resolved.entry) {
    try {
      await updateSessionStore(resolved.storePath, (store) => {
        const current = store[childSessionKey];
        if (!current) {
          return;
        }
        current.abortedLastRun = true;
        current.updatedAt = Date.now();
        store[childSessionKey] = current;
      });
    } catch (error) {
      logVerbose(
        `subagents control kill: failed to persist abortedLastRun for ${childSessionKey}: ${formatErrorMessage(error)}`,
      );
    }
  }
  const marked = markSubagentRunTerminated({
    runId: params.entry.runId,
    childSessionKey,
    reason: "killed",
  });
  const killed = marked > 0 || aborted || cleared.followupCleared > 0 || cleared.laneCleared > 0;
  return { killed, sessionId };
}

async function cascadeKillChildren(params: {
  cfg: OpenClawConfig;
  parentChildSessionKey: string;
  cache: Map<string, Record<string, SessionEntry>>;
  seenChildSessionKeys?: Set<string>;
}): Promise<{ killed: number; labels: string[] }> {
  const childRunsBySessionKey = new Map<string, SubagentRunRecord>();
  for (const run of listSubagentRunsForController(params.parentChildSessionKey)) {
    const childKey = run.childSessionKey?.trim();
    if (!childKey) {
      continue;
    }
    const latest = getLatestSubagentRunByChildSessionKey(childKey);
    const latestControllerSessionKey =
      latest?.controllerSessionKey?.trim() || latest?.requesterSessionKey?.trim();
    if (
      !latest ||
      latest.runId !== run.runId ||
      latestControllerSessionKey !== params.parentChildSessionKey
    ) {
      continue;
    }
    const existing = childRunsBySessionKey.get(childKey);
    if (!existing || run.createdAt >= existing.createdAt) {
      childRunsBySessionKey.set(childKey, run);
    }
  }
  const childRuns = Array.from(childRunsBySessionKey.values());
  const seenChildSessionKeys = params.seenChildSessionKeys ?? new Set<string>();
  let killed = 0;
  const labels: string[] = [];

  for (const run of childRuns) {
    const childKey = run.childSessionKey?.trim();
    if (!childKey || seenChildSessionKeys.has(childKey)) {
      continue;
    }
    seenChildSessionKeys.add(childKey);

    if (!run.endedAt) {
      const stopResult = await killSubagentRun({
        cfg: params.cfg,
        entry: run,
        cache: params.cache,
      });
      if (stopResult.killed) {
        killed += 1;
        labels.push(resolveSubagentLabel(run));
      }
    }

    const cascade = await cascadeKillChildren({
      cfg: params.cfg,
      parentChildSessionKey: childKey,
      cache: params.cache,
      seenChildSessionKeys,
    });
    killed += cascade.killed;
    labels.push(...cascade.labels);
  }

  return { killed, labels };
}

export async function killAllControlledSubagentRuns(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  runs: SubagentRunRecord[];
}) {
  if (params.controller.controlScope !== "children") {
    return {
      status: "forbidden" as const,
      error: "Leaf subagents cannot control other sessions.",
      killed: 0,
      labels: [],
    };
  }
  const cache = new Map<string, Record<string, SessionEntry>>();
  const seenChildSessionKeys = new Set<string>();
  const killedLabels: string[] = [];
  let killed = 0;
  for (const entry of params.runs) {
    const childKey = entry.childSessionKey?.trim();
    if (!childKey || seenChildSessionKeys.has(childKey)) {
      continue;
    }
    const currentEntry = getLatestSubagentRunByChildSessionKey(childKey);
    if (!currentEntry || currentEntry.runId !== entry.runId) {
      continue;
    }
    seenChildSessionKeys.add(childKey);

    if (!currentEntry.endedAt) {
      const stopResult = await killSubagentRun({ cfg: params.cfg, entry: currentEntry, cache });
      if (stopResult.killed) {
        killed += 1;
        killedLabels.push(resolveSubagentLabel(currentEntry));
      }
    }

    const cascade = await cascadeKillChildren({
      cfg: params.cfg,
      parentChildSessionKey: childKey,
      cache,
      seenChildSessionKeys,
    });
    killed += cascade.killed;
    killedLabels.push(...cascade.labels);
  }
  return { status: "ok" as const, killed, labels: killedLabels };
}

export async function killControlledSubagentRun(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
}) {
  const ownershipError = ensureControllerOwnsRun({
    controller: params.controller,
    entry: params.entry,
  });
  if (ownershipError) {
    return {
      status: "forbidden" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: ownershipError,
    };
  }
  if (params.controller.controlScope !== "children") {
    return {
      status: "forbidden" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: "Leaf subagents cannot control other sessions.",
    };
  }
  const currentEntry = getLatestSubagentRunByChildSessionKey(params.entry.childSessionKey);
  if (!currentEntry || currentEntry.runId !== params.entry.runId) {
    return {
      status: "done" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      label: resolveSubagentLabel(params.entry),
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }
  const killCache = new Map<string, Record<string, SessionEntry>>();
  const stopResult = await killSubagentRun({
    cfg: params.cfg,
    entry: currentEntry,
    cache: killCache,
  });
  const seenChildSessionKeys = new Set<string>();
  const targetChildKey = params.entry.childSessionKey?.trim();
  if (targetChildKey) {
    seenChildSessionKeys.add(targetChildKey);
  }
  const cascade = await cascadeKillChildren({
    cfg: params.cfg,
    parentChildSessionKey: params.entry.childSessionKey,
    cache: killCache,
    seenChildSessionKeys,
  });
  if (!stopResult.killed && cascade.killed === 0) {
    return {
      status: "done" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      label: resolveSubagentLabel(params.entry),
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }
  const cascadeText =
    cascade.killed > 0 ? ` (+ ${cascade.killed} descendant${cascade.killed === 1 ? "" : "s"})` : "";
  return {
    status: "ok" as const,
    runId: params.entry.runId,
    sessionKey: params.entry.childSessionKey,
    label: resolveSubagentLabel(params.entry),
    cascadeKilled: cascade.killed,
    cascadeLabels: cascade.killed > 0 ? cascade.labels : undefined,
    text: stopResult.killed
      ? `killed ${resolveSubagentLabel(params.entry)}${cascadeText}.`
      : `killed ${cascade.killed} descendant${cascade.killed === 1 ? "" : "s"} of ${resolveSubagentLabel(params.entry)}.`,
  };
}

export async function killSubagentRunAdmin(params: { cfg: OpenClawConfig; sessionKey: string }) {
  const targetSessionKey = params.sessionKey.trim();
  if (!targetSessionKey) {
    return { found: false as const, killed: false };
  }
  const entry = getLatestSubagentRunByChildSessionKey(targetSessionKey);
  if (!entry) {
    return { found: false as const, killed: false };
  }

  const killCache = new Map<string, Record<string, SessionEntry>>();
  const stopResult = await killSubagentRun({
    cfg: params.cfg,
    entry,
    cache: killCache,
  });
  const seenChildSessionKeys = new Set<string>([targetSessionKey]);
  const cascade = await cascadeKillChildren({
    cfg: params.cfg,
    parentChildSessionKey: targetSessionKey,
    cache: killCache,
    seenChildSessionKeys,
  });

  return {
    found: true as const,
    killed: stopResult.killed || cascade.killed > 0,
    runId: entry.runId,
    sessionKey: entry.childSessionKey,
    cascadeKilled: cascade.killed,
    cascadeLabels: cascade.killed > 0 ? cascade.labels : undefined,
  };
}

export async function compactControlledSubagentSession(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  target: CompactSubagentTarget;
}): Promise<CompactControlledSubagentSessionResult> {
  let targetSessionKey = "";
  if (params.target.kind === "self") {
    targetSessionKey = params.target.sessionKey.trim();
  } else {
    const ownershipError = ensureControllerOwnsRun({
      controller: params.controller,
      entry: params.target.entry,
    });
    if (ownershipError) {
      return {
        status: "forbidden" as const,
        sessionKey: params.target.entry.childSessionKey,
        reason: ownershipError,
        text: ownershipError,
      };
    }
    if (params.controller.controlScope !== "children") {
      const reason = "Leaf subagents cannot control other sessions.";
      return {
        status: "forbidden" as const,
        sessionKey: params.target.entry.childSessionKey,
        reason,
        text: reason,
      };
    }
    const currentEntry = getLatestSubagentRunByChildSessionKey(params.target.entry.childSessionKey);
    if (!currentEntry || currentEntry.runId !== params.target.entry.runId) {
      const reason =
        `${resolveSubagentLabel(params.target.entry)} was superseded by ` +
        "a newer child generation.";
      return {
        status: "error" as const,
        sessionKey: params.target.entry.childSessionKey,
        reason,
        text: reason,
      };
    }
    targetSessionKey = params.target.entry.childSessionKey;
  }

  if (!targetSessionKey) {
    const reason = "Missing compaction target session.";
    return {
      status: "error" as const,
      sessionKey: targetSessionKey,
      reason,
      text: reason,
    };
  }

  let response: CompactGatewayResponse | undefined;
  try {
    response = await subagentControlDeps.callGateway({
      method: "sessions.compact",
      params: { key: targetSessionKey },
    });
  } catch (err) {
    const reason = normalizeCompactString(formatErrorMessage(err)) ?? "Compaction failed.";
    return {
      status: "error" as const,
      sessionKey: targetSessionKey,
      reason,
      text: reason,
    };
  }

  const summary = summarizeCompactionGatewayResponse({
    response,
    fallbackKey: targetSessionKey,
  });
  return {
    ...summary,
    sessionKey: targetSessionKey,
    text: formatCompactResultText({
      sessionKey: targetSessionKey,
      compacted: summary.compacted,
      reason: summary.reason,
    }),
  };
}

export async function steerControlledSubagentRun(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
  message: string;
  /** Runtime-owned guarded assignment consumed before this steer. */
  delegationAssignmentId?: string;
  /** Runtime-owned exact Gateway capability for guarded follow-up execution. */
  delegationGatewayDispatch?: string;
  idempotencyKey?: string;
}): Promise<
  | {
      status: "forbidden" | "done" | "rate_limited" | "error";
      runId?: string;
      sessionKey: string;
      sessionId?: string;
      error?: string;
      text?: string;
    }
  | {
      status: "accepted";
      runId: string;
      sessionKey: string;
      sessionId?: string;
      mode: "restart";
      label: string;
      text: string;
    }
> {
  let replacementProtectedScope:
    | {
        delegationAssignmentId: string;
        delegationSliceId: string;
        delegationEpoch: number;
      }
    | undefined;
  const delegationGuard = resolveDelegationGuardConfig(params.cfg);
  const targetAgentId = normalizeAgentId(
    resolveAgentIdFromSessionKey(params.entry.childSessionKey),
  );
  const guardedTarget = delegationGuard
    ? resolveDelegationGuardPrincipal(delegationGuard, targetAgentId)
    : undefined;
  if (delegationGuard?.mode === "enforce" && guardedTarget?.kind === "worker") {
    const assignmentId = params.delegationAssignmentId?.trim();
    if (!assignmentId) {
      return {
        status: "forbidden",
        runId: params.entry.runId,
        sessionKey: params.entry.childSessionKey,
        error: "Guarded worker steering requires a consumed delegation assignment token.",
      };
    }
    const ledger = openConfiguredDelegationLedger({
      guard: delegationGuard,
      policyDigest: resolveDelegationPolicyDigest(delegationGuard),
    });
    const assignment = ledger.getAssignment(assignmentId);
    const bound = ledger.resolveAssignmentForChildSession(params.entry.childSessionKey);
    if (
      !assignment ||
      assignment.epoch !== ledger.currentEpoch() ||
      assignment.assignmentId !== bound?.assignmentId ||
      assignment.assignmentId !== params.entry.delegationAssignmentId ||
      assignment.controllerSessionKey !== params.controller.controllerSessionKey ||
      normalizeAgentId(assignment.controllerAgentId) !==
        normalizeAgentId(resolveAgentIdFromSessionKey(params.controller.controllerSessionKey)) ||
      normalizeAgentId(assignment.workerAgentId) !== targetAgentId
    ) {
      return {
        status: "forbidden",
        runId: params.entry.runId,
        sessionKey: params.entry.childSessionKey,
        error: "Guarded worker steering does not match the current protected assignment.",
      };
    }
    replacementProtectedScope = {
      delegationAssignmentId: assignment.assignmentId,
      delegationSliceId: assignment.sliceId,
      delegationEpoch: assignment.epoch,
    };
  }
  const ownershipError = ensureControllerOwnsRun({
    controller: params.controller,
    entry: params.entry,
  });
  if (ownershipError) {
    return {
      status: "forbidden",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: ownershipError,
    };
  }
  if (params.controller.controlScope !== "children") {
    return {
      status: "forbidden",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: "Leaf subagents cannot control other sessions.",
    };
  }
  if (params.controller.callerSessionKey === params.entry.childSessionKey) {
    return {
      status: "forbidden",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: "Subagents cannot steer themselves.",
    };
  }
  const currentEntry = getLatestSubagentRunByChildSessionKey(params.entry.childSessionKey);
  if (!currentEntry || currentEntry.runId !== params.entry.runId) {
    return {
      status: "done",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }
  if (currentEntry.suppressAnnounceReason === "fresh-reroute") {
    return {
      status: "error",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: `${resolveSubagentLabel(params.entry)} was superseded by a fresh child generation.`,
    };
  }
  const targetSession = resolveSessionEntryForKey({
    cfg: params.cfg,
    key: params.entry.childSessionKey,
    cache: new Map<string, Record<string, SessionEntry>>(),
  });
  const routeGuard = await guardChildRouteForDelivery({
    childSessionKey: params.entry.childSessionKey,
    context: {
      routeIntent: "followup_reuse",
      targetMethod: "subagent_control.steer",
      requesterSessionKey: params.controller.controllerSessionKey,
      requesterGeneration: getLatestSubagentRunByChildSessionKey(
        params.controller.controllerSessionKey,
      )?.runId,
      childTargetKind: "subagent",
      registryRecord: currentEntry,
      provider: resolveChildRouteProviderContextFromSession({
        cfg: params.cfg,
        sessionKey: params.entry.childSessionKey,
        entry: targetSession.entry,
        requesterSessionKey: params.controller.controllerSessionKey,
      }),
    },
    payloadForHash: {
      method: "subagent_control.steer",
      message: params.message.trim(),
    },
  });
  if (!routeGuard.ok) {
    return {
      status: "error",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: routeGuard.message,
      text: JSON.stringify({
        ok: false,
        code: routeGuard.code,
        details: routeGuard.details,
      }),
    };
  }

  const rateKey = `${params.controller.callerSessionKey}:${params.entry.childSessionKey}`;
  if (process.env.VITEST !== "true") {
    const now = Date.now();
    const lastSentAt = steerRateLimit.get(rateKey) ?? 0;
    if (now - lastSentAt < STEER_RATE_LIMIT_MS) {
      return {
        status: "rate_limited",
        runId: params.entry.runId,
        sessionKey: params.entry.childSessionKey,
        error: "Steer rate limit exceeded. Wait a moment before sending another steer.",
      };
    }
    steerRateLimit.set(rateKey, now);
  }

  markSubagentRunForSteerRestart(params.entry.runId);

  const sessionId =
    typeof targetSession.entry?.sessionId === "string" && targetSession.entry.sessionId.trim()
      ? targetSession.entry.sessionId.trim()
      : undefined;

  if (sessionId) {
    abortEmbeddedPiRun(sessionId);
  }
  const cleared = clearSessionQueues([params.entry.childSessionKey, sessionId]);
  if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
    logVerbose(
      `subagents control steer: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
    );
  }

  try {
    await subagentControlDeps.callGateway({
      method: "agent.wait",
      params: {
        runId: params.entry.runId,
        timeoutMs: STEER_ABORT_SETTLE_TIMEOUT_MS,
      },
      timeoutMs: STEER_ABORT_SETTLE_TIMEOUT_MS + 2_000,
    });
  } catch {
    // Continue even if wait fails; steer should still be attempted.
  }

  const idempotencyKey = params.idempotencyKey ?? crypto.randomUUID();
  if (params.delegationAssignmentId && !params.delegationGatewayDispatch) {
    clearSubagentRunSteerRestart(params.entry.runId);
    return {
      status: "error",
      runId: idempotencyKey,
      sessionKey: params.entry.childSessionKey,
      sessionId,
      error: "Guarded worker steering requires its exact Gateway dispatch capability.",
    };
  }
  const runTimeoutSeconds = params.entry.runTimeoutSeconds ?? 0;
  let runId: string = idempotencyKey;
  try {
    const response = await subagentControlDeps.callGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: params.message,
        sessionKey: params.entry.childSessionKey,
        sessionId,
        idempotencyKey,
        deliver: false,
        channel: INTERNAL_MESSAGE_CHANNEL,
        lane: AGENT_LANE_SUBAGENT,
        timeout: runTimeoutSeconds,
        ...(params.delegationGatewayDispatch
          ? { delegationGatewayDispatch: params.delegationGatewayDispatch }
          : {}),
      },
      timeoutMs: 10_000,
    });
    if (typeof response?.runId === "string" && response.runId) {
      runId = response.runId;
    }
  } catch (err) {
    clearSubagentRunSteerRestart(params.entry.runId);
    const error = formatErrorMessage(err);
    return {
      status: "error",
      runId,
      sessionKey: params.entry.childSessionKey,
      sessionId,
      error,
    };
  }

  const replaced = replaceSubagentRunAfterSteer({
    previousRunId: params.entry.runId,
    nextRunId: runId,
    ...replacementProtectedScope,
    fallback: params.entry,
    task: params.message,
    runTimeoutSeconds,
  });
  if (!replaced) {
    clearSubagentRunSteerRestart(params.entry.runId);
    return {
      status: "error",
      runId,
      sessionKey: params.entry.childSessionKey,
      sessionId,
      error: "failed to replace steered subagent run",
    };
  }

  return {
    status: "accepted",
    runId,
    sessionKey: params.entry.childSessionKey,
    sessionId,
    mode: "restart",
    label: resolveSubagentLabel(params.entry),
    text: `steered ${resolveSubagentLabel(params.entry)}.`,
  };
}

export async function sendControlledSubagentMessage(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
  message: string;
  waitTimeoutMs?: number;
}) {
  const ownershipError = ensureControllerOwnsRun({
    controller: params.controller,
    entry: params.entry,
  });
  if (ownershipError) {
    return { status: "forbidden" as const, error: ownershipError };
  }
  if (params.controller.controlScope !== "children") {
    return {
      status: "forbidden" as const,
      error: "Leaf subagents cannot control other sessions.",
    };
  }
  const targetSessionKey = params.entry.childSessionKey;
  const waitTimeoutMs =
    typeof params.waitTimeoutMs === "number" && Number.isFinite(params.waitTimeoutMs)
      ? Math.max(1, Math.floor(params.waitTimeoutMs))
      : 30_000;
  const currentEntry = getLatestSubagentRunByChildSessionKey(params.entry.childSessionKey);
  if (!currentEntry || currentEntry.runId !== params.entry.runId) {
    return {
      status: "done" as const,
      runId: params.entry.runId,
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }
  const targetSession = resolveSessionEntryForKey({
    cfg: params.cfg,
    key: targetSessionKey,
    cache: new Map<string, Record<string, SessionEntry>>(),
  });
  const routeGuard = await guardChildRouteForDelivery({
    childSessionKey: targetSessionKey,
    context: {
      routeIntent: "followup_reuse",
      targetMethod: "subagent_control.send",
      requesterSessionKey: params.controller.controllerSessionKey,
      requesterGeneration: getLatestSubagentRunByChildSessionKey(
        params.controller.controllerSessionKey,
      )?.runId,
      childTargetKind: "subagent",
      registryRecord: currentEntry,
      provider: resolveChildRouteProviderContextFromSession({
        cfg: params.cfg,
        sessionKey: targetSessionKey,
        entry: targetSession.entry,
        requesterSessionKey: params.controller.controllerSessionKey,
      }),
    },
    payloadForHash: {
      method: "subagent_control.send",
      message: params.message.trim(),
    },
  });
  if (!routeGuard.ok) {
    return {
      status: "error" as const,
      runId: params.entry.runId,
      error: JSON.stringify({
        ok: false,
        code: routeGuard.code,
        details: routeGuard.details,
      }),
    };
  }
  try {
    const baselineReply = await readLatestAssistantReplySnapshot({
      sessionKey: targetSessionKey,
      limit: SUBAGENT_REPLY_HISTORY_LIMIT,
      callGateway: subagentControlDeps.callGateway,
    });
    const restart = await steerControlledSubagentRun({
      cfg: params.cfg,
      controller: params.controller,
      entry: currentEntry,
      message: params.message,
    });
    if (restart.status !== "accepted") {
      if (restart.status === "forbidden") {
        return {
          status: "forbidden" as const,
          error: restart.error ?? restart.text ?? "send failed",
        };
      }
      if (restart.status === "done") {
        return {
          status: "done" as const,
          runId: restart.runId ?? params.entry.runId,
          text: restart.text ?? `${resolveSubagentLabel(params.entry)} is already finished.`,
        };
      }
      return {
        status: "error" as const,
        runId: restart.runId ?? params.entry.runId,
        error: restart.error ?? restart.text ?? "send failed",
      };
    }
    const result = await waitForAgentRunAndReadUpdatedAssistantReply({
      runId: restart.runId,
      sessionKey: targetSessionKey,
      timeoutMs: waitTimeoutMs,
      limit: SUBAGENT_REPLY_HISTORY_LIMIT,
      baseline: baselineReply,
      callGateway: subagentControlDeps.callGateway,
    });
    if (result.status === "timeout") {
      return { status: "timeout" as const, runId: restart.runId };
    }
    if (result.status === "error") {
      return {
        status: "error" as const,
        runId: restart.runId,
        error: result.error ?? "unknown error",
      };
    }
    return { status: "ok" as const, runId: restart.runId, replyText: result.replyText };
  } catch (err) {
    const error = formatErrorMessage(err);
    return {
      status: "error" as const,
      runId: currentEntry.runId,
      error,
    };
  }
}

export function resolveControlledSubagentTarget(
  runs: SubagentRunRecord[],
  token: string | undefined,
  options?: { recentMinutes?: number; isActive?: (entry: SubagentRunRecord) => boolean },
): SubagentTargetResolution {
  return resolveSubagentTargetFromRuns({
    runs,
    token,
    recentWindowMinutes: options?.recentMinutes ?? DEFAULT_RECENT_MINUTES,
    label: (entry) => resolveSubagentLabel(entry),
    isActive: options?.isActive,
    errors: {
      missingTarget: "Missing subagent target.",
      invalidIndex: (value) => `Invalid subagent index: ${value}`,
      unknownSession: (value) => `Unknown subagent session: ${value}`,
      ambiguousLabel: (value) => `Ambiguous subagent label: ${value}`,
      ambiguousLabelPrefix: (value) => `Ambiguous subagent label prefix: ${value}`,
      ambiguousRunIdPrefix: (value) => `Ambiguous subagent run id prefix: ${value}`,
      unknownTarget: (value) => `Unknown subagent target: ${value}`,
    },
  });
}

export const __testing = {
  setDepsForTest(overrides?: Partial<{ callGateway: GatewayCaller }>) {
    subagentControlDeps = overrides
      ? {
          ...defaultSubagentControlDeps,
          ...overrides,
        }
      : defaultSubagentControlDeps;
  },
};
