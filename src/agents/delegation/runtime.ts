import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { DelegationGuardConfig } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveSandboxConfigForAgent } from "../sandbox/config.js";
import { listAgentWorkspaceDirs } from "../workspace-dirs.js";
import type {
  DelegationAssignmentRecord,
  DelegationFingerprint,
  DelegationRouteKind,
} from "./contracts.js";
import {
  captureDelegationRepositorySnapshot,
  fingerprintDelegationCandidate,
} from "./fingerprint.js";
import {
  openConfiguredDelegationLedger,
  reconcileDelegationGatewayTaskAfterRestart,
} from "./gateway-task-reconciliation.js";
import { hashDelegationIdentity } from "./identity.js";
import {
  type DelegationGatewayDispatchClaim,
  type DelegationGatewayDispatchOutcome,
  type DelegationLedger,
} from "./ledger.js";
import {
  assertDelegationController,
  resolveDelegationGuardConfig,
  resolveDelegationGuardPrincipal,
  resolveDelegationPolicyDigest,
  resolveDelegationWorkerRequiredModel,
} from "./policy.js";

export { resolveDelegationPolicyDigest } from "./policy.js";
export {
  reconcileDelegationGatewayTaskAfterRestart,
  reconcileDelegationInitialSpawnTaskAfterRestart,
} from "./gateway-task-reconciliation.js";

const execFileAsync = promisify(execFile);

function resolvePathIdentity(value: string): { absolute: string; canonical: string } {
  const absolute = path.resolve(value);
  try {
    return { absolute, canonical: realpathSync(absolute) };
  } catch {
    return { absolute, canonical: absolute };
  }
}

function pathIsAtOrBelow(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertValidatorOutsideAgentWorkspaces(
  config: OpenClawConfig,
  validator: DelegationGuardConfig["validator"],
): void {
  const entrypoint = resolvePathIdentity(validator.entrypoint);
  for (const workspaceDir of listAgentWorkspaceDirs(config)) {
    const workspace = resolvePathIdentity(workspaceDir);
    if (
      pathIsAtOrBelow(workspace.absolute, entrypoint.absolute) ||
      pathIsAtOrBelow(workspace.canonical, entrypoint.canonical)
    ) {
      throw new Error("Delegation validator must be installed outside every agent workspace.");
    }
  }
}

export type DelegationRuntime = {
  guard: DelegationGuardConfig;
  ledger: DelegationLedger;
  policyDigest: string;
};

export type AuthorizedDelegationRoute = {
  runtime: DelegationRuntime;
  assignment: DelegationAssignmentRecord;
  routeKind: DelegationRouteKind;
  routeTokenHash: string;
  gatewayDispatch?: {
    capability: string;
    targetSessionKey: string;
    idempotencyKey: string;
  };
};

export function resolveDelegationRuntime(config: OpenClawConfig): DelegationRuntime | undefined {
  const guard = resolveDelegationGuardConfig(config);
  if (!guard) {
    return undefined;
  }
  assertValidatorOutsideAgentWorkspaces(config, guard.validator);
  for (const principal of [...guard.controllers, ...guard.workers]) {
    assertDelegationEmbeddedRuntime(config, principal.agentId);
  }
  const policyDigest = resolveDelegationPolicyDigest(guard);
  return {
    guard,
    policyDigest,
    ledger: openConfiguredDelegationLedger({ guard, policyDigest }),
  };
}

export async function resolveDelegationRepositoryRoot(repoPath: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd: repoPath,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
  });
  const root = stdout.trim();
  if (!root) {
    throw new Error("Delegation repository root could not be resolved.");
  }
  return await realpath(root);
}

