import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type {
  ChildRouteHealthCode,
  ChildRouteIntent,
  ChildRouteRecommendedAction,
  ChildTargetKind,
} from "./child-route-health-contract.js";
import { acquireSessionWriteLock } from "./session-write-lock.js";

const DELIVERY_ATTEMPTS_VERSION = 1 as const;
const JSON_FILE_MODE = 0o600;
const MAX_ATTEMPTS_TOTAL = 5_000;
const ATTEMPT_RETENTION_MS = 24 * 60 * 60_000;
const testStateDirContext = new AsyncLocalStorage<string>();

export type ChildRouteRejectedDeliveryAttempt = {
  version: typeof DELIVERY_ATTEMPTS_VERSION;
  deliveryAttemptId: string;
  status: "rejected_unhealthy";
  requesterSessionKey?: string;
  requesterGeneration?: string;
  routeIntent: ChildRouteIntent;
  targetMethod: string;
  childTargetKind: ChildTargetKind;
  childSessionKey: string;
  idempotencyKey?: string;
  healthEvidenceEpoch: string;
  evidenceEventIds: string[];
  codes: ChildRouteHealthCode[];
  recommendedAction: ChildRouteRecommendedAction;
  stateTransitionRequired: boolean;
  plannerInstruction: string;
  payloadHash?: string;
  observedAt: number;
};

type PersistedDeliveryAttemptState = {
  version: typeof DELIVERY_ATTEMPTS_VERSION;
  attempts: Record<string, ChildRouteRejectedDeliveryAttempt>;
  fingerprintIndex: Record<string, string>;
};

export type RejectedAttemptInput = {
  requesterSessionKey?: string;
  requesterGeneration?: string;
  routeIntent: ChildRouteIntent;
  targetMethod: string;
  childTargetKind: ChildTargetKind;
  childSessionKey: string;
  idempotencyKey?: string;
  healthEvidenceEpoch: string;
  evidenceEventIds: string[];
  codes: ChildRouteHealthCode[];
  recommendedAction: ChildRouteRecommendedAction;
  stateTransitionRequired: boolean;
  plannerInstruction: string;
  payloadHash?: string;
};

function resolveSubagentStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const testStateDir = testStateDirContext.getStore();
  if (testStateDir) {
    return path.join(testStateDir, "subagents");
  }
  const explicit = env.OPENCLAW_STATE_DIR?.trim();
  if (explicit) {
    return path.join(resolveStateDir(env), "subagents");
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), "openclaw-test-state", String(process.pid), "subagents");
  }
  return path.join(resolveStateDir(env), "subagents");
}

export function resolveChildRouteDeliveryAttemptsPath(): string {
  return path.join(resolveSubagentStateDir(process.env), "delivery-attempts.json");
}

export async function withChildRouteDeliveryAttemptsStateDirForTest<T>(
  stateDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  return await testStateDirContext.run(stateDir, fn);
}

