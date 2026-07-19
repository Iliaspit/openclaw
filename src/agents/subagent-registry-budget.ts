import crypto from "node:crypto";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type {
  SubagentRunRecord,
  SubagentSliceBoundary,
  SubagentSliceBudgetRecord,
  SubagentSliceContinuation,
  SubagentSliceBudgetTerminalEvidenceGapKind,
  SubagentSliceFullE2EGateGreen,
  SubagentSliceRole,
} from "./subagent-registry.types.js";

export const SUBAGENT_SLICE_TIMEOUT_LIMIT = 2;
export const SUBAGENT_SLICE_ROUTE_HEALTH_UNAVAILABLE_LIMIT = 2;

const MAX_TRACKED_CHILD_IDS = 8;
const SLICE_KEY_HASH_CHARS = 32;
const POST_FULL_GATE_FOLLOWUP_ROLES = new Set<SubagentSliceRole>(["review", "qa"]);

type SubagentSliceIdentity = {
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
  discriminatorKind: "label" | "task_sha256";
  discriminatorValue: string;
};

export type SubagentSliceIdentityInput = {
  requesterSessionKey: string;
  requesterGeneration?: string;
  delegationAssignmentId?: string;
  delegationSliceId?: string;
  delegationEpoch?: number;
  childSessionKey?: string;
  targetAgentId?: string;
  label?: string;
  sliceRole?: SubagentSliceRole;
  sliceContinuation?: SubagentSliceContinuation;
  task: string;
};

export type SubagentSliceBudgetBlockKind = "timeout_limit" | "route_health_unavailable_limit";

export type SubagentSliceBudgetAssessment =
  | {
      ok: true;
      sliceKey: string;
      budget?: SubagentSliceBudgetRecord;
    }
  | {
      ok: false;
      kind: SubagentSliceBudgetBlockKind;
      sliceKey: string;
      budget: SubagentSliceBudgetRecord;
      error: string;
    };

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeScalar(value?: string): string | undefined {
  const normalized = normalizeOptionalString(value)?.replace(/\s+/g, " ");
  return normalized || undefined;
}

function normalizeTaskForHash(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function resolveProtectedDelegationScope(input: SubagentSliceIdentityInput):
  | {
      delegationAssignmentId: string;
      delegationSliceId: string;
      delegationEpoch: number;
    }
  | undefined {
  const delegationAssignmentId = normalizeScalar(input.delegationAssignmentId);
  const delegationSliceId = normalizeScalar(input.delegationSliceId);
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
      "Protected subagent slice budget identity requires exact assignment, slice, and epoch.",
    );
  }
  return {
    delegationAssignmentId,
    delegationSliceId,
    delegationEpoch,
  };
}

function resolveRunProtectedDelegationScope(entry: SubagentRunRecord):
  | {
      delegationAssignmentId: string;
      delegationSliceId: string;
      delegationEpoch: number;
    }
  | undefined {
  if (
    !entry.delegationAssignmentId ||
    !entry.delegationSliceId ||
    entry.delegationEpoch === undefined
  ) {
    // Runs restored from the pre-scope registry schema may contain only the
    // assignment id. Keep their terminal history in the legacy audit bucket;
    // new registrations reject partial protected scope before reaching here.
    return undefined;
  }
  return {
    delegationAssignmentId: entry.delegationAssignmentId,
    delegationSliceId: entry.delegationSliceId,
    delegationEpoch: entry.delegationEpoch,
  };
}

function resolveTargetAgentId(params: {
  childSessionKey?: string;
  targetAgentId?: string;
}): string | undefined {
  const explicit = normalizeScalar(params.targetAgentId)?.toLowerCase();
  if (explicit) {
    return explicit;
  }
  const parsed = parseAgentSessionKey(params.childSessionKey);
  return normalizeScalar(parsed?.agentId)?.toLowerCase();
}