export async function requireCurrentDelegationCandidate(params: {
  runtime: DelegationRuntime;
  sliceId: string;
  candidateId: string;
}): Promise<{ candidateId: string; fingerprint: DelegationFingerprint }> {
  const slice = params.runtime.ledger.getSliceScope(params.sliceId);
  const candidate = params.runtime.ledger.getCandidateRecord(params.candidateId);
  const latest = params.runtime.ledger.latestCandidateRecordForSlice(params.sliceId);
  if (
    !slice ||
    slice.epoch !== params.runtime.ledger.currentEpoch() ||
    !candidate ||
    candidate.sliceId !== params.sliceId ||
    candidate.epoch !== params.runtime.ledger.currentEpoch() ||
    latest?.candidateId !== params.candidateId
  ) {
    throw new Error("Delegation candidate is missing, stale, or no longer current for this slice.");
  }
  const current = await fingerprintDelegationCandidate({
    repoPath: slice.repositoryRoot,
    scope: slice.scope,
    guard: params.runtime.guard,
    policyDigest: params.runtime.policyDigest,
    epoch: params.runtime.ledger.currentEpoch(),
  });
  if (
    current.candidateDigest !== candidate.fingerprint.candidateDigest ||
    current.contextDigest !== candidate.fingerprint.contextDigest
  ) {
    throw new Error("Delegation candidate changed after its protected fingerprint was recorded.");
  }
  return { candidateId: params.candidateId, fingerprint: candidate.fingerprint };
}

export async function resolveDelegationReportCandidate(params: {
  runtime: DelegationRuntime;
  assignment: DelegationAssignmentRecord;
}): Promise<{ candidateId: string; fingerprint: DelegationFingerprint } | undefined> {
  const { assignment, runtime } = params;
  if (!assignment.candidateId) {
    return undefined;
  }
  if (assignment.purpose !== "remediation") {
    return await requireCurrentDelegationCandidate({
      runtime,
      sliceId: assignment.sliceId,
      candidateId: assignment.candidateId,
    });
  }
  const sourceCandidate = runtime.ledger.getCandidateRecord(assignment.candidateId);
  const latest = runtime.ledger.latestCandidateRecordForSlice(assignment.sliceId);
  if (
    !sourceCandidate ||
    sourceCandidate.sliceId !== assignment.sliceId ||
    sourceCandidate.epoch !== runtime.ledger.currentEpoch() ||
    latest?.candidateId !== assignment.candidateId
  ) {
    throw new Error("Remediation source candidate is missing, stale, or no longer current.");
  }
  return {
    candidateId: assignment.candidateId,
    fingerprint: sourceCandidate.fingerprint,
  };
}

export async function assertDelegationAssignmentScopeCurrent(params: {
  runtime: DelegationRuntime;
  assignment: DelegationAssignmentRecord;
}): Promise<void> {
  const slice = params.runtime.ledger.getSliceScope(params.assignment.sliceId);
  if (!slice || slice.epoch !== params.runtime.ledger.currentEpoch()) {
    throw new Error("Delegation assignment belongs to a missing or stale slice.");
  }
  const currentSnapshot = await captureDelegationRepositorySnapshot({
    repoPath: slice.repositoryRoot,
  });
  params.runtime.ledger.assertNoOutOfScopeChanges({
    sliceId: params.assignment.sliceId,
    currentSnapshot,
    ...(params.assignment.candidateId ? { baseCandidateId: params.assignment.candidateId } : {}),
  });
}

export function resolveDelegationCallerAgentId(params: {
  agentSessionKey?: string;
  requesterAgentIdOverride?: string;
}): string {
  const explicit = params.requesterAgentIdOverride?.trim();
  if (explicit) {
    return normalizeAgentId(explicit);
  }
  const sessionKey = params.agentSessionKey?.trim();
  if (!sessionKey) {
    throw new Error("Guarded delegation requires an authenticated caller session.");
  }
  return normalizeAgentId(resolveAgentIdFromSessionKey(sessionKey));
}

export function requireDelegationController(params: {
  config: OpenClawConfig;
  agentSessionKey?: string;
  requesterAgentIdOverride?: string;
  effectiveThinking?: string;
}): { runtime: DelegationRuntime; controllerAgentId: string } {
  const runtime = resolveDelegationRuntime(params.config);
  if (!runtime) {
    throw new Error("Delegation guard is not enabled.");
  }
  const controllerAgentId = resolveDelegationCallerAgentId(params);
  assertDelegationController({
    guard: runtime.guard,
    agentId: controllerAgentId,
    effectiveThinking: params.effectiveThinking,
  });
  assertDelegationControllerSandbox({
    config: params.config,
    controllerAgentId,
  });
  return { runtime, controllerAgentId };
}

