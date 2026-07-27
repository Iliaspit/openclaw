import { realpath } from "node:fs/promises";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveDelegationGuardConfig,
  resolveDelegationGuardPrincipal,
} from "../delegation/policy.js";
import {
  assertDelegationAssignmentScopeCurrent,
  requireCurrentDelegationCandidate,
  type DelegationRuntime,
} from "../delegation/runtime.js";
import type { GuardedVerifierAuthorization, SandboxConfig } from "./types.js";

export type GuardedVerifierAuthorizationDeps = {
  canonicalWorkspace: (workspaceDir: string) => Promise<string>;
  assertAssignmentScopeCurrent: typeof assertDelegationAssignmentScopeCurrent;
  requireCurrentCandidate: typeof requireCurrentDelegationCandidate;
  sourceRevision: () => string | undefined;
};

const defaultAuthorizationDeps: GuardedVerifierAuthorizationDeps = {
  canonicalWorkspace: realpath,
  assertAssignmentScopeCurrent: assertDelegationAssignmentScopeCurrent,
  requireCurrentCandidate: requireCurrentDelegationCandidate,
  sourceRevision: () => process.env.OPENCLAW_SOURCE_REVISION?.trim(),
};

const FIXED_VERIFIER_TMPFS = [
  "/tmp:rw,nosuid,nodev,noexec,size=1g,uid=1000,gid=1000,mode=1777",
  "/var/tmp:rw,nosuid,nodev,noexec,size=256m,uid=1000,gid=1000,mode=1777",
  "/run:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000,mode=1777",
  "/workspace/node_modules/.vite-temp:rw,nosuid,nodev,noexec,size=512m,uid=1000,gid=1000,mode=1777",
  "/workspace/test-results:rw,nosuid,nodev,noexec,size=512m,uid=1000,gid=1000,mode=1777",
  "/workspace/playwright-report:rw,nosuid,nodev,noexec,size=512m,uid=1000,gid=1000,mode=1777",
] as const;

type GuardedVerifierExecutionIdentity = {
  config: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  workspaceDir: string;
  runtime: DelegationRuntime;
  deps?: GuardedVerifierAuthorizationDeps;
};

async function resolveGuardedVerifierAuthorization(
  params: GuardedVerifierExecutionIdentity,
): Promise<GuardedVerifierAuthorization> {
  const deps = params.deps ?? defaultAuthorizationDeps;
  const guard = resolveDelegationGuardConfig(params.config);
  const principal = guard ? resolveDelegationGuardPrincipal(guard, params.agentId) : undefined;
  if (
    guard?.mode !== "enforce" ||
    principal?.kind !== "worker" ||
    (principal.role !== "tester" && principal.role !== "reviewer")
  ) {
    throw new Error("Guarded verifier execution requires an enforcing verifier principal.");
  }
  const assignment = params.runtime.ledger.resolveAssignmentForChildSession(params.sessionKey);
  if (
    !assignment ||
    assignment.workerAgentId !== principal.agentId ||
    assignment.role !== principal.role ||
    assignment.workspaceAccess !== "ro" ||
    !assignment.candidateId ||
    !assignment.waveId ||
    assignment.epoch !== params.runtime.ledger.currentEpoch()
  ) {
    throw new Error(
      "Guarded verifier sandbox requires a current bound read-only frozen-wave assignment.",
    );
  }
  params.runtime.ledger.assertAssignmentOpenForExecution(assignment.assignmentId);
  const protectedFacts = params.runtime.ledger.captureProtectedEvidenceForAssignment({
    assignmentId: assignment.assignmentId,
    childSessionKey: params.sessionKey,
  });
  const currentCandidate = await deps.requireCurrentCandidate({
    runtime: params.runtime,
    sliceId: assignment.sliceId,
    candidateId: assignment.candidateId,
  });
  await deps.assertAssignmentScopeCurrent({ runtime: params.runtime, assignment });
  const slice = params.runtime.ledger.getSliceScope(assignment.sliceId);
  if (!slice || (await deps.canonicalWorkspace(params.workspaceDir)) !== slice.repositoryRoot) {
    throw new Error("Guarded verifier workspace does not match the protected assignment slice.");
  }
  if (
    protectedFacts.assignment.assignmentId !== assignment.assignmentId ||
    protectedFacts.assignment.controllerAgentId !== assignment.controllerAgentId ||
    protectedFacts.assignment.controllerSessionKey !== assignment.controllerSessionKey ||
    protectedFacts.assignment.workerAgentId !== assignment.workerAgentId ||
    protectedFacts.assignment.candidateId !== assignment.candidateId ||
    protectedFacts.assignment.waveId !== assignment.waveId ||
    protectedFacts.candidate.candidateId !== currentCandidate.candidateId ||
    protectedFacts.candidate.fingerprint.candidateDigest !==
      currentCandidate.fingerprint.candidateDigest
  ) {
    throw new Error("Guarded verifier protected assignment identity changed during authorization.");
  }
  const sourceRevision = deps.sourceRevision();
  if (!sourceRevision || !/^[a-f0-9]{40}$/u.test(sourceRevision)) {
    throw new Error("Guarded verifier installed source revision is missing or malformed.");
  }
  return {
    assignmentId: assignment.assignmentId,
    candidateId: assignment.candidateId,
    waveId: assignment.waveId,
    epoch: assignment.epoch,
    candidateDigest: currentCandidate.fingerprint.candidateDigest,
    contextDigest: currentCandidate.fingerprint.contextDigest,
    scopeDigest: currentCandidate.fingerprint.scopeDigest,
    worktreeIdentity: currentCandidate.fingerprint.worktreeIdentity,
    repositoryHead: currentCandidate.fingerprint.head,
    sourceRevision,
  };
}