export function resolveSubagentSliceIdentity(
  input: SubagentSliceIdentityInput,
): SubagentSliceIdentity {
  const requesterSessionKey = normalizeScalar(input.requesterSessionKey) ?? "unknown";
  const requesterGeneration = normalizeScalar(input.requesterGeneration);
  const protectedScope = resolveProtectedDelegationScope(input);
  const targetAgentId = resolveTargetAgentId(input);
  const label = normalizeScalar(input.label);
  const taskSha256 = sha256Hex(normalizeTaskForHash(input.task));
  const labelIsOnlyTargetRole =
    Boolean(label && targetAgentId) && label?.toLowerCase() === targetAgentId;
  const discriminatorKind: SubagentSliceIdentity["discriminatorKind"] =
    label && !labelIsOnlyTargetRole ? "label" : "task_sha256";
  const discriminatorValue = discriminatorKind === "label" && label ? label : taskSha256;
  const keyPayload = protectedScope
    ? [
        "v2-protected",
        requesterSessionKey,
        requesterGeneration ?? "",
        targetAgentId ?? "",
        protectedScope.delegationAssignmentId,
        protectedScope.delegationSliceId,
        String(protectedScope.delegationEpoch),
        discriminatorKind,
        discriminatorValue,
      ].join("\0")
    : [
        "v1",
        requesterSessionKey,
        requesterGeneration ?? "",
        targetAgentId ?? "",
        discriminatorKind,
        discriminatorValue,
      ].join("\0");
  const sliceKey = `subagent-slice:${sha256Hex(keyPayload).slice(0, SLICE_KEY_HASH_CHARS)}`;
  return {
    sliceKey,
    requesterSessionKey,
    requesterGeneration,
    ...protectedScope,
    targetAgentId,
    label,
    sliceRole: input.sliceRole,
    sliceBoundary: "original",
    taskSha256,
    discriminatorKind,
    discriminatorValue,
  };
}

function resolveBudgetAwareSliceIdentity(params: {
  budgets: Map<string, SubagentSliceBudgetRecord>;
  input: SubagentSliceIdentityInput;
}): SubagentSliceIdentity {
  const base = resolveSubagentSliceIdentity(params.input);
  if (
    params.input.sliceContinuation === "same" ||
    !params.input.sliceRole ||
    !POST_FULL_GATE_FOLLOWUP_ROLES.has(params.input.sliceRole)
  ) {
    return base;
  }
  const baseBudget = params.budgets.get(base.sliceKey);
  if (baseBudget?.fullE2EGateGreen !== true) {
    return base;
  }
  const keyPayload = base.delegationAssignmentId
    ? [
        "v2-protected",
        base.requesterSessionKey,
        base.requesterGeneration ?? "",
        base.targetAgentId ?? "",
        base.delegationAssignmentId,
        base.delegationSliceId ?? "",
        String(base.delegationEpoch ?? ""),
        base.discriminatorKind,
        base.discriminatorValue,
        "post_full_gate_followup",
        params.input.sliceRole,
      ].join("\0")
    : [
        "v1",
        base.requesterSessionKey,
        base.requesterGeneration ?? "",
        base.targetAgentId ?? "",
        base.discriminatorKind,
        base.discriminatorValue,
        "post_full_gate_followup",
        params.input.sliceRole,
      ].join("\0");
  return {
    ...base,
    sliceKey: `subagent-slice:${sha256Hex(keyPayload).slice(0, SLICE_KEY_HASH_CHARS)}`,
    sliceRole: params.input.sliceRole,
    sliceBoundary: "post_full_gate_followup",
    parentSliceKey: base.sliceKey,
  };
}

function defaultFullGateGreen(): SubagentSliceFullE2EGateGreen {
  return "unknown";
}

function createSliceBudget(
  identity: SubagentSliceIdentity,
  observedAt: number,
): SubagentSliceBudgetRecord {
  return {
    sliceKey: identity.sliceKey,
    requesterSessionKey: identity.requesterSessionKey,
    requesterGeneration: identity.requesterGeneration,
    delegationAssignmentId: identity.delegationAssignmentId,
    delegationSliceId: identity.delegationSliceId,
    delegationEpoch: identity.delegationEpoch,
    targetAgentId: identity.targetAgentId,
    label: identity.label,
    sliceRole: identity.sliceRole,
    sliceBoundary: identity.sliceBoundary,
    parentSliceKey: identity.parentSliceKey,
    taskSha256: identity.taskSha256,
    discriminatorKind: identity.discriminatorKind,
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    childSpawnCount: 0,
    childTimeoutCount: 0,
    childTimeoutRunIds: [],
    childTimeoutSessionKeys: [],
    terminalEvidenceGapCount: 0,
    terminalEvidenceGapRunIds: [],
    childRouteHealthUnavailableCount: 0,
    childRouteHealthUnavailableChildSessionKeys: [],
    fullE2EGateGreen: defaultFullGateGreen(),
    fullE2EGateSignal: "unavailable",
  };
}