export function assertDelegationControllerSandbox(params: {
  config: OpenClawConfig;
  controllerAgentId: string;
}): void {
  assertDelegationEmbeddedRuntime(params.config, params.controllerAgentId);
  const sandbox = resolveSandboxConfigForAgent(params.config, params.controllerAgentId);
  if (
    sandbox.mode === "off" ||
    sandbox.backend !== "docker" ||
    sandbox.scope !== "session" ||
    sandbox.workspaceAccess !== "ro"
  ) {
    throw new Error(
      `Guarded controller ${params.controllerAgentId} requires a per-session Docker sandbox with read-only workspace access.`,
    );
  }
  assertDelegationSandboxHasNoPrivilegedInputs(sandbox, params.controllerAgentId);
}

function assertDelegationEmbeddedRuntime(config: OpenClawConfig, agentId: string): void {
  const normalizedAgentId = normalizeAgentId(agentId);
  const configuredRuntime = config.agents?.list?.find(
    (entry) => normalizeAgentId(entry.id) === normalizedAgentId,
  )?.runtime;
  if (configuredRuntime && configuredRuntime.type !== "embedded") {
    throw new Error("Guarded delegation principals require the embedded agent runtime.");
  }
}

export function assertDelegationWorkerSandbox(params: {
  config: OpenClawConfig;
  workerAgentId: string;
  workspaceAccess: "ro" | "rw";
}): void {
  assertDelegationEmbeddedRuntime(params.config, params.workerAgentId);
  const sandbox = resolveSandboxConfigForAgent(params.config, params.workerAgentId);
  if (
    sandbox.mode === "off" ||
    sandbox.backend !== "docker" ||
    sandbox.scope !== "session" ||
    sandbox.workspaceAccess !== params.workspaceAccess
  ) {
    throw new Error(
      `Guarded worker ${params.workerAgentId} requires a per-session Docker sandbox with exact ${params.workspaceAccess} workspace access.`,
    );
  }
  assertDelegationSandboxHasNoPrivilegedInputs(sandbox, params.workerAgentId);
}

function assertDelegationSandboxHasNoPrivilegedInputs(
  sandbox: ReturnType<typeof resolveSandboxConfigForAgent>,
  agentId: string,
): void {
  const hasUnexpectedEnvironment = Object.entries(sandbox.docker.env ?? {}).some(
    ([key, value]) => key !== "LANG" || value !== "C.UTF-8",
  );
  if (
    (sandbox.docker.binds?.length ?? 0) > 0 ||
    (sandbox.browser.binds?.length ?? 0) > 0 ||
    hasUnexpectedEnvironment ||
    sandbox.docker.dangerouslyAllowReservedContainerTargets === true ||
    sandbox.docker.dangerouslyAllowExternalBindSources === true ||
    sandbox.docker.dangerouslyAllowContainerNamespaceJoin === true
  ) {
    throw new Error(
      `Guarded sandbox ${agentId} cannot inherit extra binds, environment values, or dangerous Docker overrides.`,
    );
  }
}

