import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { isAcpSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  type ChildRouteCompactionStatus,
  type ChildRouteHeadroomEstimateSource,
  type ChildRouteHealthCode,
  type ChildRouteIntent,
  type ChildRouteRecommendedAction,
  type ChildTargetKind,
} from "./child-route-health-contract.js";
import { acquireSessionWriteLock } from "./session-write-lock.js";

const STORE_VERSION = 1 as const;
const JSON_FILE_MODE = 0o600;
const TRANSIENT_EVENT_WINDOW_MS = 30 * 60_000;
const EVENT_RETENTION_MS = 24 * 60 * 60_000;
const MAX_EVENTS_TOTAL = 5_000;
const MAX_EVENTS_PER_CHILD = 200;

const CHILD_LOCAL_BLOCKERS = new Set<ChildRouteHealthCode>([
  "child_conversation_expired",
  "context_overflow",
  "agent_lifecycle_blocked",
  "agent_lifecycle_abandoned",
  "agent_lifecycle_error",
  "edit_failure_threshold",
]);

const ALL_CODES = new Set<ChildRouteHealthCode>([
  "child_conversation_expired",
  "auth_profile_session_expired",
  "context_overflow",
  "agent_lifecycle_blocked",
  "agent_lifecycle_abandoned",
  "agent_lifecycle_error",
  "edit_failure_threshold",
]);

export type ChildRouteProviderContext = {
  providerId?: string;
  modelId?: string;
  authProfileKey?: string;
  credentialSource?: string;
  credentialBucket?: string;
  requesterSessionKey?: string;
  fallbackCredentialSelected?: boolean;
};

export type ChildRouteHealthEventSource =
  | "agent_lifecycle"
  | "context_overflow"
  | "edit_tool"
  | "provider_error"
  | "subagent_terminal"
  | "repair_control"
  | "manual";

export type ChildRouteHealthEventStatus = "active" | "cleared" | "success";

export type ChildRouteHealthContext = {
  routeIntent: ChildRouteIntent;
  targetMethod: string;
  requesterSessionKey?: string;
  idempotencyKey?: string;
  requesterGeneration?: string;
  targetAgentId?: string;
  provider?: ChildRouteProviderContext;
  childTargetKind?: ChildTargetKind;
  registryRecord?: ChildRouteRegistryRecord | null;
  sessionLineage?: {
    spawnedBy?: string;
    parentSessionKey?: string;
    forkedFromParent?: boolean;
  };
  pendingSpawn?: {
    pendingSpawnId?: string;
    requesterSessionKey?: string;
    idempotencyKey?: string;
  };
  contextHeadroom?: ChildRouteContextHeadroomSnapshot;
  descendantWakeAccepted?: boolean;
  editFailureScope?: {
    runId?: string;
    filePath?: string;
    toolKind?: "edit" | "apply_patch";
  };
};

export type ChildRouteRegistryRecord = {
  childSessionKey?: string;
  runId?: string;
  suppressAnnounceReason?: "steer-restart" | "killed" | "fresh-reroute";
};

export type ChildRouteSessionLineage = {
  spawnedBy?: string;
  parentSessionKey?: string;
  forkedFromParent?: boolean;
  spawnDepth?: number;
};

export type ChildRouteTarget = {
  sessionKey: string;
  healthSessionKey: string;
  childTargetKind: ChildTargetKind;
  lineageSessionKey?: string;
};

export type ChildRouteHealthUnavailableKind =
  | "child_route_health_unavailable"
  | "child_route_context_missing"
  | "child_route_untrusted";

export type ChildRouteHealthAssessment =
  | { status: "ok"; codes: []; healthEvidenceEpoch: string }
  | {
      status: "unhealthy";
      codes: ChildRouteHealthCode[];
      recommendedAction: ChildRouteRecommendedAction;
      plannerInstruction: string;
      stateTransitionRequired: boolean;
      healthEvidenceEpoch: string;
      evidenceEventIds: string[];
    }
  | {
      status: "unavailable";
      errorKind: ChildRouteHealthUnavailableKind;
      retryable: boolean;
      plannerInstruction: string;
    };

export type ChildRoutePendingSpawnRecord = {
  pendingSpawnId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  childTargetKind: ChildTargetKind;
  idempotencyKey: string;
  runId?: string;
  targetAgentId?: string;
  createdAt: number;
  expiresAt: number;
  consumedAt?: number;
  failedAt?: number;
  cleanupAttemptedAt?: number;
};

export type ChildRouteAssignmentKind =
  | "small_clarification"
  | "implementation"
  | "testing"
  | "review";

export type ChildRouteContextHeadroomSnapshot = {
  childSessionKey: string;
  runId?: string;
  estimatedPromptTokens?: number;
  modelContextLimitTokens?: number;
  headroomTokens?: number;
  headroomPercent?: number;
  estimateSource: ChildRouteHeadroomEstimateSource;
  lastCompactionStatus: ChildRouteCompactionStatus;
  observedAt: number;
};

export type ChildRouteEditFailureSignal = {
  childSessionKey: string;
  runId?: string;
  filePath?: string;
  toolKind: "edit" | "apply_patch";
  failureKind: "old_text_mismatch" | "ambiguous_old_text" | "mechanical_edit_failure";
  count: number;
  firstFailureAt: number;
  lastFailureAt: number;
  expiresAt: number;
};

export type ChildRouteAssignmentPreflightResult =
  | {
      status: "reuse";
      childSessionKey: string;
      assignmentKind: ChildRouteAssignmentKind;
      contextHeadroom?: ChildRouteContextHeadroomSnapshot;
    }
  | {
      status: "reroute";
      reason: "route_health" | "lifecycle" | "tracking" | "context_headroom" | "compaction";
      childSessionKey: string;
      assignmentKind: ChildRouteAssignmentKind;
      recommendedAction: ChildRouteRecommendedAction;
      plannerInstruction: string;
      codes?: ChildRouteHealthCode[];
      contextHeadroom?: ChildRouteContextHeadroomSnapshot;
    }
  | {
      status: "unavailable";
      reason: "route_health" | "tracking" | "context_headroom";
      childSessionKey: string;
      assignmentKind: ChildRouteAssignmentKind;
      retryable: boolean;
      plannerInstruction: string;
    };

type RouteHealthEvent = {
  version: typeof STORE_VERSION;
  eventId: string;
  code: ChildRouteHealthCode;
  status: ChildRouteHealthEventStatus;
  observedAt: number;
  expiresAt?: number;
  source: ChildRouteHealthEventSource;
  childSessionKey?: string;
  runId?: string;
  requesterSessionKey?: string;
  provider?: ChildRouteProviderContext;
  filePath?: string;
  toolKind?: "edit" | "apply_patch";
  reason?: string;
};

type ActiveBlockerSummary = {
  code: ChildRouteHealthCode;
  eventId: string;
  observedAt: number;
  expiresAt?: number;
  source: ChildRouteHealthEventSource;
  runId?: string;
  filePath?: string;
  toolKind?: "edit" | "apply_patch";
};

type RouteHealthState = {
  version: typeof STORE_VERSION;
  events: RouteHealthEvent[];
  activeChildBlockers: Record<string, ActiveBlockerSummary[]>;
  activeAuthBlockers: Record<string, ActiveBlockerSummary[]>;
  successMarkers: Record<string, { eventId: string; observedAt: number; runId?: string }>;
  pendingSpawns: Record<string, ChildRoutePendingSpawnRecord>;
  contextHeadroomSnapshots: {
    byChildSessionKey: Record<string, ChildRouteContextHeadroomSnapshot>;
    byRunId: Record<string, ChildRouteContextHeadroomSnapshot>;
  };
  editFailures: Record<string, ChildRouteEditFailureSignal>;
  unavailableScopes: Record<string, { reason: string; observedAt: number }>;
};

export type ChildRouteHealthEventInput = {
  code: ChildRouteHealthCode;
  status: ChildRouteHealthEventStatus;
  source: ChildRouteHealthEventSource;
  eventId?: string;
  observedAt?: number;
  expiresAt?: number;
  childSessionKey?: string;
  runId?: string;
  requesterSessionKey?: string;
  provider?: ChildRouteProviderContext;
  filePath?: string;
  toolKind?: "edit" | "apply_patch";
  reason?: string;
};

const unavailableScopes = new Map<string, { reason: string; observedAt: number }>();

const EDIT_FAILURE_THRESHOLD = 3;
const EDIT_FAILURE_WINDOW_MS = 30 * 60_000;

function resolveSubagentStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCLAW_STATE_DIR?.trim()) {
    return path.join(resolveStateDir(env), "subagents");
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), "openclaw-test-state", String(process.pid), "subagents");
  }
  return path.join(resolveStateDir(env), "subagents");
}

export function resolveChildRouteHealthPath(): string {
  return path.join(resolveSubagentStateDir(process.env), "route-health.json");
}

function resolveChildRouteUnavailablePath(): string {
  return path.join(resolveSubagentStateDir(process.env), "route-health-unavailable.json");
}

export function resolveChildTargetKind(childSessionKey: string): ChildTargetKind | undefined {
  if (isSubagentSessionKey(childSessionKey)) {
    return "subagent";
  }
  if (isAcpSessionKey(childSessionKey)) {
    return "acp";
  }
  return undefined;
}

export function resolveChildRouteTarget(params: {
  sessionKey: string;
  entry?: ChildRouteSessionLineage | null;
  registryRecord?: ChildRouteRegistryRecord | null;
}): ChildRouteTarget | undefined {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return undefined;
  }
  const directKind = resolveChildTargetKind(sessionKey);
  if (directKind) {
    return {
      sessionKey,
      healthSessionKey: sessionKey,
      childTargetKind: directKind,
    };
  }
  const registryChildKey = normalizeOptionalString(params.registryRecord?.childSessionKey);
  if (registryChildKey) {
    return {
      sessionKey,
      healthSessionKey: registryChildKey,
      childTargetKind: resolveChildTargetKind(registryChildKey) ?? "subagent",
      lineageSessionKey: registryChildKey,
    };
  }
  const lineageKeys = [
    normalizeOptionalString(params.entry?.spawnedBy),
    normalizeOptionalString(params.entry?.parentSessionKey),
  ].filter((key): key is string => Boolean(key));
  for (const lineageSessionKey of lineageKeys) {
    const childTargetKind = resolveChildTargetKind(lineageSessionKey);
    if (childTargetKind) {
      return {
        sessionKey,
        healthSessionKey: lineageSessionKey,
        childTargetKind,
        lineageSessionKey,
      };
    }
  }
  return undefined;
}