function getOrCreateBudget(
  budgets: Map<string, SubagentSliceBudgetRecord>,
  identity: SubagentSliceIdentity,
  observedAt: number,
): SubagentSliceBudgetRecord {
  const existing = budgets.get(identity.sliceKey);
  if (existing) {
    existing.requesterSessionKey ||= identity.requesterSessionKey;
    existing.requesterGeneration ??= identity.requesterGeneration;
    existing.delegationAssignmentId ??= identity.delegationAssignmentId;
    existing.delegationSliceId ??= identity.delegationSliceId;
    existing.delegationEpoch ??= identity.delegationEpoch;
    existing.targetAgentId ??= identity.targetAgentId;
    existing.label ??= identity.label;
    existing.sliceRole ??= identity.sliceRole;
    existing.sliceBoundary ??= identity.sliceBoundary;
    existing.parentSliceKey ??= identity.parentSliceKey;
    existing.taskSha256 ||= identity.taskSha256;
    existing.discriminatorKind ??= identity.discriminatorKind;
    existing.fullE2EGateGreen ??= defaultFullGateGreen();
    existing.fullE2EGateSignal ??= "unavailable";
    existing.lastObservedAt = Math.max(existing.lastObservedAt ?? observedAt, observedAt);
    return existing;
  }
  const created = createSliceBudget(identity, observedAt);
  budgets.set(identity.sliceKey, created);
  return created;
}

function appendUniqueBounded(target: string[], value?: string): boolean {
  const normalized = normalizeScalar(value);
  if (!normalized || target.includes(normalized)) {
    return false;
  }
  target.push(normalized);
  if (target.length > MAX_TRACKED_CHILD_IDS) {
    target.splice(0, target.length - MAX_TRACKED_CHILD_IDS);
  }
  return true;
}

function markObserved(budget: SubagentSliceBudgetRecord, observedAt: number): boolean {
  const nextLast = Math.max(budget.lastObservedAt ?? observedAt, observedAt);
  if (budget.lastObservedAt === nextLast) {
    return false;
  }
  budget.lastObservedAt = nextLast;
  return true;
}

export function recordSubagentSliceSpawn(params: {
  budgets: Map<string, SubagentSliceBudgetRecord>;
  entry: SubagentRunRecord;
  observedAt?: number;
}): boolean {
  const observedAt = params.observedAt ?? params.entry.createdAt ?? Date.now();
  const identity = resolveBudgetAwareSliceIdentity({
    budgets: params.budgets,
    input: {
      requesterSessionKey: params.entry.requesterSessionKey,
      requesterGeneration: params.entry.requesterGeneration,
      ...resolveRunProtectedDelegationScope(params.entry),
      childSessionKey: params.entry.childSessionKey,
      label: params.entry.label,
      sliceRole: params.entry.sliceRole,
      sliceContinuation: params.entry.sliceContinuation,
      task: params.entry.task,
    },
  });
  const budget = getOrCreateBudget(params.budgets, identity, observedAt);
  params.entry.sliceBudgetKey = identity.sliceKey;
  params.entry.sliceTaskSha256 = identity.taskSha256;
  params.entry.sliceBudgetDiscriminator = identity.discriminatorKind;
  budget.childSpawnCount += 1;
  markObserved(budget, observedAt);
  return true;
}