export function authorizeDelegationRoute(params: {
  config: OpenClawConfig;
  agentSessionKey?: string;
  requesterAgentIdOverride?: string;
  effectiveThinking?: string;
  targetAgentId: string;
  targetThinking?: string;
  targetModel?: string;
  targetSessionKey?: string;
  delegationToken?: string;
  idempotencyKey?: string;
  routeKind: DelegationRouteKind;
}): AuthorizedDelegationRoute | undefined {
  const runtime = resolveDelegationRuntime(params.config);
  if (!runtime) {
    return undefined;
  }
  const targetAgentId = normalizeAgentId(params.targetAgentId);
  const target = resolveDelegationGuardPrincipal(runtime.guard, targetAgentId);
  let resolvedCallerAgentId: string | undefined;
  try {
    resolvedCallerAgentId = resolveDelegationCallerAgentId(params);
  } catch {
    resolvedCallerAgentId = undefined;
  }
  const caller = resolvedCallerAgentId
    ? resolveDelegationGuardPrincipal(runtime.guard, resolvedCallerAgentId)
    : undefined;
  if (runtime.guard.mode === "audit") {
    if (!caller && target?.kind !== "worker" && !params.delegationToken?.trim()) {
      return undefined;
    }
    runtime.ledger.appendAuditEvent({
      kind: "guarded_route_attempt",
      payload: {
        callerAgentId: resolvedCallerAgentId ?? null,
        callerSessionKey: params.agentSessionKey?.trim() || null,
        targetAgentId,
        routeKind: params.routeKind,
        decision: "allow-audit",
        tokenPresent: Boolean(params.delegationToken?.trim()),
        thinkingPresent: Boolean(params.targetThinking?.trim()),
        modelPresent: Boolean(params.targetModel?.trim()),
      },
    });
    return undefined;
  }
  if (caller?.kind === "worker") {
    throw new Error("Guarded workers cannot spawn, send to, or steer another agent.");
  }
  if (target?.kind !== "worker") {
    if (params.delegationToken?.trim()) {
      throw new Error("Delegation tokens can only authorize routes to configured guarded workers.");
    }
    if (caller?.kind === "controller") {
      throw new Error("Guarded controllers may route only to configured guarded workers.");
    }
    return undefined;
  }
  assertDelegationEmbeddedRuntime(params.config, targetAgentId);
  const callerAgentId = resolvedCallerAgentId ?? resolveDelegationCallerAgentId(params);
  assertDelegationController({
    guard: runtime.guard,
    agentId: callerAgentId,
    effectiveThinking: params.effectiveThinking,
  });
  assertDelegationControllerSandbox({
    config: params.config,
    controllerAgentId: callerAgentId,
  });
  const delegationToken = params.delegationToken?.trim();
  if (!delegationToken) {
    throw new Error(`Guarded ${params.routeKind} requires a one-use delegationToken.`);
  }
  assertDelegationWorkerSandbox({
    config: params.config,
    workerAgentId: targetAgentId,
    workspaceAccess: target.workspaceAccess,
  });
  if (
    (params.routeKind !== "spawn" && params.targetThinking !== target.requiredThinking) ||
    (params.targetThinking !== undefined && params.targetThinking !== target.requiredThinking)
  ) {
    throw new Error(
      `Guarded ${target.role} session must remain at exact ${target.requiredThinking} thinking.`,
    );
  }
  const requiredModel = resolveDelegationWorkerRequiredModel(params.config, targetAgentId);
  if (params.routeKind !== "spawn" && !params.targetModel) {
    throw new Error(`Guarded ${params.routeKind} requires the target session's resolved model.`);
  }
  if (params.targetModel && params.targetModel !== requiredModel) {
    throw new Error(
      `Guarded delegation is bound to ${requiredModel}; target model ${params.targetModel} is not allowed.`,
    );
  }
  const gatewayDispatch =
    params.routeKind === "send" || params.routeKind === "steer"
      ? runtime.ledger.consumeSendTokenWithGatewayDispatch({
          delegationToken,
          routeKind: params.routeKind,
          callerAgentId,
          callerSessionKey:
            params.agentSessionKey ??
            (() => {
              throw new Error(`Guarded ${params.routeKind} requires the exact controller session.`);
            })(),
          targetAgentId,
          targetSessionKey:
            params.targetSessionKey ??
            (() => {
              throw new Error(
                `Guarded ${params.routeKind} requires an exact target child session.`,
              );
            })(),
          idempotencyKey:
            params.idempotencyKey ??
            (() => {
              throw new Error(`Guarded ${params.routeKind} requires a Gateway idempotency key.`);
            })(),
        })
      : undefined;
  const assignment =
    gatewayDispatch?.assignment ??
    runtime.ledger.consumeAssignmentToken({
      delegationToken,
      routeKind: params.routeKind,
      callerAgentId,
      targetAgentId,
      callerSessionKey: params.agentSessionKey,
      ...(params.targetSessionKey ? { targetSessionKey: params.targetSessionKey } : {}),
    });
  const rejectConsumedRoute = (reason: string): never => {
    runtime.ledger.appendRouteEvent({
      assignmentId: assignment.assignmentId,
      kind: "route_rejected",
      payload: {
        routeKind: params.routeKind,
        ...(params.targetSessionKey ? { targetSessionKey: params.targetSessionKey } : {}),
        reason,
      },
    });
    throw new Error(reason);
  };
  if (
    assignment.role !== target.role ||
    assignment.requiredThinking !== target.requiredThinking ||
    assignment.requiredModel !== requiredModel ||
    assignment.workspaceAccess !== target.workspaceAccess
  ) {
    rejectConsumedRoute("Delegation assignment no longer matches the configured worker policy.");
  }
  if (!params.agentSessionKey || assignment.controllerSessionKey !== params.agentSessionKey) {
    rejectConsumedRoute("Delegation token does not match the exact issuing controller session.");
  }
  if (params.routeKind !== "spawn") {
    const targetSessionKey =
      params.targetSessionKey ??
      rejectConsumedRoute(`Guarded ${params.routeKind} requires an exact target child session.`);
    const bound = runtime.ledger.resolveAssignmentForChildSession(targetSessionKey);
    const sameWorkerFacts =
      bound !== undefined &&
      bound.controllerAgentId === assignment.controllerAgentId &&
      bound.controllerSessionKey === assignment.controllerSessionKey &&
      bound.workerAgentId === assignment.workerAgentId &&
      bound.role === assignment.role &&
      bound.requiredThinking === assignment.requiredThinking &&
      bound.requiredModel === assignment.requiredModel &&
      bound.workspaceAccess === assignment.workspaceAccess;
    const currentAssignmentMatches =
      bound !== undefined &&
      bound.assignmentId === assignment.assignmentId &&
      bound.sliceId === assignment.sliceId &&
      sameWorkerFacts;
    const completedPriorAssignmentMatches =
      bound !== undefined &&
      bound.assignmentId !== assignment.assignmentId &&
      bound.sliceId === assignment.sliceId &&
      sameWorkerFacts &&
      runtime.ledger.isAssignmentCompleted(bound.assignmentId);
    if (!currentAssignmentMatches && !completedPriorAssignmentMatches) {
      rejectConsumedRoute(
        `Guarded ${params.routeKind} token does not match the existing child assignment/session.`,
      );
    }
  }
  return {
    runtime,
    assignment,
    routeKind: params.routeKind,
    routeTokenHash: hashDelegationIdentity("delegation-token-v1", delegationToken),
    ...(gatewayDispatch
      ? {
          gatewayDispatch: {
            capability: gatewayDispatch.capability,
            targetSessionKey: params.targetSessionKey as string,
            idempotencyKey: params.idempotencyKey as string,
          },
        }
      : {}),
  };
}