function emptyState(): RouteHealthState {
  return {
    version: STORE_VERSION,
    events: [],
    activeChildBlockers: {},
    activeAuthBlockers: {},
    successMarkers: {},
    pendingSpawns: {},
    contextHeadroomSnapshots: {
      byChildSessionKey: {},
      byRunId: {},
    },
    editFailures: {},
    unavailableScopes: {},
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isHealthCode(value: unknown): value is ChildRouteHealthCode {
  return typeof value === "string" && ALL_CODES.has(value as ChildRouteHealthCode);
}

function isEventStatus(value: unknown): value is ChildRouteHealthEventStatus {
  return value === "active" || value === "cleared" || value === "success";
}

function isEventSource(value: unknown): value is ChildRouteHealthEventSource {
  return (
    value === "agent_lifecycle" ||
    value === "context_overflow" ||
    value === "edit_tool" ||
    value === "provider_error" ||
    value === "subagent_terminal" ||
    value === "repair_control" ||
    value === "manual"
  );
}

function isHeadroomEstimateSource(value: unknown): value is ChildRouteHeadroomEstimateSource {
  return value === "actual_request" || value === "preflight_estimate" || value === "unknown";
}

function isCompactionStatus(value: unknown): value is ChildRouteCompactionStatus {
  return (
    value === "none" ||
    value === "pending" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "unknown"
  );
}

function normalizeProvider(raw: unknown): ChildRouteProviderContext | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const provider: ChildRouteProviderContext = {};
  const providerId = readString(record.providerId);
  if (providerId) {
    provider.providerId = providerId;
  }
  const modelId = readString(record.modelId);
  if (modelId) {
    provider.modelId = modelId;
  }
  const authProfileKey = readString(record.authProfileKey);
  if (authProfileKey) {
    provider.authProfileKey = authProfileKey;
  }
  const credentialSource = readString(record.credentialSource);
  if (credentialSource) {
    provider.credentialSource = credentialSource;
  }
  const credentialBucket = readString(record.credentialBucket);
  if (credentialBucket) {
    provider.credentialBucket = credentialBucket;
  }
  const requesterSessionKey = readString(record.requesterSessionKey);
  if (requesterSessionKey) {
    provider.requesterSessionKey = requesterSessionKey;
  }
  if (typeof record.fallbackCredentialSelected === "boolean") {
    provider.fallbackCredentialSelected = record.fallbackCredentialSelected;
  }
  return Object.keys(provider).length > 0 ? provider : undefined;
}

function normalizeEvent(raw: unknown): RouteHealthEvent | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const eventId = readString(record.eventId);
  const observedAt = readNumber(record.observedAt);
  if (
    record.version !== STORE_VERSION ||
    !eventId ||
    !isHealthCode(record.code) ||
    !isEventStatus(record.status) ||
    !isEventSource(record.source) ||
    observedAt === undefined
  ) {
    return null;
  }
  const event: RouteHealthEvent = {
    version: STORE_VERSION,
    eventId,
    code: record.code,
    status: record.status,
    observedAt,
    source: record.source,
  };
  const expiresAt = readNumber(record.expiresAt);
  if (expiresAt !== undefined) {
    event.expiresAt = expiresAt;
  }
  const childSessionKey = readString(record.childSessionKey);
  if (childSessionKey) {
    event.childSessionKey = childSessionKey;
  }
  const runId = readString(record.runId);
  if (runId) {
    event.runId = runId;
  }
  const requesterSessionKey = readString(record.requesterSessionKey);
  if (requesterSessionKey) {
    event.requesterSessionKey = requesterSessionKey;
  }
  const provider = normalizeProvider(record.provider);
  if (provider) {
    event.provider = provider;
  }
  const toolKind = readString(record.toolKind);
  if (toolKind === "edit" || toolKind === "apply_patch") {
    event.toolKind = toolKind;
  }
  const filePath = readString(record.filePath);
  if (filePath) {
    event.filePath = filePath;
  }
  const reason = readString(record.reason);
  if (reason) {
    event.reason = reason;
  }
  return event;
}

function normalizeBlocker(raw: unknown): ActiveBlockerSummary | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const eventId = readString(record.eventId);
  const observedAt = readNumber(record.observedAt);
  if (
    !eventId ||
    !isHealthCode(record.code) ||
    !isEventSource(record.source) ||
    observedAt === undefined
  ) {
    return null;
  }
  const blocker: ActiveBlockerSummary = {
    code: record.code,
    eventId,
    observedAt,
    source: record.source,
  };
  const expiresAt = readNumber(record.expiresAt);
  if (expiresAt !== undefined) {
    blocker.expiresAt = expiresAt;
  }
  const runId = readString(record.runId);
  if (runId) {
    blocker.runId = runId;
  }
  const filePath = readString(record.filePath);
  if (filePath) {
    blocker.filePath = filePath;
  }
  const toolKind = readString(record.toolKind);
  if (toolKind === "edit" || toolKind === "apply_patch") {
    blocker.toolKind = toolKind;
  }
  return blocker;
}

function normalizeBlockerMap(raw: unknown): Record<string, ActiveBlockerSummary[]> {
  const out: Record<string, ActiveBlockerSummary[]> = {};
  if (!raw || typeof raw !== "object") {
    return out;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!key.trim() || !Array.isArray(value)) {
      continue;
    }
    const blockers = value
      .map(normalizeBlocker)
      .filter((blocker): blocker is ActiveBlockerSummary => Boolean(blocker))
      .toSorted(compareBlockers);
    if (blockers.length > 0) {
      out[key] = blockers;
    }
  }
  return out;
}

function normalizePendingSpawn(raw: unknown): ChildRoutePendingSpawnRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const pendingSpawnId = readString(record.pendingSpawnId);
  const childSessionKey = readString(record.childSessionKey);
  const requesterSessionKey = readString(record.requesterSessionKey);
  const idempotencyKey = readString(record.idempotencyKey);
  const createdAt = readNumber(record.createdAt);
  const expiresAt = readNumber(record.expiresAt);
  if (
    !pendingSpawnId ||
    !childSessionKey ||
    !requesterSessionKey ||
    !idempotencyKey ||
    createdAt === undefined ||
    expiresAt === undefined ||
    (record.childTargetKind !== "subagent" && record.childTargetKind !== "acp")
  ) {
    return null;
  }
  const pending: ChildRoutePendingSpawnRecord = {
    pendingSpawnId,
    childSessionKey,
    requesterSessionKey,
    childTargetKind: record.childTargetKind,
    idempotencyKey,
    createdAt,
    expiresAt,
  };
  const runId = readString(record.runId);
  if (runId) {
    pending.runId = runId;
  }
  const targetAgentId = readString(record.targetAgentId);
  if (targetAgentId) {
    pending.targetAgentId = targetAgentId;
  }
  const consumedAt = readNumber(record.consumedAt);
  if (consumedAt !== undefined) {
    pending.consumedAt = consumedAt;
  }
  const failedAt = readNumber(record.failedAt);
  if (failedAt !== undefined) {
    pending.failedAt = failedAt;
  }
  const cleanupAttemptedAt = readNumber(record.cleanupAttemptedAt);
  if (cleanupAttemptedAt !== undefined) {
    pending.cleanupAttemptedAt = cleanupAttemptedAt;
  }
  return pending;
}

function normalizeHeadroomPercent(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Math.min(100, Math.max(0, value));
}

function normalizeHeadroomSnapshot(raw: unknown): ChildRouteContextHeadroomSnapshot | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const childSessionKey = readString(record.childSessionKey);
  const observedAt = readNumber(record.observedAt);
  if (
    !childSessionKey ||
    observedAt === undefined ||
    !isHeadroomEstimateSource(record.estimateSource) ||
    !isCompactionStatus(record.lastCompactionStatus)
  ) {
    return null;
  }
  const snapshot: ChildRouteContextHeadroomSnapshot = {
    childSessionKey,
    estimateSource: record.estimateSource,
    lastCompactionStatus: record.lastCompactionStatus,
    observedAt,
  };
  const runId = readString(record.runId);
  if (runId) {
    snapshot.runId = runId;
  }
  const estimatedPromptTokens = readNumber(record.estimatedPromptTokens);
  if (estimatedPromptTokens !== undefined) {
    snapshot.estimatedPromptTokens = Math.max(0, Math.floor(estimatedPromptTokens));
  }
  const modelContextLimitTokens = readNumber(record.modelContextLimitTokens);
  if (modelContextLimitTokens !== undefined) {
    snapshot.modelContextLimitTokens = Math.max(1, Math.floor(modelContextLimitTokens));
  }
  const headroomTokens = readNumber(record.headroomTokens);
  if (headroomTokens !== undefined) {
    snapshot.headroomTokens = Math.floor(headroomTokens);
  }
  const headroomPercent = normalizeHeadroomPercent(readNumber(record.headroomPercent));
  if (headroomPercent !== undefined) {
    snapshot.headroomPercent = headroomPercent;
  }
  return snapshot;
}

function normalizeHeadroomSnapshotMap(
  raw: unknown,
): Record<string, ChildRouteContextHeadroomSnapshot> {
  const out: Record<string, ChildRouteContextHeadroomSnapshot> = {};
  if (!raw || typeof raw !== "object") {
    return out;
  }
  for (const [key, value] of Object.entries(raw)) {
    const snapshot = normalizeHeadroomSnapshot(value);
    if (key.trim() && snapshot) {
      out[key] = snapshot;
    }
  }
  return out;
}