function emptyState(): PersistedDeliveryAttemptState {
  return {
    version: DELIVERY_ATTEMPTS_VERSION,
    attempts: {},
    fingerprintIndex: {},
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRouteIntent(value: unknown): value is ChildRouteIntent {
  return (
    value === "initial_spawn" ||
    value === "followup_reuse" ||
    value === "reactivation" ||
    value === "a2a_step" ||
    value === "completion_receipt" ||
    value === "descendant_wake" ||
    value === "repair_control"
  );
}

function isChildTargetKind(value: unknown): value is ChildTargetKind {
  return value === "subagent" || value === "acp";
}

function isRecommendedAction(value: unknown): value is ChildRouteRecommendedAction {
  return (
    value === "spawn_fresh" ||
    value === "reauth" ||
    value === "fallback_profile" ||
    value === "stop"
  );
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizeOptionalString(item))
    .filter((item): item is string => Boolean(item))
    .toSorted((left, right) => left.localeCompare(right));
}

function normalizeCodeArray(value: unknown): ChildRouteHealthCode[] {
  const allowed = new Set<ChildRouteHealthCode>([
    "child_conversation_expired",
    "auth_profile_session_expired",
    "context_overflow",
    "agent_lifecycle_blocked",
    "agent_lifecycle_abandoned",
    "agent_lifecycle_error",
    "edit_failure_threshold",
  ]);
  return normalizeStringArray(value)
    .filter((item): item is ChildRouteHealthCode => allowed.has(item as ChildRouteHealthCode))
    .toSorted((left, right) => left.localeCompare(right));
}

function normalizeAttempt(raw: unknown): ChildRouteRejectedDeliveryAttempt | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const deliveryAttemptId = readString(record.deliveryAttemptId);
  const routeIntent = record.routeIntent;
  const targetMethod = readString(record.targetMethod);
  const childTargetKind = record.childTargetKind;
  const childSessionKey = readString(record.childSessionKey);
  const healthEvidenceEpoch = readString(record.healthEvidenceEpoch);
  const recommendedAction = record.recommendedAction;
  const plannerInstruction = readString(record.plannerInstruction);
  const observedAt = readNumber(record.observedAt);
  const codes = normalizeCodeArray(record.codes);
  if (
    record.version !== DELIVERY_ATTEMPTS_VERSION ||
    record.status !== "rejected_unhealthy" ||
    !deliveryAttemptId ||
    !isRouteIntent(routeIntent) ||
    !targetMethod ||
    !isChildTargetKind(childTargetKind) ||
    !childSessionKey ||
    !healthEvidenceEpoch ||
    !isRecommendedAction(recommendedAction) ||
    !plannerInstruction ||
    observedAt === undefined ||
    codes.length === 0
  ) {
    return null;
  }
  return {
    version: DELIVERY_ATTEMPTS_VERSION,
    deliveryAttemptId,
    status: "rejected_unhealthy",
    ...(readString(record.requesterSessionKey)
      ? { requesterSessionKey: readString(record.requesterSessionKey) }
      : {}),
    ...(readString(record.requesterGeneration)
      ? { requesterGeneration: readString(record.requesterGeneration) }
      : {}),
    routeIntent,
    targetMethod,
    childTargetKind,
    childSessionKey,
    ...(readString(record.idempotencyKey)
      ? { idempotencyKey: readString(record.idempotencyKey) }
      : {}),
    healthEvidenceEpoch,
    evidenceEventIds: normalizeStringArray(record.evidenceEventIds),
    codes,
    recommendedAction,
    stateTransitionRequired: record.stateTransitionRequired === true,
    plannerInstruction,
    ...(readString(record.payloadHash) ? { payloadHash: readString(record.payloadHash) } : {}),
    observedAt,
  };
}

function normalizeState(raw: unknown): PersistedDeliveryAttemptState {
  if (!raw || typeof raw !== "object") {
    throw new Error("delivery-attempt store is not an object");
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== DELIVERY_ATTEMPTS_VERSION) {
    throw new Error("unsupported delivery-attempt store version");
  }
  const state = emptyState();
  if (record.attempts && typeof record.attempts === "object") {
    for (const [key, value] of Object.entries(record.attempts)) {
      const attempt = normalizeAttempt(value);
      if (attempt && key === attempt.deliveryAttemptId) {
        state.attempts[key] = attempt;
      }
    }
  }
  if (record.fingerprintIndex && typeof record.fingerprintIndex === "object") {
    for (const [key, value] of Object.entries(record.fingerprintIndex)) {
      const attemptId = readString(value);
      if (key.trim() && attemptId && state.attempts[attemptId]) {
        state.fingerprintIndex[key] = attemptId;
      }
    }
  }
  return state;
}

async function readStateFromPath(pathname: string): Promise<PersistedDeliveryAttemptState> {
  let raw: string;
  try {
    raw = await fs.readFile(pathname, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyState();
    }
    throw error;
  }
  return normalizeState(JSON.parse(raw));
}

async function writeStateToPath(
  pathname: string,
  state: PersistedDeliveryAttemptState,
): Promise<void> {
  await fs.mkdir(path.dirname(pathname), { recursive: true, mode: 0o700 });
  await fs.writeFile(pathname, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: JSON_FILE_MODE,
  });
}

function stableHash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function buildFingerprint(input: RejectedAttemptInput): string {
  return stableHash({
    requesterSessionKey: input.requesterSessionKey,
    requesterGeneration: input.requesterGeneration,
    routeIntent: input.routeIntent,
    targetMethod: input.targetMethod,
    childTargetKind: input.childTargetKind,
    childSessionKey: input.childSessionKey,
    healthEvidenceEpoch: input.healthEvidenceEpoch,
    evidenceEventIds: input.evidenceEventIds.toSorted(),
    payloadHash: input.payloadHash,
  });
}

