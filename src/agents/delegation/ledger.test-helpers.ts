import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  DelegationGuardConfig,
  DelegationGuardWorkerRole,
} from "../../config/types.agents.js";
import {
  DELEGATION_CONTRACT_VERSION,
  DELEGATION_REPORT_VERSION,
  type CanonicalDelegationScope,
  type DelegationAssignmentPurpose,
  type DelegationAssignmentRecord,
  type DelegationFingerprint,
  type DelegationFinding,
  type DelegationRepositorySnapshot,
  type DelegationRouteKind,
  type DelegationWorkerReport,
} from "./contracts.js";
import { hashDelegationIdentity } from "./identity.js";
import { openDelegationLedger, type DelegationLedger } from "./ledger.js";
import { resolveDelegationPolicyDigest } from "./policy.js";
import { canonicalizeDelegationScope } from "./scope.js";

const VALIDATOR_SOURCE = "process.stdout.write('{}\\n');\n";

export const TEST_CONTROLLER = {
  agentId: "planner",
  sessionKey: "agent:planner:main",
} as const;

const WORKERS = {
  helper: {
    agentId: "helper",
    requiredThinking: "xhigh",
    workspaceAccess: "ro",
  },
  implementer: {
    agentId: "implementer",
    requiredThinking: "xhigh",
    workspaceAccess: "rw",
  },
  tester: {
    agentId: "tester",
    requiredThinking: "medium",
    workspaceAccess: "ro",
  },
  reviewer: {
    agentId: "reviewer",
    requiredThinking: "high",
    workspaceAccess: "ro",
  },
  qa: {
    agentId: "qa",
    requiredThinking: "medium",
    workspaceAccess: "ro",
  },
} as const;

export type DelegationLedgerFixture = {
  rootDir: string;
  stateDir: string;
  validatorPath: string;
  guard: DelegationGuardConfig;
  policyDigest: string;
  ledger: DelegationLedger;
  scope: CanonicalDelegationScope;
  sliceId: string;
  baselineCandidateId: string;
  close: () => void;
};

export function installTestValidator(rootDir: string, name = "validator.mjs") {
  mkdirSync(rootDir, { recursive: true });
  const validatorPath = path.join(rootDir, name);
  writeFileSync(validatorPath, VALIDATOR_SOURCE, { mode: 0o444 });
  chmodSync(validatorPath, 0o444);
  return {
    validatorPath,
    sha256: createHash("sha256").update(VALIDATOR_SOURCE).digest("hex"),
  };
}

export function createTestGuard(params: {
  validatorPath: string;
  validatorSha256: string;
  validatorVersion?: string;
}): DelegationGuardConfig {
  return {
    enabled: true,
    mode: "enforce",
    controllers: [{ agentId: TEST_CONTROLLER.agentId, requiredThinking: "xhigh" }],
    workers: Object.entries(WORKERS).map(([role, worker]) => ({
      agentId: worker.agentId,
      role: role as DelegationGuardWorkerRole,
      requiredThinking: worker.requiredThinking,
      workspaceAccess: worker.workspaceAccess,
    })),
    validator: {
      id: "test-validator",
      version: params.validatorVersion ?? "1",
      sha256: params.validatorSha256,
      entrypoint: params.validatorPath,
      maxOutputBytes: 16 * 1024,
    },
  };
}

export function createFingerprint(params: {
  guard: DelegationGuardConfig;
  policyDigest: string;
  scope: CanonicalDelegationScope;
  epoch: number;
  label: string;
}): DelegationFingerprint {
  const candidateDigest = hashDelegationIdentity("test-candidate", params.label);
  return {
    contractVersion: DELEGATION_CONTRACT_VERSION,
    candidateId: `candidate_${candidateDigest}`,
    candidateDigest,
    contextDigest: hashDelegationIdentity("test-context", params.label),
    scopeDigest: params.scope.scopeDigest,
    worktreeIdentity: hashDelegationIdentity("test-worktree", "repo"),
    head: "a".repeat(40),
    epoch: params.epoch,
    pathCount: params.scope.paths.length,
    dirtyCount: 0,
    validatorId: params.guard.validator.id,
    validatorVersion: params.guard.validator.version,
    validatorDigest: params.guard.validator.sha256,
    policyDigest: params.policyDigest,
    truncated: false,
  };
}

export function createRepositorySnapshot(params: {
  repositoryRoot: string;
  entries?: DelegationRepositorySnapshot["entries"];
  head?: string;
}): DelegationRepositorySnapshot {
  const facts = {
    version: "openclaw-repository-snapshot-v1" as const,
    repositoryRoot: params.repositoryRoot,
    head: params.head ?? "a".repeat(40),
    worktreeIdentity: hashDelegationIdentity("test-worktree", "repo"),
    entries: params.entries ?? [],
  };
  return {
    ...facts,
    snapshotDigest: hashDelegationIdentity("delegation-repository-snapshot-v1", facts),
  };
}