function normalizeEditFailureSignal(raw: unknown): ChildRouteEditFailureSignal | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const childSessionKey = readString(record.childSessionKey);
  const count = readNumber(record.count);
  const firstFailureAt = readNumber(record.firstFailureAt);
  const lastFailureAt = readNumber(record.lastFailureAt);
  const expiresAt = readNumber(record.expiresAt);
  if (
    !childSessionKey ||
    count === undefined ||
    firstFailureAt === undefined ||
    lastFailureAt === undefined ||
    expiresAt === undefined ||
    (record.toolKind !== "edit" && record.toolKind !== "apply_patch") ||
    (record.failureKind !== "old_text_mismatch" &&
      record.failureKind !== "ambiguous_old_text" &&
      record.failureKind !== "mechanical_edit_failure")
  ) {
    return null;
  }
  const signal: ChildRouteEditFailureSignal = {
    childSessionKey,
    toolKind: record.toolKind,
    failureKind: record.failureKind,
    count: Math.max(0, Math.floor(count)),
    firstFailureAt,
    lastFailureAt,
    expiresAt,
  };
  const runId = readString(record.runId);
  if (runId) {
    signal.runId = runId;
  }
  const filePath = readString(record.filePath);
  if (filePath) {
    signal.filePath = filePath;
  }
  return signal;
}

function normalizeEditFailureMap(raw: unknown): Record<string, ChildRouteEditFailureSignal> {
  const out: Record<string, ChildRouteEditFailureSignal> = {};
  if (!raw || typeof raw !== "object") {
    return out;
  }
  for (const [key, value] of Object.entries(raw)) {
    const signal = normalizeEditFailureSignal(value);
    if (key.trim() && signal) {
      out[key] = signal;
    }
  }
  return out;
}

function normalizeState(raw: unknown): RouteHealthState {
  if (!raw || typeof raw !== "object") {
    throw new Error("route-health store is not an object");
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== STORE_VERSION) {
    throw new Error("unsupported route-health store version");
  }
  const state = emptyState();
  if (Array.isArray(record.events)) {
    state.events = record.events
      .map(normalizeEvent)
      .filter((event): event is RouteHealthEvent => Boolean(event));
  }
  state.activeChildBlockers = normalizeBlockerMap(record.activeChildBlockers);
  state.activeAuthBlockers = normalizeBlockerMap(record.activeAuthBlockers);
  if (record.pendingSpawns && typeof record.pendingSpawns === "object") {
    for (const [key, value] of Object.entries(record.pendingSpawns)) {
      const pending = normalizePendingSpawn(value);
      if (pending && key === pending.pendingSpawnId) {
        state.pendingSpawns[key] = pending;
      }
    }
  }
  if (record.unavailableScopes && typeof record.unavailableScopes === "object") {
    for (const [key, value] of Object.entries(record.unavailableScopes)) {
      if (!value || typeof value !== "object") {
        continue;
      }
      const unavailable = value as Record<string, unknown>;
      const reason = readString(unavailable.reason);
      const observedAt = readNumber(unavailable.observedAt);
      if (key.trim() && reason && observedAt !== undefined) {
        state.unavailableScopes[key] = { reason, observedAt };
      }
    }
  }
  if (record.contextHeadroomSnapshots && typeof record.contextHeadroomSnapshots === "object") {
    const snapshots = record.contextHeadroomSnapshots as Record<string, unknown>;
    state.contextHeadroomSnapshots = {
      byChildSessionKey: normalizeHeadroomSnapshotMap(snapshots.byChildSessionKey),
      byRunId: normalizeHeadroomSnapshotMap(snapshots.byRunId),
    };
  }
  state.editFailures = normalizeEditFailureMap(record.editFailures);
  return state;
}

function normalizeUnavailableState(
  raw: unknown,
): Record<string, { reason: string; observedAt: number }> {
  if (!raw || typeof raw !== "object") {
    throw new Error("route-health unavailable store is not an object");
  }
  const record = raw as Record<string, unknown>;
  const result: Record<string, { reason: string; observedAt: number }> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!key.trim() || !value || typeof value !== "object") {
      continue;
    }
    const scope = value as Record<string, unknown>;
    const reason = readString(scope.reason) ?? "route health unavailable";
    const observedAt = readNumber(scope.observedAt) ?? Date.now();
    result[key] = { reason, observedAt };
  }
  return result;
}

async function readStateFromPath(pathname: string): Promise<RouteHealthState> {
  try {
    const raw = await fs.readFile(pathname, "utf8");
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyState();
    }
    throw error;
  }
}

async function writeStateToPath(pathname: string, state: RouteHealthState): Promise<void> {
  await fs.mkdir(path.dirname(pathname), { recursive: true, mode: 0o700 });
  await fs.writeFile(pathname, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: JSON_FILE_MODE,
  });
}

async function readUnavailableScopesFromPath(): Promise<
  Record<string, { reason: string; observedAt: number }>