export function issueDelegationGatewayDispatch(params: {
  authorized?: AuthorizedDelegationRoute;
  targetSessionKey: string;
  idempotencyKey: string;
}): string | undefined {
  if (!params.authorized) {
    return undefined;
  }
  if (params.authorized.routeKind !== "send" && params.authorized.routeKind !== "steer") {
    throw new Error("Gateway dispatch capabilities can only continue guarded follow-up routes.");
  }
  const dispatch = params.authorized.gatewayDispatch;
  if (
    !dispatch ||
    dispatch.targetSessionKey !== params.targetSessionKey ||
    dispatch.idempotencyKey !== params.idempotencyKey
  ) {
    throw new Error("Gateway dispatch capability does not match this exact guarded follow-up.");
  }
  return dispatch.capability;
}

export function consumeDelegationGatewayDispatch(params: {
  config: OpenClawConfig;
  capability?: string;
  controllerSessionKey?: string;
  targetSessionKey: string;
  idempotencyKey: string;
}): DelegationGatewayDispatchClaim | undefined {
  const capability = params.capability?.trim();
  if (!capability) {
    return undefined;
  }
  const controllerSessionKey = params.controllerSessionKey?.trim();
  if (!controllerSessionKey) {
    throw new Error("Gateway dispatch capability requires its exact controller session.");
  }
  const runtime = resolveDelegationRuntime(params.config);
  if (!runtime || runtime.guard.mode !== "enforce") {
    throw new Error("Gateway dispatch capability requires an enforcing delegation guard.");
  }
  return runtime.ledger.consumeGatewayDispatchCapability({
    capability,
    controllerSessionKey,
    targetSessionKey: params.targetSessionKey,
    idempotencyKey: params.idempotencyKey,
  });
}

export function isDelegationGuardedChildSession(params: {
  config: OpenClawConfig;
  targetSessionKey: string;
}): boolean {
  const runtime = resolveDelegationRuntime(params.config);
  if (!runtime || runtime.guard.mode !== "enforce") {
    return false;
  }
  return Boolean(runtime.ledger.resolveAssignmentForChildSession(params.targetSessionKey));
}

