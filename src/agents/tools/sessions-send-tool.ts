import crypto from "node:crypto";
import fs from "node:fs/promises";
import { Type } from "typebox";
import { loadSessionStore, resolveStorePath, type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { SESSION_LABEL_MAX_LENGTH } from "../../sessions/session-label.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import {
  type GatewayMessageChannel,
  INTERNAL_MESSAGE_CHANNEL,
} from "../../utils/message-channel.js";
import {
  buildChildHandoffPacket,
  decideFreshChildReroute,
  type ChildHandoffPacket,
  type ChildHandoffRuntimeEnvelope,
  type ChildHandoffSemanticSection,
} from "../child-handoff-reroute.js";
import { guardChildRouteForDelivery } from "../child-route-guard.js";
import type {
  ChildRouteHealthCode,
  ChildRouteUnhealthyDetails,
} from "../child-route-health-contract.js";
import {
  preflightChildRouteAssignment,
  readActiveChildRouteAuthBlockersForRoute,
  resolveChildTargetKind,
  type ChildRouteAssignmentKind,
} from "../child-route-health.js";
import { resolveChildRouteProviderContextFromSession } from "../child-route-provider-context.js";
import { authBlockersPreventFreshSpawn } from "../child-route-spawn-preflight.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import {
  readLatestAssistantReplySnapshot,
  waitForAgentRunAndReadUpdatedAssistantReply,
} from "../run-wait.js";
import {
  listControlledSubagentRuns,
  resolveSubagentController,
  steerControlledSubagentRun,
} from "../subagent-control.js";
import { markSubagentRunForFreshReroute } from "../subagent-registry-fresh-reroute.js";
import { getLatestSubagentRunByChildSessionKey } from "../subagent-registry-read.js";
import type { SubagentRunRecord } from "../subagent-registry.types.js";
import { persistSubagentResultReceiptForRunSync } from "../subagent-result-receipts.js";
import { spawnSubagentDirect } from "../subagent-spawn.js";
import {
  describeSessionsSendTool,
  SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  createSessionVisibilityGuard,
  createAgentToAgentPolicy,
  resolveEffectiveSessionToolsVisibility,
  resolveSessionReference,
  resolveSessionToolContext,
  resolveVisibleSessionReference,
} from "./sessions-helpers.js";
import { buildAgentToAgentMessageContext, resolvePingPongTurns } from "./sessions-send-helpers.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

const SessionsSendToolSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: SESSION_LABEL_MAX_LENGTH })),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  message: Type.String(),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  assignmentKind: Type.Optional(
    Type.Union([
      Type.Literal("small_clarification"),
      Type.Literal("implementation"),
      Type.Literal("testing"),
      Type.Literal("review"),
    ]),
  ),
  handoff: Type.Optional(
    Type.Object({
      originalTask: Type.String({ minLength: 1 }),
      desiredOutcome: Type.Optional(Type.String()),
      acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
      constraints: Type.Optional(Type.Array(Type.String())),
      findings: Type.Optional(Type.Array(Type.String())),
      filesInspected: Type.Optional(Type.Array(Type.String())),
      commandsInspected: Type.Optional(Type.Array(Type.String())),
      logExcerpts: Type.Optional(Type.Array(Type.String())),
      currentNextStep: Type.String({ minLength: 1 }),
      nonGoals: Type.Optional(Type.Array(Type.String())),
      degradedContext: Type.Optional(Type.Boolean()),
    }),
  ),
});

type GatewayCaller = typeof callGateway;
const SESSIONS_SEND_REPLY_HISTORY_LIMIT = 50;
const SESSIONS_SEND_LATE_ANNOUNCE_WAIT_MS = 10 * 60_000;
const FRESH_CHILD_REROUTE_COOLDOWN_MS = 10 * 60_000;
const SESSIONS_SEND_HARD_HEADROOM_PERCENT_THRESHOLD = 5;
const MAX_HANDOFF_ATTACHMENT_REFS = 30;

type FreshChildReroute = ReturnType<typeof decideFreshChildReroute>;
type FreshChildRerouteMarker =
  | {
      status: "accepted";
      key: string;
      createdAt: number;
      runId: string;
      childSessionKey: string;
      mode?: "run" | "session";
      reroute: FreshChildReroute;
    }
  | {
      status: "error";
      key: string;
      createdAt: number;
      error: string;
      oldChildSessionKey?: string;
      oldRunId?: string;
      childSessionKey?: string;
      runId?: string;
      reroute?: FreshChildReroute;
    };

const freshChildReroutes = new Map<string, FreshChildRerouteMarker>();

function readAssignmentKind(params: Record<string, unknown>): ChildRouteAssignmentKind {
  const value = params.assignmentKind;
  if (
    value === "small_clarification" ||
    value === "implementation" ||
    value === "testing" ||
    value === "review"
  ) {
    return value;
  }
  return "implementation";
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((item) => normalizeOptionalString(item))
    .filter((item): item is string => Boolean(item));
  return normalized.length > 0 ? normalized : undefined;
}

function readPlannerHandoffSemantic(
  value: unknown,
): { ok: true; semantic: ChildHandoffSemanticSection } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      error:
        "Fresh child reroute requires a planner-authored handoff with originalTask and currentNextStep.",
    };
  }
  const record = value as Record<string, unknown>;
  const originalTask = normalizeOptionalString(record.originalTask);
  const currentNextStep = normalizeOptionalString(record.currentNextStep);
  if (!originalTask || !currentNextStep) {
    return {
      ok: false,
      error:
        "Fresh child reroute requires handoff.originalTask and handoff.currentNextStep before spawning.",
    };
  }
  return {
    ok: true,
    semantic: {
      originalTask,
      ...(normalizeOptionalString(record.desiredOutcome)
        ? { desiredOutcome: normalizeOptionalString(record.desiredOutcome) }
        : {}),
      ...(normalizeStringArray(record.acceptanceCriteria)
        ? { acceptanceCriteria: normalizeStringArray(record.acceptanceCriteria) }
        : {}),
      ...(normalizeStringArray(record.constraints)
        ? { constraints: normalizeStringArray(record.constraints) }
        : {}),
      ...(normalizeStringArray(record.findings)
        ? { findings: normalizeStringArray(record.findings) }
        : {}),
      ...(normalizeStringArray(record.filesInspected)
        ? { filesInspected: normalizeStringArray(record.filesInspected) }
        : {}),
      ...(normalizeStringArray(record.commandsInspected)
        ? { commandsInspected: normalizeStringArray(record.commandsInspected) }
        : {}),
      ...(normalizeStringArray(record.logExcerpts)
        ? { logExcerpts: normalizeStringArray(record.logExcerpts) }
        : {}),
      currentNextStep,
      ...(normalizeStringArray(record.nonGoals)
        ? { nonGoals: normalizeStringArray(record.nonGoals) }
        : {}),
      ...(record.degradedContext === true ? { degradedContext: true } : {}),
    },
  };
}