export function recordSubagentSliceTerminalOutcome(params: {
  budgets: Map<string, SubagentSliceBudgetRecord>;
  entry: SubagentRunRecord;
  observedAt?: number;
  evidenceGapKind?: SubagentSliceBudgetTerminalEvidenceGapKind;
}): boolean {
  const observedAt = params.observedAt ?? params.entry.endedAt ?? Date.now();
  const identity = resolveBudgetAwareSliceIdentity({
    budgets: params.budgets,
    input: {
      requesterSessionKey: params.entry.requesterSessionKey,
      requesterGeneration: params.entry.requesterGeneration,
      ...resolveRunProtectedDelegationScope(params.entry),
      childSessionKey: params.entry.childSessionKey,
      label: params.entry.label,
      sliceRole: params.entry.sliceRole,
      sliceContinuation: params.entry.sliceContinuation,
      task: params.entry.task,
    },
  });
  const budget = getOrCreateBudget(params.budgets, identity, observedAt);
  let changed = markObserved(budget, observedAt);
  params.entry.sliceBudgetKey = identity.sliceKey;
  params.entry.sliceTaskSha256 = identity.taskSha256;
  params.entry.sliceBudgetDiscriminator = identity.discriminatorKind;
  const outcome = params.entry.outcome;
  const timeoutAlreadyRecorded = budget.childTimeoutRunIds.includes(params.entry.runId);
  if (outcome?.status === "timeout" && !timeoutAlreadyRecorded) {
    budget.childTimeoutCount += 1;
    changed = appendUniqueBounded(budget.childTimeoutRunIds, params.entry.runId) || changed;
    changed =
      appendUniqueBounded(budget.childTimeoutSessionKeys, params.entry.childSessionKey) || changed;
  }
  const hasEvidenceGap =
    params.evidenceGapKind || outcome?.status === "timeout" || outcome?.status === "error";
  const evidenceGapAlreadyRecorded = budget.terminalEvidenceGapRunIds.includes(params.entry.runId);
  if (hasEvidenceGap && !evidenceGapAlreadyRecorded) {
    budget.terminalEvidenceGapCount += 1;
    budget.lastTerminalEvidenceGapKind =
      params.evidenceGapKind ??
      (outcome?.status === "timeout" ? "timeout" : outcome?.status === "error" ? "error" : "error");
    changed = appendUniqueBounded(budget.terminalEvidenceGapRunIds, params.entry.runId) || changed;
  }
  return changed;
}

export function recordSubagentSliceRouteHealthUnavailable(params: {
  budgets: Map<string, SubagentSliceBudgetRecord>;
  identityInput: SubagentSliceIdentityInput;
  childSessionKey?: string;
  observedAt?: number;
}): SubagentSliceBudgetAssessment {
  const observedAt = params.observedAt ?? Date.now();
  const identity = resolveBudgetAwareSliceIdentity({
    budgets: params.budgets,
    input: params.identityInput,
  });
  const budget = getOrCreateBudget(params.budgets, identity, observedAt);
  budget.childRouteHealthUnavailableCount += 1;
  appendUniqueBounded(budget.childRouteHealthUnavailableChildSessionKeys, params.childSessionKey);
  markObserved(budget, observedAt);
  return assessSubagentSliceBudget({
    budgets: params.budgets,
    identityInput: params.identityInput,
  });
}

export function assessSubagentSliceBudget(params: {
  budgets: Map<string, SubagentSliceBudgetRecord>;
  identityInput: SubagentSliceIdentityInput;
}): SubagentSliceBudgetAssessment {
  const identity = resolveBudgetAwareSliceIdentity({
    budgets: params.budgets,
    input: params.identityInput,
  });
  const budget = params.budgets.get(identity.sliceKey);
  if (!budget) {
    return { ok: true, sliceKey: identity.sliceKey };
  }
  if (budget.childRouteHealthUnavailableCount >= SUBAGENT_SLICE_ROUTE_HEALTH_UNAVAILABLE_LIMIT) {
    return {
      ok: false,
      kind: "route_health_unavailable_limit",
      sliceKey: identity.sliceKey,
      budget,
      error: formatSubagentSliceBudgetBlocker({
        kind: "route_health_unavailable_limit",
        budget,
      }),
    };
  }
  if (budget.childTimeoutCount >= SUBAGENT_SLICE_TIMEOUT_LIMIT) {
    return {
      ok: false,
      kind: "timeout_limit",
      sliceKey: identity.sliceKey,
      budget,
      error: formatSubagentSliceBudgetBlocker({
        kind: "timeout_limit",
        budget,
      }),
    };
  }
  return { ok: true, sliceKey: identity.sliceKey, budget };
}