export function createLedgerFixture(paths = ["src/one.ts", "src/two.ts"]): DelegationLedgerFixture {
  const rootDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "openclaw-delegation-ledger-")));
  const stateDir = path.join(rootDir, "state");
  const { validatorPath, sha256 } = installTestValidator(rootDir);
  const guard = createTestGuard({ validatorPath, validatorSha256: sha256 });
  const policyDigest = resolveDelegationPolicyDigest(guard);
  const ledger = openDelegationLedger({
    guard,
    policyDigest,
    stateDir,
    reconcileGatewayTask: () => "absent",
  });
  const scope = canonicalizeDelegationScope({
    version: "openclaw-scope-v1",
    kind: "slice",
    entries: paths.map((filePath) => ({ path: filePath, expectation: "existing" })),
  });
  const baseline = ledger.createSliceWithBaseline({
    controllerAgentId: TEST_CONTROLLER.agentId,
    controllerSessionKey: TEST_CONTROLLER.sessionKey,
    repositoryRoot: path.join(rootDir, "repo"),
    scope,
    fingerprint: createFingerprint({
      guard,
      policyDigest,
      scope,
      epoch: ledger.currentEpoch(),
      label: "baseline",
    }),
    repositorySnapshot: createRepositorySnapshot({
      repositoryRoot: path.join(rootDir, "repo"),
    }),
  });
  return {
    rootDir,
    stateDir,
    validatorPath,
    guard,
    policyDigest,
    ledger,
    scope,
    sliceId: baseline.sliceId,
    baselineCandidateId: baseline.candidateId,
    close: () => {
      closeLedgerForTest(ledger);
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

export function closeLedgerForTest(ledger: DelegationLedger): void {
  try {
    unsafeDatabaseForTest(ledger).close();
  } catch {
    // Dedicated test ledgers may already have been closed to emulate a restart.
  }
}

export function unsafeDatabaseForTest(ledger: DelegationLedger): DatabaseSync {
  return (ledger as unknown as { db: DatabaseSync }).db;
}

export function makeFinding(params: {
  localId: string;
  summary: string;
  severity?: "warning" | "blocker";
  proposedProvenance?: DelegationFinding["proposedProvenance"];
  scopeId?: string;
}): DelegationFinding {
  return {
    localId: params.localId,
    severity: params.severity ?? "blocker",
    summary: params.summary,
    proposedProvenance: params.proposedProvenance ?? "indeterminate",
    scopeIds: [params.scopeId ?? "src/one.ts"],
    evidenceIds: [],
    discoveryTrigger: "targeted review",
  };
}

export function makeCompleteReport(params: {
  assigned: string[];
  findings?: DelegationFinding[];
  conclusionScope?: string;
}): DelegationWorkerReport {
  const findings = params.findings ?? [];
  const evidence = params.assigned.map((scopeId, index) => ({
    evidenceId: `command-${index + 1}`,
    scopeId,
  }));
  return {
    contractVersion: DELEGATION_REPORT_VERSION,
    status: findings.length > 0 ? "findings" : "completed",
    work: [{ what: "Inspected the assigned scope.", why: "To satisfy the assignment." }],
    scope: {
      assigned: [...params.assigned],
      inspected: evidence.map(({ evidenceId, scopeId }) => ({
        scopeId,
        path: scopeId,
        purpose: "assigned coverage",
        evidenceIds: [evidenceId],
      })),
      omitted: [],
      failed: [],
      newlyDiscovered: [],
    },
    commands: evidence.map(({ evidenceId, scopeId }) => ({
      evidenceId,
      purpose: "Inspect the assigned scope unit.",
      command: `inspect ${scopeId}`,
      cwd: "/workspace",
      exitCode: 0,
      scopeIds: [scopeId],
      cap: null,
      resultCount: 1,
      truncated: false,
    })),
    artifacts: [],
    assumptions: [],
    remainingRisks: [],
    findings,
    coverage: "complete",
    conclusionScope: params.conclusionScope ?? "Only the assigned finite scope.",
  };
}

export function issueAssignment(params: {
  fixture: DelegationLedgerFixture;
  purpose: DelegationAssignmentPurpose;
  role: DelegationGuardWorkerRole;
  candidateId?: string;
  waveId?: string;
  remediationRevisionId?: string;
  recoveryOfAssignmentId?: string;
  initialRouteKind?: DelegationRouteKind;
  targetSessionKey?: string;
  requiredModel?: string;
  issuedAt?: number;
}) {
  const worker = WORKERS[params.role];
  return params.fixture.ledger.issueAssignment({
    sliceId: params.fixture.sliceId,
    ...(params.candidateId ? { candidateId: params.candidateId } : {}),
    ...(params.waveId ? { waveId: params.waveId } : {}),
    controllerAgentId: TEST_CONTROLLER.agentId,
    controllerSessionKey: TEST_CONTROLLER.sessionKey,
    workerAgentId: worker.agentId,
    role: params.role,
    requiredThinking: worker.requiredThinking,
    requiredModel: params.requiredModel ?? "openai/gpt-5.4",
    workspaceAccess: worker.workspaceAccess,
    purpose: params.purpose,
    ...(params.issuedAt === undefined ? {} : { issuedAt: params.issuedAt }),
    ...(params.remediationRevisionId
      ? { remediationRevisionId: params.remediationRevisionId }
      : {}),
    ...(params.recoveryOfAssignmentId
      ? { recoveryOfAssignmentId: params.recoveryOfAssignmentId }
      : {}),
    ...(params.initialRouteKind ? { initialRouteKind: params.initialRouteKind } : {}),
    ...(params.targetSessionKey ? { targetSessionKey: params.targetSessionKey } : {}),
  });
}

export function startAssignment(params: {
  fixture: DelegationLedgerFixture;
  assignment: DelegationAssignmentRecord;
  delegationToken: string;
  childSessionKey?: string;
  runId?: string;
  boundAt?: number;
  acceptedAt?: number;
  acceptedPayload?: unknown;
}) {
  const childSessionKey =
    params.childSessionKey ??
    `agent:${params.assignment.workerAgentId}:sub:${params.assignment.assignmentId}`;
  const runId = params.runId ?? `run-${params.assignment.assignmentId}`;
  params.fixture.ledger.consumeAssignmentToken({
    delegationToken: params.delegationToken,
    routeKind: "spawn",
    callerAgentId: TEST_CONTROLLER.agentId,
    callerSessionKey: TEST_CONTROLLER.sessionKey,
    targetAgentId: params.assignment.workerAgentId,
  });
  params.fixture.ledger.bindAssignment({
    assignmentId: params.assignment.assignmentId,
    childSessionKey,
    runId,
    ...(params.boundAt === undefined ? {} : { boundAt: params.boundAt }),
  });
  params.fixture.ledger.appendRouteEvent({
    assignmentId: params.assignment.assignmentId,
    kind: "accepted",
    ...(params.acceptedAt === undefined ? {} : { createdAt: params.acceptedAt }),
    ...(params.acceptedPayload === undefined ? {} : { payload: params.acceptedPayload }),
  });
  return { childSessionKey, runId };
}

export function finishAssignment(params: {
  fixture: DelegationLedgerFixture;
  assignment: DelegationAssignmentRecord;
  report?: DelegationWorkerReport;
  runId?: string;
  resultText?: string;
}) {
  const report = params.report ?? makeCompleteReport({ assigned: params.assignment.scopeUnits });
  const receiptId = submitAcceptedReport({
    fixture: params.fixture,
    assignment: params.assignment,
    report,
  });
  const resultText = params.resultText ?? `completed ${params.assignment.assignmentId}`;
  const terminal = recordTerminalReceipt({
    fixture: params.fixture,
    assignment: params.assignment,
    runId: params.runId ?? `run-${params.assignment.assignmentId}`,
    resultText,
  });
  return { receiptId, ...terminal };
}

export function submitAcceptedReport(params: {
  fixture: DelegationLedgerFixture;
  assignment: DelegationAssignmentRecord;
  report?: DelegationWorkerReport;
}): string {
  const receiptId = params.fixture.ledger.appendReceipt({
    assignmentId: params.assignment.assignmentId,
    report: params.report ?? makeCompleteReport({ assigned: params.assignment.scopeUnits }),
  });
  params.fixture.ledger.appendValidation({ receiptId, outcome: "accepted" });
  return receiptId;
}

export function recordTerminalReceipt(params: {
  fixture: DelegationLedgerFixture;
  assignment: DelegationAssignmentRecord;
  runId?: string;
  resultText?: string;
}) {
  const resultText = params.resultText ?? `completed ${params.assignment.assignmentId}`;
  const resultReceipt = {
    receiptId: `result-${params.assignment.assignmentId}`,
    sha256: createHash("sha256").update(resultText).digest("hex"),
    bytes: Buffer.byteLength(resultText),
    capturedAt: Date.now(),
    resultText,
  };
  const terminalReceiptId = params.fixture.ledger.recordAcceptedTerminalCompletion({
    assignmentId: params.assignment.assignmentId,
    runId: params.runId ?? `run-${params.assignment.assignmentId}`,
    resultReceipt,
  });
  return { terminalReceiptId, resultReceipt };
}

export function completeAssignment(params: {
  fixture: DelegationLedgerFixture;
  assignment: DelegationAssignmentRecord;
  delegationToken: string;
  report?: DelegationWorkerReport;
}) {
  const started = startAssignment(params);
  return { ...started, ...finishAssignment({ ...params, runId: started.runId }) };
}

export function completeDiscoveryAndImplementation(fixture: DelegationLedgerFixture): void {
  const discovery = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
  completeAssignment({ fixture, ...discovery });
  const implementation = issueAssignment({
    fixture,
    purpose: "implementation",
    role: "implementer",
  });
  completeAssignment({ fixture, ...implementation });
}

export function createVerificationWave(fixture: DelegationLedgerFixture, label = "implementation") {
  const fingerprint = createFingerprint({
    guard: fixture.guard,
    policyDigest: fixture.policyDigest,
    scope: fixture.scope,
    epoch: fixture.ledger.currentEpoch(),
    label,
  });
  return fixture.ledger.recordCandidateAndFreezeWave({
    sliceId: fixture.sliceId,
    fingerprint,
    requiredRoles: ["tester", "reviewer"],
  });
}