export function recordDelegationGatewayDispatchOutcome(params: {
  config: OpenClawConfig;
  capability: string;
  controllerSessionKey: string;
  targetSessionKey: string;
  idempotencyKey: string;
  decision: "rejected";
  response: unknown;
  rejectRoute?: boolean;
}): DelegationGatewayDispatchOutcome {
  const runtime = resolveDelegationRuntime(params.config);
  if (!runtime || runtime.guard.mode !== "enforce") {
    throw new Error("Gateway dispatch outcome requires an enforcing delegation guard.");
  }
  return runtime.ledger.recordGatewayDispatchOutcome(params);
}

export function recordDelegationGatewayDispatchEnqueued(params: {
  config: OpenClawConfig;
  capability: string;
  controllerSessionKey: string;
  targetSessionKey: string;
  idempotencyKey: string;
  runId: string;
  response: unknown;
}): DelegationGatewayDispatchOutcome {
  const runtime = resolveDelegationRuntime(params.config);
  if (!runtime || runtime.guard.mode !== "enforce") {
    throw new Error("Gateway dispatch enqueue requires an enforcing delegation guard.");
  }
  return runtime.ledger.recordGatewayDispatchEnqueued(params);
}

export function recordDelegationGatewayDispatchExecutionCompleted(params: {
  config: OpenClawConfig;
  capability: string;
  controllerSessionKey: string;
  targetSessionKey: string;
  idempotencyKey: string;
  runId: string;
  resultText?: string;
}): void {
  const runtime = resolveDelegationRuntime(params.config);
  if (!runtime || runtime.guard.mode !== "enforce") {
    throw new Error("Gateway dispatch completion requires an enforcing delegation guard.");
  }
  runtime.ledger.recordGatewayDispatchExecutionCompleted(params);
}

export function recordDelegationGatewayDispatchExecutionFailed(params: {
  config: OpenClawConfig;
  capability: string;
  controllerSessionKey: string;
  targetSessionKey: string;
  idempotencyKey: string;
  runId: string;
  response: unknown;
}): void {
  const runtime = resolveDelegationRuntime(params.config);
  if (!runtime || runtime.guard.mode !== "enforce") {
    throw new Error("Gateway dispatch failure requires an enforcing delegation guard.");
  }
  runtime.ledger.recordGatewayDispatchExecutionFailed(params);
}

export function appendDelegationRouteEvent(params: {
  authorized?: AuthorizedDelegationRoute;
  kind: "accepted" | "route_rejected" | "validation_rejected" | "timeout";
  childSessionKey?: string;
  runId?: string;
  reason?: string;
}): void {
  if (!params.authorized) {
    return;
  }
  if (params.kind === "route_rejected") {
    params.authorized.runtime.ledger.rejectRouteIfOpen({
      assignmentId: params.authorized.assignment.assignmentId,
      targetSessionKey: params.childSessionKey,
      runId: params.runId,
      reason: params.reason,
    });
    return;
  }
  params.authorized.runtime.ledger.appendRouteEvent({
    assignmentId: params.authorized.assignment.assignmentId,
    kind: params.kind,
    payload: {
      ...(params.childSessionKey ? { childSessionKey: params.childSessionKey } : {}),
      ...(params.runId ? { runId: params.runId } : {}),
      ...(params.reason ? { reason: params.reason } : {}),
    },
  });
}

export function appendDelegationObservationEvent(params: {
  authorized?: AuthorizedDelegationRoute;
  kind: "wait_timeout";
  childSessionKey?: string;
  runId?: string;
  reason?: string;
}): void {
  if (!params.authorized) {
    return;
  }
  params.authorized.runtime.ledger.appendAuditEvent({
    kind: `delegation_${params.kind}`,
    payload: {
      assignmentId: params.authorized.assignment.assignmentId,
      routeFamilyId: params.authorized.assignment.routeFamilyId,
      ...(params.childSessionKey ? { childSessionKey: params.childSessionKey } : {}),
      ...(params.runId ? { runId: params.runId } : {}),
      ...(params.reason ? { reason: params.reason } : {}),
    },
  });
}

export function bindDelegationRoute(params: {
  authorized?: AuthorizedDelegationRoute;
  childSessionKey?: string;
  runId?: string;
}): void {
  if (!params.authorized || !params.childSessionKey) {
    return;
  }
  params.authorized.runtime.ledger.bindAssignment({
    assignmentId: params.authorized.assignment.assignmentId,
    childSessionKey: params.childSessionKey,
    runId: params.runId,
  });
}