function hasCompletionReceipt(entry: SubagentRunRecord): boolean {
  if (entry.expectsCompletionMessage === false) {
    return true;
  }
  return Boolean(
    normalizeOptionalString(entry.resultReceiptId) ||
    normalizeOptionalString(entry.frozenResultText ?? undefined) ||
    normalizeOptionalString(entry.fallbackFrozenResultText ?? undefined),
  );
}

function resolvePreflightLifecycleOutcome(
  entry: SubagentRunRecord,
): "healthy" | "no_final" | "degraded" | "blocked" | "abandoned" | "error" | "unknown" {
  if (typeof entry.endedAt !== "number") {
    return "healthy";
  }
  if (!entry.outcome) {
    return "no_final";
  }
  if (entry.outcome.status === "ok") {
    return hasCompletionReceipt(entry) ? "healthy" : "no_final";
  }
  if (entry.outcome.status === "timeout") {
    return "abandoned";
  }
  if (entry.outcome.status === "error") {
    return "error";
  }
  return "unknown";
}

function codesForAssignmentPreflight(
  preflight: Exclude<
    Awaited<ReturnType<typeof preflightChildRouteAssignment>>,
    { status: "reuse" }
  >,
  latestLifecycleOutcome?: ReturnType<typeof resolvePreflightLifecycleOutcome>,
): ChildRouteHealthCode[] {
  if (preflight.status === "reroute" && preflight.codes && preflight.codes.length > 0) {
    return [...preflight.codes];
  }
  if (preflight.status === "reroute" && preflight.reason === "lifecycle") {
    if (latestLifecycleOutcome === "blocked") {
      return ["agent_lifecycle_blocked"];
    }
    if (latestLifecycleOutcome === "error" || latestLifecycleOutcome === "degraded") {
      return ["agent_lifecycle_error"];
    }
    return ["agent_lifecycle_abandoned"];
  }
  if (
    preflight.status === "reroute" &&
    (preflight.reason === "context_headroom" || preflight.reason === "compaction")
  ) {
    return ["context_overflow"];
  }
  return ["agent_lifecycle_blocked"];
}

function buildPreflightFreshRerouteDetails(params: {
  childSessionKey: string;
  requesterSessionKey: string;
  idempotencyKey: string;
  preflight: Extract<
    Awaited<ReturnType<typeof preflightChildRouteAssignment>>,
    { status: "reroute" }
  >;
  latestLifecycleOutcome?: ReturnType<typeof resolvePreflightLifecycleOutcome>;
}): ChildRouteUnhealthyDetails {
  const attemptKey = stableSessionsSendHash({
    childSessionKey: params.childSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    idempotencyKey: params.idempotencyKey,
    reason: params.preflight.reason,
    assignmentKind: params.preflight.assignmentKind,
  }).slice(0, 48);
  return {
    kind: "child_route_unhealthy",
    childSessionKey: params.childSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    deliveryAttemptId: `child_route_preflight:${attemptKey}`,
    codes: codesForAssignmentPreflight(params.preflight, params.latestLifecycleOutcome),
    recommendedAction: params.preflight.recommendedAction,
    stateTransitionRequired: true,
    plannerInstruction: params.preflight.plannerInstruction,
  };
}

function formatChildHandoffTask(params: { message: string; packet: ChildHandoffPacket }): string {
  return [
    "Continue this task in a fresh tracked child session.",
    "Do not query or reuse the old child session. Use the handoff packet below as the bounded source of continuity.",
    `[Parent follow-up]: ${params.message}`,
    "[Child handoff packet]",
    JSON.stringify(params.packet),
  ].join("\n\n");
}

async function resolveHandoffAttachmentFacts(entry?: SubagentRunRecord | null): Promise<{
  envelope: Pick<
    ChildHandoffRuntimeEnvelope,
    "attachmentRoots" | "attachmentReferences" | "retainedAttachmentPolicy"
  >;
  missingRequired: boolean;
}> {
  if (!entry?.attachmentsDir && !entry?.attachmentsRootDir) {
    return {
      envelope: { retainedAttachmentPolicy: "none" },
      missingRequired: false,
    };
  }
  const retained = entry.cleanup === "keep" && entry.retainAttachmentsOnKeep === true;
  const retainedAttachmentPolicy = retained ? "retain" : "cleanup";
  const roots: NonNullable<ChildHandoffRuntimeEnvelope["attachmentRoots"]> = [];
  const references: NonNullable<ChildHandoffRuntimeEnvelope["attachmentReferences"]> = [];
  let missingRequired = false;
  const addRoot = async (rootPath: string | undefined) => {
    const normalized = normalizeOptionalString(rootPath);
    if (!normalized) {
      return;
    }
    try {
      const stat = await fs.stat(normalized);
      const available = stat.isDirectory();
      roots.push({
        path: normalized,
        available,
        retained,
        readableByReplacement: available,
        ...(!available ? { missingReason: "not_directory" } : {}),
      });
      if (!available) {
        missingRequired = true;
      }
    } catch (error) {
      roots.push({
        path: normalized,
        available: false,
        retained,
        readableByReplacement: false,
        missingReason: (error as NodeJS.ErrnoException).code ?? "unavailable",
      });
      missingRequired = true;
    }
  };
  await addRoot(entry.attachmentsRootDir);
  await addRoot(entry.attachmentsDir);
  const attachmentsDir = normalizeOptionalString(entry.attachmentsDir);
  if (attachmentsDir) {
    try {
      const children = (await fs.readdir(attachmentsDir, { withFileTypes: true }))
        .filter((child) => child.isFile())
        .map((child) => child.name)
        .toSorted((left, right) => left.localeCompare(right))
        .slice(0, MAX_HANDOFF_ATTACHMENT_REFS);
      for (const name of children) {
        const childPath = `${attachmentsDir}/${name}`;
        let sizeBytes: number | undefined;
        try {
          sizeBytes = (await fs.stat(childPath)).size;
        } catch {
          sizeBytes = undefined;
        }
        references.push({
          name,
          available: true,
          rootPath: attachmentsDir,
          ...(typeof sizeBytes === "number" ? { sizeBytes } : {}),
        });
      }
    } catch (error) {
      references.push({
        name: "(attachment directory)",
        available: false,
        rootPath: attachmentsDir,
        missingReason: (error as NodeJS.ErrnoException).code ?? "unavailable",
      });
      missingRequired = true;
    }
  }
  return {
    envelope: {
      retainedAttachmentPolicy,
      ...(roots.length > 0 ? { attachmentRoots: roots } : {}),
      ...(references.length > 0 ? { attachmentReferences: references } : {}),
    },
    missingRequired,
  };
}

