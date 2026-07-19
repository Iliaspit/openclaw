import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  normalizeElevatedLevel,
  normalizeReasoningLevel,
  normalizeThinkLevel,
  normalizeTraceLevel,
  normalizeUsageDisplay,
  normalizeVerboseLevel,
} from "../auto-reply/thinking.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeExecAsk,
  normalizeExecSecurity,
  normalizeExecTarget,
} from "../infra/exec-approvals.js";
import type { SubagentLifecycleHookRunner } from "../plugins/hooks.js";
import { isValidAgentId, normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { findTaskRunByExactScope } from "../tasks/task-executor.js";
import type { BootstrapContextMode } from "./bootstrap-files.js";
import {
  markChildRoutePendingSpawnFailed,
  registerChildRoutePendingSpawn,
} from "./child-route-health.js";
import { resolveChildRouteProviderContextForSpawn } from "./child-route-provider-context.js";
import { guardFreshChildSpawnAuth } from "./child-route-spawn-preflight.js";
import type { DelegationAssignmentRecord } from "./delegation/contracts.js";
import { openConfiguredDelegationLedger } from "./delegation/gateway-task-reconciliation.js";
import {
  resolveDelegationGuardConfig,
  resolveDelegationGuardPrincipal,
  resolveDelegationPolicyDigest,
} from "./delegation/policy.js";
import {
  mapToolContextToSpawnedRunMetadata,
  normalizeSpawnedRunMetadata,
  resolveSpawnedWorkspaceInheritance,
} from "./spawned-context.js";
import {
  decodeStrictBase64,
  materializeSubagentAttachments,
  type SubagentAttachmentReceiptFile,
} from "./subagent-attachments.js";
import { resolveSubagentCapabilities } from "./subagent-capabilities.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import {
  assessSubagentSliceBudgetForSpawn,
  countActiveRunsForSession,
  failPendingSubagentTaskRun,
  recordSubagentSliceRouteHealthUnavailableForSpawn,
  registerPendingSubagentTaskRun,
  registerSubagentRun,
} from "./subagent-registry.js";
import { resolveSubagentSpawnAcceptedNote } from "./subagent-spawn-accepted-note.js";
export {
  SUBAGENT_SPAWN_ACCEPTED_NOTE,
  SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE,
} from "./subagent-spawn-accepted-note.js";
import type { SubagentSliceContinuation, SubagentSliceRole } from "./subagent-registry.types.js";
import {
  resolveConfiguredSubagentRunTimeoutSeconds,
  resolveSubagentModelAndThinkingPlan,
  splitModelRef,
} from "./subagent-spawn-plan.js";
import {
  ADMIN_SCOPE,
  AGENT_LANE_SUBAGENT,
  DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH,
  buildSubagentSliceRoleTaskNotice,
  buildSubagentSystemPrompt,
  callGateway,
  emitSessionLifecycleEvent,
  forkSessionFromParent,
  getGlobalHookRunner,
  loadConfig,
  mergeSessionEntry,
  normalizeDeliveryContext,
  pruneLegacyStoreKeys,
  resolveAgentConfig,
  resolveContextEngine,
  resolveDisplaySessionKey,
  resolveGatewaySessionStoreTarget,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  resolveParentForkMaxTokens,
  resolveSandboxRuntimeStatus,
  updateSessionStore,
  isAdminOnlyMethod,
} from "./subagent-spawn.runtime.js";
import {
  SUBAGENT_SPAWN_MODES,
  SUBAGENT_SPAWN_SANDBOX_MODES,
  type SpawnSubagentContextMode,
  type SpawnSubagentMode,
  type SpawnSubagentSandboxMode,
} from "./subagent-spawn.types.js";

export {
  SUBAGENT_SPAWN_CONTEXT_MODES,
  SUBAGENT_SPAWN_MODES,
  SUBAGENT_SPAWN_SANDBOX_MODES,
} from "./subagent-spawn.types.js";
export type {
  SpawnSubagentContextMode,
  SpawnSubagentMode,
  SpawnSubagentSandboxMode,
} from "./subagent-spawn.types.js";

export { decodeStrictBase64 };

type SubagentSpawnDeps = {
  callGateway: typeof callGateway;
  forkSessionFromParent: typeof forkSessionFromParent;
  getGlobalHookRunner: () => SubagentLifecycleHookRunner | null;
  loadConfig: typeof loadConfig;
  mergeSessionEntry: typeof mergeSessionEntry;
  resolveContextEngine: typeof resolveContextEngine;
  resolveGatewaySessionStoreTarget: typeof resolveGatewaySessionStoreTarget;
  resolveParentForkMaxTokens: typeof resolveParentForkMaxTokens;
  updateSessionStore: typeof updateSessionStore;
};

type SubagentSessionRuntimeReplay = Partial<{
  thinkingLevel: string;
  fastMode: boolean;
  verboseLevel: string;
  traceLevel: string;
  reasoningLevel: string;
  elevatedLevel: string;
  ttsAuto: string;
  execHost: string;
  execSecurity: string;
  execAsk: string;
  execNode: string;
  responseUsage: "on" | "off" | "tokens" | "full";
  authProfileOverride: string;
  authProfileOverrideSource: "auto" | "user";
}>;

function buildPatchableSessionRuntime(
  sessionRuntime?: SubagentSessionRuntimeReplay,
): Record<string, unknown> {
  if (!sessionRuntime) {
    return {};
  }
  const thinkingLevel = normalizeThinkLevel(sessionRuntime.thinkingLevel);
  const verboseLevel = normalizeVerboseLevel(sessionRuntime.verboseLevel);
  const traceLevel = normalizeTraceLevel(sessionRuntime.traceLevel);
  const reasoningLevel = normalizeReasoningLevel(sessionRuntime.reasoningLevel);
  const elevatedLevel = normalizeElevatedLevel(sessionRuntime.elevatedLevel);
  const execHost = normalizeExecTarget(sessionRuntime.execHost) ?? undefined;
  const execSecurity = normalizeExecSecurity(sessionRuntime.execSecurity) ?? undefined;
  const execAsk = normalizeExecAsk(sessionRuntime.execAsk) ?? undefined;
  const execNode = normalizeOptionalString(sessionRuntime.execNode);
  const responseUsage = normalizeUsageDisplay(sessionRuntime.responseUsage);
  return {
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(typeof sessionRuntime.fastMode === "boolean" ? { fastMode: sessionRuntime.fastMode } : {}),
    ...(verboseLevel ? { verboseLevel } : {}),
    ...(traceLevel ? { traceLevel } : {}),
    ...(reasoningLevel ? { reasoningLevel } : {}),
    ...(elevatedLevel ? { elevatedLevel } : {}),
    ...(execHost ? { execHost } : {}),
    ...(execSecurity ? { execSecurity } : {}),
    ...(execAsk ? { execAsk } : {}),
    ...(execNode ? { execNode } : {}),
    ...(responseUsage ? { responseUsage } : {}),
  };
}