export function recordSubagentSliceFullE2EGateGreen(params: {
  budgets: Map<string, SubagentSliceBudgetRecord>;
  entry: SubagentRunRecord;
  observedAt?: number;
}): boolean {
  const observedAt = params.observedAt ?? params.entry.endedAt ?? Date.now();
  const identity = resolveSubagentSliceIdentity({
    requesterSessionKey: params.entry.requesterSessionKey,
    requesterGeneration: params.entry.requesterGeneration,
    ...resolveRunProtectedDelegationScope(params.entry),
    childSessionKey: params.entry.childSessionKey,
    label: params.entry.label,
    task: params.entry.task,
  });
  const budget = getOrCreateBudget(params.budgets, identity, observedAt);
  let changed = markObserved(budget, observedAt);
  if (budget.fullE2EGateGreen !== true) {
    budget.fullE2EGateGreen = true;
    changed = true;
  }
  if (budget.fullE2EGateSignal !== "observed") {
    budget.fullE2EGateSignal = "observed";
    changed = true;
  }
  return changed;
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(",") : "none";
}

export function formatSubagentSliceBudgetBlocker(params: {
  kind: SubagentSliceBudgetBlockKind;
  budget: SubagentSliceBudgetRecord;
}): string {
  const budget = params.budget;
  const failedRunIds = formatList(budget.childTimeoutRunIds ?? []);
  const failedChildIds = formatList(budget.childTimeoutSessionKeys ?? []);
  const routeUnavailableChildIds = formatList(
    budget.childRouteHealthUnavailableChildSessionKeys ?? [],
  );
  const evidence = [
    `sliceKey=${budget.sliceKey}`,
    `requester=${budget.requesterSessionKey}`,
    budget.requesterGeneration ? `requesterGeneration=${budget.requesterGeneration}` : undefined,
    budget.delegationAssignmentId
      ? `delegationAssignmentId=${budget.delegationAssignmentId}`
      : undefined,
    budget.delegationSliceId ? `delegationSliceId=${budget.delegationSliceId}` : undefined,
    budget.delegationEpoch !== undefined ? `delegationEpoch=${budget.delegationEpoch}` : undefined,
    budget.targetAgentId ? `targetAgentId=${budget.targetAgentId}` : undefined,
    budget.label ? `label=${budget.label}` : undefined,
    budget.sliceRole ? `sliceRole=${budget.sliceRole}` : undefined,
    budget.sliceBoundary ? `sliceBoundary=${budget.sliceBoundary}` : undefined,
    budget.parentSliceKey ? `parentSliceKey=${budget.parentSliceKey}` : undefined,
    `taskSha256=${budget.taskSha256}`,
    `childSpawnCount=${budget.childSpawnCount}`,
    `childTimeoutCount=${budget.childTimeoutCount}`,
    `timeoutRunIds=${failedRunIds}`,
    `timeoutChildSessionKeys=${failedChildIds}`,
    `childRouteHealthUnavailableCount=${budget.childRouteHealthUnavailableCount}`,
    `routeHealthUnavailableChildSessionKeys=${routeUnavailableChildIds}`,
    `terminalEvidenceGapCount=${budget.terminalEvidenceGapCount}`,
    `fullE2EGateGreen=${budget.fullE2EGateGreen}`,
    `fullE2EGateSignal=${budget.fullE2EGateSignal}`,
    `firstObservedAt=${budget.firstObservedAt}`,
    `lastObservedAt=${budget.lastObservedAt}`,
  ].filter((part): part is string => Boolean(part));
  const headline =
    params.kind === "route_health_unavailable_limit"
      ? "Subagent route/system health blocker: repeated child_route_health_unavailable for this planner slice."
      : "Subagent slice budget exhausted: two same-slice child timeouts were already observed.";
  return `${headline} Failed child run ids: ${failedRunIds}. Failed child session keys: ${failedChildIds}. Last trusted scalar evidence: ${evidence.join("; ")}. Next step: stop spawning broad replacement children for this slice; hand off the scalar evidence and start one focused recovery under a new user-approved slice or repair the route/system health first.`;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readPositiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => readString(item))
    .filter((item): item is string => Boolean(item))
    .slice(-MAX_TRACKED_CHILD_IDS);
}