function pruneFreshChildReroutes(now = Date.now()): void {
  for (const [key, marker] of freshChildReroutes.entries()) {
    if (marker.status === "accepted" && now - marker.createdAt > FRESH_CHILD_REROUTE_COOLDOWN_MS) {
      freshChildReroutes.delete(key);
    }
  }
}

function stableSessionsSendHash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function buildFreshChildRerouteKey(params: {
  requesterSessionKey: string;
  oldChildSessionKey: string;
  oldChildRunId?: string;
  targetAgentId: string;
  label?: string;
  task?: string;
  message: string;
  codes: string[];
}): string {
  const workKey = params.label ?? params.task ?? params.message.trim();
  return `fresh_child_reroute:${stableSessionsSendHash({
    requesterSessionKey: params.requesterSessionKey,
    oldChildSessionKey: params.oldChildSessionKey,
    oldChildRunId: params.oldChildRunId,
    targetAgentId: params.targetAgentId,
    workKey,
    codes: params.codes.toSorted(),
  }).slice(0, 32)}`;
}

function markFreshChildRerouteError(params: {
  marker: Extract<FreshChildRerouteMarker, { status: "accepted" }>;
  error: string;
}) {
  const rejectedOld =
    params.marker.reroute.status === "fresh_child_spawned"
      ? params.marker.reroute.rejectedOldChild
      : undefined;
  freshChildReroutes.set(params.marker.key, {
    status: "error",
    key: params.marker.key,
    createdAt: Date.now(),
    error: params.error,
    ...(rejectedOld?.childSessionKey ? { oldChildSessionKey: rejectedOld.childSessionKey } : {}),
    ...(rejectedOld?.generation ? { oldRunId: rejectedOld.generation } : {}),
    childSessionKey: params.marker.childSessionKey,
    runId: params.marker.runId,
    reroute: params.marker.reroute,
  });
}

function freshChildRerouteMatchesOldGeneration(
  marker: FreshChildRerouteMarker,
  params: {
    oldChildSessionKey: string;
    oldRunId?: string;
  },
): boolean {
  if (marker.status === "error" && marker.oldChildSessionKey) {
    const oldRunId = normalizeOptionalString(params.oldRunId);
    return (
      marker.oldChildSessionKey === params.oldChildSessionKey.trim() &&
      !(oldRunId && marker.oldRunId !== oldRunId)
    );
  }
  const reroute = marker.reroute;
  if (!reroute || reroute.status !== "fresh_child_spawned") {
    return false;
  }
  const oldChildSessionKey = params.oldChildSessionKey.trim();
  const oldRunId = normalizeOptionalString(params.oldRunId);
  const rejectedOldChild = reroute.rejectedOldChild;
  if (rejectedOldChild.childSessionKey !== oldChildSessionKey) {
    return false;
  }
  return !(oldRunId && rejectedOldChild.generation !== oldRunId);
}

function findFreshChildRerouteForOldGeneration(params: {
  oldChildSessionKey: string;
  oldRunId?: string;
}): FreshChildRerouteMarker | undefined {
  for (const marker of freshChildReroutes.values()) {
    if (freshChildRerouteMatchesOldGeneration(marker, params)) {
      return marker;
    }
  }
  return undefined;
}

function ensureFreshChildResultReceipt(params: {
  runId: string;
  childSessionKey: string;
  replyText?: string;
}): { ok: true } | { ok: false; error: string } {
  const entry = getLatestSubagentRunByChildSessionKey(params.childSessionKey);
  if (!entry) {
    return {
      ok: false,
      error: `fresh child run ${params.runId} is missing from the subagent registry`,
    };
  }
  if (entry.runId !== params.runId) {
    return {
      ok: false,
      error: `fresh child generation mismatch: expected ${params.runId}, found ${entry.runId}`,
    };
  }
  if (entry.resultReceiptId) {
    return { ok: true };
  }
  if (entry.frozenResultText === undefined) {
    entry.frozenResultText = params.replyText?.trim() ? params.replyText : null;
    entry.frozenResultCapturedAt = Date.now();
  }
  const persisted = persistSubagentResultReceiptForRunSync(entry);
  if (!persisted.ok) {
    return {
      ok: false,
      error: `failed to persist fresh child result receipt: ${persisted.error}`,
    };
  }
  return { ok: true };
}

async function buildFreshChildRerouteResponse(params: {
  marker: Extract<FreshChildRerouteMarker, { status: "accepted" }>;
  timeoutSeconds: number;
  timeoutMs: number;
  callGateway: GatewayCaller;
}) {
  const trackedDelivery = { status: "tracked", mode: "completion_event" as const };
  if (params.timeoutSeconds === 0) {
    return {
      runId: params.marker.runId,
      status: "accepted",
      sessionKey: params.marker.childSessionKey,
      mode: params.marker.mode,
      delivery: trackedDelivery,
      reroute: params.marker.reroute,
    };
  }
  const result = await waitForAgentRunAndReadUpdatedAssistantReply({
    runId: params.marker.runId,
    sessionKey: params.marker.childSessionKey,
    timeoutMs: params.timeoutMs,
    limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
    callGateway: params.callGateway,
  });
  if (result.status === "timeout") {
    return {
      runId: params.marker.runId,
      status: "timeout",
      error: result.error,
      sessionKey: params.marker.childSessionKey,
      delivery: trackedDelivery,
      reroute: params.marker.reroute,
    };
  }
  if (result.status === "error") {
    const error = result.error ?? "agent error";
    markFreshChildRerouteError({ marker: params.marker, error });
    return {
      runId: params.marker.runId,
      status: "error",
      error,
      sessionKey: params.marker.childSessionKey,
      reroute: params.marker.reroute,
    };
  }
  const receipt = ensureFreshChildResultReceipt({
    runId: params.marker.runId,
    childSessionKey: params.marker.childSessionKey,
    replyText: result.replyText,
  });
  if (!receipt.ok) {
    markFreshChildRerouteError({ marker: params.marker, error: receipt.error });
    return {
      runId: params.marker.runId,
      status: "error",
      error: receipt.error,
      sessionKey: params.marker.childSessionKey,
      reroute: params.marker.reroute,
    };
  }
  return {
    runId: params.marker.runId,
    status: "ok",
    reply: result.replyText,
    sessionKey: params.marker.childSessionKey,
    delivery: trackedDelivery,
    reroute: params.marker.reroute,
  };
}

function resolveTargetRouteSessionContext(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  requesterSessionKey: string;
}): {
  provider: ReturnType<typeof resolveChildRouteProviderContextFromSession>;
  entry?: SessionEntry;
} {
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  const entry = loadSessionStore(storePath, { skipCache: true })[params.sessionKey];
  return {
    provider: resolveChildRouteProviderContextFromSession({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      entry,
      requesterSessionKey: params.requesterSessionKey,
    }),
    entry,
  };
}