function buildInitialChildSessionPatch(params: {
  spawnDepth: number;
  subagentRole: "main" | "orchestrator" | "leaf";
  subagentControlScope: "children" | "none";
  initialSessionPatch: Record<string, unknown>;
  guarded: boolean;
}): Record<string, unknown> {
  return {
    spawnDepth: params.spawnDepth,
    subagentRole: params.subagentRole === "main" ? null : params.subagentRole,
    subagentControlScope: params.subagentControlScope,
    // For guarded routes, model and thinking come from protected assignment
    // authority and are persisted internally below. They must not re-enter the
    // public sessions.patch path as if they were caller-supplied overrides.
    ...(params.guarded ? {} : params.initialSessionPatch),
  };
}

function buildProtectedDelegationAssignmentPrompt(
  assignment: Pick<DelegationAssignmentRecord, "assignmentId" | "purpose" | "role" | "scopeUnits">,
): string {
  const assignedScopeJson = JSON.stringify(assignment.scopeUnits);
  return [
    "[Protected Delegation Assignment]",
    `Runtime authority binds this session to assignment ${assignment.assignmentId} as ${assignment.role} for ${assignment.purpose}.`,
    "When calling delegation_report, report.scope.assigned MUST exactly equal the following JSON array:",
    assignedScopeJson,
    "Copy those scope IDs byte-for-byte into inspected, omitted, failed, newlyDiscovered, command scopeIds, and finding scopeIds where applicable.",
    "Do not add labels, aliases, descriptions, expectation annotations, or Markdown to a scope ID.",
  ].join("\n");
}

const defaultSubagentSpawnDeps: SubagentSpawnDeps = {
  callGateway,
  forkSessionFromParent,
  getGlobalHookRunner,
  loadConfig,
  mergeSessionEntry,
  resolveContextEngine,
  resolveGatewaySessionStoreTarget,
  resolveParentForkMaxTokens,
  updateSessionStore,
};

let subagentSpawnDeps: SubagentSpawnDeps = defaultSubagentSpawnDeps;

export type SpawnSubagentParams = {
  task: string;
  /** Runtime-owned guarded assignment consumed by the caller's routing gate. */
  delegationAssignmentId?: string;
  label?: string;
  agentId?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  thread?: boolean;
  mode?: SpawnSubagentMode;
  cleanup?: "delete" | "keep";
  sliceRole?: SubagentSliceRole;
  sliceContinuation?: SubagentSliceContinuation;
  sandbox?: SpawnSubagentSandboxMode;
  context?: SpawnSubagentContextMode;
  lightContext?: boolean;
  expectsCompletionMessage?: boolean;
  sessionRuntime?: SubagentSessionRuntimeReplay;
  attachments?: Array<{
    name: string;
    content: string;
    encoding?: "utf8" | "base64";
    mimeType?: string;
  }>;
  attachMountPath?: string;
};

export type SpawnSubagentContext = {
  agentSessionKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  agentMemberRoleIds?: string[];
  requesterAgentIdOverride?: string;
  /** Explicit workspace directory for subagent to inherit (optional). */
  workspaceDir?: string;
};

export type SpawnSubagentResult = {
  status: "accepted" | "forbidden" | "error";
  childSessionKey?: string;
  runId?: string;
  mode?: SpawnSubagentMode;
  note?: string;
  modelApplied?: boolean;
  error?: string;
  attachments?: {
    count: number;
    totalBytes: number;
    files: Array<{ name: string; bytes: number; sha256: string }>;
    relDir: string;
  };
};

export { splitModelRef } from "./subagent-spawn-plan.js";

async function updateSubagentSessionStore(
  storePath: string,
  mutator: Parameters<typeof updateSessionStore>[1],
) {
  return await subagentSpawnDeps.updateSessionStore(storePath, mutator);
}

async function callSubagentGateway(
  params: Parameters<typeof callGateway>[0],
): Promise<Awaited<ReturnType<typeof callGateway>>> {
  // Subagent lifecycle requires methods spanning multiple scope tiers
  // (sessions.patch / sessions.delete → admin, agent → write).  When each call
  // independently negotiates least-privilege scopes the first connection pairs
  // at a lower tier and every subsequent higher-tier call triggers a
  // scope-upgrade handshake that headless gateway-client connections cannot
  // complete interactively, causing close(1008) "pairing required" (#59428).
  //
  // Only admin-only methods are pinned to ADMIN_SCOPE; other methods (e.g.
  // "agent" → write) keep their least-privilege scope so that the gateway does
  // not treat the caller as owner (senderIsOwner) and expose owner-only tools.
  const scopes = params.scopes ?? (isAdminOnlyMethod(params.method) ? [ADMIN_SCOPE] : undefined);
  return await subagentSpawnDeps.callGateway({
    ...params,
    ...(scopes != null ? { scopes } : {}),
  });
}

function readGatewayRunId(response: Awaited<ReturnType<typeof callGateway>>): string | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }
  const { runId } = response as { runId?: unknown };
  return typeof runId === "string" && runId ? runId : undefined;
}

function loadSubagentConfig() {
  return subagentSpawnDeps.loadConfig();
}