function readFullGateGreen(value: unknown): SubagentSliceFullE2EGateGreen {
  if (value === true || value === false || value === "unknown") {
    return value;
  }
  return "unknown";
}

function readSliceRole(value: unknown): SubagentSliceRole | undefined {
  if (
    value === "implementation" ||
    value === "testing" ||
    value === "review" ||
    value === "qa" ||
    value === "full_gate"
  ) {
    return value;
  }
  return undefined;
}

function readSliceBoundary(value: unknown): SubagentSliceBoundary | undefined {
  if (value === "original" || value === "post_full_gate_followup") {
    return value;
  }
  return undefined;
}

function readEvidenceGapKind(
  value: unknown,
): SubagentSliceBudgetTerminalEvidenceGapKind | undefined {
  if (
    value === "timeout" ||
    value === "no_visible_final" ||
    value === "error" ||
    value === "killed"
  ) {
    return value;
  }
  return undefined;
}

export function normalizeSubagentSliceBudgetRecord(
  raw: unknown,
  fallbackKey?: string,
): SubagentSliceBudgetRecord | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const sliceKey = readString(record.sliceKey) ?? readString(fallbackKey);
  const requesterSessionKey = readString(record.requesterSessionKey);
  const taskSha256 = readString(record.taskSha256);
  const firstObservedAt = readNumber(record.firstObservedAt);
  const lastObservedAt = readNumber(record.lastObservedAt);
  if (!sliceKey || !requesterSessionKey || !taskSha256 || firstObservedAt == null) {
    return undefined;
  }
  return {
    sliceKey,
    requesterSessionKey,
    requesterGeneration: readString(record.requesterGeneration),
    delegationAssignmentId: readString(record.delegationAssignmentId),
    delegationSliceId: readString(record.delegationSliceId),
    delegationEpoch: readPositiveSafeInteger(record.delegationEpoch),
    targetAgentId: readString(record.targetAgentId),
    label: readString(record.label),
    sliceRole: readSliceRole(record.sliceRole),
    sliceBoundary: readSliceBoundary(record.sliceBoundary),
    parentSliceKey: readString(record.parentSliceKey),
    taskSha256,
    discriminatorKind: record.discriminatorKind === "label" ? "label" : "task_sha256",
    firstObservedAt,
    lastObservedAt: lastObservedAt ?? firstObservedAt,
    childSpawnCount: Math.max(0, Math.floor(readNumber(record.childSpawnCount) ?? 0)),
    childTimeoutCount: Math.max(0, Math.floor(readNumber(record.childTimeoutCount) ?? 0)),
    childTimeoutRunIds: readStringArray(record.childTimeoutRunIds),
    childTimeoutSessionKeys: readStringArray(record.childTimeoutSessionKeys),
    terminalEvidenceGapCount: Math.max(
      0,
      Math.floor(readNumber(record.terminalEvidenceGapCount) ?? 0),
    ),
    terminalEvidenceGapRunIds: readStringArray(record.terminalEvidenceGapRunIds),
    lastTerminalEvidenceGapKind: readEvidenceGapKind(record.lastTerminalEvidenceGapKind),
    childRouteHealthUnavailableCount: Math.max(
      0,
      Math.floor(readNumber(record.childRouteHealthUnavailableCount) ?? 0),
    ),
    childRouteHealthUnavailableChildSessionKeys: readStringArray(
      record.childRouteHealthUnavailableChildSessionKeys,
    ),
    fullE2EGateGreen: readFullGateGreen(record.fullE2EGateGreen),
    fullE2EGateSignal: record.fullE2EGateSignal === "observed" ? "observed" : "unavailable",
  };
}