function buildSessionRuntimeReplay(entry: SessionEntry | undefined): {
  envelope: Pick<
    ChildHandoffRuntimeEnvelope,
    | "thinking"
    | "thinkingOverride"
    | "fastMode"
    | "reasoningLevel"
    | "verbosity"
    | "traceLevel"
    | "elevatedLevel"
    | "toolExecHost"
    | "execSecurity"
    | "execAskPolicy"
    | "execNode"
    | "ttsMode"
    | "responseUsageMode"
  >;
  sessionRuntime: Record<string, unknown>;
  thinking?: string;
} {
  const envelope: Pick<
    ChildHandoffRuntimeEnvelope,
    | "thinking"
    | "thinkingOverride"
    | "fastMode"
    | "reasoningLevel"
    | "verbosity"
    | "traceLevel"
    | "elevatedLevel"
    | "toolExecHost"
    | "execSecurity"
    | "execAskPolicy"
    | "execNode"
    | "ttsMode"
    | "responseUsageMode"
  > = {
    ...(entry?.thinkingLevel ? { thinking: entry.thinkingLevel } : {}),
    ...(entry?.thinkingLevel ? { thinkingOverride: entry.thinkingLevel } : {}),
    ...(typeof entry?.fastMode === "boolean" ? { fastMode: entry.fastMode } : {}),
    ...(entry?.reasoningLevel ? { reasoningLevel: entry.reasoningLevel } : {}),
    ...(entry?.verboseLevel ? { verbosity: entry.verboseLevel } : {}),
    ...(entry?.traceLevel ? { traceLevel: entry.traceLevel } : {}),
    ...(entry?.elevatedLevel ? { elevatedLevel: entry.elevatedLevel } : {}),
    ...(entry?.execHost ? { toolExecHost: entry.execHost } : {}),
    ...(entry?.execSecurity ? { execSecurity: entry.execSecurity } : {}),
    ...(entry?.execAsk ? { execAskPolicy: entry.execAsk } : {}),
    ...(entry?.execNode ? { execNode: entry.execNode } : {}),
    ...(entry?.ttsAuto ? { ttsMode: entry.ttsAuto } : {}),
    ...(entry?.responseUsage ? { responseUsageMode: entry.responseUsage } : {}),
  };
  return {
    envelope,
    sessionRuntime: {
      ...(entry?.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
      ...(typeof entry?.fastMode === "boolean" ? { fastMode: entry.fastMode } : {}),
      ...(entry?.reasoningLevel ? { reasoningLevel: entry.reasoningLevel } : {}),
      ...(entry?.verboseLevel ? { verboseLevel: entry.verboseLevel } : {}),
      ...(entry?.traceLevel ? { traceLevel: entry.traceLevel } : {}),
      ...(entry?.elevatedLevel ? { elevatedLevel: entry.elevatedLevel } : {}),
      ...(entry?.execHost ? { execHost: entry.execHost } : {}),
      ...(entry?.execSecurity ? { execSecurity: entry.execSecurity } : {}),
      ...(entry?.execAsk ? { execAsk: entry.execAsk } : {}),
      ...(entry?.execNode ? { execNode: entry.execNode } : {}),
      ...(entry?.ttsAuto ? { ttsAuto: entry.ttsAuto } : {}),
      ...(entry?.responseUsage ? { responseUsage: entry.responseUsage } : {}),
      ...(entry?.authProfileOverride ? { authProfileOverride: entry.authProfileOverride } : {}),
      ...(entry?.authProfileOverrideSource
        ? { authProfileOverrideSource: entry.authProfileOverrideSource }
        : {}),
    },
    ...(entry?.thinkingLevel ? { thinking: entry.thinkingLevel } : {}),
  };
}

async function rerouteToFreshChild(params: {
  code: "child_session_unhealthy" | "child_route_assignment_blocked";
  deliveryMode: "child_route_guard" | "child_route_preflight";
  details: ChildRouteUnhealthyDetails;
  resolvedKey: string;
  effectiveRequesterKey: string;
  requesterGeneration?: string;
  childTargetKind: ReturnType<typeof resolveChildTargetKind>;
  registryRecord?: SubagentRunRecord | null;
  targetProvider: ReturnType<typeof resolveChildRouteProviderContextFromSession>;
  targetSessionContext: ReturnType<typeof resolveTargetRouteSessionContext>;
  runtimeReplay: ReturnType<typeof buildSessionRuntimeReplay>;
  message: string;
  handoffValue: unknown;
  idempotencyKey: string;
  timeoutSeconds: number;
  timeoutMs: number;
  callGateway: GatewayCaller;
  sandboxed: boolean;
  agentChannel?: GatewayMessageChannel;
}) {
  const targetAgentId =
    parseAgentSessionKey(params.resolvedKey)?.agentId ??
    resolveAgentIdFromSessionKey(params.resolvedKey);
  if (params.childTargetKind !== "subagent") {
    return jsonResult({
      ok: false,
      status: "no_delivery",
      code: params.code,
      details: params.details,
      delivery: { status: "rejected", mode: params.deliveryMode },
      reroute: {
        status: "blocked",
        reason: "unsupported_child_target_kind",
        plannerInstruction: "Fresh reroute is currently supported only for sub-agent children.",
      },
    });
  }
  const authBlockers = await readActiveChildRouteAuthBlockersForRoute({
    provider: params.targetProvider,
    childSessionKey: params.resolvedKey,
    runId: params.registryRecord?.runId,
    includeProviderDefaultCredentialBlockers: true,
  });
  if (!authBlockers.ok) {
    return jsonResult({
      ok: false,
      status: "no_delivery",
      code: "child_route_health_unavailable",
      details: {
        kind: "child_route_health_unavailable",
        childSessionKey: params.resolvedKey,
        requesterSessionKey: params.effectiveRequesterKey,
        errorKind: authBlockers.errorKind,
        retryable: authBlockers.retryable,
        plannerInstruction:
          "Auth route health is unavailable; do not spawn a fresh child until provider health is known.",
      },
      delivery: { status: "rejected", mode: params.deliveryMode },
    });
  }
  if (authBlockersPreventFreshSpawn(authBlockers.blockers)) {
    return jsonResult({
      ok: false,
      status: "no_delivery",
      code: params.code,
      details: params.details,
      delivery: { status: "rejected", mode: params.deliveryMode },
      reroute: {
        status: "blocked",
        reason: "auth_profile_session_expired",
        plannerInstruction:
          "Re-authenticate or select a healthy fallback provider profile before spawning a fresh child.",
        authBlockers: authBlockers.blockers,
      },
    });
  }
  const rerouteKey = buildFreshChildRerouteKey({
    requesterSessionKey: params.effectiveRequesterKey,
    oldChildSessionKey: params.resolvedKey,
    oldChildRunId: params.registryRecord?.runId,
    targetAgentId,
    label: params.registryRecord?.label,
    task: params.registryRecord?.task,
    message: params.message,
    codes: params.details.codes,
  });
  pruneFreshChildReroutes();
  const existingReroute = freshChildReroutes.get(rerouteKey);
  if (existingReroute?.status === "accepted") {
    return jsonResult(
      await buildFreshChildRerouteResponse({
        marker: existingReroute,
        timeoutSeconds: params.timeoutSeconds,
        timeoutMs: params.timeoutMs,
        callGateway: params.callGateway,
      }),
    );
  }
  if (existingReroute?.status === "error") {
    return jsonResult({
      ok: false,
      status: "no_delivery",
      code: params.code,
      details: params.details,
      delivery: { status: "rejected", mode: params.deliveryMode },
      reroute: {
        status: "error",
        error: existingReroute.error,
        childSessionKey: existingReroute.childSessionKey,
        runId: existingReroute.runId,
      },
    });
  }
  const handoffSemantic = readPlannerHandoffSemantic(params.handoffValue);
  if (!handoffSemantic.ok) {
    return jsonResult({
      ok: false,
      status: "no_delivery",
      code: params.code,
      details: params.details,
      delivery: { status: "rejected", mode: params.deliveryMode },
      reroute: {
        status: "handoff_required",
        plannerInstruction: handoffSemantic.error,
      },
    });
  }
  const attachmentFacts = await resolveHandoffAttachmentFacts(params.registryRecord);
  if (attachmentFacts.missingRequired && handoffSemantic.semantic.degradedContext !== true) {
    return jsonResult({
      ok: false,
      status: "no_delivery",
      code: params.code,
      details: params.details,
      delivery: { status: "rejected", mode: params.deliveryMode },
      reroute: {
        status: "attachment_degradation_required",
        plannerInstruction:
          "Attachment references are missing or unreadable; provide a handoff with degradedContext=true only if the continuation remains valid without them.",
        attachments: attachmentFacts.envelope,
      },
    });
  }
  const replaySpawnMode = params.registryRecord?.spawnMode === "session" ? "session" : "run";
  const handoffPacket = buildChildHandoffPacket({
    semantic: handoffSemantic.semantic,
    envelope: {
      requesterSessionKey: params.effectiveRequesterKey,
      ...(params.requesterGeneration ? { requesterGeneration: params.requesterGeneration } : {}),
      originalChildSessionKey: params.resolvedKey,
      ...(params.registryRecord?.runId ? { oldChildRunId: params.registryRecord.runId } : {}),
      healthRejectionCodes: params.details.codes,
      recommendedAction: "spawn_fresh",
      deliveryAttemptId: params.details.deliveryAttemptId,
      oldRouteState: "rejected",
      targetAgentId,
      ...(params.targetProvider.providerId ? { providerId: params.targetProvider.providerId } : {}),
      ...(params.targetProvider.modelId ? { modelId: params.targetProvider.modelId } : {}),
      ...(params.targetSessionContext.entry?.modelOverride
        ? { modelOverrideSource: "session" }
        : {}),
      ...(params.targetProvider.authProfileKey
        ? { authProfileKey: params.targetProvider.authProfileKey }
        : {}),
      ...(params.targetSessionContext.entry?.authProfileOverrideSource
        ? { authProfileSource: params.targetSessionContext.entry.authProfileOverrideSource }
        : {}),
      ...(params.targetProvider.credentialSource
        ? { credentialSource: params.targetProvider.credentialSource }
        : {}),
      ...(params.targetProvider.credentialBucket
        ? { credentialBucket: params.targetProvider.credentialBucket }
        : {}),
      ...(params.targetProvider.fallbackCredentialSelected !== undefined
        ? { fallbackProfileSelected: params.targetProvider.fallbackCredentialSelected }
        : {}),
      ...params.runtimeReplay.envelope,
      childTargetKind: params.childTargetKind,
      subagentRole: targetAgentId,
      ...(params.registryRecord?.controllerSessionKey ? { controlScope: "children" } : {}),
      ...(params.registryRecord?.label ? { featureLabel: params.registryRecord.label } : {}),
      ...(params.registryRecord?.workspaceDir
        ? { workspaceDir: params.registryRecord.workspaceDir }
        : {}),
      ...(params.registryRecord?.workspaceDir
        ? { spawnedWorkspace: params.registryRecord.workspaceDir }
        : {}),
      ...(params.registryRecord?.runTimeoutSeconds !== undefined
        ? { runTimeoutSeconds: params.registryRecord.runTimeoutSeconds }
        : {}),
      spawnMode: replaySpawnMode,
      ...(params.registryRecord?.cleanup ? { cleanup: params.registryRecord.cleanup } : {}),
      ...(params.registryRecord?.requesterOrigin
        ? { requesterOrigin: params.registryRecord.requesterOrigin as Record<string, unknown> }
        : {}),
      ...(params.registryRecord?.requesterDisplayKey
        ? { requesterDisplayKey: params.registryRecord.requesterDisplayKey }
        : {}),
      ...attachmentFacts.envelope,
      replacementRole: targetAgentId,
      timestamp: Date.now(),
      idempotencyKey: params.idempotencyKey,
    },
  });
  const replayModel =
    params.registryRecord?.model ??
    (params.targetProvider.providerId && params.targetProvider.modelId
      ? `${params.targetProvider.providerId}/${params.targetProvider.modelId}`
      : params.targetProvider.modelId);
  if (params.registryRecord?.runId) {
    markSubagentRunForFreshReroute(params.registryRecord.runId);
  }
  const spawn = await spawnSubagentDirect(
    {
      task: formatChildHandoffTask({ message: params.message, packet: handoffPacket }),
      agentId: targetAgentId,
      label: params.registryRecord?.label,
      ...(replayModel ? { model: replayModel } : {}),
      runTimeoutSeconds: params.registryRecord?.runTimeoutSeconds,
      ...(params.runtimeReplay.thinking ? { thinking: params.runtimeReplay.thinking } : {}),
      mode: replaySpawnMode,
      ...(replaySpawnMode === "session" ? { thread: true } : {}),
      cleanup: params.registryRecord?.cleanup,
      sandbox: params.sandboxed ? "require" : "inherit",
      lightContext: true,
      expectsCompletionMessage: params.registryRecord?.expectsCompletionMessage !== false,
      sessionRuntime: params.runtimeReplay.sessionRuntime,
    },
    {
      agentSessionKey: params.effectiveRequesterKey,
      agentChannel: params.registryRecord?.requesterOrigin?.channel ?? params.agentChannel,
      agentAccountId: params.registryRecord?.requesterOrigin?.accountId,
      agentTo: params.registryRecord?.requesterOrigin?.to,
      agentThreadId: params.registryRecord?.requesterOrigin?.threadId,
      workspaceDir: params.registryRecord?.workspaceDir,
    },
  );
  if (spawn.status !== "accepted" || !spawn.childSessionKey || !spawn.runId) {
    freshChildReroutes.set(rerouteKey, {
      status: "error",
      key: rerouteKey,
      createdAt: Date.now(),
      error: spawn.error ?? "failed to spawn fresh tracked child",
      oldChildSessionKey: params.resolvedKey,
      ...(params.registryRecord?.runId ? { oldRunId: params.registryRecord.runId } : {}),
      childSessionKey: spawn.childSessionKey,
      runId: spawn.runId,
    });
    return jsonResult({
      ok: false,
      status: "no_delivery",
      code: params.code,
      details: params.details,
      delivery: { status: "rejected", mode: params.deliveryMode },
      reroute: {
        status: "error",
        error: spawn.error ?? "failed to spawn fresh tracked child",
        childSessionKey: spawn.childSessionKey,
        runId: spawn.runId,
      },
    });
  }
  const reroute = decideFreshChildReroute({
    failure: params.details,
    semantic: handoffSemantic.semantic,
    envelope: handoffPacket.envelope,
    replacement: {
      role: targetAgentId,
      childSessionKey: spawn.childSessionKey,
      runId: spawn.runId,
    },
  });
  const marker: FreshChildRerouteMarker = {
    status: "accepted",
    key: rerouteKey,
    createdAt: Date.now(),
    runId: spawn.runId,
    childSessionKey: spawn.childSessionKey,
    mode: spawn.mode,
    reroute,
  };
  freshChildReroutes.set(rerouteKey, marker);
  return jsonResult(
    await buildFreshChildRerouteResponse({
      marker,
      timeoutSeconds: params.timeoutSeconds,
      timeoutMs: params.timeoutMs,
      callGateway: params.callGateway,
    }),
  );
}

async function startAgentRun(params: {
  callGateway: GatewayCaller;
  runId: string;
  sendParams: Record<string, unknown>;
  sessionKey: string;
}): Promise<{ ok: true; runId: string } | { ok: false; result: ReturnType<typeof jsonResult> }> {
  try {
    const response = await params.callGateway<{ runId: string }>({
      method: "agent",
      params: params.sendParams,
      timeoutMs: 10_000,
    });
    return {
      ok: true,
      runId: typeof response?.runId === "string" && response.runId ? response.runId : params.runId,
    };
  } catch (err) {
    const messageText =
      err instanceof Error ? err.message : typeof err === "string" ? err : "error";
    return {
      ok: false,
      result: jsonResult({
        runId: params.runId,
        status: "error",
        error: messageText,
        sessionKey: params.sessionKey,
      }),
    };
  }
}

export function createSessionsSendTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
}): AnyAgentTool {
  return {
    label: "Session Send",
    name: "sessions_send",
    displaySummary: SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSendTool(),
    parameters: SessionsSendToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const gatewayCall = opts?.callGateway ?? callGateway;
      const message = readStringParam(params, "message", { required: true });
      const { cfg, mainKey, alias, effectiveRequesterKey, restrictToSpawned } =
        resolveSessionToolContext(opts);

      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const sessionVisibility = resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: opts?.sandboxed === true,
      });

      const sessionKeyParam = readStringParam(params, "sessionKey");
      const labelParam = normalizeOptionalString(readStringParam(params, "label"));
      const labelAgentIdParam = normalizeOptionalString(readStringParam(params, "agentId"));
      if (sessionKeyParam && labelParam) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "Provide either sessionKey or label (not both).",
        });
      }

      let sessionKey = sessionKeyParam;
      if (!sessionKey && labelParam) {
        const requesterAgentId = resolveAgentIdFromSessionKey(effectiveRequesterKey);
        const requestedAgentId = labelAgentIdParam
          ? normalizeAgentId(labelAgentIdParam)
          : undefined;

        if (restrictToSpawned && requestedAgentId && requestedAgentId !== requesterAgentId) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "forbidden",
            error: "Sandboxed sessions_send label lookup is limited to this agent",
          });
        }

        const resolveParams: Record<string, unknown> = {
          label: labelParam,
          ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
          ...(restrictToSpawned ? { spawnedBy: effectiveRequesterKey } : {}),
        };
        let resolvedKey = "";
        try {
          const resolved = await gatewayCall<{ key: string }>({
            method: "sessions.resolve",
            params: resolveParams,
            timeoutMs: 10_000,
          });
          resolvedKey = normalizeOptionalString(resolved?.key) ?? "";
        } catch (err) {
          const msg = formatErrorMessage(err);
          if (restrictToSpawned) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Session not visible from this sandboxed agent session.",
            });
          }
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: msg || `No session found with label: ${labelParam}`,
          });
        }

        if (!resolvedKey) {
          if (restrictToSpawned) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Session not visible from this sandboxed agent session.",
            });
          }
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: `No session found with label: ${labelParam}`,
          });
        }
        sessionKey = resolvedKey;
      }

      if (!sessionKey) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "Either sessionKey or label is required",
        });
      }
      const resolvedSession = await resolveSessionReference({
        sessionKey,
        alias,
        mainKey,
        requesterInternalKey: effectiveRequesterKey,
        restrictToSpawned,
      });
      if (!resolvedSession.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: resolvedSession.status,
          error: resolvedSession.error,
        });
      }
      const visibleSession = await resolveVisibleSessionReference({
        resolvedSession,
        requesterSessionKey: effectiveRequesterKey,
        restrictToSpawned,
        visibilitySessionKey: sessionKey,
      });
      if (!visibleSession.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: visibleSession.status,
          error: visibleSession.error,
          sessionKey: visibleSession.displayKey,
        });
      }
      // Normalize sessionKey/sessionId input into a canonical session key.
      const resolvedKey = visibleSession.key;
      const displayKey = visibleSession.displayKey;
      const timeoutSeconds =
        typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
          ? Math.max(0, Math.floor(params.timeoutSeconds))
          : 30;
      const assignmentKind = readAssignmentKind(params);
      const timeoutMs = timeoutSeconds * 1000;
      const announceTimeoutMs = timeoutSeconds === 0 ? 30_000 : timeoutMs;
      const idempotencyKey = crypto.randomUUID();
      let runId: string = idempotencyKey;
      const subagentController = resolveSubagentController({
        cfg,
        agentSessionKey: effectiveRequesterKey,
      });
      const controlledChildRun =
        subagentController.controlScope === "children"
          ? listControlledSubagentRuns(subagentController.controllerSessionKey).find(
              (entry) => entry.childSessionKey === resolvedKey,
            )
          : undefined;
      const visibilityGuard = await createSessionVisibilityGuard({
        action: "send",
        requesterSessionKey: effectiveRequesterKey,
        visibility: sessionVisibility,
        a2aPolicy,
      });
      const access = visibilityGuard.check(resolvedKey);
      // A controlled child is already scoped by the subagent registry, so parent
      // follow-ups should not depend on the broader cross-agent allowlist.
      if (!access.allowed && !controlledChildRun) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: access.status,
          error: access.error,
          sessionKey: displayKey,
        });
      }
      const childTargetKind = resolveChildTargetKind(resolvedKey);
      const requesterGeneration =
        getLatestSubagentRunByChildSessionKey(effectiveRequesterKey)?.runId;
      const latestRegistryRecord = getLatestSubagentRunByChildSessionKey(resolvedKey);
      const controlledRegistryRecord = controlledChildRun
        ? (latestRegistryRecord ?? controlledChildRun)
        : undefined;
      const registryRecord = controlledRegistryRecord ?? latestRegistryRecord;
      const targetSessionContext = resolveTargetRouteSessionContext({
        cfg,
        sessionKey: resolvedKey,
        requesterSessionKey: effectiveRequesterKey,
      });
      const targetProvider = targetSessionContext.provider;
      const runtimeReplay = buildSessionRuntimeReplay(targetSessionContext.entry);
      if (childTargetKind) {
        if (registryRecord?.suppressAnnounceReason === "fresh-reroute") {
          pruneFreshChildReroutes();
          const existingReroute = findFreshChildRerouteForOldGeneration({
            oldChildSessionKey: resolvedKey,
            oldRunId: registryRecord.runId,
          });
          if (existingReroute?.status === "accepted") {
            return jsonResult(
              await buildFreshChildRerouteResponse({
                marker: existingReroute,
                timeoutSeconds,
                timeoutMs,
                callGateway: gatewayCall,
              }),
            );
          }
          if (existingReroute?.status === "error") {
            return jsonResult({
              ok: false,
              status: "no_delivery",
              code: "child_session_unhealthy",
              details: {
                kind: "child_route_unhealthy",
                childSessionKey: resolvedKey,
                requesterSessionKey: effectiveRequesterKey,
                codes: ["agent_lifecycle_abandoned"],
                recommendedAction: "stop",
                stateTransitionRequired: true,
                healthEvidenceEpoch: `fresh_reroute_error:${registryRecord.runId}`,
                evidenceEventIds: [registryRecord.runId],
                deliveryAttemptId: `fresh_reroute_error:${registryRecord.runId}`,
                plannerInstruction:
                  "The fresh child reroute for this old generation already failed; do not send follow-up work to the old child.",
              },
              delivery: { status: "rejected", mode: "child_route_guard" },
              reroute: {
                status: "error",
                error: existingReroute.error,
                childSessionKey: existingReroute.childSessionKey,
                runId: existingReroute.runId,
              },
            });
          }
          return jsonResult({
            ok: false,
            status: "no_delivery",
            code: "child_session_unhealthy",
            details: {
              kind: "child_route_unhealthy",
              childSessionKey: resolvedKey,
              requesterSessionKey: effectiveRequesterKey,
              codes: ["agent_lifecycle_abandoned"],
              recommendedAction: "stop",
              stateTransitionRequired: true,
              healthEvidenceEpoch: `fresh_reroute_superseded:${registryRecord.runId}`,
              evidenceEventIds: [registryRecord.runId],
              deliveryAttemptId: `fresh_reroute_superseded:${registryRecord.runId}`,
              plannerInstruction:
                "This old child generation was superseded by a fresh reroute; do not send follow-up work to it.",
            },
            delivery: { status: "rejected", mode: "child_route_guard" },
            reroute: {
              status: "blocked",
              reason: "old_generation_superseded",
              plannerInstruction:
                "Continue with the fresh child generation created by the prior reroute instead of sending to the old child.",
            },
          });
        }
        const routeGuard = await guardChildRouteForDelivery({
          childSessionKey: resolvedKey,
          context: {
            routeIntent: "followup_reuse",
            targetMethod: "sessions_send",
            idempotencyKey,
            requesterSessionKey: effectiveRequesterKey,
            requesterGeneration,
            childTargetKind,
            registryRecord,
            provider: targetProvider,
          },
          payloadForHash: {
            method: "sessions_send",
            message: message.trim(),
            timeoutSeconds,
          },
        });
        if (!routeGuard.ok) {
          if (
            routeGuard.details.kind === "child_route_unhealthy" &&
            routeGuard.details.recommendedAction === "spawn_fresh"
          ) {
            return rerouteToFreshChild({
              code: "child_session_unhealthy",
              deliveryMode: "child_route_guard",
              details: routeGuard.details,
              resolvedKey,
              effectiveRequesterKey,
              requesterGeneration,
              childTargetKind,
              registryRecord,
              targetProvider,
              targetSessionContext,
              runtimeReplay,
              message,
              handoffValue: params.handoff,
              idempotencyKey,
              timeoutSeconds,
              timeoutMs,
              callGateway: gatewayCall,
              sandboxed: opts?.sandboxed === true,
              agentChannel: opts?.agentChannel,
            });
          }
          return jsonResult({
            ok: false,
            status: "no_delivery",
            code: routeGuard.code,
            details: routeGuard.details,
            delivery: {
              status: "rejected",
              mode: "child_route_guard",
            },
          });
        }
      }

      // Controlled child sessions already have tracked lifecycle state; route
      // follow-up work through subagent control so long runs keep push-based
      // completion instead of the best-effort A2A announce loop.
      if (controlledRegistryRecord) {
        const latestLifecycleOutcome = resolvePreflightLifecycleOutcome(controlledRegistryRecord);
        const preflight = await preflightChildRouteAssignment({
          childSessionKey: resolvedKey,
          assignmentKind,
          context: {
            routeIntent: "followup_reuse",
            targetMethod: "sessions_send",
            idempotencyKey,
            requesterSessionKey: effectiveRequesterKey,
            requesterGeneration,
            childTargetKind: resolveChildTargetKind(resolvedKey) ?? "subagent",
            registryRecord: controlledRegistryRecord,
            provider: targetProvider,
          },
          latestLifecycleOutcome,
          hardHeadroomPercentThreshold: SESSIONS_SEND_HARD_HEADROOM_PERCENT_THRESHOLD,
        });
        if (preflight.status === "reroute" && preflight.recommendedAction === "spawn_fresh") {
          return rerouteToFreshChild({
            code: "child_route_assignment_blocked",
            deliveryMode: "child_route_preflight",
            details: buildPreflightFreshRerouteDetails({
              childSessionKey: resolvedKey,
              requesterSessionKey: effectiveRequesterKey,
              idempotencyKey,
              preflight,
              latestLifecycleOutcome,
            }),
            resolvedKey,
            effectiveRequesterKey,
            requesterGeneration,
            childTargetKind,
            registryRecord: controlledRegistryRecord,
            targetProvider,
            targetSessionContext,
            runtimeReplay,
            message,
            handoffValue: params.handoff,
            idempotencyKey,
            timeoutSeconds,
            timeoutMs,
            callGateway: gatewayCall,
            sandboxed: opts?.sandboxed === true,
            agentChannel: opts?.agentChannel,
          });
        }
        if (preflight.status !== "reuse") {
          return jsonResult({
            ok: false,
            status: "no_delivery",
            code:
              preflight.status === "unavailable"
                ? "child_route_assignment_unavailable"
                : "child_route_assignment_blocked",
            details: {
              kind: "child_route_assignment_preflight",
              childSessionKey: resolvedKey,
              requesterSessionKey: effectiveRequesterKey,
              assignmentKind,
              status: preflight.status,
              reason: preflight.reason,
              ...(preflight.status === "unavailable"
                ? { retryable: preflight.retryable }
                : {
                    recommendedAction: preflight.recommendedAction,
                    ...(preflight.codes ? { codes: preflight.codes } : {}),
                  }),
              plannerInstruction: preflight.plannerInstruction,
              ...("contextHeadroom" in preflight && preflight.contextHeadroom
                ? { contextHeadroom: preflight.contextHeadroom }
                : {}),
            },
            delivery: { status: "rejected", mode: "child_route_preflight" },
          });
        }
      }
      const controlledTrackedRun = controlledRegistryRecord;
      if (controlledTrackedRun) {
        const trackedDelivery = { status: "tracked", mode: "completion_event" as const };
        const baselineReply =
          timeoutSeconds === 0
            ? undefined
            : await readLatestAssistantReplySnapshot({
                sessionKey: resolvedKey,
                limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
                callGateway: gatewayCall,
              });
        const restart = await steerControlledSubagentRun({
          cfg,
          controller: subagentController,
          entry: controlledTrackedRun,
          message,
        });
        if (restart.status !== "accepted") {
          return jsonResult({
            runId: restart.runId ?? crypto.randomUUID(),
            status: "error",
            error: restart.error ?? restart.text ?? "failed to restart tracked child session",
            sessionKey: displayKey,
          });
        }
        if (timeoutSeconds === 0) {
          return jsonResult({
            runId: restart.runId,
            status: "accepted",
            sessionKey: displayKey,
            sessionId: restart.sessionId,
            label: restart.label,
            mode: restart.mode,
            delivery: trackedDelivery,
            text: restart.text,
          });
        }

        const result = await waitForAgentRunAndReadUpdatedAssistantReply({
          runId: restart.runId,
          sessionKey: resolvedKey,
          timeoutMs,
          limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
          baseline: baselineReply,
          callGateway: gatewayCall,
        });
        if (result.status === "timeout") {
          return jsonResult({
            runId: restart.runId,
            status: "timeout",
            error: result.error,
            sessionKey: displayKey,
            delivery: trackedDelivery,
          });
        }
        if (result.status === "error") {
          return jsonResult({
            runId: restart.runId,
            status: "error",
            error: result.error ?? "agent error",
            sessionKey: displayKey,
          });
        }
        return jsonResult({
          runId: restart.runId,
          status: "ok",
          reply: result.replyText,
          sessionKey: displayKey,
          delivery: trackedDelivery,
        });
      }

      // Capture the pre-run assistant snapshot before starting the nested run.
      // Fast in-process test doubles and short-circuit agent paths can finish
      // before we reach the post-run read, which would otherwise make the new
      // reply look like the baseline and hide it from the caller.
      const baselineReply =
        timeoutSeconds === 0
          ? undefined
          : await readLatestAssistantReplySnapshot({
              sessionKey: resolvedKey,
              limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
              callGateway: gatewayCall,
            });

      const agentMessageContext = buildAgentToAgentMessageContext({
        requesterSessionKey: opts?.agentSessionKey,
        requesterChannel: opts?.agentChannel,
        targetSessionKey: displayKey,
      });
      const sendParams = {
        message,
        sessionKey: resolvedKey,
        idempotencyKey,
        deliver: false,
        channel: INTERNAL_MESSAGE_CHANNEL,
        lane: AGENT_LANE_NESTED,
        extraSystemPrompt: agentMessageContext,
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: opts?.agentSessionKey,
          sourceChannel: opts?.agentChannel,
          sourceTool: "sessions_send",
        },
      };
      const requesterSessionKey = opts?.agentSessionKey;
      const requesterChannel = opts?.agentChannel;
      const maxPingPongTurns = resolvePingPongTurns(cfg);
      const delivery = { status: "pending", mode: "announce" as const };
      const startA2AFlow = (
        roundOneReply?: string,
        waitRunId?: string,
        options?: { waitTimeoutMs?: number },
      ) => {
        void runSessionsSendA2AFlow({
          targetSessionKey: resolvedKey,
          displayKey,
          message,
          announceTimeoutMs,
          waitTimeoutMs: options?.waitTimeoutMs,
          maxPingPongTurns,
          requesterSessionKey,
          requesterChannel,
          roundOneReply,
          waitRunId,
        });
      };

      if (timeoutSeconds === 0) {
        const start = await startAgentRun({
          callGateway: gatewayCall,
          runId,
          sendParams,
          sessionKey: displayKey,
        });
        if (!start.ok) {
          return start.result;
        }
        runId = start.runId;
        startA2AFlow(undefined, runId);
        return jsonResult({
          runId,
          status: "accepted",
          sessionKey: displayKey,
          delivery,
        });
      }

      const start = await startAgentRun({
        callGateway: gatewayCall,
        runId,
        sendParams,
        sessionKey: displayKey,
      });
      if (!start.ok) {
        return start.result;
      }
      runId = start.runId;
      const result = await waitForAgentRunAndReadUpdatedAssistantReply({
        runId,
        sessionKey: resolvedKey,
        timeoutMs,
        limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
        baseline: baselineReply,
        callGateway: gatewayCall,
      });

      if (result.status === "timeout") {
        startA2AFlow(undefined, runId, {
          waitTimeoutMs: Math.max(announceTimeoutMs, SESSIONS_SEND_LATE_ANNOUNCE_WAIT_MS),
        });
        return jsonResult({
          runId,
          status: "timeout",
          error: result.error,
          sessionKey: displayKey,
          delivery,
        });
      }
      if (result.status === "error") {
        return jsonResult({
          runId,
          status: "error",
          error: result.error ?? "agent error",
          sessionKey: displayKey,
        });
      }
      const reply = result.replyText;
      startA2AFlow(reply ?? undefined);

      return jsonResult({
        runId,
        status: "ok",
        reply,
        sessionKey: displayKey,
        delivery,
      });
    },
  };
}

export const __testing = {
  resetFreshChildReroutesForTest() {
    freshChildReroutes.clear();
  },
};