function buildAttemptId(input: RejectedAttemptInput): string {
  return `attempt_${buildFingerprint(input).slice(0, 32)}`;
}

function applyRetention(
  state: PersistedDeliveryAttemptState,
  now: number,
): PersistedDeliveryAttemptState {
  const attempts = Object.values(state.attempts)
    .filter((attempt) => now - attempt.observedAt <= ATTEMPT_RETENTION_MS)
    .toSorted(
      (left, right) =>
        right.observedAt - left.observedAt ||
        right.deliveryAttemptId.localeCompare(left.deliveryAttemptId),
    )
    .slice(0, MAX_ATTEMPTS_TOTAL);
  state.attempts = {};
  state.fingerprintIndex = {};
  for (const attempt of attempts) {
    state.attempts[attempt.deliveryAttemptId] = attempt;
    const fingerprintInput: RejectedAttemptInput = {
      ...(attempt.requesterSessionKey ? { requesterSessionKey: attempt.requesterSessionKey } : {}),
      ...(attempt.requesterGeneration ? { requesterGeneration: attempt.requesterGeneration } : {}),
      routeIntent: attempt.routeIntent,
      targetMethod: attempt.targetMethod,
      childTargetKind: attempt.childTargetKind,
      childSessionKey: attempt.childSessionKey,
      ...(attempt.idempotencyKey ? { idempotencyKey: attempt.idempotencyKey } : {}),
      healthEvidenceEpoch: attempt.healthEvidenceEpoch,
      evidenceEventIds: attempt.evidenceEventIds,
      codes: attempt.codes,
      recommendedAction: attempt.recommendedAction,
      stateTransitionRequired: attempt.stateTransitionRequired,
      plannerInstruction: attempt.plannerInstruction,
      ...(attempt.payloadHash ? { payloadHash: attempt.payloadHash } : {}),
    };
    state.fingerprintIndex[buildFingerprint(fingerprintInput)] = attempt.deliveryAttemptId;
  }
  return state;
}

export async function recordRejectedChildRouteDeliveryAttempt(
  input: RejectedAttemptInput,
): Promise<
  { ok: true; attempt: ChildRouteRejectedDeliveryAttempt } | { ok: false; error: string }
> {
  const pathname = resolveChildRouteDeliveryAttemptsPath();
  let lock: { release: () => Promise<void> } | undefined;
  try {
    lock = await acquireSessionWriteLock({
      sessionFile: pathname,
      timeoutMs: 10_000,
      staleMs: 30 * 60_000,
    });
    const state = applyRetention(await readStateFromPath(pathname), Date.now());
    const fingerprint = buildFingerprint(input);
    const existingId = state.fingerprintIndex[fingerprint];
    if (existingId && state.attempts[existingId]) {
      return { ok: true, attempt: state.attempts[existingId] };
    }
    const attempt: ChildRouteRejectedDeliveryAttempt = {
      version: DELIVERY_ATTEMPTS_VERSION,
      deliveryAttemptId: buildAttemptId(input),
      status: "rejected_unhealthy",
      ...(input.requesterSessionKey ? { requesterSessionKey: input.requesterSessionKey } : {}),
      ...(input.requesterGeneration ? { requesterGeneration: input.requesterGeneration } : {}),
      routeIntent: input.routeIntent,
      targetMethod: input.targetMethod,
      childTargetKind: input.childTargetKind,
      childSessionKey: input.childSessionKey,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      healthEvidenceEpoch: input.healthEvidenceEpoch,
      evidenceEventIds: input.evidenceEventIds.toSorted(),
      codes: input.codes.toSorted(),
      recommendedAction: input.recommendedAction,
      stateTransitionRequired: input.stateTransitionRequired,
      plannerInstruction: input.plannerInstruction,
      ...(input.payloadHash ? { payloadHash: input.payloadHash } : {}),
      observedAt: Date.now(),
    };
    state.attempts[attempt.deliveryAttemptId] = attempt;
    state.fingerprintIndex[fingerprint] = attempt.deliveryAttemptId;
    await writeStateToPath(pathname, applyRetention(state, Date.now()));
    return { ok: true, attempt };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await lock?.release().catch(() => undefined);
  }
}