> {
  const pathname = resolveChildRouteUnavailablePath();
  let raw: string;
  try {
    raw = await fs.readFile(pathname, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
  return normalizeUnavailableState(JSON.parse(raw));
}

async function writeUnavailableScopesToPath(
  scopes: Record<string, { reason: string; observedAt: number }>,
): Promise<void> {
  const pathname = resolveChildRouteUnavailablePath();
  const entries = Object.entries(scopes).filter(([key]) => key.trim());
  if (entries.length === 0) {
    await fs.rm(pathname, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(pathname), { recursive: true, mode: 0o700 });
  await fs.writeFile(pathname, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`, {
    encoding: "utf8",
    mode: JSON_FILE_MODE,
  });
}

async function mutateUnavailableScopes(
  apply: (scopes: Record<string, { reason: string; observedAt: number }>) => void,
): Promise<void> {
  const pathname = resolveChildRouteUnavailablePath();
  let lock: { release: () => Promise<void> } | undefined;
  try {
    lock = await acquireSessionWriteLock({
      sessionFile: pathname,
      timeoutMs: 10_000,
      staleMs: 30 * 60_000,
      allowReentrant: true,
    });
    const scopes = await readUnavailableScopesFromPath();
    apply(scopes);
    await writeUnavailableScopesToPath(scopes);
  } finally {
    await lock?.release().catch(() => undefined);
  }
}

function stableHash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stableRouteId(prefix: string, value: unknown): string {
  return `${prefix}_${stableHash(value).slice(0, 32)}`;
}

function resolveAuthScopeQuery(provider?: ChildRouteProviderContext):
  | {
      providerId: string;
      exactScopeKey?: string;
      providerPrefix: string;
    }
  | undefined {
  const providerId = normalizeOptionalString(provider?.providerId);
  if (!providerId) {
    return undefined;
  }
  const authProfileKey = normalizeOptionalString(provider?.authProfileKey);
  if (authProfileKey) {
    return {
      providerId,
      exactScopeKey: `${providerId}:profile:${authProfileKey}`,
      providerPrefix: `${providerId}:`,
    };
  }
  const credentialSource = normalizeOptionalString(provider?.credentialSource);
  if (credentialSource) {
    return {
      providerId,
      exactScopeKey: `${providerId}:source:${credentialSource}`,
      providerPrefix: `${providerId}:`,
    };
  }
  const credentialBucket = normalizeOptionalString(provider?.credentialBucket);
  if (credentialBucket) {
    return {
      providerId,
      exactScopeKey: `${providerId}:bucket:${credentialBucket}`,
      providerPrefix: `${providerId}:`,
    };
  }
  return {
    providerId,
    exactScopeKey: `${providerId}:bucket:unknown/default`,
    providerPrefix: `${providerId}:`,
  };
}

function resolveAuthScopeKey(provider?: ChildRouteProviderContext): string | undefined {
  const query = resolveAuthScopeQuery(provider);
  if (!query) {
    return undefined;
  }
  return query.exactScopeKey ?? `${query.providerId}:bucket:unknown/default`;
}

function collectAuthBlockerEntries(
  state: Pick<RouteHealthState, "activeAuthBlockers">,
  provider?: ChildRouteProviderContext,
): Array<[string, ActiveBlockerSummary[]]> {
  const query = resolveAuthScopeQuery(provider);
  if (!query) {
    return [];
  }
  if (query.exactScopeKey) {
    const blockers = state.activeAuthBlockers[query.exactScopeKey] ?? [];
    return blockers.length > 0 ? [[query.exactScopeKey, blockers]] : [];
  }
  return Object.entries(state.activeAuthBlockers)
    .filter(
      ([scopeKey, blockers]) => scopeKey.startsWith(query.providerPrefix) && blockers.length > 0,
    )
    .toSorted(([left], [right]) => left.localeCompare(right));
}

function summarizeAuthBlockerEntries(
  authBlockerEntries: Array<[string, ActiveBlockerSummary[]]>,
): ChildRouteActiveAuthBlockerSummary[] {
  return authBlockerEntries.map(([authScopeKey, blockers]) => ({
    authScopeKey,
    codes: Array.from(new Set(blockers.map((blocker) => blocker.code))).toSorted(),
    eventIds: blockers.map((blocker) => blocker.eventId).toSorted(),
    observedAt: Math.max(...blockers.map((blocker) => blocker.observedAt)),
  }));
}

function upsertAuthBlockerEntries(
  entries: Map<string, ActiveBlockerSummary[]>,
  scopeKey: string,
  blockers: ActiveBlockerSummary[],
): void {
  const existing = entries.get(scopeKey) ?? [];
  const byEventId = new Map<string, ActiveBlockerSummary>();
  for (const blocker of [...existing, ...blockers]) {
    byEventId.set(blocker.eventId, blocker);
  }
  entries.set(scopeKey, [...byEventId.values()].toSorted(compareBlockers));
}

function collectRouteScopedAuthBlockerEntries(
  state: Pick<RouteHealthState, "activeAuthBlockers" | "events">,
  params: {
    provider?: ChildRouteProviderContext;
    childSessionKey?: string;
    runId?: string;
    includeProviderDefaultCredentialBlockers?: boolean;
  },
): Array<[string, ActiveBlockerSummary[]]> {
  const entries = new Map(collectAuthBlockerEntries(state, params.provider));
  const query = resolveAuthScopeQuery(params.provider);
  const childSessionKey = normalizeOptionalString(params.childSessionKey);
  const includeProviderDefaultCredentialBlockers =
    params.includeProviderDefaultCredentialBlockers === true;
  if (
    !query ||
    query.exactScopeKey !== `${query.providerId}:bucket:unknown/default` ||
    (!childSessionKey && !includeProviderDefaultCredentialBlockers)
  ) {
    return [...entries.entries()].toSorted(([left], [right]) => left.localeCompare(right));
  }
  const eventById = new Map(state.events.map((event) => [event.eventId, event]));
  for (const [scopeKey, blockers] of Object.entries(state.activeAuthBlockers)) {
    if (!scopeKey.startsWith(query.providerPrefix)) {
      continue;
    }
    if (
      includeProviderDefaultCredentialBlockers &&
      scopeKey.startsWith(`${query.providerId}:profile:`)
    ) {
      continue;
    }
    const matchingBlockers = blockers.filter((blocker) => {
      const event = eventById.get(blocker.eventId);
      if (
        !event ||
        event.code !== "auth_profile_session_expired" ||
        event.status !== "active" ||
        normalizeOptionalString(event.provider?.providerId) !== query.providerId
      ) {
        return false;
      }
      if (
        childSessionKey &&
        !includeProviderDefaultCredentialBlockers &&
        normalizeOptionalString(event.childSessionKey) !== childSessionKey
      ) {
        return false;
      }
      return true;
    });
    if (matchingBlockers.length > 0) {
      upsertAuthBlockerEntries(entries, scopeKey, matchingBlockers);
    }
  }
  return [...entries.entries()].toSorted(([left], [right]) => left.localeCompare(right));
}

function collectUnavailableAuthScopeKeys(
  state: Pick<RouteHealthState, "unavailableScopes">,
  provider?: ChildRouteProviderContext,
): string[] {
  const query = resolveAuthScopeQuery(provider);
  if (!query) {
    return [];
  }
  if (query.exactScopeKey) {
    const unavailableKey = `auth:${query.exactScopeKey}`;
    return state.unavailableScopes[unavailableKey] ? [unavailableKey] : [];
  }
  const unavailablePrefix = `auth:${query.providerPrefix}`;
  return Object.keys(state.unavailableScopes)
    .filter((scopeKey) => scopeKey.startsWith(unavailablePrefix))
    .toSorted();
}

function compareBlockers(left: ActiveBlockerSummary, right: ActiveBlockerSummary): number {
  return (
    left.code.localeCompare(right.code) ||
    left.eventId.localeCompare(right.eventId) ||
    (left.runId ?? "").localeCompare(right.runId ?? "") ||
    (left.toolKind ?? "").localeCompare(right.toolKind ?? "") ||
    (left.filePath ?? "").localeCompare(right.filePath ?? "") ||
    left.observedAt - right.observedAt
  );
}

function isEditFailureBlockerScopeMatch(
  blocker: ActiveBlockerSummary,
  scope?: {
    runId?: string;
    filePath?: string;
    toolKind?: "edit" | "apply_patch";
  },
): boolean {
  if (blocker.code !== "edit_failure_threshold") {
    return true;
  }
  if (!scope) {
    return true;
  }
  const scopeRunId = normalizeOptionalString(scope.runId);
  const blockerRunId = normalizeOptionalString(blocker.runId);
  if (scopeRunId && blockerRunId && blockerRunId !== scopeRunId) {
    return false;
  }
  const scopeToolKind = normalizeOptionalString(scope.toolKind) as
    | "edit"
    | "apply_patch"
    | undefined;
  if (scopeToolKind && blocker.toolKind && blocker.toolKind !== scopeToolKind) {
    return false;
  }
  const scopeFilePath = normalizeOptionalString(scope.filePath);
  const blockerFilePath = normalizeOptionalString(blocker.filePath);
  if (scopeFilePath && blockerFilePath && blockerFilePath !== scopeFilePath) {
    return false;
  }
  return true;
}

function makeBlocker(event: RouteHealthEvent): ActiveBlockerSummary {
  const blocker: ActiveBlockerSummary = {
    code: event.code,
    eventId: event.eventId,
    observedAt: event.observedAt,
    source: event.source,
  };
  if (event.expiresAt !== undefined) {
    blocker.expiresAt = event.expiresAt;
  }
  if (event.runId) {
    blocker.runId = event.runId;
  }
  if (event.filePath) {
    blocker.filePath = event.filePath;
  }
  if (event.toolKind) {
    blocker.toolKind = event.toolKind;
  }
  return blocker;
}

function upsertBlocker(
  map: Record<string, ActiveBlockerSummary[]>,
  key: string,
  blocker: ActiveBlockerSummary,
): void {
  const next = (map[key] ?? []).filter((item) => !blockerOccupiesSameSlot(item, blocker));
  next.push(blocker);
  map[key] = next.toSorted(compareBlockers);
}

function blockerOccupiesSameSlot(left: ActiveBlockerSummary, right: ActiveBlockerSummary): boolean {
  if (left.code !== right.code) {
    return false;
  }
  if (left.code !== "edit_failure_threshold") {
    return true;
  }
  return (
    normalizeOptionalString(left.runId) === normalizeOptionalString(right.runId) &&
    normalizeOptionalString(left.filePath) === normalizeOptionalString(right.filePath) &&
    normalizeOptionalString(left.toolKind) === normalizeOptionalString(right.toolKind)
  );
}

function blockerMatchesClearEvent(blocker: ActiveBlockerSummary, event: RouteHealthEvent): boolean {
  if (blocker.code !== event.code) {
    return false;
  }
  if (blocker.code !== "edit_failure_threshold") {
    return true;
  }
  const eventRunId = normalizeOptionalString(event.runId);
  const eventFilePath = normalizeOptionalString(event.filePath);
  const eventToolKind = normalizeOptionalString(event.toolKind);
  if (eventRunId && normalizeOptionalString(blocker.runId) !== eventRunId) {
    return false;
  }
  if (eventFilePath && normalizeOptionalString(blocker.filePath) !== eventFilePath) {
    return false;
  }
  if (eventToolKind && normalizeOptionalString(blocker.toolKind) !== eventToolKind) {
    return false;
  }
  return true;
}

function clearBlocker(
  map: Record<string, ActiveBlockerSummary[]>,
  key: string,
  code: ChildRouteHealthCode,
): void {
  const next = (map[key] ?? []).filter((item) => item.code !== code);
  if (next.length === 0) {
    delete map[key];
    return;
  }
  map[key] = next.toSorted(compareBlockers);
}

function clearBlockersForEvent(
  map: Record<string, ActiveBlockerSummary[]>,
  key: string,
  event: RouteHealthEvent,
): void {
  const next = (map[key] ?? []).filter((item) => !blockerMatchesClearEvent(item, event));
  if (next.length === 0) {
    delete map[key];
    return;
  }
  map[key] = next.toSorted(compareBlockers);
}

function clearEditFailureSignalsForEvent(state: RouteHealthState, event: RouteHealthEvent): void {
  const childSessionKey = normalizeOptionalString(event.childSessionKey);
  if (event.code !== "edit_failure_threshold" || !childSessionKey) {
    return;
  }
  const runId = normalizeOptionalString(event.runId);
  const filePath = normalizeOptionalString(event.filePath);
  const toolKind = normalizeOptionalString(event.toolKind);
  for (const [key, signal] of Object.entries(state.editFailures)) {
    if (
      signal.childSessionKey === childSessionKey &&
      (!runId || normalizeOptionalString(signal.runId) === runId) &&
      (!filePath || normalizeOptionalString(signal.filePath) === filePath) &&
      (!toolKind || normalizeOptionalString(signal.toolKind) === toolKind)
    ) {
      delete state.editFailures[key];
    }
  }
}

function defaultExpiryForCode(code: ChildRouteHealthCode, observedAt: number): number | undefined {
  if (
    code === "auth_profile_session_expired" ||
    code === "child_conversation_expired" ||
    code === "context_overflow"
  ) {
    return undefined;
  }
  return observedAt + TRANSIENT_EVENT_WINDOW_MS;
}

function normalizeEventInput(input: ChildRouteHealthEventInput): RouteHealthEvent {
  const observedAt = input.observedAt ?? Date.now();
  const event: RouteHealthEvent = {
    version: STORE_VERSION,
    eventId:
      input.eventId ??
      stableRouteId("rhe", {
        code: input.code,
        status: input.status,
        observedAt,
        childSessionKey: input.childSessionKey,
        runId: input.runId,
        authScope: resolveAuthScopeKey(input.provider),
        source: input.source,
        filePath: input.filePath,
        toolKind: input.toolKind,
      }),
    code: input.code,
    status: input.status,
    observedAt,
    source: input.source,
  };
  const expiresAt = input.expiresAt ?? defaultExpiryForCode(input.code, observedAt);
  if (expiresAt !== undefined) {
    event.expiresAt = expiresAt;
  }
  if (input.childSessionKey) {
    event.childSessionKey = input.childSessionKey;
  }
  if (input.runId) {
    event.runId = input.runId;
  }
  if (input.requesterSessionKey) {
    event.requesterSessionKey = input.requesterSessionKey;
  }
  if (input.provider) {
    event.provider = input.provider;
  }
  if (input.filePath) {
    event.filePath = input.filePath;
  }
  if (input.toolKind) {
    event.toolKind = input.toolKind;
  }
  if (input.reason) {
    event.reason = input.reason;
  }
  return event;
}

function editFailureCounterKey(params: {
  childSessionKey: string;
  runId?: string;
  filePath?: string;
  toolKind: "edit" | "apply_patch";
}): string {
  return stableRouteId("edit_failure", {
    childSessionKey: params.childSessionKey,
    runId: normalizeOptionalString(params.runId) ?? "unknown-run",
    filePath: normalizeOptionalString(params.filePath) ?? "unknown-file",
    toolKind: params.toolKind,
  });
}

function matchesEditFailureScope(
  signal: ChildRouteEditFailureSignal,
  scope: {
    childSessionKey: string;
    runId?: string;
    filePath?: string;
    toolKind: "edit" | "apply_patch";
  },
): boolean {
  return (
    signal.childSessionKey === scope.childSessionKey &&
    signal.toolKind === scope.toolKind &&
    normalizeOptionalString(signal.runId) === normalizeOptionalString(scope.runId) &&
    normalizeOptionalString(signal.filePath) === normalizeOptionalString(scope.filePath)
  );
}

function applyEvent(state: RouteHealthState, event: RouteHealthEvent): void {
  if (!state.events.some((existing) => existing.eventId === event.eventId)) {
    state.events.push(event);
  }
  const childKey = normalizeOptionalString(event.childSessionKey);
  const authScopeKey = resolveAuthScopeKey(event.provider);
  if (event.status === "success") {
    if (childKey) {
      state.successMarkers[childKey] = {
        eventId: event.eventId,
        observedAt: event.observedAt,
        ...(event.runId ? { runId: event.runId } : {}),
      };
      for (const code of CHILD_LOCAL_BLOCKERS) {
        clearBlocker(state.activeChildBlockers, childKey, code);
      }
    }
    return;
  }
  if (event.status === "cleared") {
    if (event.code === "auth_profile_session_expired" && authScopeKey) {
      clearBlocker(state.activeAuthBlockers, authScopeKey, event.code);
    }
    if (childKey && CHILD_LOCAL_BLOCKERS.has(event.code)) {
      clearBlockersForEvent(state.activeChildBlockers, childKey, event);
      clearEditFailureSignalsForEvent(state, event);
    }
    return;
  }
  if (event.code === "auth_profile_session_expired" && authScopeKey) {
    upsertBlocker(state.activeAuthBlockers, authScopeKey, makeBlocker(event));
    return;
  }
  if (childKey && CHILD_LOCAL_BLOCKERS.has(event.code)) {
    upsertBlocker(state.activeChildBlockers, childKey, makeBlocker(event));
  }
}

function unavailableScopesForEvent(
  event: Pick<RouteHealthEvent, "childSessionKey" | "provider">,
): string[] {
  const scopes: string[] = [];
  const childKey = normalizeOptionalString(event.childSessionKey);
  if (childKey) {
    scopes.push(`child:${childKey}`);
  }
  const authScope = resolveAuthScopeKey(event.provider);
  if (authScope) {
    scopes.push(`auth:${authScope}`);
  }
  if (scopes.length === 0) {
    scopes.push("global");
  }
  return scopes;
}

function clearUnavailableScopes(
  state: Pick<RouteHealthState, "unavailableScopes">,
  scopes: string[],
): void {
  for (const scope of scopes) {
    delete state.unavailableScopes[scope];
  }
}

function clearInMemoryUnavailableScopes(scopes: string[]): void {
  for (const scope of scopes) {
    unavailableScopes.delete(scope);
  }
}

function applyRetention(state: RouteHealthState, now: number): RouteHealthState {
  for (const [key, blockers] of Object.entries(state.activeChildBlockers)) {
    const active = blockers.filter((blocker) => !blocker.expiresAt || blocker.expiresAt > now);
    if (active.length === 0) {
      delete state.activeChildBlockers[key];
    } else {
      state.activeChildBlockers[key] = active.toSorted(compareBlockers);
    }
  }
  for (const [key, blockers] of Object.entries(state.activeAuthBlockers)) {
    const active = blockers.filter((blocker) => !blocker.expiresAt || blocker.expiresAt > now);
    if (active.length === 0) {
      delete state.activeAuthBlockers[key];
    } else {
      state.activeAuthBlockers[key] = active.toSorted(compareBlockers);
    }
  }
  for (const [key, pending] of Object.entries(state.pendingSpawns)) {
    if (pending.consumedAt || pending.expiresAt <= now) {
      delete state.pendingSpawns[key];
    }
  }
  for (const [key, signal] of Object.entries(state.editFailures)) {
    if (signal.expiresAt <= now) {
      delete state.editFailures[key];
    }
  }
  for (const [key, snapshot] of Object.entries(state.contextHeadroomSnapshots.byChildSessionKey)) {
    if (now - snapshot.observedAt > EVENT_RETENTION_MS) {
      delete state.contextHeadroomSnapshots.byChildSessionKey[key];
    }
  }
  for (const [key, snapshot] of Object.entries(state.contextHeadroomSnapshots.byRunId)) {
    if (now - snapshot.observedAt > EVENT_RETENTION_MS) {
      delete state.contextHeadroomSnapshots.byRunId[key];
    }
  }
  const activeEventIds = new Set<string>();
  for (const blockers of Object.values(state.activeChildBlockers)) {
    blockers.forEach((blocker) => activeEventIds.add(blocker.eventId));
  }
  for (const blockers of Object.values(state.activeAuthBlockers)) {
    blockers.forEach((blocker) => activeEventIds.add(blocker.eventId));
  }
  const childCounts = new Map<string, number>();
  const retained: RouteHealthEvent[] = [];
  const sorted = state.events
    .filter(
      (event) => activeEventIds.has(event.eventId) || now - event.observedAt <= EVENT_RETENTION_MS,
    )
    .toSorted((left, right) => {
      const activeDelta =
        Number(activeEventIds.has(right.eventId)) - Number(activeEventIds.has(left.eventId));
      return (
        activeDelta ||
        right.observedAt - left.observedAt ||
        right.eventId.localeCompare(left.eventId)
      );
    });
  for (const event of sorted) {
    const childKey = event.childSessionKey;
    if (childKey) {
      const count = childCounts.get(childKey) ?? 0;
      if (count >= MAX_EVENTS_PER_CHILD && !activeEventIds.has(event.eventId)) {
        continue;
      }
      childCounts.set(childKey, count + 1);
    }
    if (retained.length >= MAX_EVENTS_TOTAL && !activeEventIds.has(event.eventId)) {
      continue;
    }
    retained.push(event);
  }
  state.events = retained.toSorted(
    (left, right) =>
      left.observedAt - right.observedAt || left.eventId.localeCompare(right.eventId),
  );
  return state;
}

async function mutateStore<T>(
  apply: (state: RouteHealthState) => T,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const pathname = resolveChildRouteHealthPath();
  let lock: { release: () => Promise<void> } | undefined;
  try {
    lock = await acquireSessionWriteLock({
      sessionFile: pathname,
      timeoutMs: 10_000,
      staleMs: 30 * 60_000,
      allowReentrant: true,
    });
    const state = applyRetention(await readStateFromPath(pathname), Date.now());
    const value = apply(state);
    await writeStateToPath(pathname, applyRetention(state, Date.now()));
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await lock?.release().catch(() => undefined);
  }
}

async function markUnavailable(
  scope: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const unavailable = { reason, observedAt: Date.now() };
  unavailableScopes.set(scope, unavailable);
  try {
    await mutateUnavailableScopes((scopes) => {
      scopes[scope] = unavailable;
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function clearPersistedUnavailableScopes(
  scopes: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (scopes.length === 0) {
    return { ok: true };
  }
  try {
    await mutateUnavailableScopes((stored) => {
      for (const scope of scopes) {
        delete stored[scope];
      }
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function recordChildRouteHealthEvent(
  input: ChildRouteHealthEventInput,
): Promise<{ ok: true; eventId: string } | { ok: false; error: string }> {
  const result = await recordChildRouteHealthEvents([input]);
  return result.ok ? { ok: true, eventId: result.eventIds[0] ?? "" } : result;
}

export async function recordChildRouteHealthEvents(
  inputs: ChildRouteHealthEventInput[],
  options?: { failClosedOnError?: boolean },
): Promise<{ ok: true; eventIds: string[] } | { ok: false; error: string }> {
  if (inputs.length === 0) {
    return { ok: true, eventIds: [] };
  }
  const fallbackEvents: RouteHealthEvent[] = [];
  const clearedScopes = new Set<string>();
  const result = await mutateStore((state) => {
    const eventIds: string[] = [];
    for (const input of inputs) {
      const event = normalizeEventInput(input);
      fallbackEvents.push(event);
      const eventScopes = unavailableScopesForEvent(event);
      if (event.status === "success" || event.status === "cleared") {
        for (const scope of eventScopes) {
          clearedScopes.add(scope);
        }
        clearUnavailableScopes(state, eventScopes);
      }
      applyEvent(state, event);
      eventIds.push(event.eventId);
    }
    return eventIds;
  });
  if (result.ok) {
    const cleared = await clearPersistedUnavailableScopes([...clearedScopes]);
    if (!cleared.ok) {
      return {
        ok: false,
        error: `failed to clear route-health unavailable tombstone: ${cleared.error}`,
      };
    }
    clearInMemoryUnavailableScopes([...clearedScopes]);
    return { ok: true, eventIds: result.value };
  }
  const events = fallbackEvents.length > 0 ? fallbackEvents : inputs.map(normalizeEventInput);
  const tombstoneErrors = new Set<string>();
  for (const event of events) {
    if (event.status === "active" || options?.failClosedOnError === true) {
      for (const scope of unavailableScopesForEvent(event)) {
        const marked = await markUnavailable(scope, result.error);
        if (!marked.ok) {
          tombstoneErrors.add(marked.error);
        }
      }
    }
  }
  if (tombstoneErrors.size > 0) {
    return {
      ok: false,
      error: `${result.error}; failed to persist fail-closed route-health tombstone: ${[
        ...tombstoneErrors,
      ].join("; ")}`,
    };
  }
  return result;
}

export async function registerChildRoutePendingSpawn(record: {
  childSessionKey: string;
  requesterSessionKey: string;
  childTargetKind: ChildTargetKind;
  idempotencyKey: string;
  runId?: string;
  targetAgentId?: string;
}): Promise<{ ok: true; pendingSpawnId: string } | { ok: false; error: string }> {
  const now = Date.now();
  const pendingSpawnId = stableRouteId("pending_spawn", {
    childSessionKey: record.childSessionKey,
    requesterSessionKey: record.requesterSessionKey,
    idempotencyKey: record.idempotencyKey,
  });
  const result = await mutateStore((state) => {
    state.pendingSpawns[pendingSpawnId] = {
      pendingSpawnId,
      childSessionKey: record.childSessionKey,
      requesterSessionKey: record.requesterSessionKey,
      childTargetKind: record.childTargetKind,
      idempotencyKey: record.idempotencyKey,
      createdAt: now,
      expiresAt: now + 5 * 60_000,
      ...(record.runId ? { runId: record.runId } : {}),
      ...(record.targetAgentId ? { targetAgentId: record.targetAgentId } : {}),
    };
    return pendingSpawnId;
  });
  return result.ok ? { ok: true, pendingSpawnId: result.value } : result;
}

function findPendingSpawn(
  state: RouteHealthState,
  match: {
    childSessionKey: string;
    requesterSessionKey?: string;
    idempotencyKey?: string;
    pendingSpawnId?: string;
  },
): ChildRoutePendingSpawnRecord | undefined {
  const candidates = match.pendingSpawnId
    ? [state.pendingSpawns[match.pendingSpawnId]].filter(
        (record): record is ChildRoutePendingSpawnRecord => Boolean(record),
      )
    : Object.values(state.pendingSpawns);
  return candidates.find((record) => {
    if (record.childSessionKey !== match.childSessionKey) {
      return false;
    }
    if (match.requesterSessionKey && record.requesterSessionKey !== match.requesterSessionKey) {
      return false;
    }
    if (match.idempotencyKey && record.idempotencyKey !== match.idempotencyKey) {
      return false;
    }
    return true;
  });
}

export async function consumeChildRoutePendingSpawn(match: {
  childSessionKey: string;
  requesterSessionKey?: string;
  idempotencyKey?: string;
  pendingSpawnId?: string;
}): Promise<{ ok: true; consumed: boolean } | { ok: false; error: string }> {
  const result = await mutateStore((state) => {
    const pending = findPendingSpawn(state, match);
    if (!pending) {
      return false;
    }
    pending.consumedAt = Date.now();
    return true;
  });
  return result.ok ? { ok: true, consumed: result.value } : result;
}

export async function markChildRoutePendingSpawnFailed(match: {
  childSessionKey: string;
  requesterSessionKey?: string;
  idempotencyKey?: string;
  pendingSpawnId?: string;
}): Promise<{ ok: true; marked: boolean } | { ok: false; error: string }> {
  const result = await mutateStore((state) => {
    const pending = findPendingSpawn(state, match);
    if (!pending) {
      return false;
    }
    pending.failedAt = Date.now();
    pending.cleanupAttemptedAt = pending.failedAt;
    return true;
  });
  if (!result.ok) {
    await markUnavailable(`child:${match.childSessionKey}`, result.error);
    return result;
  }
  return { ok: true, marked: result.value };
}

export async function recordChildRouteContextHeadroomSnapshot(input: {
  childSessionKey: string;
  runId?: string;
  estimatedPromptTokens?: number;
  modelContextLimitTokens?: number;
  headroomTokens?: number;
  headroomPercent?: number;
  estimateSource: ChildRouteHeadroomEstimateSource;
  lastCompactionStatus: ChildRouteCompactionStatus;
  observedAt?: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const snapshot = normalizeHeadroomSnapshot({
    ...input,
    observedAt: input.observedAt ?? Date.now(),
  });
  if (!snapshot) {
    return { ok: false, error: "invalid context-headroom snapshot" };
  }
  const result = await mutateStore((state) => {
    state.contextHeadroomSnapshots.byChildSessionKey[snapshot.childSessionKey] = snapshot;
    if (snapshot.runId) {
      state.contextHeadroomSnapshots.byRunId[snapshot.runId] = snapshot;
    }
  });
  return result.ok ? { ok: true } : result;
}

export async function recordChildRouteEditFailure(input: {
  childSessionKey: string;
  runId?: string;
  filePath?: string;
  toolKind?: "edit" | "apply_patch";
  failureKind?: ChildRouteEditFailureSignal["failureKind"];
  threshold?: number;
  windowMs?: number;
  observedAt?: number;
}): Promise<
  | { ok: true; counted: false; reason: "not_child_target" | "invalid_context" }
  | { ok: true; counted: true; count: number; thresholdCrossed: boolean; eventId?: string }
  | { ok: false; error: string }
> {
  const childSessionKey = normalizeOptionalString(input.childSessionKey);
  if (!childSessionKey) {
    return { ok: true, counted: false, reason: "invalid_context" };
  }
  if (!resolveChildTargetKind(childSessionKey)) {
    return { ok: true, counted: false, reason: "not_child_target" };
  }
  const now = input.observedAt ?? Date.now();
  const threshold = Math.max(1, Math.floor(input.threshold ?? EDIT_FAILURE_THRESHOLD));
  const windowMs = Math.max(1_000, Math.floor(input.windowMs ?? EDIT_FAILURE_WINDOW_MS));
  const toolKind = input.toolKind ?? "edit";
  const failureKind = input.failureKind ?? "mechanical_edit_failure";
  const key = editFailureCounterKey({
    childSessionKey,
    runId: input.runId,
    filePath: input.filePath,
    toolKind,
  });
  let count = 0;
  let eventId: string | undefined;
  const result = await mutateStore((state) => {
    let existing: ChildRouteEditFailureSignal | undefined;
    for (const [existingKey, signal] of Object.entries(state.editFailures)) {
      if (
        !matchesEditFailureScope(signal, {
          childSessionKey,
          runId: input.runId,
          filePath: input.filePath,
          toolKind,
        })
      ) {
        continue;
      }
      if (!existing || signal.lastFailureAt > existing.lastFailureAt) {
        existing = signal;
      }
      if (existingKey !== key) {
        delete state.editFailures[existingKey];
      }
    }
    const reusable = existing && existing.expiresAt > now ? existing : undefined;
    const next: ChildRouteEditFailureSignal = {
      childSessionKey,
      ...(normalizeOptionalString(input.runId)
        ? { runId: normalizeOptionalString(input.runId) }
        : {}),
      ...(normalizeOptionalString(input.filePath)
        ? { filePath: normalizeOptionalString(input.filePath) }
        : {}),
      toolKind,
      failureKind,
      count: reusable ? reusable.count + 1 : 1,
      firstFailureAt: reusable ? reusable.firstFailureAt : now,
      lastFailureAt: now,
      expiresAt: now + windowMs,
    };
    state.editFailures[key] = next;
    count = next.count;
    if (next.count >= threshold) {
      eventId = stableRouteId("rhe_edit_failure_threshold", {
        childSessionKey,
        runId: next.runId ?? "unknown-run",
        filePath: next.filePath ?? "unknown-file",
        toolKind,
        firstFailureAt: next.firstFailureAt,
      });
      applyEvent(
        state,
        normalizeEventInput({
          eventId,
          code: "edit_failure_threshold",
          status: "active",
          source: "edit_tool",
          childSessionKey,
          runId: next.runId,
          filePath: next.filePath,
          toolKind,
          observedAt: now,
          expiresAt: next.expiresAt,
          reason:
            "Repeated mechanical edit failures crossed the threshold; inspect surrounding context and use unique edit anchors.",
        }),
      );
    }
  });
  if (!result.ok) {
    await markUnavailable(`child:${childSessionKey}`, result.error);
    return result;
  }
  return {
    ok: true,
    counted: true,
    count,
    thresholdCrossed: count >= threshold,
    ...(eventId ? { eventId } : {}),
  };
}

export async function recordChildRouteEditSuccess(input: {
  childSessionKey: string;
  runId?: string;
  filePath?: string;
  toolKind?: "edit" | "apply_patch";
  observedAt?: number;
}): Promise<{ ok: true; cleared: boolean } | { ok: false; error: string }> {
  const childSessionKey = normalizeOptionalString(input.childSessionKey);
  if (!childSessionKey || !resolveChildTargetKind(childSessionKey)) {
    return { ok: true, cleared: false };
  }
  const now = input.observedAt ?? Date.now();
  const toolKind = input.toolKind ?? "edit";
  const targetRunId = normalizeOptionalString(input.runId);
  const targetFilePath = normalizeOptionalString(input.filePath);
  let cleared = false;
  const result = await mutateStore((state) => {
    for (const [key, signal] of Object.entries(state.editFailures)) {
      if (
        signal.childSessionKey === childSessionKey &&
        signal.toolKind === toolKind &&
        (!targetRunId || normalizeOptionalString(signal.runId) === targetRunId) &&
        (!targetFilePath || normalizeOptionalString(signal.filePath) === targetFilePath)
      ) {
        delete state.editFailures[key];
        cleared = true;
      }
    }
    if (cleared) {
      applyEvent(
        state,
        normalizeEventInput({
          code: "edit_failure_threshold",
          status: "cleared",
          source: "edit_tool",
          childSessionKey,
          runId: normalizeOptionalString(input.runId),
          filePath: normalizeOptionalString(input.filePath),
          toolKind,
          observedAt: now,
          reason: "Successful edit cleared repeated edit failure state.",
        }),
      );
    }
  });
  return result.ok ? { ok: true, cleared } : result;
}

export async function readLatestChildRouteContextHeadroomSnapshot(match: {
  childSessionKey?: string;
  runId?: string;
}): Promise<
  | { ok: true; snapshot?: ChildRouteContextHeadroomSnapshot }
  | { ok: false; errorKind: ChildRouteHealthUnavailableKind; retryable: boolean }
> {
  const read = await readRouteHealth();
  if (!read.ok) {
    return read;
  }
  const byRunId = normalizeOptionalString(match.runId)
    ? read.state.contextHeadroomSnapshots.byRunId[normalizeOptionalString(match.runId) as string]
    : undefined;
  if (byRunId) {
    return { ok: true, snapshot: byRunId };
  }
  const childSessionKey = normalizeOptionalString(match.childSessionKey);
  return {
    ok: true,
    snapshot: childSessionKey
      ? read.state.contextHeadroomSnapshots.byChildSessionKey[childSessionKey]
      : undefined,
  };
}

export type ChildRouteActiveAuthBlockerSummary = {
  authScopeKey: string;
  codes: ChildRouteHealthCode[];
  eventIds: string[];
  observedAt: number;
};

export async function readActiveChildRouteAuthBlockers(
  provider?: ChildRouteProviderContext,
): Promise<
  | { ok: true; blockers: ChildRouteActiveAuthBlockerSummary[] }
  | { ok: false; errorKind: ChildRouteHealthUnavailableKind; retryable: boolean }
> {
  const read = await readRouteHealth();
  if (!read.ok) {
    return read;
  }
  if (read.state.unavailableScopes.global) {
    return { ok: false, errorKind: "child_route_health_unavailable", retryable: true };
  }
  const unavailableAuthScopes = collectUnavailableAuthScopeKeys(read.state, provider);
  if (unavailableAuthScopes.length > 0) {
    return { ok: false, errorKind: "child_route_health_unavailable", retryable: true };
  }
  const authBlockerEntries = collectAuthBlockerEntries(read.state, provider);
  if (authBlockerEntries.length === 0) {
    return { ok: true, blockers: [] };
  }
  return {
    ok: true,
    blockers: summarizeAuthBlockerEntries(authBlockerEntries),
  };
}

export async function readActiveChildRouteAuthBlockersForRoute(params: {
  provider?: ChildRouteProviderContext;
  childSessionKey?: string;
  runId?: string;
  includeProviderDefaultCredentialBlockers?: boolean;
}): Promise<
  | { ok: true; blockers: ChildRouteActiveAuthBlockerSummary[] }
  | { ok: false; errorKind: ChildRouteHealthUnavailableKind; retryable: boolean }
> {
  const read = await readRouteHealth();
  if (!read.ok) {
    return read;
  }
  if (read.state.unavailableScopes.global) {
    return { ok: false, errorKind: "child_route_health_unavailable", retryable: true };
  }
  const unavailableAuthScopes = collectUnavailableAuthScopeKeys(read.state, params.provider);
  if (unavailableAuthScopes.length > 0) {
    return { ok: false, errorKind: "child_route_health_unavailable", retryable: true };
  }
  const authBlockerEntries = collectRouteScopedAuthBlockerEntries(read.state, params);
  if (authBlockerEntries.length === 0) {
    return { ok: true, blockers: [] };
  }
  return {
    ok: true,
    blockers: summarizeAuthBlockerEntries(authBlockerEntries),
  };
}

async function readRouteHealth(): Promise<
  | { ok: true; state: RouteHealthState }
  | { ok: false; errorKind: ChildRouteHealthUnavailableKind; retryable: boolean }
> {
  try {
    const state = applyRetention(
      await readStateFromPath(resolveChildRouteHealthPath()),
      Date.now(),
    );
    const persistedUnavailable = await readUnavailableScopesFromPath();
    state.unavailableScopes = {
      ...state.unavailableScopes,
      ...persistedUnavailable,
      ...Object.fromEntries(unavailableScopes.entries()),
    };
    return {
      ok: true,
      state,
    };
  } catch {
    return { ok: false, errorKind: "child_route_health_unavailable", retryable: true };
  }
}

function hasUsablePendingSpawn(
  state: RouteHealthState,
  childSessionKey: string,
  context: ChildRouteHealthContext,
): boolean {
  const pending = findPendingSpawn(state, {
    childSessionKey,
    requesterSessionKey: context.pendingSpawn?.requesterSessionKey ?? context.requesterSessionKey,
    idempotencyKey: context.pendingSpawn?.idempotencyKey ?? context.idempotencyKey,
    pendingSpawnId: context.pendingSpawn?.pendingSpawnId,
  });
  return Boolean(
    pending && !pending.consumedAt && !pending.failedAt && pending.expiresAt > Date.now(),
  );
}

function collectBlockers(
  state: RouteHealthState,
  childSessionKey: string,
  context: ChildRouteHealthContext,
  editFailureScope?: {
    runId?: string;
    filePath?: string;
    toolKind?: "edit" | "apply_patch";
  },
): ActiveBlockerSummary[] {
  const blockers = [...(state.activeChildBlockers[childSessionKey] ?? [])].filter((blocker) =>
    isEditFailureBlockerScopeMatch(blocker, editFailureScope),
  );
  for (const [, authBlockers] of collectRouteScopedAuthBlockerEntries(state, {
    provider: context.provider,
    childSessionKey,
    runId: context.registryRecord?.runId ?? context.editFailureScope?.runId,
  })) {
    blockers.push(...authBlockers);
  }
  return blockers.toSorted(compareBlockers);
}

function hasTrustedLineageForChild(
  childSessionKey: string,
  context: ChildRouteHealthContext,
): boolean {
  const lineageKeys = [
    normalizeOptionalString(context.sessionLineage?.spawnedBy),
    normalizeOptionalString(context.sessionLineage?.parentSessionKey),
  ];
  return lineageKeys.some((key) => key === childSessionKey);
}

function recommendedActionFor(
  codes: ChildRouteHealthCode[],
  provider?: ChildRouteProviderContext,
): { action: ChildRouteRecommendedAction; stateTransitionRequired: boolean } {
  if (codes.includes("auth_profile_session_expired")) {
    if (provider?.fallbackCredentialSelected) {
      return { action: "fallback_profile", stateTransitionRequired: true };
    }
    return { action: "reauth", stateTransitionRequired: true };
  }
  if (codes.some((code) => CHILD_LOCAL_BLOCKERS.has(code))) {
    return { action: "spawn_fresh", stateTransitionRequired: false };
  }
  return { action: "stop", stateTransitionRequired: true };
}

function plannerInstruction(action: ChildRouteRecommendedAction): string {
  if (action === "spawn_fresh") {
    return "Start a fresh child with a bounded handoff packet.";
  }
  if (action === "fallback_profile") {
    return "Retry only with the selected healthy fallback credential.";
  }
  if (action === "reauth") {
    return "Re-authenticate the provider profile before retrying.";
  }
  return "Stop this child route and ask for operator repair.";
}

function plannerInstructionForCodes(
  action: ChildRouteRecommendedAction,
  codes: ChildRouteHealthCode[],
): string {
  if (action === "spawn_fresh") {
    if (codes.includes("edit_failure_threshold")) {
      return "Inspect surrounding context and use unique edit anchors.";
    }
    return plannerInstruction(action);
  }
  return plannerInstruction(action);
}

function unavailable(
  errorKind: ChildRouteHealthUnavailableKind,
  retryable: boolean,
  instruction: string,
): ChildRouteHealthAssessment {
  return { status: "unavailable", errorKind, retryable, plannerInstruction: instruction };
}

function freshRerouteSuperseded(
  childSessionKey: string,
  context: ChildRouteHealthContext,
): ChildRouteHealthAssessment | undefined {
  if (context.registryRecord?.suppressAnnounceReason !== "fresh-reroute") {
    return undefined;
  }
  const runId =
    normalizeOptionalString(context.registryRecord.runId) ??
    stableRouteId("fresh_reroute_superseded", childSessionKey);
  return {
    status: "unhealthy",
    codes: ["agent_lifecycle_abandoned"],
    recommendedAction: "stop",
    plannerInstruction:
      "This old child generation was superseded by a fresh reroute; do not send follow-up work to it.",
    stateTransitionRequired: true,
    healthEvidenceEpoch: stableRouteId("fresh_reroute_superseded", {
      childSessionKey,
      runId,
    }),
    evidenceEventIds: [runId],
  };
}

export async function assessChildRouteHealth(
  childSessionKey: string,
  context: ChildRouteHealthContext,
): Promise<ChildRouteHealthAssessment> {
  const childKey = childSessionKey.trim();
  if (!childKey) {
    return unavailable("child_route_context_missing", false, "Missing child session key.");
  }
  const childTargetKind = context.childTargetKind ?? resolveChildTargetKind(childKey);
  if (!childTargetKind && !context.registryRecord) {
    return { status: "ok", codes: [], healthEvidenceEpoch: "none" };
  }
  if (context.routeIntent === "repair_control" || context.routeIntent === "completion_receipt") {
    return { status: "ok", codes: [], healthEvidenceEpoch: "control" };
  }
  const superseded = freshRerouteSuperseded(childKey, context);
  if (superseded) {
    return superseded;
  }
  const read = await readRouteHealth();
  if (!read.ok) {
    return unavailable(read.errorKind, read.retryable, "Route health is unavailable; retry later.");
  }
  const state = read.state;
  const globalUnavailable = state.unavailableScopes.global ?? unavailableScopes.get("global");
  const childUnavailable =
    state.unavailableScopes[`child:${childKey}`] ?? unavailableScopes.get(`child:${childKey}`);
  if (globalUnavailable || childUnavailable) {
    return unavailable(
      "child_route_health_unavailable",
      true,
      "Route health has an unpersisted hard blocker; repair storage before retrying.",
    );
  }
  if (collectUnavailableAuthScopeKeys(state, context.provider).length > 0) {
    return unavailable(
      "child_route_health_unavailable",
      true,
      "Auth route health has an unpersisted hard blocker; repair storage before retrying.",
    );
  }
  if (context.routeIntent === "initial_spawn") {
    if (!hasUsablePendingSpawn(state, childKey, context)) {
      return unavailable(
        "child_route_untrusted",
        false,
        "Initial child spawn is missing a trusted pending-spawn record.",
      );
    }
  } else if (
    childTargetKind &&
    !context.registryRecord &&
    !hasTrustedLineageForChild(childKey, context)
  ) {
    return unavailable(
      "child_route_untrusted",
      false,
      "Child-shaped targets require tracked child ownership before follow-up delivery.",
    );
  }

  const editFailureScope = {
    runId: normalizeOptionalString(context.editFailureScope?.runId),
    filePath: normalizeOptionalString(context.editFailureScope?.filePath),
    toolKind: context.editFailureScope?.toolKind,
  };
  const blockers = collectBlockers(
    state,
    childKey,
    context,
    Object.values(editFailureScope).some((value) => value !== undefined)
      ? editFailureScope
      : undefined,
  );
  if (blockers.length === 0) {
    return { status: "ok", codes: [], healthEvidenceEpoch: "none" };
  }
  const codes = Array.from(new Set(blockers.map((blocker) => blocker.code))).toSorted();
  const evidenceEventIds = blockers.map((blocker) => blocker.eventId).toSorted();
  const action = recommendedActionFor(codes, context.provider);
  return {
    status: "unhealthy",
    codes,
    recommendedAction: action.action,
    plannerInstruction: plannerInstructionForCodes(action.action, codes),
    stateTransitionRequired: action.stateTransitionRequired,
    healthEvidenceEpoch: stableRouteId("health_epoch", evidenceEventIds),
    evidenceEventIds,
  };
}

function isSubstantialAssignment(kind: ChildRouteAssignmentKind): boolean {
  return kind === "implementation" || kind === "testing" || kind === "review";
}

function contextHeadroomTooLow(params: {
  snapshot: ChildRouteContextHeadroomSnapshot;
  hardHeadroomPercentThreshold?: number;
  hardHeadroomTokensThreshold?: number;
}): boolean {
  if (
    typeof params.hardHeadroomPercentThreshold === "number" &&
    Number.isFinite(params.hardHeadroomPercentThreshold) &&
    typeof params.snapshot.headroomPercent === "number"
  ) {
    return params.snapshot.headroomPercent < params.hardHeadroomPercentThreshold;
  }
  if (
    typeof params.hardHeadroomTokensThreshold === "number" &&
    Number.isFinite(params.hardHeadroomTokensThreshold) &&
    typeof params.snapshot.headroomTokens === "number"
  ) {
    return params.snapshot.headroomTokens < params.hardHeadroomTokensThreshold;
  }
  return false;
}

export async function preflightChildRouteAssignment(params: {
  childSessionKey: string;
  assignmentKind: ChildRouteAssignmentKind;
  context: ChildRouteHealthContext;
  latestLifecycleOutcome?:
    | "healthy"
    | "no_final"
    | "degraded"
    | "blocked"
    | "abandoned"
    | "error"
    | "unknown";
  requireHeadroomForSubstantialWork?: boolean;
  hardHeadroomPercentThreshold?: number;
  hardHeadroomTokensThreshold?: number;
}): Promise<ChildRouteAssignmentPreflightResult> {
  const childSessionKey = params.childSessionKey.trim();
  const assignmentKind = params.assignmentKind;
  const substantial = isSubstantialAssignment(assignmentKind);
  if (!params.context.registryRecord && substantial) {
    return {
      status: "unavailable",
      reason: "tracking",
      childSessionKey,
      assignmentKind,
      retryable: false,
      plannerInstruction:
        "Substantial child work requires a tracked child run generation; spawn a fresh tracked child instead.",
    };
  }

  const routeHealth = await assessChildRouteHealth(childSessionKey, params.context);
  if (routeHealth.status === "unavailable") {
    return {
      status: "unavailable",
      reason: "route_health",
      childSessionKey,
      assignmentKind,
      retryable: routeHealth.retryable,
      plannerInstruction: routeHealth.plannerInstruction,
    };
  }
  if (routeHealth.status === "unhealthy") {
    return {
      status: "reroute",
      reason: "route_health",
      childSessionKey,
      assignmentKind,
      recommendedAction: routeHealth.recommendedAction,
      plannerInstruction: routeHealth.plannerInstruction,
      codes: routeHealth.codes,
    };
  }

  const lifecycle = params.latestLifecycleOutcome;
  if (lifecycle && lifecycle !== "healthy" && lifecycle !== "unknown") {
    return {
      status: "reroute",
      reason: "lifecycle",
      childSessionKey,
      assignmentKind,
      recommendedAction: "spawn_fresh",
      plannerInstruction:
        "The previous child lifecycle is degraded or missing a final report; spawn a fresh tracked child before assigning substantial work.",
    };
  }

  const requiresHeadroom = substantial && params.requireHeadroomForSubstantialWork !== false;
  let snapshot = params.context.contextHeadroom;
  if (!snapshot && requiresHeadroom) {
    const contextHeadroom = await readLatestChildRouteContextHeadroomSnapshot({
      childSessionKey,
      runId: params.context.registryRecord?.runId,
    });
    if (!contextHeadroom.ok) {
      return {
        status: "unavailable",
        reason: "context_headroom",
        childSessionKey,
        assignmentKind,
        retryable: contextHeadroom.retryable,
        plannerInstruction:
          "Context headroom telemetry is unavailable; do not assign substantial child work until telemetry is available.",
      };
    }
    snapshot = contextHeadroom.snapshot;
  }
  if (requiresHeadroom && !snapshot) {
    return {
      status: "unavailable",
      reason: "context_headroom",
      childSessionKey,
      assignmentKind,
      retryable: true,
      plannerInstruction:
        "Context headroom telemetry is missing; do not assign substantial child work until the request path records a snapshot.",
    };
  }
  if (
    requiresHeadroom &&
    snapshot &&
    (snapshot.estimateSource === "unknown" ||
      (typeof snapshot.headroomPercent !== "number" && typeof snapshot.headroomTokens !== "number"))
  ) {
    return {
      status: "unavailable",
      reason: "context_headroom",
      childSessionKey,
      assignmentKind,
      retryable: true,
      plannerInstruction:
        "Context headroom telemetry is not decisive; do not assign substantial child work until prompt headroom is known.",
    };
  }
  if (substantial && snapshot?.lastCompactionStatus === "failed") {
    return {
      status: "reroute",
      reason: "compaction",
      childSessionKey,
      assignmentKind,
      recommendedAction: "spawn_fresh",
      plannerInstruction:
        "The previous child compaction or recovery failed; spawn a fresh tracked child before assigning substantial work.",
      contextHeadroom: snapshot,
    };
  }
  if (substantial && snapshot && contextHeadroomTooLow({ snapshot, ...params })) {
    return {
      status: "reroute",
      reason: "context_headroom",
      childSessionKey,
      assignmentKind,
      recommendedAction: "spawn_fresh",
      plannerInstruction:
        "The child context headroom is below the configured hard threshold; spawn a fresh tracked child before assigning substantial work.",
      contextHeadroom: snapshot,
    };
  }

  return {
    status: "reuse",
    childSessionKey,
    assignmentKind,
    ...(snapshot ? { contextHeadroom: snapshot } : {}),
  };
}

export type SessionExpiredClassification =
  | {
      status: "classified";
      code: "auth_profile_session_expired" | "child_conversation_expired";
      recommendedAction: ChildRouteRecommendedAction;
      stateTransitionRequired: boolean;
    }
  | {
      status: "ambiguous";
      recommendedAction: "stop";
      stateTransitionRequired: true;
    };

export function classifySessionExpiredRouteHealth(params: {
  message?: string;
  statusCode?: number;
  providerEvidence?: boolean;
  authEvidence?: boolean;
  conversationEvidence?: boolean;
  provider?: ChildRouteProviderContext;
}): SessionExpiredClassification | null {
  const text = (params.message ?? "").toLowerCase();
  const hasConversationEvidenceText =
    text.includes("conversation not found") ||
    text.includes("no conversation found") ||
    text.includes("conversation does not exist") ||
    text.includes("conversation expired") ||
    text.includes("conversation invalid") ||
    text.includes("conversation id not found") ||
    text.includes("thread not found") ||
    text.includes("thread does not exist") ||
    text.includes("thread expired") ||
    text.includes("thread invalid") ||
    text.includes("cli session not found") ||
    text.includes("cli session does not exist") ||
    text.includes("cli session expired") ||
    text.includes("cli session invalid") ||
    text.includes("session not found") ||
    text.includes("session does not exist") ||
    text.includes("session invalid") ||
    text.includes("no such session") ||
    text.includes("invalid session") ||
    text.includes("session id not found");
  const rawSessionExpired =
    text.includes("session_expired") ||
    text.includes("session expired") ||
    hasConversationEvidenceText ||
    params.statusCode === 404 ||
    params.statusCode === 410;
  if (!rawSessionExpired) {
    return null;
  }
  const authEvidence =
    params.authEvidence === true ||
    /\b(auth|oauth|credential|login|token|profile|account).{0,28}(expired|invalid|missing|revoked)\b/.test(
      text,
    ) ||
    /\b(expired|invalid|revoked).{0,28}(auth|oauth|credential|login|token|profile|account)\b/.test(
      text,
    );
  if (authEvidence) {
    return {
      status: "classified",
      code: "auth_profile_session_expired",
      recommendedAction: params.provider?.fallbackCredentialSelected
        ? "fallback_profile"
        : "reauth",
      stateTransitionRequired: true,
    };
  }
  const conversationEvidence =
    params.conversationEvidence === true ||
    hasConversationEvidenceText ||
    /\b(conversation|thread|cli session|session id|conversation id).{0,40}(not found|missing|expired|gone|invalid)\b/.test(
      text,
    );
  if (conversationEvidence) {
    return {
      status: "classified",
      code: "child_conversation_expired",
      recommendedAction: "spawn_fresh",
      stateTransitionRequired: false,
    };
  }
  return { status: "ambiguous", recommendedAction: "stop", stateTransitionRequired: true };
}

export async function recordSessionExpiredRouteHealth(params: {
  message?: string;
  statusCode?: number;
  childSessionKey?: string;
  sessionLineage?: ChildRouteSessionLineage;
  runId?: string;
  requesterSessionKey?: string;
  provider?: ChildRouteProviderContext;
  authEvidence?: boolean;
  conversationEvidence?: boolean;
}): Promise<
  | {
      recorded: true;
      classification: Extract<SessionExpiredClassification, { status: "classified" }>;
      eventId: string;
    }
  | {
      recorded: false;
      classification: SessionExpiredClassification | null;
      error?: string;
    }
> {
  const classification = classifySessionExpiredRouteHealth({
    message: params.message,
    statusCode: params.statusCode,
    provider: params.provider,
    authEvidence: params.authEvidence,
    conversationEvidence: params.conversationEvidence,
  });
  if (!classification || classification.status !== "classified") {
    return { recorded: false, classification };
  }

  const childSessionKey = normalizeOptionalString(params.childSessionKey);
  const routeTarget = childSessionKey
    ? resolveChildRouteTarget({
        sessionKey: childSessionKey,
        entry: params.sessionLineage,
      })
    : undefined;
  const routeHealthChildSessionKey = routeTarget?.healthSessionKey ?? childSessionKey;
  const runId = normalizeOptionalString(params.runId);
  const requesterSessionKey = normalizeOptionalString(params.requesterSessionKey);
  const result = await recordChildRouteHealthEvent({
    code: classification.code,
    status: "active",
    source: "provider_error",
    ...(routeHealthChildSessionKey && resolveChildTargetKind(routeHealthChildSessionKey)
      ? { childSessionKey: routeHealthChildSessionKey }
      : {}),
    ...(runId ? { runId } : {}),
    ...(requesterSessionKey ? { requesterSessionKey } : {}),
    ...(params.provider ? { provider: params.provider } : {}),
    reason: params.message,
  });
  if (!result.ok) {
    return { recorded: false, classification, error: result.error };
  }
  return { recorded: true, classification, eventId: result.eventId };
}

export function resetChildRouteHealthForTest(): void {
  unavailableScopes.clear();
}
