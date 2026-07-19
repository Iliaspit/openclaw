import type {
  DelegationGuardThinkingLevel,
  DelegationGuardWorkerRole,
} from "../../config/types.agents.js";

export const DELEGATION_SCOPE_VERSION = "openclaw-scope-v1" as const;
export const DELEGATION_CONTRACT_VERSION = "openclaw-delegation-v1" as const;
export const DELEGATION_REPORT_VERSION = "openclaw-delegation-report-v1" as const;
export const DELEGATION_VALIDATOR_PROTOCOL = "openclaw-delegation-validator-v1" as const;

export type DelegationScopeExpectation = "existing" | "may-create";

export type DelegationSliceScopeManifest = {
  version: typeof DELEGATION_SCOPE_VERSION;
  kind: "slice";
  entries: Array<{
    path: string;
    expectation: DelegationScopeExpectation;
  }>;
};

export type DelegationRepositoryScopeManifest = {
  version: typeof DELEGATION_SCOPE_VERSION;
  kind: "repository";
  operatorAuthorized: true;
};

export type DelegationScopeManifest =
  | DelegationSliceScopeManifest
  | DelegationRepositoryScopeManifest;

export type CanonicalDelegationScope = {
  manifest: DelegationScopeManifest;
  canonicalJson: string;
  scopeDigest: string;
  paths: string[];
};

export type DelegationFingerprint = {
  contractVersion: typeof DELEGATION_CONTRACT_VERSION;
  candidateId: string;
  candidateDigest: string;
  contextDigest: string;
  scopeDigest: string;
  worktreeIdentity: string;
  head: string;
  epoch: number;
  pathCount: number;
  dirtyCount: number;
  validatorId: string;
  validatorVersion: string;
  validatorDigest: string;
  policyDigest: string;
  truncated: false;
};

export type DelegationRepositorySnapshot = {
  version: "openclaw-repository-snapshot-v1";
  repositoryRoot: string;
  head: string;
  worktreeIdentity: string;
  entries: Array<{
    path: string;
    state: "file" | "missing" | "symlink" | "other";
    digest: string;
  }>;
  snapshotDigest: string;
};

export type DelegationAssignmentPurpose =
  | "discovery"
  | "implementation"
  | "verification"
  | "qa"
  | "remediation"
  | "confirmation";

export type DelegationAssignmentRecord = {
  assignmentId: string;
  sliceId: string;
  candidateId?: string;
  waveId?: string;
  controllerAgentId: string;
  controllerSessionKey: string;
  workerAgentId: string;
  role: DelegationGuardWorkerRole;
  requiredThinking: DelegationGuardThinkingLevel;
  requiredModel: string;
  workspaceAccess: "ro" | "rw";
  scopeUnits: string[];
  routeFamilyId: string;
  purpose: DelegationAssignmentPurpose;
  remediationRevisionId?: string;
  recoveryOfAssignmentId?: string;
  epoch: number;
  issuedAt: number;
};

export type DelegationRemediationDisposition = {
  assignmentId: string;
  localId: string;
  disposition: "fix" | "accepted-risk" | "not-actionable" | "new-slice";
  finalProvenance: "baseline-pre-existing" | "change-induced" | "indeterminate";
  rationale: string;
};

export type DelegationRouteKind = "spawn" | "send" | "steer";

export type DelegationMissReasonCode =
  | "not-assigned"
  | "search-truncated"
  | "search-missed"
  | "dependency-discovered-late"
  | "candidate-drift"
  | "insufficient-evidence";

export type DelegationReportCommand = {
  evidenceId: string;
  purpose: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  scopeIds: string[];
  cap: number | null;
  resultCount: number | null;
  truncated: boolean;
  artifactSha256?: string;
  notApplicableReason?: string;
};

export type DelegationFinding = {
  localId: string;
  severity: "warning" | "blocker";
  summary: string;
  proposedProvenance: "baseline-pre-existing" | "change-induced" | "indeterminate";
  scopeIds: string[];
  evidenceIds: string[];
  discoveryTrigger: string;
  lateReasonCode?: DelegationMissReasonCode;
};

export type DelegationWorkerReport = {
  contractVersion: typeof DELEGATION_REPORT_VERSION;
  status: "completed" | "blocked" | "findings";
  work: Array<{ what: string; why: string }>;
  scope: {
    assigned: string[];
    inspected: Array<{
      scopeId: string;
      path: string;
      purpose: string;
      evidenceIds: string[];
    }>;
    omitted: Array<{
      scopeId: string;
      path: string;
      reason: string;
      missReasonCode: DelegationMissReasonCode;
    }>;
    failed: Array<{ scopeId: string; path: string; reason: string; evidenceId?: string }>;
    newlyDiscovered: Array<{
      scopeId: string;
      path: string;
      reason: string;
      disposition: "covered" | "follow-up" | "not-required";
      evidenceIds: string[];
    }>;
  };
  commands: DelegationReportCommand[];
  artifacts: Array<{
    evidenceId: string;
    path?: string;
    sha256: string;
    kind: string;
  }>;
  assumptions: Array<{ assumption: string; impact: string }>;
  remainingRisks: string[];
  findings: DelegationFinding[];
  coverage: "complete" | "partial" | "blocked";
  conclusionScope: string;
};

export type DelegationValidatorAction = "fingerprint" | "validate_report" | "validate_ledger";

export type DelegationValidatorRequest = {
  protocol: typeof DELEGATION_VALIDATOR_PROTOCOL;
  action: DelegationValidatorAction;
  payload: unknown;
};

export type DelegationValidatorResponse = {
  protocol: typeof DELEGATION_VALIDATOR_PROTOCOL;
  action: DelegationValidatorAction;
  ok: boolean;
  result?: unknown;
  issues?: Array<{
    code: string;
    message: string;
    path?: string;
  }>;
};

export type DelegationValidationOutcome = "accepted" | "rejected" | "blocked";

export type DelegationLedgerStatus = {
  epoch: number;
  auditEvents: number;
  slices: number;
  candidates: number;
  waves: number;
  assignments: number;
  receipts: number;
  validations: number;
  terminalResults: number;
  remediationRevisions: number;
};