async function persistInitialChildSessionRuntimeModel(params: {
  cfg: OpenClawConfig;
  childSessionKey: string;
  resolvedModel?: string;
  thinkingLevel?: string;
  sessionRuntime?: SubagentSessionRuntimeReplay;
}): Promise<string | undefined> {
  const { provider, model } = splitModelRef(params.resolvedModel);
  const thinkingLevel = normalizeThinkLevel(params.thinkingLevel);
  const authProfileOverride = normalizeOptionalString(params.sessionRuntime?.authProfileOverride);
  const authProfileOverrideSource = params.sessionRuntime?.authProfileOverrideSource;
  if (!model && !thinkingLevel && !authProfileOverride) {
    return undefined;
  }
  try {
    const target = subagentSpawnDeps.resolveGatewaySessionStoreTarget({
      cfg: params.cfg,
      key: params.childSessionKey,
    });
    await updateSubagentSessionStore(target.storePath, (store) => {
      pruneLegacyStoreKeys({
        store,
        canonicalKey: target.canonicalKey,
        candidates: target.storeKeys,
      });
      store[target.canonicalKey] = subagentSpawnDeps.mergeSessionEntry(store[target.canonicalKey], {
        ...(model ? { model } : {}),
        ...(provider ? { modelProvider: provider } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(authProfileOverride ? { authProfileOverride } : {}),
        ...(authProfileOverride && authProfileOverrideSource ? { authProfileOverrideSource } : {}),
      });
    });
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : typeof err === "string" ? err : "error";
  }
}

function sanitizeMountPathHint(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  // Prevent prompt injection via control/newline characters in system prompt hints.
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\u0000-\u001F\u007F\u0085\u2028\u2029]/.test(trimmed)) {
    return undefined;
  }
  if (!/^[A-Za-z0-9._\-/:]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

async function cleanupProvisionalSession(
  childSessionKey: string,
  options?: {
    emitLifecycleHooks?: boolean;
    deleteTranscript?: boolean;
  },
): Promise<string | undefined> {
  try {
    await callSubagentGateway({
      method: "sessions.delete",
      params: {
        key: childSessionKey,
        emitLifecycleHooks: options?.emitLifecycleHooks === true,
        deleteTranscript: options?.deleteTranscript === true,
      },
      timeoutMs: 10_000,
    });
    return undefined;
  } catch (error) {
    return summarizeError(error);
  }
}

async function cleanupFailedSpawnBeforeAgentStart(params: {
  childSessionKey: string;
  attachmentAbsDir?: string;
  emitLifecycleHooks?: boolean;
  deleteTranscript?: boolean;
}): Promise<string | undefined> {
  let attachmentCleanupError: string | undefined;
  if (params.attachmentAbsDir) {
    try {
      await fs.rm(params.attachmentAbsDir, { recursive: true, force: true });
    } catch (error) {
      attachmentCleanupError = `failed to remove provisional attachments: ${summarizeError(error)}`;
    }
  }
  const sessionCleanupError = await cleanupProvisionalSession(params.childSessionKey, {
    emitLifecycleHooks: params.emitLifecycleHooks,
    deleteTranscript: params.deleteTranscript,
  });
  return (
    [attachmentCleanupError, sessionCleanupError]
      .filter((value): value is string => Boolean(value))
      .join("; ") || undefined
  );
}

function failPendingSubagentTaskRunVerified(params: {
  pendingRunId: string;
  childSessionKey: string;
  error: string;
}): string | undefined {
  try {
    failPendingSubagentTaskRun({
      pendingRunId: params.pendingRunId,
      error: params.error,
    });
    const task = findTaskRunByExactScope({
      runId: params.pendingRunId,
      runtime: "subagent",
      childSessionKey: params.childSessionKey,
    });
    if (!task) {
      return "durable pending subagent task disappeared during terminalization";
    }
    if (task.status === "queued" || task.status === "running") {
      return `durable pending subagent task remained ${task.status}`;
    }
    return undefined;
  } catch (error) {
    return summarizeError(error);
  }
}

async function cleanupRejectedProtectedInitialSpawns(
  ledger: ReturnType<typeof openConfiguredDelegationLedger>,
): Promise<void> {
  for (const target of ledger.listRejectedInitialSpawnCleanupTargets()) {
    const pending = await markChildRoutePendingSpawnFailed({
      childSessionKey: target.childSessionKey,
      requesterSessionKey: target.controllerSessionKey,
      idempotencyKey: target.runId,
    });
    if (!pending.ok) {
      throw new Error(
        `failed to terminalize rejected protected pending-spawn state: ${pending.error}`,
      );
    }
    await callSubagentGateway({
      method: "sessions.delete",
      params: {
        key: target.childSessionKey,
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      timeoutMs: 10_000,
    });
    ledger.recordRejectedInitialSpawnCleanup({
      assignmentId: target.assignmentId,
      childSessionKey: target.childSessionKey,
      runId: target.runId,
    });
  }
}

type PreparedSubagentSpawnContext =
  | { status: "ok"; rollback?: () => void | Promise<void> }
  | { status: "error"; error: string };

function findSessionEntry(
  store: Record<string, SessionEntry>,
  keys: readonly string[],
): SessionEntry | undefined {
  for (const key of keys) {
    const entry = store[key];
    if (entry) {
      return entry;
    }
  }
  return undefined;
}

async function rollbackPreparedSubagentContext(
  rollback: (() => void | Promise<void>) | undefined,
): Promise<void> {
  if (!rollback) {
    return;
  }
  try {
    await rollback();
  } catch {
    // Best-effort cleanup only.
  }
}

async function prepareSubagentSpawnContext(params: {
  cfg: OpenClawConfig;
  contextMode: SpawnSubagentContextMode;
  parentSessionKey: string;
  childSessionKey: string;
  targetAgentId: string;
}): Promise<PreparedSubagentSpawnContext> {
  try {
    const contextEngine = await subagentSpawnDeps.resolveContextEngine(params.cfg);
    const parentTarget = subagentSpawnDeps.resolveGatewaySessionStoreTarget({
      cfg: params.cfg,
      key: params.parentSessionKey,
    });
    let parentEntry: SessionEntry | undefined;
    await updateSubagentSessionStore(parentTarget.storePath, (store) => {
      parentEntry = findSessionEntry(store, parentTarget.storeKeys);
    });

    let childSessionId: string | undefined;
    let childSessionFile: string | undefined;
    if (params.contextMode === "fork") {
      if (!parentEntry?.sessionId || !parentEntry.sessionFile) {
        return {
          status: "error",
          error:
            'context="fork" requires requester session metadata with an existing transcript file.',
        };
      }
      const maxParentForkTokens = subagentSpawnDeps.resolveParentForkMaxTokens(params.cfg);
      const parentTokens =
        typeof parentEntry.totalTokens === "number" && Number.isFinite(parentEntry.totalTokens)
          ? parentEntry.totalTokens
          : undefined;
      if (maxParentForkTokens <= 0 || parentTokens == null || parentTokens <= maxParentForkTokens) {
        const forked = await subagentSpawnDeps.forkSessionFromParent({
          parentEntry,
          agentId: params.targetAgentId,
          sessionsDir: path.dirname(parentTarget.storePath),
        });
        if (!forked) {
          return {
            status: "error",
            error: 'context="fork" could not fork the requester transcript.',
          };
        }
        childSessionId = forked.sessionId;
        childSessionFile = forked.sessionFile;
        const childTarget = subagentSpawnDeps.resolveGatewaySessionStoreTarget({
          cfg: params.cfg,
          key: params.childSessionKey,
        });
        await updateSubagentSessionStore(childTarget.storePath, (store) => {
          store[childTarget.canonicalKey] = subagentSpawnDeps.mergeSessionEntry(
            store[childTarget.canonicalKey],
            {
              sessionId: childSessionId,
              sessionFile: childSessionFile,
              forkedFromParent: true,
              updatedAt: Date.now(),
            },
          );
        });
      }
    }

    const preparation = await contextEngine.prepareSubagentSpawn?.({
      parentSessionKey: params.parentSessionKey,
      childSessionKey: params.childSessionKey,
      contextMode: params.contextMode,
      parentSessionId: parentEntry?.sessionId,
      parentSessionFile: parentEntry?.sessionFile,
      childSessionId,
      childSessionFile,
    });
    return { status: "ok", rollback: preparation?.rollback };
  } catch (err) {
    return { status: "error", error: summarizeError(err) };
  }
}

function resolveSpawnMode(params: {
  requestedMode?: SpawnSubagentMode;
  threadRequested: boolean;
}): SpawnSubagentMode {
  if (params.requestedMode === "run" || params.requestedMode === "session") {
    return params.requestedMode;
  }
  // Thread-bound spawns should default to persistent sessions.
  return params.threadRequested ? "session" : "run";
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

function summarizeDelegationGatewayResponse(response: unknown, fallback: string): string {
  if (response && typeof response === "object") {
    const message = normalizeOptionalString((response as { message?: unknown }).message);
    if (message) {
      return message;
    }
  }
  return fallback;
}

async function ensureThreadBindingForSubagentSpawn(params: {
  hookRunner: SubagentLifecycleHookRunner | null;
  childSessionKey: string;
  agentId: string;
  label?: string;
  mode: SpawnSubagentMode;
  requesterSessionKey?: string;
  requester: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
}): Promise<{ status: "ok" } | { status: "error"; error: string }> {
  const hookRunner = params.hookRunner;
  if (!hookRunner?.hasHooks("subagent_spawning")) {
    return {
      status: "error",
      error:
        "thread=true is unavailable because no channel plugin registered subagent_spawning hooks.",
    };
  }

  try {
    const result = await hookRunner.runSubagentSpawning(
      {
        childSessionKey: params.childSessionKey,
        agentId: params.agentId,
        label: params.label,
        mode: params.mode,
        requester: params.requester,
        threadRequested: true,
      },
      {
        childSessionKey: params.childSessionKey,
        requesterSessionKey: params.requesterSessionKey,
      },
    );
    if (result?.status === "error") {
      const error = result.error.trim();
      return {
        status: "error",
        error: error || "Failed to prepare thread binding for this subagent session.",
      };
    }
    if (result?.status !== "ok" || !result.threadBindingReady) {
      return {
        status: "error",
        error:
          "Unable to create or bind a thread for this subagent session. Session mode is unavailable for this target.",
      };
    }
    return { status: "ok" };
  } catch (err) {
    return {
      status: "error",
      error: `Thread bind failed: ${summarizeError(err)}`,
    };
  }
}

export async function spawnSubagentDirect(
  params: SpawnSubagentParams,
  ctx: SpawnSubagentContext,
): Promise<SpawnSubagentResult> {
  const task = params.task;
  const label = params.label?.trim() || "";
  const sliceRole = params.sliceRole;
  const sliceContinuation = params.sliceContinuation;
  const requestedAgentId = params.agentId?.trim();

  // Reject malformed agentId before normalizeAgentId can mangle it.
  // Without this gate, error-message strings like "Agent not found: xyz" pass
  // through normalizeAgentId and become "agent-not-found--xyz", which later
  // creates ghost workspace directories and triggers cascading cron loops (#31311).
  if (requestedAgentId && !isValidAgentId(requestedAgentId)) {
    return {
      status: "error",
      error: `Invalid agentId "${requestedAgentId}". Agent IDs must match [a-z0-9][a-z0-9_-]{0,63}. Use agents_list to discover valid targets.`,
    };
  }
  const modelOverride = params.model;
  const thinkingOverrideRaw = params.thinking;
  const requestThreadBinding = params.thread === true;
  const sandboxMode = params.sandbox === "require" ? "require" : "inherit";
  const spawnMode = resolveSpawnMode({
    requestedMode: params.mode,
    threadRequested: requestThreadBinding,
  });
  if (spawnMode === "session" && !requestThreadBinding) {
    return {
      status: "error",
      error: 'mode="session" requires thread=true so the subagent can stay bound to a thread.',
    };
  }
  const cleanup =
    spawnMode === "session"
      ? "keep"
      : params.cleanup === "keep" || params.cleanup === "delete"
        ? params.cleanup
        : "keep";
  const expectsCompletionMessage = params.expectsCompletionMessage !== false;
  const requesterOrigin = normalizeDeliveryContext({
    channel: ctx.agentChannel,
    accountId: ctx.agentAccountId,
    to: ctx.agentTo,
    threadId: ctx.agentThreadId,
  });
  const hookRunner = subagentSpawnDeps.getGlobalHookRunner();
  const cfg = loadSubagentConfig();

  // When agent omits runTimeoutSeconds, use the config default.
  // Falls back to 0 (no timeout) if config key is also unset,
  // preserving current behavior for existing deployments.
  const runTimeoutSeconds = resolveConfiguredSubagentRunTimeoutSeconds({
    cfg,
    runTimeoutSeconds: params.runTimeoutSeconds,
  });
  let modelApplied = false;
  let threadBindingReady = false;
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  const requesterSessionKey = ctx.agentSessionKey;
  const requesterInternalKey = requesterSessionKey
    ? resolveInternalSessionKey({
        key: requesterSessionKey,
        alias,
        mainKey,
      })
    : alias;
  const requesterDisplayKey = resolveDisplaySessionKey({
    key: requesterInternalKey,
    alias,
    mainKey,
  });

  const callerDepth = getSubagentDepthFromSessionStore(requesterInternalKey, { cfg });
  const maxSpawnDepth =
    cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
  if (callerDepth >= maxSpawnDepth) {
    return {
      status: "forbidden",
      error: `sessions_spawn is not allowed at this depth (current depth: ${callerDepth}, max: ${maxSpawnDepth})`,
    };
  }

  const maxChildren = cfg.agents?.defaults?.subagents?.maxChildrenPerAgent ?? 5;
  const activeChildren = countActiveRunsForSession(requesterInternalKey);
  if (activeChildren >= maxChildren) {
    return {
      status: "forbidden",
      error: `sessions_spawn has reached max active children for this session (${activeChildren}/${maxChildren})`,
    };
  }

  const requesterAgentId = normalizeAgentId(
    ctx.requesterAgentIdOverride ?? parseAgentSessionKey(requesterInternalKey)?.agentId,
  );
  const requireAgentId =
    resolveAgentConfig(cfg, requesterAgentId)?.subagents?.requireAgentId ??
    cfg.agents?.defaults?.subagents?.requireAgentId ??
    false;
  if (requireAgentId && !requestedAgentId?.trim()) {
    return {
      status: "forbidden",
      error:
        "sessions_spawn requires explicit agentId when requireAgentId is configured. Use agents_list to see allowed agent ids.",
    };
  }
  const targetAgentId = requestedAgentId ? normalizeAgentId(requestedAgentId) : requesterAgentId;
  if (targetAgentId !== requesterAgentId) {
    const allowAgents =
      resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ??
      cfg?.agents?.defaults?.subagents?.allowAgents ??
      [];
    const allowAny = allowAgents.some((value) => value.trim() === "*");
    const normalizedTargetId = normalizeLowercaseStringOrEmpty(targetAgentId);
    const allowSet = new Set(
      allowAgents
        .filter((value) => value.trim() && value.trim() !== "*")
        .map((value) => normalizeLowercaseStringOrEmpty(normalizeAgentId(value))),
    );
    if (!allowAny && !allowSet.has(normalizedTargetId)) {
      const allowedText = allowSet.size > 0 ? Array.from(allowSet).join(", ") : "none";
      return {
        status: "forbidden",
        error: `agentId is not allowed for sessions_spawn (allowed: ${allowedText})`,
      };
    }
  }
  const delegationAssignmentId = normalizeOptionalString(params.delegationAssignmentId);
  const delegationGuard = resolveDelegationGuardConfig(cfg);
  const delegationTarget = delegationGuard
    ? resolveDelegationGuardPrincipal(delegationGuard, targetAgentId)
    : undefined;
  if (
    delegationGuard?.mode === "enforce" &&
    delegationTarget?.kind === "worker" &&
    !delegationAssignmentId
  ) {
    return {
      status: "forbidden",
      error:
        "Guarded workers can only be spawned through a controller-issued delegation assignment.",
    };
  }
  let delegationAssignment: DelegationAssignmentRecord | undefined;
  let delegationLedger: ReturnType<typeof openConfiguredDelegationLedger> | undefined;
  let delegationRepositoryRoot: string | undefined;
  if (delegationAssignmentId) {
    if (!delegationGuard) {
      return {
        status: "error",
        error: "A guarded delegation assignment cannot run while the delegation guard is disabled.",
      };
    }
    if (delegationTarget?.kind !== "worker") {
      return {
        status: "error",
        error: "A guarded delegation assignment can only target a configured worker.",
      };
    }
    try {
      delegationLedger = openConfiguredDelegationLedger({
        guard: delegationGuard,
        policyDigest: resolveDelegationPolicyDigest(delegationGuard),
      });
      await cleanupRejectedProtectedInitialSpawns(delegationLedger);
      delegationAssignment = delegationLedger.getAssignment(delegationAssignmentId);
    } catch (err) {
      return {
        status: "error",
        error: `Unable to resolve the protected delegation assignment: ${summarizeError(err)}`,
      };
    }
    if (
      !delegationAssignment ||
      delegationAssignment.epoch !== delegationLedger.currentEpoch() ||
      normalizeAgentId(delegationAssignment.controllerAgentId) !== requesterAgentId ||
      delegationAssignment.controllerSessionKey !== requesterInternalKey ||
      normalizeAgentId(delegationAssignment.workerAgentId) !== targetAgentId
    ) {
      return {
        status: "error",
        error:
          "The guarded delegation assignment is stale or does not match this controller/worker route.",
      };
    }
    const slice = delegationLedger.getSliceScope(delegationAssignment.sliceId);
    if (!slice || slice.epoch !== delegationLedger.currentEpoch()) {
      return {
        status: "error",
        error: "The guarded delegation slice workspace is missing or stale.",
      };
    }
    try {
      delegationRepositoryRoot = await fs.realpath(slice.repositoryRoot);
    } catch (err) {
      return {
        status: "error",
        error: `Unable to resolve the protected delegation workspace: ${summarizeError(err)}`,
      };
    }
    if (delegationRepositoryRoot !== slice.repositoryRoot) {
      return {
        status: "error",
        error: "The protected delegation workspace changed canonical identity.",
      };
    }
    const replayThinking = params.sessionRuntime?.thinkingLevel;
    if (
      replayThinking &&
      normalizeThinkLevel(replayThinking) !== delegationAssignment.requiredThinking
    ) {
      return {
        status: "error",
        error: `Guarded delegation requires exact ${delegationAssignment.requiredThinking} thinking; conflicting session runtime patches are not allowed.`,
      };
    }
  }
  const sliceBudget = assessSubagentSliceBudgetForSpawn({
    requesterSessionKey: requesterInternalKey,
    delegationAssignmentId: delegationAssignment?.assignmentId,
    delegationSliceId: delegationAssignment?.sliceId,
    delegationEpoch: delegationAssignment?.epoch,
    targetAgentId,
    label: label || undefined,
    sliceRole,
    sliceContinuation,
    task,
  });
  if (!sliceBudget.ok) {
    return {
      status: "error",
      error: sliceBudget.error,
    };
  }
  const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
  const requesterRuntime = resolveSandboxRuntimeStatus({
    cfg,
    sessionKey: requesterInternalKey,
  });
  const childRuntime = resolveSandboxRuntimeStatus({
    cfg,
    sessionKey: childSessionKey,
  });
  if (!childRuntime.sandboxed && (requesterRuntime.sandboxed || sandboxMode === "require")) {
    if (requesterRuntime.sandboxed) {
      return {
        status: "forbidden",
        error:
          "Sandboxed sessions cannot spawn unsandboxed subagents. Set a sandboxed target agent or use the same agent runtime.",
      };
    }
    return {
      status: "forbidden",
      error:
        'sessions_spawn sandbox="require" needs a sandboxed target runtime. Pick a sandboxed agentId or use sandbox="inherit".',
    };
  }
  const childDepth = callerDepth + 1;
  const spawnedByKey = requesterInternalKey;
  const childCapabilities = resolveSubagentCapabilities({
    depth: childDepth,
    maxSpawnDepth,
  });
  const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId);
  const plan = resolveSubagentModelAndThinkingPlan({
    cfg,
    targetAgentId,
    targetAgentConfig,
    modelOverride,
    thinkingOverrideRaw,
    requiredThinking: delegationAssignment?.requiredThinking,
  });
  if (plan.status === "error") {
    return {
      status: "error",
      error: plan.error,
    };
  }
  const { resolvedModel, thinkingOverride } = plan;
  if (delegationAssignment && resolvedModel !== delegationAssignment.requiredModel) {
    return {
      status: "error",
      error: `Guarded delegation requires exact model ${delegationAssignment.requiredModel}; model switches and fallbacks are not allowed.`,
    };
  }
  const spawnProviderContext = resolveChildRouteProviderContextForSpawn({
    cfg,
    sessionKey: childSessionKey,
    requesterSessionKey: requesterInternalKey,
    modelRef: resolvedModel,
  });
  const authProfileOverride = normalizeOptionalString(params.sessionRuntime?.authProfileOverride);
  if (authProfileOverride) {
    spawnProviderContext.authProfileKey = authProfileOverride;
  }
  // Shared with every registration-failure path below: repeated failures for
  // the same requester+task slice trip the route-health-unavailable budget,
  // so a persistently broken route (e.g. a task-store write failure) surfaces
  // as an explicit blocker instead of silently retrying forever.
  const recordRegistrationRouteHealthUnavailable = (fallbackError: string): string => {
    const routeHealthBudget = recordSubagentSliceRouteHealthUnavailableForSpawn({
      requesterSessionKey: requesterInternalKey,
      delegationAssignmentId: delegationAssignment?.assignmentId,
      delegationSliceId: delegationAssignment?.sliceId,
      delegationEpoch: delegationAssignment?.epoch,
      targetAgentId,
      label: label || undefined,
      sliceRole,
      sliceContinuation,
      task,
      childSessionKey,
    });
    return !routeHealthBudget.ok ? routeHealthBudget.error : fallbackError;
  };
  const spawnAuthPreflight = await guardFreshChildSpawnAuth(spawnProviderContext, {
    childSessionKey,
    includeProviderDefaultCredentialBlockers: true,
  });
  if (!spawnAuthPreflight.ok) {
    return {
      status: "error",
      error:
        spawnAuthPreflight.code === "child_route_health_unavailable"
          ? recordRegistrationRouteHealthUnavailable(spawnAuthPreflight.error)
          : spawnAuthPreflight.error,
      childSessionKey,
    };
  }
  const patchChildSession = async (patch: Record<string, unknown>): Promise<string | undefined> => {
    try {
      await callSubagentGateway({
        method: "sessions.patch",
        params: { key: childSessionKey, ...patch },
        timeoutMs: 10_000,
      });
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : typeof err === "string" ? err : "error";
    }
  };

  const childIdem = crypto.randomUUID();
  const pendingSpawn = await registerChildRoutePendingSpawn({
    childSessionKey,
    requesterSessionKey: requesterInternalKey,
    childTargetKind: "subagent",
    idempotencyKey: childIdem,
    runId: childIdem,
    targetAgentId,
  });
  if (!pendingSpawn.ok) {
    return {
      status: "error",
      error: `failed to persist child route pending-spawn state: ${pendingSpawn.error}`,
      childSessionKey,
    };
  }
  const markPendingSpawnFailed = async (): Promise<string | undefined> => {
    const result = await markChildRoutePendingSpawnFailed({
      childSessionKey,
      requesterSessionKey: requesterInternalKey,
      idempotencyKey: childIdem,
      pendingSpawnId: pendingSpawn.pendingSpawnId,
    });
    return result.ok ? undefined : result.error;
  };
  const failPreparedInitialSpawn = async (failure: {
    error: string;
    status?: "error" | "forbidden";
    attachmentAbsDir?: string;
    rollback?: () => void | Promise<void>;
    taskMayExist?: boolean;
  }) => {
    const cleanupErrors: string[] = [];
    if (failure.rollback) {
      try {
        await failure.rollback();
      } catch (error) {
        cleanupErrors.push(`context rollback failed: ${summarizeError(error)}`);
      }
    }
    const pendingCleanupError = await markPendingSpawnFailed();
    if (pendingCleanupError) {
      cleanupErrors.push(`pending-spawn cleanup failed: ${pendingCleanupError}`);
    }
    if (failure.taskMayExist) {
      const taskCleanupError = failPendingSubagentTaskRunVerified({
        pendingRunId: childIdem,
        childSessionKey,
        error: failure.error,
      });
      if (taskCleanupError) {
        cleanupErrors.push(`task cleanup failed: ${taskCleanupError}`);
      }
    }
    const sessionCleanupError = await cleanupFailedSpawnBeforeAgentStart({
      childSessionKey,
      attachmentAbsDir: failure.attachmentAbsDir,
      emitLifecycleHooks: threadBindingReady,
      deleteTranscript: true,
    });
    if (sessionCleanupError) {
      cleanupErrors.push(`session cleanup failed: ${sessionCleanupError}`);
    }
    if (delegationAssignment && delegationLedger) {
      try {
        delegationLedger.rejectRouteIfOpen({
          assignmentId: delegationAssignment.assignmentId,
          targetSessionKey: childSessionKey,
          runId: childIdem,
          reason: failure.error,
        });
      } catch (error) {
        cleanupErrors.push(`assignment settlement failed: ${summarizeError(error)}`);
      }
    }
    return {
      status: failure.status ?? ("error" as const),
      error:
        cleanupErrors.length > 0 ? `${failure.error}; ${cleanupErrors.join("; ")}` : failure.error,
      childSessionKey,
    };
  };

  const initialChildSessionPatch = buildInitialChildSessionPatch({
    spawnDepth: childDepth,
    subagentRole: childCapabilities.role,
    subagentControlScope: childCapabilities.controlScope,
    initialSessionPatch: plan.initialSessionPatch,
    guarded: Boolean(delegationAssignment),
  });

  const initialPatchError = await patchChildSession(initialChildSessionPatch);
  if (initialPatchError) {
    return failPreparedInitialSpawn({
      error: initialPatchError,
    });
  }
  if (resolvedModel || delegationAssignment || authProfileOverride) {
    const runtimeModelPersistError = await persistInitialChildSessionRuntimeModel({
      cfg,
      childSessionKey,
      resolvedModel,
      thinkingLevel: delegationAssignment?.requiredThinking,
      sessionRuntime: params.sessionRuntime,
    });
    if (runtimeModelPersistError) {
      return failPreparedInitialSpawn({
        error: runtimeModelPersistError,
      });
    }
    modelApplied = true;
  }
  if (requestThreadBinding) {
    let bindResult: Awaited<ReturnType<typeof ensureThreadBindingForSubagentSpawn>>;
    try {
      bindResult = await ensureThreadBindingForSubagentSpawn({
        hookRunner,
        childSessionKey,
        agentId: targetAgentId,
        label: label || undefined,
        mode: spawnMode,
        requesterSessionKey: requesterInternalKey,
        requester: {
          channel: requesterOrigin?.channel,
          accountId: requesterOrigin?.accountId,
          to: requesterOrigin?.to,
          threadId: requesterOrigin?.threadId,
        },
      });
    } catch (error) {
      return failPreparedInitialSpawn({
        error: `Failed to bind protected child thread: ${summarizeError(error)}`,
      });
    }
    if (bindResult.status === "error") {
      return failPreparedInitialSpawn({
        error: bindResult.error,
      });
    }
    threadBindingReady = true;
  }
  const mountPathHint = sanitizeMountPathHint(params.attachMountPath);

  let childSystemPrompt = buildSubagentSystemPrompt({
    requesterSessionKey,
    requesterOrigin,
    childSessionKey,
    label: label || undefined,
    task,
    sliceRole,
    acpEnabled: cfg.acp?.enabled !== false && !childRuntime.sandboxed,
    childDepth,
    maxSpawnDepth,
  });
  if (delegationAssignment) {
    childSystemPrompt = `${childSystemPrompt}\n\n${buildProtectedDelegationAssignmentPrompt(delegationAssignment)}`;
  }

  let retainOnSessionKeep = false;
  let attachmentsReceipt:
    | {
        count: number;
        totalBytes: number;
        files: SubagentAttachmentReceiptFile[];
        relDir: string;
      }
    | undefined;
  let attachmentAbsDir: string | undefined;
  let attachmentRootDir: string | undefined;
  let materializedAttachments: Awaited<ReturnType<typeof materializeSubagentAttachments>>;
  try {
    materializedAttachments = await materializeSubagentAttachments({
      config: cfg,
      targetAgentId,
      attachments: params.attachments,
      mountPathHint,
    });
  } catch (error) {
    return failPreparedInitialSpawn({
      error: `Failed to materialize subagent attachments: ${summarizeError(error)}`,
    });
  }
  if (materializedAttachments && materializedAttachments.status !== "ok") {
    return failPreparedInitialSpawn({
      status: materializedAttachments.status,
      error: materializedAttachments.error,
    });
  }
  if (materializedAttachments?.status === "ok") {
    retainOnSessionKeep = materializedAttachments.retainOnSessionKeep;
    attachmentsReceipt = materializedAttachments.receipt;
    attachmentAbsDir = materializedAttachments.absDir;
    attachmentRootDir = materializedAttachments.rootDir;
    childSystemPrompt = `${childSystemPrompt}\n\n${materializedAttachments.systemPromptSuffix}`;
  }

  const spawnContextMode: SpawnSubagentContextMode =
    params.context === "fork" ? "fork" : "isolated";
  let preparedContext: Awaited<ReturnType<typeof prepareSubagentSpawnContext>>;
  try {
    preparedContext = await prepareSubagentSpawnContext({
      cfg,
      contextMode: spawnContextMode,
      parentSessionKey: requesterInternalKey,
      childSessionKey,
      targetAgentId,
    });
  } catch (error) {
    return failPreparedInitialSpawn({
      error: `Failed to prepare subagent context: ${summarizeError(error)}`,
      attachmentAbsDir,
    });
  }
  if (preparedContext.status === "error") {
    return failPreparedInitialSpawn({
      error: preparedContext.error,
      attachmentAbsDir,
    });
  }

  const bootstrapContextMode: BootstrapContextMode | undefined = params.lightContext
    ? "lightweight"
    : undefined;

  const childTaskMessage = [
    `[Subagent Context] You are running as a subagent (depth ${childDepth}/${maxSpawnDepth}). Results auto-announce to your requester; do not busy-poll for status.`,
    spawnMode === "session"
      ? "[Subagent Context] This subagent session is persistent and remains available for thread follow-up messages."
      : undefined,
    buildSubagentSliceRoleTaskNotice(sliceRole),
    `[Subagent Task]: ${task}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n\n");

  const toolSpawnMetadata = mapToolContextToSpawnedRunMetadata({
    agentGroupId: ctx.agentGroupId,
    agentGroupChannel: ctx.agentGroupChannel,
    agentGroupSpace: ctx.agentGroupSpace,
    workspaceDir: ctx.workspaceDir,
  });
  if (delegationRepositoryRoot) {
    try {
      if ((await fs.realpath(delegationRepositoryRoot)) !== delegationRepositoryRoot) {
        throw new Error("canonical workspace identity changed");
      }
    } catch (err) {
      return failPreparedInitialSpawn({
        error: `Protected delegation workspace is no longer available: ${summarizeError(err)}`,
        attachmentAbsDir,
        rollback: preparedContext.rollback,
      });
    }
  }
  const spawnedMetadata = normalizeSpawnedRunMetadata({
    spawnedBy: spawnedByKey,
    ...toolSpawnMetadata,
    workspaceDir: resolveSpawnedWorkspaceInheritance({
      config: cfg,
      targetAgentId,
      requesterSessionKey: requesterInternalKey,
      explicitWorkspaceDir:
        delegationRepositoryRoot ??
        (targetAgentId === requesterAgentId ? toolSpawnMetadata.workspaceDir : undefined),
    }),
  });
  const patchableSessionRuntime = buildPatchableSessionRuntime(params.sessionRuntime);
  const spawnLineagePatchError = await patchChildSession({
    spawnedBy: spawnedByKey,
    ...patchableSessionRuntime,
    ...(spawnedMetadata.workspaceDir ? { spawnedWorkspaceDir: spawnedMetadata.workspaceDir } : {}),
  });
  if (spawnLineagePatchError) {
    return failPreparedInitialSpawn({
      error: spawnLineagePatchError,
      attachmentAbsDir,
      rollback: preparedContext.rollback,
    });
  }

  try {
    registerPendingSubagentTaskRun({
      pendingRunId: childIdem,
      requesterSessionKey: requesterInternalKey,
      requesterOrigin,
      childSessionKey,
      task,
      label: label || undefined,
      expectsCompletionMessage,
    });
  } catch (err) {
    const registrationError = `Failed to register subagent task: ${summarizeError(err)}`;
    return failPreparedInitialSpawn({
      error: delegationAssignment
        ? registrationError
        : recordRegistrationRouteHealthUnavailable(registrationError),
      attachmentAbsDir,
      rollback: preparedContext.rollback,
      taskMayExist: true,
    });
  }

  let delegationGatewayDispatch: string | undefined;
  if (delegationAssignmentId && delegationLedger) {
    try {
      const guardedDispatch = delegationLedger.bindInitialSpawnWithGatewayDispatch({
        assignmentId: delegationAssignmentId,
        controllerSessionKey: requesterInternalKey,
        childSessionKey,
        idempotencyKey: childIdem,
      });
      delegationGatewayDispatch = guardedDispatch.capability;
    } catch (err) {
      await rollbackPreparedSubagentContext(preparedContext.rollback);
      const pendingCleanupError = await markPendingSpawnFailed();
      const taskCleanupError = failPendingSubagentTaskRunVerified({
        pendingRunId: childIdem,
        childSessionKey,
        error: "Failed to bind the protected delegation assignment.",
      });
      const sessionCleanupError = await cleanupFailedSpawnBeforeAgentStart({
        childSessionKey,
        attachmentAbsDir,
        emitLifecycleHooks: threadBindingReady,
        deleteTranscript: true,
      });
      const cleanupErrors = [
        pendingCleanupError ? `pending-spawn cleanup failed: ${pendingCleanupError}` : undefined,
        taskCleanupError ? `task cleanup failed: ${taskCleanupError}` : undefined,
        sessionCleanupError ? `session cleanup failed: ${sessionCleanupError}` : undefined,
      ].filter((value): value is string => Boolean(value));
      try {
        delegationLedger.rejectRouteIfOpen({
          assignmentId: delegationAssignmentId,
          targetSessionKey: childSessionKey,
          runId: childIdem,
          reason: `Failed to bind the protected delegation assignment: ${summarizeError(err)}`,
        });
      } catch (settlementError) {
        cleanupErrors.push(`assignment settlement failed: ${summarizeError(settlementError)}`);
      }
      return {
        status: "error",
        error: [
          `Failed to bind the protected delegation assignment: ${summarizeError(err)}`,
          ...cleanupErrors,
        ].join("; "),
        childSessionKey,
      };
    }
  }

  let childRunId: string = childIdem;
  try {
    const {
      spawnedBy: _spawnedBy,
      workspaceDir: _workspaceDir,
      ...publicSpawnedMetadata
    } = spawnedMetadata;
    const response = await callSubagentGateway({
      method: "agent",
      params: {
        message: childTaskMessage,
        sessionKey: childSessionKey,
        channel: requesterOrigin?.channel,
        to: requesterOrigin?.to ?? undefined,
        accountId: requesterOrigin?.accountId ?? undefined,
        threadId: requesterOrigin?.threadId != null ? String(requesterOrigin.threadId) : undefined,
        idempotencyKey: childIdem,
        deliver: false,
        lane: AGENT_LANE_SUBAGENT,
        extraSystemPrompt: childSystemPrompt,
        thinking: thinkingOverride,
        timeout: runTimeoutSeconds,
        label: label || undefined,
        ...(delegationGatewayDispatch ? { delegationGatewayDispatch } : {}),
        ...(bootstrapContextMode
          ? {
              bootstrapContextMode,
              bootstrapContextRunKind: "default" as const,
            }
          : {}),
        ...publicSpawnedMetadata,
      },
      timeoutMs: 10_000,
    });
    const runId = readGatewayRunId(response);
    if (runId) {
      childRunId = runId;
    }
  } catch (err) {
    let guardedFailureText = summarizeError(err);
    let guardedDispatchAccepted = false;
    if (
      delegationAssignmentId &&
      delegationLedger &&
      delegationGatewayDispatch &&
      delegationAssignment
    ) {
      try {
        const claim = delegationLedger.consumeGatewayDispatchCapability({
          capability: delegationGatewayDispatch,
          controllerSessionKey: requesterInternalKey,
          targetSessionKey: childSessionKey,
          idempotencyKey: childIdem,
        });
        if (
          claim.outcome?.decision === "accepted" &&
          claim.dispatchRun?.runId === childIdem &&
          !claim.interruption
        ) {
          // The protected ledger is authoritative when the transport loses the
          // accepted response after durable enqueue. Continue registration
          // instead of deleting a child whose guarded execution already began.
          childRunId = claim.dispatchRun.runId;
          guardedDispatchAccepted = true;
        } else {
          guardedFailureText =
            claim.outcome?.decision === "rejected"
              ? summarizeDelegationGatewayResponse(claim.outcome.response, guardedFailureText)
              : claim.interruption === "accepted_by_prior_gateway_writer"
                ? "Guarded initial spawn belonged to a prior Gateway process."
                : claim.interruption === "accepted_without_run_proof"
                  ? "Guarded initial spawn acceptance has no durable run proof."
                  : guardedFailureText;
          if (!claim.outcome && !claim.interruption) {
            const response = {
              message: guardedFailureText,
              retryable: false,
              details: { code: "delegation_initial_spawn_dispatch_failed" },
            };
            delegationLedger.recordGatewayDispatchOutcome({
              capability: delegationGatewayDispatch,
              controllerSessionKey: requesterInternalKey,
              targetSessionKey: childSessionKey,
              idempotencyKey: childIdem,
              decision: "rejected",
              response,
              rejectRoute: true,
            });
          }
        }
      } catch (dispatchError) {
        guardedFailureText = `${guardedFailureText}; protected dispatch reconciliation failed: ${summarizeError(dispatchError)}`;
        try {
          delegationLedger.rejectRouteIfOpen({
            assignmentId: delegationAssignmentId,
            targetSessionKey: childSessionKey,
            runId: childIdem,
            reason: guardedFailureText,
          });
        } catch {
          // Preserve the original spawn failure; the outer guarded route owner
          // will make one final idempotent settlement attempt.
        }
      }
    }
    if (guardedDispatchAccepted) {
      // Resume the ordinary accepted path below.
    } else {
      await rollbackPreparedSubagentContext(preparedContext.rollback);
      const pendingCleanupError = await markPendingSpawnFailed();
      if (attachmentAbsDir) {
        try {
          await fs.rm(attachmentAbsDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup only.
        }
      }
      let emitLifecycleHooks = false;
      if (threadBindingReady) {
        const hasEndedHook = hookRunner?.hasHooks("subagent_ended") === true;
        let endedHookEmitted = false;
        if (hasEndedHook) {
          try {
            await hookRunner?.runSubagentEnded(
              {
                targetSessionKey: childSessionKey,
                targetKind: "subagent",
                reason: "spawn-failed",
                sendFarewell: true,
                accountId: requesterOrigin?.accountId,
                runId: childRunId,
                outcome: "error",
                error: "Session failed to start",
              },
              {
                runId: childRunId,
                childSessionKey,
                requesterSessionKey: requesterInternalKey,
              },
            );
            endedHookEmitted = true;
          } catch {
            // Spawn should still return an actionable error even if cleanup hooks fail.
          }
        }
        emitLifecycleHooks = !endedHookEmitted;
      }
      // Always delete the provisional child session after a failed spawn attempt.
      // If we already emitted subagent_ended above, suppress a duplicate lifecycle hook.
      const sessionCleanupError = await cleanupProvisionalSession(childSessionKey, {
        deleteTranscript: true,
        emitLifecycleHooks,
      });
      let messageText = delegationAssignment ? guardedFailureText : summarizeError(err);
      const taskCleanupError = failPendingSubagentTaskRunVerified({
        pendingRunId: childIdem,
        childSessionKey,
        error: messageText,
      });
      const cleanupErrors = [
        pendingCleanupError ? `pending-spawn cleanup failed: ${pendingCleanupError}` : undefined,
        taskCleanupError ? `task cleanup failed: ${taskCleanupError}` : undefined,
        sessionCleanupError ? `session cleanup failed: ${sessionCleanupError}` : undefined,
      ].filter((value): value is string => Boolean(value));
      if (cleanupErrors.length > 0) {
        messageText = `${messageText}; ${cleanupErrors.join("; ")}`;
      }
      return {
        status: "error",
        error: delegationAssignment
          ? messageText
          : recordRegistrationRouteHealthUnavailable(messageText),
        childSessionKey,
        runId: childRunId,
      };
    }
  }

  try {
    registerSubagentRun({
      pendingTaskRunId: childIdem,
      runId: childRunId,
      delegationAssignmentId,
      delegationSliceId: delegationAssignment?.sliceId,
      delegationEpoch: delegationAssignment?.epoch,
      childSessionKey,
      controllerSessionKey: requesterInternalKey,
      requesterSessionKey: requesterInternalKey,
      requesterOrigin,
      requesterDisplayKey,
      task,
      cleanup,
      label: label || undefined,
      sliceRole,
      sliceContinuation,
      model: resolvedModel,
      workspaceDir: spawnedMetadata.workspaceDir,
      runTimeoutSeconds,
      expectsCompletionMessage,
      spawnMode,
      attachmentsDir: attachmentAbsDir,
      attachmentsRootDir: attachmentRootDir,
      retainAttachmentsOnKeep: retainOnSessionKeep,
    });
  } catch (err) {
    await rollbackPreparedSubagentContext(preparedContext.rollback);
    const pendingCleanupError = await markPendingSpawnFailed();
    if (attachmentAbsDir) {
      try {
        await fs.rm(attachmentAbsDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
    const sessionCleanupError = await cleanupProvisionalSession(childSessionKey, {
      deleteTranscript: true,
      emitLifecycleHooks: threadBindingReady,
    });
    const taskCleanupError = failPendingSubagentTaskRunVerified({
      pendingRunId: childIdem,
      childSessionKey,
      error: `Failed to register subagent run: ${summarizeError(err)}`,
    });
    const cleanupErrors = [
      pendingCleanupError ? `pending-spawn cleanup failed: ${pendingCleanupError}` : undefined,
      taskCleanupError ? `task cleanup failed: ${taskCleanupError}` : undefined,
      sessionCleanupError ? `session cleanup failed: ${sessionCleanupError}` : undefined,
    ].filter((value): value is string => Boolean(value));
    const registrationError = [
      `Failed to register subagent run: ${summarizeError(err)}`,
      ...cleanupErrors,
    ].join("; ");
    return {
      status: "error",
      error: delegationAssignment
        ? registrationError
        : recordRegistrationRouteHealthUnavailable(registrationError),
      childSessionKey,
      runId: childRunId,
    };
  }

  if (hookRunner?.hasHooks("subagent_spawned")) {
    try {
      await hookRunner.runSubagentSpawned(
        {
          runId: childRunId,
          childSessionKey,
          agentId: targetAgentId,
          label: label || undefined,
          requester: {
            channel: requesterOrigin?.channel,
            accountId: requesterOrigin?.accountId,
            to: requesterOrigin?.to,
            threadId: requesterOrigin?.threadId,
          },
          threadRequested: requestThreadBinding,
          mode: spawnMode,
        },
        {
          runId: childRunId,
          childSessionKey,
          requesterSessionKey: requesterInternalKey,
        },
      );
    } catch {
      // Spawn should still return accepted if spawn lifecycle hooks fail.
    }
  }

  // Emit lifecycle event so the gateway can broadcast sessions.changed to SSE subscribers.
  emitSessionLifecycleEvent({
    sessionKey: childSessionKey,
    reason: "create",
    parentSessionKey: requesterInternalKey,
    label: label || undefined,
  });

  return {
    status: "accepted",
    childSessionKey,
    runId: childRunId,
    mode: spawnMode,
    note: resolveSubagentSpawnAcceptedNote({
      spawnMode,
      agentSessionKey: ctx.agentSessionKey,
    }),
    modelApplied: resolvedModel ? modelApplied : undefined,
    attachments: attachmentsReceipt,
  };
}

export const __testing = {
  buildInitialChildSessionPatch,
  buildProtectedDelegationAssignmentPrompt,
  setDepsForTest(overrides?: Partial<SubagentSpawnDeps>) {
    subagentSpawnDeps = overrides
      ? {
          ...defaultSubagentSpawnDeps,
          ...overrides,
        }
      : defaultSubagentSpawnDeps;
  },
};