function sameGuardedVerifierAuthorization(
  left: GuardedVerifierAuthorization,
  right: GuardedVerifierAuthorization,
): boolean {
  return (
    left.assignmentId === right.assignmentId &&
    left.candidateId === right.candidateId &&
    left.waveId === right.waveId &&
    left.epoch === right.epoch &&
    left.candidateDigest === right.candidateDigest &&
    left.contextDigest === right.contextDigest &&
    left.scopeDigest === right.scopeDigest &&
    left.worktreeIdentity === right.worktreeIdentity &&
    left.repositoryHead === right.repositoryHead &&
    left.sourceRevision === right.sourceRevision
  );
}

export async function assertGuardedVerifierExecutionCurrent(
  params: GuardedVerifierExecutionIdentity & {
    expectedAuthorization: GuardedVerifierAuthorization;
  },
): Promise<void> {
  const current = await resolveGuardedVerifierAuthorization(params);
  if (!sameGuardedVerifierAuthorization(current, params.expectedAuthorization)) {
    throw new Error(
      "Guarded verifier assignment, candidate, or workspace changed before execution.",
    );
  }
}

export async function resolveGuardedVerifierSandboxConfig(params: {
  config?: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  workspaceDir?: string;
  sandbox: SandboxConfig;
  runtime?: DelegationRuntime;
  deps?: GuardedVerifierAuthorizationDeps;
}): Promise<SandboxConfig> {
  const guard = params.config ? resolveDelegationGuardConfig(params.config) : undefined;
  const principal = guard ? resolveDelegationGuardPrincipal(guard, params.agentId) : undefined;
  if (
    principal?.kind !== "worker" ||
    (principal.role !== "tester" && principal.role !== "reviewer")
  ) {
    return params.sandbox;
  }
  if (guard?.mode !== "enforce") {
    return params.sandbox;
  }
  if (!params.config) {
    throw new Error("Guarded verifier execution requires an enforcing verifier principal.");
  }
  if (!params.runtime) {
    throw new Error("Guarded verifier runtime requires an initialized enforcing ledger.");
  }
  const configuredWorkspace = params.workspaceDir?.trim();
  if (!configuredWorkspace) {
    throw new Error("Guarded verifier workspace does not match the protected assignment slice.");
  }
  const authorization = await resolveGuardedVerifierAuthorization({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    workspaceDir: configuredWorkspace,
    runtime: params.runtime,
    deps: params.deps,
  });
  const publishedImageId = process.env.OPENCLAW_VERIFIER_IMAGE_ID?.trim() ?? "";
  if (!/^sha256:[a-f0-9]{64}$/u.test(publishedImageId)) {
    throw new Error("Guarded verifier published OCI image identity is missing or malformed.");
  }
  if (
    params.sandbox.backend !== "docker" ||
    params.sandbox.scope !== "session" ||
    params.sandbox.workspaceAccess !== "ro" ||
    params.sandbox.docker.workdir !== "/workspace" ||
    (params.sandbox.docker.binds?.length ?? 0) > 0
  ) {
    throw new Error(
      "Guarded verifier sandbox configuration is not eligible for toolchain mounting.",
    );
  }
  return {
    ...params.sandbox,
    guardedVerifierRuntime: true,
    guardedVerifierAuthorization: authorization,
    browser: {
      ...params.sandbox.browser,
      enabled: false,
      binds: undefined,
      autoStart: false,
      allowHostControl: false,
      network: "none",
    },
    docker: {
      ...params.sandbox.docker,
      image: publishedImageId,
      binds: undefined,
      apparmorProfile: undefined,
      capDrop: ["ALL"],
      dangerouslyAllowContainerNamespaceJoin: false,
      dangerouslyAllowExternalBindSources: false,
      dangerouslyAllowReservedContainerTargets: false,
      dns: undefined,
      env: {},
      extraHosts: undefined,
      pidsLimit: 512,
      memory: "4g",
      memorySwap: "4g",
      cpus: 4,
      ulimits: {
        nofile: { soft: 65_536, hard: 65_536 },
        nproc: { soft: 4_096, hard: 4_096 },
      },
      network: "none",
      readOnlyRoot: true,
      seccompProfile: undefined,
      setupCommand: undefined,
      tmpfs: [...FIXED_VERIFIER_TMPFS],
      user: "1000:1000",
    },
  };
}
